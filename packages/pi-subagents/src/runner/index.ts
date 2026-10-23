import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { RunControl, Settlement } from "../runner-pool/index.ts";
import { prepareInvocation, type ResearchSource } from "../runtime/index.ts";
import {
  Preparation,
  PreparationLimitError,
  PreparationSafetyError,
} from "../runtime/discovery.ts";
import { ChildSession, type FollowupDelivery } from "../session/index.ts";
import { Budget } from "./budget.ts";
import { LIMITS } from "../runtime/limits.ts";
import type { HandoffReference } from "../runtime/handoff.ts";
import { cleanupFailure } from "./cleanup.ts";
import { safeErrorText } from "../runtime/errors.ts";

/** The caller retains native history; each invocation still owns a fresh runtime and budget. */
export interface RunnerIngress {
  accepting(): boolean;
  validate(): Promise<boolean>;
  steer(requestId: string, message: string): Promise<FollowupDelivery>;
}

export interface RunnerContinuation {
  requestId?: string;
  history: SessionManager;
  checkHistory(): void;
  onReady(ingress: RunnerIngress): void;
  delivery(requestId: string, state: FollowupDelivery): void;
}

/** Coordinates preparation, execution and every owner before reporting safe settlement. */
export async function runResearch(
  source: ResearchSource,
  { task, agent, handoff }: { task: string; agent: string; handoff?: HandoffReference },
  control: RunControl,
  continuation?: RunnerContinuation,
): Promise<Settlement> {
  const budget = new Budget(control);
  const checkHistory = () => {
    budget.check();
    try {
      continuation?.checkHistory();
    } catch (error) {
      control.stop("history_invalid");
      throw error;
    }
  };
  let child: ChildSession | undefined;
  let failure: string | undefined;
  let cleanupError: string | undefined;
  let unsafeCleanup: Error | undefined;
  let outcome: Settlement["outcome"] = "failed";
  try {
    budget.check();
    control.diagnostics({ stage: "preparation" });
    const captureBound = (includeParentPrompt: boolean) => {
      budget.check();
      const captured = source.capture(includeParentPrompt);
      return Object.freeze({
        ...captured,
        signal: AbortSignal.any([control.signal, ...(captured.signal ? [captured.signal] : [])]),
      });
    };
    const host = source.scope();
    const preparation = new Preparation(control.signal, control.startupDeadline);
    const { config, fingerprint: epoch } = await budget.track(
      prepareInvocation(host, task, agent, preparation, captureBound, handoff),
      "transport",
    );
    preparation.check();
    budget.check();
    control.observation({ selection: config.selection });
    budget.configureModelTokens(config.maxModelTokens);
    control.diagnostics({ stage: "session_start" });
    const history = continuation?.history ?? SessionManager.inMemory(config.cwd);
    child = new ChildSession(
      {
        ...config,
        ...(continuation?.requestId ? { followupRequestId: continuation.requestId } : {}),
      },
      {
        signal: control.signal,
        safeguardSignal: control.safeguardSignal,
        workSignal: control.workSignal,
        wrapTools: (tools, codemode) => budget.tools(tools, codemode),
        check: () => budget.check(),
        checkHistory,
        checkStartup: () => {
          budget.check();
          preparation.check();
        },
        request: (toolResultContinuation) => {
          checkHistory();
          budget.request(toolResultContinuation);
        },
        takeWrapUpNotice: () => budget.takeWrapUpNotice(),
        takeMessages: () => control.takeMessages(),
        exceeded: (limit) => budget.exceeded(limit),
        trackTransport: (work) => {
          budget.track(work, "transport");
        },
        partial: (update) => control.partial(update),
        usage: (totals) => {
          control.observation({ usage: totals });
          budget.observeModelUsage(totals);
        },
        activity: (event) => control.activity(event),
        delivery: continuation?.delivery,
      },
      history,
    );
    await child.start();
    if (continuation) {
      const session = child;
      continuation.onReady({
        accepting: () => session.accepting(),
        steer: (id, message) => session.steer(id, message),
        validate: () =>
          budget.track(
            (async () => {
              if (!session.accepting()) return false;
              const preparation = new Preparation(
                control.signal,
                Math.min(control.deadline, performance.now() + LIMITS.startupMs),
              );
              budget.check();
              const current = source.scope();
              const { fingerprint: candidate } = await prepareInvocation(
                current,
                task,
                agent,
                preparation,
                captureBound,
                handoff,
              );
              budget.check();
              return session.accepting() && candidate === epoch;
            })().catch((error: unknown) => {
              if (error instanceof PreparationSafetyError) {
                unsafeCleanup ??= error;
                control.stop("preparation_cleanup_failed");
              }
              throw error;
            }),
            "transport",
          ),
      });
    }
    control.diagnostics({ stage: "execution" });
    control.running();
    try {
      await child.prompt();
    } catch (error) {
      if (!control.safeguardSignal.aborted || control.signal.aborted) throw error;
    }
    if (control.safeguardSignal.aborted && !control.signal.aborted) {
      const reason = `limit_exceeded: ${safeErrorText(control.safeguardSignal.reason)}`;
      failure = reason;
      control.diagnostics({ stage: "safeguard_finish" });
      try {
        await child.finishWork();
        await budget.drain();
      } catch (error) {
        unsafeCleanup ??= cleanupFailure(error, "Safeguard cleanup failed.");
        control.stop("safeguard_cleanup_failed");
        throw error;
      }
      budget.check();
      if (control.beginSummary()) {
        budget.beginSummary();
        control.diagnostics({ stage: "safeguard_summary" });
        const summarized = await child.summarize(reason);
        control.finishSummary(summarized);
      }
    } else failure = child.snapshot().error;
    if (control.signal.aborted) {
      const reason = safeErrorText(control.signal.reason);
      outcome = reason === "cancelled" || reason === "shutdown" ? "cancelled" : "failed";
      failure ??= reason;
    } else outcome = failure ? "failed" : "succeeded";
  } catch (error) {
    if (error instanceof PreparationSafetyError) unsafeCleanup ??= error;
    if (error instanceof PreparationLimitError) control.stop(`limit_exceeded: ${error.message}`);
    failure ??= child?.snapshot().error ?? safeErrorText(error);
    const reason = safeErrorText(control.signal.reason);
    outcome =
      control.signal.aborted && (reason === "cancelled" || reason === "shutdown")
        ? "cancelled"
        : "failed";
  } finally {
    control.diagnostics({ stage: "abort" });
    control.settling();
    // A failed owner cannot prevent the other owners from attempting cleanup.
    const cleanup = async (operation: () => void | Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        const normalized = cleanupFailure(error, "Child resource cleanup failed.");
        unsafeCleanup ??= normalized;
        cleanupError = [cleanupError, normalized.message].filter(Boolean).join("; ");
      }
    };
    await cleanup(() => child?.abort());
    control.diagnostics({ stage: "operations" });
    await cleanup(() => budget.drain());
    await cleanup(() => child?.close((stage) => control.diagnostics({ stage })));
  }
  const result = child?.snapshot();
  cleanupError = [cleanupError, result?.cleanupError].filter(Boolean).join("; ") || undefined;
  if (unsafeCleanup !== undefined) {
    control.diagnostics({ stage: "cleanup_unconfirmed" });
    throw new Error(
      `${failure ?? "Execution stopped"}; resource cleanup is unconfirmed. ${cleanupError ?? ""}`,
      { cause: unsafeCleanup },
    );
  }
  if (cleanupError && outcome === "succeeded") outcome = "failed";
  control.diagnostics({ stage: "finished" });
  return { outcome, text: result?.text ?? "", error: failure, cleanupError, usage: result?.usage };
}
