import type { Usage } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunControl } from "../runner-pool/index.ts";
import { ToolCleanupError } from "../runtime/research-tools.ts";
import { LIMITS } from "../runtime/limits.ts";
import type { ToolEffects } from "./failure.ts";

export interface ModelTokenBudget {
  limit: number;
  observedTotal?: number;
  state: "not_observed" | "within_budget" | "exhausted" | "unavailable";
}

export interface WrapUpNotice {
  remainingTurns: number;
  remainingToolCalls: number;
  remainingModelTokens?: number;
  remainingMs?: number;
}

export type ModelRequestKind = "work" | "tool_result" | "compaction";

export interface ModelRequestAdmission {
  requestIndex: number;
  remainingMs: number;
}

/** Counts actual child tools separately from codemode. Work inside delegated host tools stays parent-owned. */
export class Budget {
  private requests = 0;
  private turns = 0;
  private toolStarts = 0;
  private codemodeStarts = 0;
  private active = 0;
  private readonly waiting: { start(): void; cancel(): void }[] = [];
  private granting = false;
  private wrapUpDelivered = false;
  private timeWrapUpDelivered = false;
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

  get toolEffects(): ToolEffects {
    return this.toolStarts > 0 ? "possible" : "none_started";
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

  checkFast(): void {
    if (this.control.checkFast) this.control.checkFast();
    else this.control.check();
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

  request(kind: ModelRequestKind = "work"): ModelRequestAdmission {
    if (this.summary) {
      this.check();
      if (kind === "compaction") throw new Error("Safeguard handoff cannot start compaction.");
      if (this.summaryRequested) throw new Error("Safeguard permits only one model request.");
    } else {
      this.admitWork();
      if (kind === "work") {
        if (this.turns >= LIMITS.turns) {
          this.control.safeguard("model turns");
          throw new Error("Model turn allowance ended; safeguard handoff required.");
        }
      }
    }
    // Measure after history/authority checks, before committing any request allowance.
    const remainingMs = this.control.remainingMs();
    if (remainingMs <= 0) {
      if (this.summary) this.control.stop("limit_exceeded: safeguard");
      else this.control.safeguard("invocation");
      throw new Error("Model request deadline has expired.");
    }
    if (this.summary) this.summaryRequested = true;
    else {
      this.control.safeguardSignal.throwIfAborted();
      if (kind === "work") this.turns++;
    }
    this.requests++;
    this.reportActivity();
    return { requestIndex: this.requests, remainingMs };
  }

  takeWrapUpNotice(): WrapUpNotice | undefined {
    if (this.control.signal.aborted) return undefined;
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
    const budgetNotice =
      !this.wrapUpDelivered &&
      (remainingTurns <= LIMITS.wrapUpTurns ||
        remainingToolCalls <= LIMITS.wrapUpToolCalls ||
        nearModelLimit);
    const remainingMs = Math.max(0, this.control.deadline - performance.now());
    const timeNotice =
      !this.timeWrapUpDelivered &&
      remainingMs <= Math.min(LIMITS.wrapUpMs, this.control.executionLimits.invocationMs);
    if (!budgetNotice && !timeNotice) return undefined;
    if (budgetNotice) this.wrapUpDelivered = true;
    if (timeNotice) this.timeWrapUpDelivered = true;
    return {
      remainingTurns,
      remainingToolCalls,
      ...(remainingModelTokens === undefined ? {} : { remainingModelTokens }),
      ...(timeNotice ? { remainingMs } : {}),
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
    this.control.diagnostics({
      pendingTools,
      pendingTransports,
      activeTools: this.active,
      queuedTools: this.waiting.length,
    });
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled(this.pending.keys());
    if (this.unsafeCleanup) throw this.unsafeCleanup;
  }

  private grantTools(): void {
    if (this.granting) return;
    this.granting = true;
    try {
      while (this.active < LIMITS.toolConcurrency && this.waiting.length)
        this.waiting.shift()!.start();
    } finally {
      this.granting = false;
    }
  }

  tools(tools: ToolDefinition[], codemode = false): ToolDefinition[] {
    return tools.map((tool) => ({
      ...tool,
      execute: async (id, params, signal, onUpdate, ctx) => {
        this.admitWork();
        const combined = AbortSignal.any([
          this.control.signal,
          this.control.workSignal,
          ...(signal ? [signal] : []),
        ]);
        combined.throwIfAborted();
        const execute = () => this.executeTool(tool, id, params, combined, onUpdate, ctx);
        if (codemode) {
          this.codemodeStarts++;
          this.reportActivity();
          return this.track(Promise.resolve().then(execute), "tool");
        }
        if (this.toolStarts + this.waiting.length >= LIMITS.toolCalls) this.exceeded("tool calls");
        let resolve!: (result: Awaited<ReturnType<ToolDefinition["execute"]>>) => void;
        let reject!: (error: unknown) => void;
        const owned = this.track(
          new Promise<Awaited<ReturnType<ToolDefinition["execute"]>>>((done, failed) => {
            resolve = done;
            reject = failed;
          }),
          "tool",
        );
        const detach = () => {
          combined.removeEventListener("abort", waiting.cancel);
          this.control.safeguardSignal.removeEventListener("abort", waiting.cancel);
        };
        const finish = () => {
          this.active--;
          this.reportPending();
          this.grantTools();
        };
        const waiting = {
          start: () => {
            detach();
            try {
              this.admitWork();
              combined.throwIfAborted();
            } catch (error) {
              reject(error);
              this.reportPending();
              return;
            }
            this.toolStarts++;
            this.active++;
            this.reportActivity();
            this.reportPending();
            void execute().then(
              (value) => {
                finish();
                resolve(value);
              },
              (error) => {
                finish();
                reject(error);
              },
            );
          },
          cancel: () => {
            const index = this.waiting.indexOf(waiting);
            if (index < 0) return;
            this.waiting.splice(index, 1);
            detach();
            reject(
              combined.aborted
                ? combined.reason
                : new Error("Ordinary work is closed for safeguard handoff."),
            );
            this.reportPending();
            this.grantTools();
          },
        };
        this.waiting.push(waiting);
        combined.addEventListener("abort", waiting.cancel, { once: true });
        this.control.safeguardSignal.addEventListener("abort", waiting.cancel, { once: true });
        if (combined.aborted || this.control.safeguardSignal.aborted) waiting.cancel();
        else {
          this.grantTools();
          if (this.waiting.includes(waiting)) this.reportPending();
        }
        return owned;
      },
    }));
  }

  private async executeTool(tool: ToolDefinition, ...args: Parameters<ToolDefinition["execute"]>) {
    this.admitWork();
    const [id, params, signal, onUpdate, ctx] = args;
    signal?.throwIfAborted();
    const deadline = performance.now() + this.control.executionLimits.toolMs;
    const timer = setTimeout(
      () => this.control.safeguard("tool deadline"),
      this.control.executionLimits.toolMs,
    );
    let updates = 0;
    let updateTrafficBytes = 0;
    try {
      const result = await tool.execute(
        id,
        params,
        signal,
        (update) => {
          this.checkFast();
          if (++updates > LIMITS.toolUpdates) this.exceeded("tool update count");
          const bytes = Buffer.byteLength(JSON.stringify(update));
          if (bytes > LIMITS.toolBytes) this.exceeded("tool update size");
          updateTrafficBytes += bytes;
          if (updateTrafficBytes > LIMITS.toolUpdateTrafficBytes)
            this.exceeded("tool update traffic");
          onUpdate?.(update);
        },
        ctx,
      );
      if (performance.now() >= deadline) this.control.safeguard("tool deadline");
      this.check();
      const bytes = Buffer.byteLength(JSON.stringify(result));
      if (bytes > LIMITS.toolBytes)
        throw new Error(
          `Tool result withheld: its serialized size is ${bytes} bytes, exceeding the ${LIMITS.toolBytes}-byte limit. ` +
            "Execution has already returned; external effects may have occurred and are not rolled back. " +
            "Do not automatically repeat the action. Inspect existing artifacts or request a smaller output.",
        );
      return result;
    } catch (error) {
      if (error instanceof ToolCleanupError) {
        this.unsafeCleanup ??= error;
        this.control.observation({ cleanupUnsafe: true });
        this.control.stop("tool_cleanup_failed");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
