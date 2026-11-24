import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { RunControl, RunStage, Settlement } from "../runner-pool/index.ts";
import { prepareInvocation, type ResearchSource } from "../runtime/index.ts";
import {
  Preparation,
  PreparationLimitError,
  PreparationSafetyError,
} from "../runtime/discovery.ts";
import { ChildSession, type FollowupDelivery } from "../session/index.ts";
import { Budget } from "./budget.ts";
import { LIMITS } from "../runtime/limits.ts";
import { cleanupFailure } from "./cleanup.ts";
import { safeErrorText } from "../runtime/errors.ts";
import { classifyFailure } from "./failure.ts";

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
  { task, agent }: { task: string; agent: string },
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
  let configurationFailure = false;
  let stage: RunStage = "admitted";
  let failureStage: RunStage | undefined;
  const step = (value: RunStage) => {
    stage = value;
    control.diagnostics({ stage: value });
  };
  try {
    budget.check();
    step("preparation");
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
      prepareInvocation(host, task, agent, preparation, captureBound, control.executionLimits),
      "transport",
    );
    preparation.check();
    budget.check();
    control.observation({ selection: config.selection });
    control.observation({ executionLimits: config.executionLimits });
    budget.configureModelTokens(config.maxModelTokens);
    step("session_start");
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
        safeguard: (reason) => control.safeguard(reason),
        wrapTools: (tools, codemode) => budget.tools(tools, codemode),
        check: () => budget.check(),
        checkFast: () => budget.checkFast(),
        checkHistory,
        checkStartup: () => {
          budget.check();
          preparation.check();
        },
        cleanupUnsafe: () => control.observation({ cleanupUnsafe: true }),
        request: (kind) => {
          checkHistory();
          return budget.request(kind);
        },
        modelFailure: (model) => {
          failureStage ??= stage;
          control.observation({ modelFailure: model, failureStage });
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
                control.executionLimits,
              );
              budget.check();
              return session.accepting() && candidate === epoch;
            })().catch((error: unknown) => {
              if (error instanceof PreparationSafetyError) {
                unsafeCleanup ??= error;
                control.observation({ cleanupUnsafe: true });
                control.stop("preparation_cleanup_failed");
              }
              throw error;
            }),
            "transport",
          ),
      });
    }
    step("execution");
    control.running();
    try {
      await child.prompt();
    } catch (error) {
      if (!control.safeguardSignal.aborted || control.signal.aborted) throw error;
    }
    if (control.safeguardSignal.aborted && !control.signal.aborted) {
      const reason = `limit_exceeded: ${safeErrorText(control.safeguardSignal.reason)}`;
      failure = reason;
      failureStage ??= stage;
      step("safeguard_finish");
      try {
        await child.finishWork();
        await budget.drain();
      } catch (error) {
        unsafeCleanup ??= cleanupFailure(error, "Safeguard cleanup failed.");
        control.observation({ cleanupUnsafe: true });
        control.stop("safeguard_cleanup_failed");
        throw error;
      }
      budget.check();
      if (control.beginSummary()) {
        budget.beginSummary();
        step("safeguard_summary");
        const summarized = await child.summarize(reason);
        control.finishSummary(summarized);
      }
    } else failure = child.snapshot().error;
    if (failure) failureStage ??= stage;
    if (control.signal.aborted) {
      const reason = safeErrorText(control.signal.reason);
      outcome = reason === "cancelled" || reason === "shutdown" ? "cancelled" : "failed";
      failure ??= reason;
    } else outcome = failure ? "failed" : "succeeded";
  } catch (error) {
    failureStage ??= stage;
    configurationFailure =
      failureStage === "preparation" &&
      !control.signal.aborted &&
      !control.safeguardSignal.aborted &&
      !(error instanceof PreparationLimitError) &&
      !(error instanceof PreparationSafetyError);
    if (error instanceof PreparationSafetyError) {
      unsafeCleanup ??= error;
      control.observation({ cleanupUnsafe: true });
    }
    if (error instanceof PreparationLimitError) control.stop(`limit_exceeded: ${error.message}`);
    failure ??= child?.snapshot().error ?? safeErrorText(error);
    const reason = safeErrorText(control.signal.reason);
    outcome =
      control.signal.aborted && (reason === "cancelled" || reason === "shutdown")
        ? "cancelled"
        : "failed";
  } finally {
    step("abort");
    control.settling();
    // A failed owner cannot prevent the other owners from attempting cleanup.
    const cleanup = async (operation: () => void | Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        failureStage ??= stage;
        const normalized = cleanupFailure(error, "Child resource cleanup failed.");
        unsafeCleanup ??= normalized;
        control.observation({ cleanupUnsafe: true });
        cleanupError = [cleanupError, normalized.message].filter(Boolean).join("; ");
      }
    };
    await cleanup(() => child?.abort());
    step("operations");
    await cleanup(() => budget.drain());
    await cleanup(() => child?.close(step));
  }
  const result = child?.snapshot();
  cleanupError = [cleanupError, result?.cleanupError].filter(Boolean).join("; ") || undefined;
  if (unsafeCleanup !== undefined) {
    step("cleanup_unconfirmed");
    throw new Error(
      `${failure ?? "Execution stopped"}; resource cleanup is unconfirmed. ${cleanupError ?? ""}`,
      { cause: unsafeCleanup },
    );
  }
  if (cleanupError && outcome === "succeeded") outcome = "failed";
  const diagnostic = classifyFailure({
    outcome,
    stage: failureStage ?? stage,
    stopReason: control.signal.reason,
    safeguardReason: control.safeguardSignal.reason,
    model: result?.modelFailure,
    toolEffects: budget.toolEffects,
    configurationFailure,
  });
  step("finished");
  return {
    outcome,
    text: result?.text ?? "",
    error: failure,
    cleanupError,
    usage: result?.usage,
    ...(diagnostic ? { failure: diagnostic } : {}),
  };
}
