import type { Usage } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunControl } from "../runner-pool/index.ts";
import { ToolCleanupError } from "../runtime/research-tools.ts";
import { LIMITS } from "../runtime/limits.ts";

export interface ModelTokenBudget {
  limit: number;
  observedTotal?: number;
  state: "not_observed" | "within_budget" | "exhausted" | "unavailable";
}

export interface WrapUpNotice {
  remainingTurns: number;
  remainingToolCalls: number;
  remainingModelTokens?: number;
}

/** Counts actual child tools separately from codemode. Work inside delegated host tools stays parent-owned. */
export class Budget {
  private requests = 0;
  private turns = 0;
  private toolStarts = 0;
  private codemodeStarts = 0;
  private active = 0;
  private wrapUpDelivered = false;
  private summary = false;
  private summaryRequested = false;
  private modelTokensConfigured = false;
  private modelTokenBudget?: ModelTokenBudget;
  private readonly pending = new Map<Promise<unknown>, "tool" | "transport">();
  private unsafeCleanup?: ToolCleanupError;

  private readonly control: RunControl;

  constructor(control: RunControl) {
    this.control = control;
  }

  configureModelTokens(limit: number | undefined): void {
    if (this.modelTokensConfigured) {
      if (limit !== this.modelTokenBudget?.limit)
        throw new Error("Model token budget cannot be reconfigured.");
      return;
    }
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0))
      throw new Error("Model token budget must be a positive safe integer.");
    this.modelTokensConfigured = true;
    if (limit !== undefined) {
      this.modelTokenBudget = { limit, state: "not_observed" };
      this.control.observation({ modelTokenBudget: this.modelTokenBudget });
    }
  }

  observeModelUsage(totals: Usage): void {
    const budget = this.modelTokenBudget;
    if (!budget || budget.state === "unavailable") return;
    const total = totals?.totalTokens;
    let reason: string | undefined;
    if (!Number.isSafeInteger(total) || total < 0 || total < (budget.observedTotal ?? 0)) {
      budget.state = "unavailable";
      reason = "usage_unavailable: model token budget";
    } else {
      budget.observedTotal = total;
      budget.state = total >= budget.limit ? "exhausted" : "within_budget";
      if (budget.state === "exhausted") reason = "limit_exceeded: model tokens";
    }
    this.control.observation({ modelTokenBudget: budget });
    if (reason && !this.control.signal.aborted) this.control.stop(reason);
  }

  check(): void {
    this.control.check();
  }

  exceeded(limit: string): never {
    this.control.stop(`limit_exceeded: ${limit}`);
    throw new Error(`Subagent limit exceeded: ${limit}`);
  }

  beginSummary(): void {
    this.check();
    if (!this.control.safeguardSignal.aborted || this.summary)
      throw new Error("Safeguard summary is not available.");
    this.summary = true;
  }

  private admitWork(): void {
    this.check();
    if (this.summary || this.control.safeguardSignal.aborted)
      throw new Error("Ordinary work is closed for safeguard handoff.");
  }

  request(toolResultContinuation = false): void {
    if (this.summary) {
      this.check();
      if (this.summaryRequested) throw new Error("Safeguard permits only one model request.");
      this.summaryRequested = true;
    } else {
      this.admitWork();
      if (!toolResultContinuation) {
        if (this.turns >= LIMITS.turns) {
          this.control.safeguard("model turns");
          throw new Error("Model turn allowance ended; safeguard handoff required.");
        }
        this.turns++;
      }
    }
    this.requests++;
    this.reportActivity();
  }

  takeWrapUpNotice(): WrapUpNotice | undefined {
    if (this.wrapUpDelivered || this.control.signal.aborted) return undefined;
    const remainingTurns = LIMITS.turns - this.turns;
    const remainingToolCalls = LIMITS.toolCalls - this.toolStarts;
    const budget = this.modelTokenBudget;
    const remainingModelTokens =
      budget?.observedTotal === undefined ? undefined : budget.limit - budget.observedTotal;
    const nearModelLimit =
      budget !== undefined &&
      remainingModelTokens !== undefined &&
      remainingModelTokens > 0 &&
      remainingModelTokens <= Math.ceil(budget.limit * LIMITS.wrapUpModelTokenFraction);
    if (
      remainingTurns > LIMITS.wrapUpTurns &&
      remainingToolCalls > LIMITS.wrapUpToolCalls &&
      !nearModelLimit
    )
      return undefined;
    this.wrapUpDelivered = true;
    return {
      remainingTurns,
      remainingToolCalls,
      ...(remainingModelTokens === undefined ? {} : { remainingModelTokens }),
    };
  }

  private reportActivity(): void {
    this.control.activity({
      providerRequests: this.requests,
      toolStarts: this.toolStarts,
      codemodeStarts: this.codemodeStarts,
    });
  }

  track<T>(work: Promise<T>, kind: "tool" | "transport"): Promise<T> {
    this.pending.set(work, kind);
    this.reportPending();
    const settled = () => {
      this.pending.delete(work);
      this.reportPending();
    };
    void work.then(settled, settled);
    return work;
  }

  private reportPending(): void {
    let pendingTools = 0;
    let pendingTransports = 0;
    for (const kind of this.pending.values()) {
      if (kind === "tool") pendingTools++;
      else pendingTransports++;
    }
    this.control.diagnostics({ pendingTools, pendingTransports });
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled(this.pending.keys());
    if (this.unsafeCleanup) throw this.unsafeCleanup;
  }

  tools(tools: ToolDefinition[], codemode = false): ToolDefinition[] {
    return tools.map((tool) => ({
      ...tool,
      execute: async (id, params, signal, onUpdate, ctx) => {
        this.admitWork();
        if (codemode) this.codemodeStarts++;
        else {
          if (this.toolStarts >= LIMITS.toolCalls) this.exceeded("tool calls");
          if (this.active >= LIMITS.toolConcurrency) this.exceeded("concurrent tools");
          this.toolStarts++;
          this.active++;
        }
        this.reportActivity();
        const deadline = performance.now() + LIMITS.toolMs;
        const timer = setTimeout(() => this.control.safeguard("tool deadline"), LIMITS.toolMs);
        const combined = AbortSignal.any([
          this.control.signal,
          this.control.workSignal,
          ...(signal ? [signal] : []),
        ]);
        let updates = 0;
        let updateTrafficBytes = 0;
        const captureUpdate = (value: unknown) => {
          // SDK updates can repeat snapshots. Bound processing work separately from result size.
          if (++updates > LIMITS.toolUpdates) this.exceeded("tool update count");
          const bytes = Buffer.byteLength(JSON.stringify(value));
          if (bytes > LIMITS.toolBytes) this.exceeded("tool update size");
          updateTrafficBytes += bytes;
          if (updateTrafficBytes > LIMITS.toolUpdateTrafficBytes)
            this.exceeded("tool update traffic");
        };
        try {
          return await this.track(
            Promise.resolve().then(async () => {
              this.admitWork();
              const result = await tool.execute(
                id,
                params,
                combined,
                (update) => {
                  this.check();
                  captureUpdate(update);
                  onUpdate?.(update);
                },
                ctx,
              );
              if (performance.now() >= deadline) this.control.safeguard("tool deadline");
              this.check();
              const bytes = Buffer.byteLength(JSON.stringify(result));
              if (bytes > LIMITS.toolBytes) {
                // The operation settled. Keep SDK content intact or report a recoverable error.
                throw new Error(
                  `Tool result withheld: its serialized size is ${bytes} bytes, exceeding the ${LIMITS.toolBytes}-byte limit. ` +
                    "Execution has already returned; external effects may have occurred and are not rolled back. " +
                    "Do not automatically repeat the action. Inspect existing artifacts or request a smaller output.",
                );
              }
              return result;
            }),
            "tool",
          );
        } catch (error) {
          if (error instanceof ToolCleanupError) {
            this.unsafeCleanup ??= error;
            this.control.stop("tool_cleanup_failed");
          }
          throw error;
        } finally {
          clearTimeout(timer);
          if (!codemode) this.active--;
        }
      },
    }));
  }
}
