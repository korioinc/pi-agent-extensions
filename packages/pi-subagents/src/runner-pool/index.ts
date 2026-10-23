import { createHash, randomUUID } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import type { ModelTokenBudget } from "../runner/budget.ts";
import type { HandoffReference } from "../runtime/handoff.ts";
import type { ResolvedSelection } from "../runtime/index.ts";
import { boundedText, LIMITS } from "../runtime/limits.ts";
import { OutputBuffer, type OutputUpdate } from "../runtime/output.ts";
import { safeErrorText } from "../runtime/errors.ts";
import type { WorkspaceIdentity } from "../workspace/identity.ts";
import {
  validMessage,
  type MessageState,
  type MessageResult,
  type PendingMessage,
} from "../runtime/messages.ts";

export interface Origin {
  sessionId: string;
  anchor: string | null;
}

export interface Caller {
  sessionId: string;
  branch: ReadonlySet<string>;
  cwd?: string;
  workspace?: WorkspaceIdentity;
  trustedProject?: boolean;
}

type Phase =
  | "preparing"
  | "running"
  | "safeguarding"
  | "cancelling"
  | "settling"
  | "blocked"
  | "terminal";
export type SafeguardReason = "model turns" | "invocation" | "tool deadline";
export interface Safeguard {
  reason: SafeguardReason;
  stage: "finishing" | "summarizing" | "summarized" | "unavailable";
}
type Outcome = "succeeded" | "failed" | "cancelled";
export interface Settlement {
  outcome: Outcome;
  text: string;
  error?: string;
  cleanupError?: string;
  usage?: Usage;
}

export type RunStage =
  | "admitted"
  | "preparation"
  | "session_start"
  | "execution"
  | "safeguard_finish"
  | "safeguard_summary"
  | "abort"
  | "operations"
  | "sdk_shutdown"
  | "dispose"
  | "mcp_close"
  | "cleanup_unconfirmed"
  | "finished";

export interface RunDiagnostics {
  stage: RunStage;
  executor: "pending" | "resolved" | "rejected";
  pendingTools: number;
  pendingTransports: number;
  admittedAt: number;
  phaseStartedAt: number;
  stageStartedAt: number;
  stopRequestedAt?: number;
  elapsedMs: number;
  phaseElapsedMs: number;
  stageElapsedMs: number;
  stopElapsedMs?: number;
  recovery?: "await_owned_work" | "containment_required";
}

export interface RunIdentity {
  readonly agent: string;
  readonly agentId?: string;
}

export interface RunView {
  identity?: RunIdentity;
  diagnostics: RunDiagnostics;
  runId: string;
  agentId?: string;
  generation: string;
  phase: Phase;
  outcome?: Outcome;
  stopReason?: string;
  safeguard?: Safeguard;
  text: string;
  truncated: boolean;
  outputBytes: number;
  persistence: "volatile";
  cleanup: "pending" | "safe";
  error?: string;
  cleanupError?: string;
  progressError?: string;
  completedAt?: number;
  usage?: Usage;
}

export type RunProgress = Pick<
  RunView,
  "runId" | "generation" | "phase" | "stopReason" | "error" | "diagnostics" | "identity"
>;

export interface RunActivity {
  providerRequests: number;
  toolStarts: number;
  codemodeStarts: number;
  recentTools: { name: string; state: "started" | "returned" | "error" }[];
}

type ActivityUpdate =
  | Pick<RunActivity, "providerRequests" | "toolStarts" | "codemodeStarts">
  | { type: "started" | "returned" | "error"; id: string; name: string };

type ModelUsage =
  | { status: "not_observed" }
  | { status: "observed"; totals: Usage }
  | { status: "unavailable" };

interface RunObservation {
  selection?: ResolvedSelection;
  modelUsage: ModelUsage;
  modelTokenBudget?: ModelTokenBudget;
  usageScope: "child_model_only";
}

type ObservationUpdate =
  | { selection: ResolvedSelection }
  | { usage: Usage }
  | { modelTokenBudget: ModelTokenBudget };

/** Diagnostic projection only. Never return extra provider fields or change billing totals. */
function observedUsage(value: Usage): ModelUsage {
  const totals: Usage = {
    input: value?.input,
    output: value?.output,
    cacheRead: value?.cacheRead,
    cacheWrite: value?.cacheWrite,
    totalTokens: value?.totalTokens,
    cost: {
      input: value?.cost?.input,
      output: value?.cost?.output,
      cacheRead: value?.cost?.cacheRead,
      cacheWrite: value?.cost?.cacheWrite,
      total: value?.cost?.total,
    },
  };
  const { cost, ...tokens } = totals;
  return [...Object.values(tokens), ...Object.values(cost)].every(
    (number) => typeof number === "number" && Number.isFinite(number) && number >= 0,
  )
    ? { status: "observed", totals }
    : { status: "unavailable" };
}

export interface RunControl {
  signal: AbortSignal;
  safeguardSignal: AbortSignal;
  workSignal: AbortSignal;
  safeguard(reason: SafeguardReason): void;
  beginSummary(): boolean;
  finishSummary(summarized: boolean): void;
  deadline: number;
  startupDeadline: number;
  check(): void;
  running(): void;
  settling(): void;
  takeMessages(): PendingMessage[];
  stop(reason: string): void;
  partial(update: OutputUpdate): void;
  activity(update: ActivityUpdate): void;
  observation(update: ObservationUpdate): void;
  diagnostics(
    update: { stage: RunStage } | { pendingTools: number; pendingTransports: number },
  ): void;
}

export type ExecuteRun = (control: RunControl) => Promise<Settlement>;
export type Rejection = { rejection: "busy" | "unavailable" | "not_available"; generation: string };

export interface RunReservation {
  runId: string;
  stop(reason: string): void;
}

export type RunSubmission = RunReservation & {
  result: Promise<RunView>;
  admissionFailure?: { error: unknown };
};

export interface RunOptions {
  authorize(caller: Caller): boolean;
  check(): void;
  /** Logical commitment is synchronous; no child work may start inside this callback. */
  commit(reservation: RunReservation): undefined;
  afterSafe(settlement: Settlement): Promise<Settlement>;
}

interface Run {
  authorize?: RunOptions["authorize"];
  origin: Origin;
  view: RunView;
  preview: string;
  output: OutputBuffer;
  abort: AbortController;
  safeguard: AbortController;
  work: AbortController;
  safeguardDeadline?: number;
  summaryDeadline?: number;
  finishTimer?: ReturnType<typeof setTimeout>;
  safeguardTimer?: ReturnType<typeof setTimeout>;
  invocation: ReturnType<typeof setTimeout>;
  startup: ReturnType<typeof setTimeout>;
  grace?: ReturnType<typeof setTimeout>;
  done: Promise<void>;
  release: () => void;
  onProgress?: (progress: RunProgress) => void | Promise<void>;
  executionSettled: boolean;
  inbox: {
    pending: PendingMessage[];
    bytes: number;
    receipts: Map<string, { digest: string; state: MessageState }>;
  };
  observation: RunObservation;
  activity: Omit<RunActivity, "recentTools"> & {
    recentTools: (RunActivity["recentTools"][number] & { id: string })[];
  };
  clock: { admitted: number; phase: number; stage: number; stopped?: number; completed?: number };
}

/** One generation owns every run until its executor proves resource safety. */
export class RunnerPool {
  readonly generation = randomUUID();
  private readonly runs = new Map<string, Run>();
  private draining = false;
  private drainPromise?: Promise<void>;
  private expiry?: { at: number; timer: ReturnType<typeof setTimeout> };
  private readonly maxConcurrentRuns: number;

  constructor(maxConcurrentRuns: number = LIMITS.runs) {
    if (
      !Number.isSafeInteger(maxConcurrentRuns) ||
      maxConcurrentRuns < 1 ||
      maxConcurrentRuns > LIMITS.retainedAgents
    )
      throw new Error(
        `Runner pool capacity must be an integer between 1 and ${LIMITS.retainedAgents}.`,
      );
    this.maxConcurrentRuns = maxConcurrentRuns;
  }

  private prune(): void {
    const now = Date.now();
    const terminal = [...this.runs.values()]
      .filter((run) => run.view.phase === "terminal")
      .sort(
        (a, b) =>
          a.view.completedAt! - b.view.completedAt! || a.view.runId.localeCompare(b.view.runId),
      );
    for (const [index, run] of terminal.entries()) {
      if (
        now - run.view.completedAt! >= LIMITS.retentionMs ||
        index < terminal.length - LIMITS.retained
      ) {
        this.runs.delete(run.view.runId);
      }
    }
    const oldest = terminal.find((run) => this.runs.has(run.view.runId));
    const at = oldest && oldest.view.completedAt! + LIMITS.retentionMs;
    if (at === this.expiry?.at) return;
    clearTimeout(this.expiry?.timer);
    this.expiry = undefined;
    if (at !== undefined) {
      const timer = setTimeout(
        () => {
          this.expiry = undefined;
          this.prune();
        },
        Math.max(0, at - Date.now()),
      );
      timer.unref();
      this.expiry = { at, timer };
    }
  }

  private owns(run: Run, caller: Caller): boolean {
    return (
      run.origin.sessionId === caller.sessionId &&
      (!run.authorize || run.authorize(caller)) &&
      (run.origin.anchor === null || caller.branch.has(run.origin.anchor))
    );
  }

  private diagnostics(run: Run): RunDiagnostics {
    const diagnostics = { ...run.view.diagnostics };
    const now = run.clock.completed ?? performance.now();
    diagnostics.elapsedMs = Math.max(0, now - run.clock.admitted);
    diagnostics.phaseElapsedMs = Math.max(0, now - run.clock.phase);
    diagnostics.stageElapsedMs = Math.max(0, now - run.clock.stage);
    if (run.clock.stopped !== undefined)
      diagnostics.stopElapsedMs = Math.max(0, now - run.clock.stopped);
    if (run.view.phase === "blocked")
      diagnostics.recovery =
        diagnostics.executor === "rejected" ? "containment_required" : "await_owned_work";
    return diagnostics;
  }

  private copy(run: Run): RunView {
    return {
      ...structuredClone(run.view),
      ...(run.view.identity?.agentId ? { agentId: run.view.identity.agentId } : {}),
      diagnostics: this.diagnostics(run),
    };
  }

  private phase(run: Run, phase: Phase): void {
    if (run.view.phase === phase) return;
    run.view.phase = phase;
    if (phase !== "running") this.closeInbox(run);
    run.clock.phase = performance.now();
    run.view.diagnostics.phaseStartedAt = Date.now();
  }

  inspect(caller: Caller, runId?: string) {
    this.prune();
    if (runId !== undefined) {
      const run = this.runs.get(runId);
      return run && this.owns(run, caller)
        ? {
            ...this.copy(run),
            observation: structuredClone(run.observation),
            inbox: {
              pendingCount: run.inbox.pending.length,
              pendingBytes: run.inbox.bytes,
              receipts: [...run.inbox.receipts].map(([messageId, { state }]) => ({
                messageId,
                state,
              })),
            },
            activity: {
              providerRequests: run.activity.providerRequests,
              toolStarts: run.activity.toolStarts,
              codemodeStarts: run.activity.codemodeStarts,
              recentTools: run.activity.recentTools.map(({ name, state }) => ({ name, state })),
            },
          }
        : this.reject("not_available");
    }
    return {
      generation: this.generation,
      health: this.health(),
      maxConcurrentRuns: this.maxConcurrentRuns,
      runs: [...this.runs.values()]
        .filter((run) => this.owns(run, caller))
        .map((run) => ({
          runId: run.view.runId,
          ...(run.view.identity?.agentId ? { agentId: run.view.identity.agentId } : {}),
          ...(run.view.identity ? { identity: { ...run.view.identity } } : {}),
          phase: run.view.phase,
          outcome: run.view.outcome,
          stopReason: run.view.stopReason,
          diagnostics: this.diagnostics(run),
        })),
    };
  }

  /** TUI-only projection: authorize before reading text; Map order is admission order. */
  inspectActivity(caller: Caller) {
    const summary = this.inspect(caller);
    if (!("runs" in summary) || !summary.runs) return [];
    return summary.runs.map((run) => ({
      ...run,
      error: this.runs.get(run.runId)!.view.error,
      preview: this.runs.get(run.runId)!.preview,
    }));
  }

  handoff(
    caller: Caller,
    runId: string,
  ):
    | HandoffReference
    | {
        rejection: "not_available" | "source_not_terminal" | "source_empty";
        generation: string;
      } {
    this.prune();
    const run = this.runs.get(runId);
    if (!run || !this.owns(run, caller))
      return { rejection: "not_available", generation: this.generation };
    const source = run.view;
    if (source.phase !== "terminal" || source.cleanup !== "safe")
      return { rejection: "source_not_terminal", generation: this.generation };
    if (!source.text.trim()) return { rejection: "source_empty", generation: this.generation };
    return {
      runId: source.runId,
      sourceOutcome: source.outcome!,
      sourceTruncated: source.truncated,
      excerptTruncated: Buffer.byteLength(source.text) > LIMITS.handoffBytes,
      text: boundedText(source.text, LIMITS.handoffBytes),
    };
  }

  private acceptingMessages(run: Run): boolean {
    return (
      !this.draining &&
      run.view.phase === "running" &&
      !run.abort.signal.aborted &&
      run.view.diagnostics.executor === "pending" &&
      !run.executionSettled
    );
  }

  private closeInbox(run: Run): void {
    for (const { messageId } of run.inbox.pending)
      run.inbox.receipts.get(messageId)!.state = "discarded";
    run.inbox.pending = [];
    run.inbox.bytes = 0;
  }

  sendMessage(
    caller: Caller,
    input: unknown,
    signal?: AbortSignal,
    beforePublish?: (messageId: string) => void,
  ): MessageResult {
    if (!validMessage(input)) return { rejection: "invalid_input" as const };
    this.prune();
    const run = this.runs.get(input.runId);
    if (!run || !this.owns(run, caller))
      return { rejection: "not_available", generation: this.generation };
    const { runId, messageId, message } = input;
    const digest = createHash("sha256").update(message).digest("hex");
    const receipt = run.inbox.receipts.get(messageId);
    if (receipt)
      return receipt.digest === digest
        ? { runId, messageId, state: receipt.state }
        : { rejection: "message_conflict" as const };
    if (signal?.aborted || !this.acceptingMessages(run))
      return { rejection: "not_accepting" as const };
    const bytes = Buffer.byteLength(message);
    if (
      run.inbox.receipts.size >= LIMITS.messageReceipts ||
      run.inbox.pending.length >= LIMITS.pendingMessages ||
      run.inbox.bytes + bytes > LIMITS.pendingMessageBytes
    )
      return { rejection: "message_capacity" as const };
    try {
      beforePublish?.(messageId);
    } catch {
      return { rejection: "not_available" };
    }
    if (signal?.aborted || !this.acceptingMessages(run)) {
      run.inbox.receipts.set(messageId, { digest, state: "discarded" });
      return { runId, messageId, state: "discarded" };
    }
    run.inbox.pending.push({ messageId, message });
    run.inbox.bytes += bytes;
    run.inbox.receipts.set(messageId, { digest, state: "queued" });
    return { runId, messageId, state: "queued" as const };
  }

  private health(): "ready" | "degraded" | "draining" {
    if (this.draining) return "draining";
    return [...this.runs.values()].some((run) => run.view.phase === "blocked")
      ? "degraded"
      : "ready";
  }

  private reject(rejection: Rejection["rejection"]): Rejection {
    return { rejection, generation: this.generation };
  }

  submit(
    origin: Origin,
    execute: ExecuteRun,
    signal?: AbortSignal,
    onProgress?: (progress: RunProgress) => void | Promise<void>,
    identity?: RunIdentity,
    options?: RunOptions,
  ): Rejection | RunSubmission {
    this.prune();
    // Degraded health is diagnostic; unresolved runs retain only their own slots.
    if (this.draining) return this.reject("unavailable");
    if (
      [...this.runs.values()].filter((run) => run.view.phase !== "terminal").length >=
      this.maxConcurrentRuns
    ) {
      return this.reject("busy");
    }
    const admittedAt = performance.now();
    const wallTime = Date.now();
    const deadline = admittedAt + LIMITS.invocationMs;
    const startupDeadline = admittedAt + LIMITS.startupMs;
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runId = randomUUID();
    const run: Run = {
      authorize: options?.authorize,
      origin: { ...origin },
      view: {
        ...(identity
          ? {
              identity: Object.freeze({ ...identity }),
            }
          : {}),
        diagnostics: {
          stage: "admitted",
          executor: "pending",
          pendingTools: 0,
          pendingTransports: 0,
          admittedAt: wallTime,
          phaseStartedAt: wallTime,
          stageStartedAt: wallTime,
          elapsedMs: 0,
          phaseElapsedMs: 0,
          stageElapsedMs: 0,
        },
        runId,
        generation: this.generation,
        phase: "preparing",
        text: "",
        truncated: false,
        outputBytes: 0,
        persistence: "volatile",
        cleanup: "pending",
      },
      abort: new AbortController(),
      safeguard: new AbortController(),
      work: new AbortController(),
      invocation: setTimeout(
        () => this.safeguard(run, "invocation"),
        Math.max(0, Math.ceil(deadline - performance.now())),
      ),
      startup: setTimeout(
        () => this.stop(run, "limit_exceeded: startup"),
        Math.max(0, Math.ceil(startupDeadline - performance.now())),
      ),
      preview: "",
      output: new OutputBuffer(),
      done,
      release,
      onProgress: options ? undefined : onProgress,
      executionSettled: false,
      inbox: { pending: [], bytes: 0, receipts: new Map() },
      observation: { modelUsage: { status: "not_observed" }, usageScope: "child_model_only" },
      activity: { providerRequests: 0, toolStarts: 0, codemodeStarts: 0, recentTools: [] },
      clock: { admitted: admittedAt, phase: admittedAt, stage: admittedAt },
    };
    this.runs.set(runId, run);
    const onAbort = () => this.stop(run, "cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (!options) this.progress(run);
    const control: RunControl = {
      signal: run.abort.signal,
      safeguardSignal: run.safeguard.signal,
      workSignal: run.work.signal,
      safeguard: (reason) => this.safeguard(run, reason),
      beginSummary: () => {
        control.check();
        const safeguard = run.view.safeguard;
        if (!safeguard || safeguard.stage !== "finishing") return false;
        clearTimeout(run.finishTimer);
        safeguard.stage = "summarizing";
        run.summaryDeadline = Math.min(
          run.safeguardDeadline!,
          performance.now() + LIMITS.safeguardSummaryMs,
        );
        clearTimeout(run.safeguardTimer);
        run.safeguardTimer = setTimeout(
          () => this.stop(run, "limit_exceeded: safeguard"),
          Math.max(0, Math.ceil(run.summaryDeadline - performance.now())),
        );
        this.progress(run);
        return true;
      },
      finishSummary: (summarized) => {
        if (run.view.safeguard)
          run.view.safeguard.stage = summarized ? "summarized" : "unavailable";
      },
      deadline,
      startupDeadline,
      check: () => {
        if (!run.executionSettled) {
          if (!run.view.safeguard && performance.now() >= deadline)
            this.safeguard(run, "invocation");
          const end = run.summaryDeadline ?? run.safeguardDeadline;
          if (end !== undefined && performance.now() >= end)
            this.stop(run, "limit_exceeded: safeguard");
        }
        run.abort.signal.throwIfAborted();
        if (options) {
          try {
            options.check();
          } catch (error) {
            this.stop(run, "authority_revoked");
            throw error;
          }
        }
      },
      running: () => {
        clearTimeout(run.startup);
        control.check();
        if (run.view.phase !== "preparing") return;
        if (performance.now() >= startupDeadline) this.stop(run, "limit_exceeded: startup");
        run.abort.signal.throwIfAborted();
        this.phase(run, "running");
        this.progress(run);
        // A synchronous progress consumer can cancel or drain this run.
        control.check();
      },
      settling: () => {
        clearTimeout(run.startup);
        clearTimeout(run.finishTimer);
        if (run.view.safeguard && run.view.safeguard.stage !== "summarized")
          run.view.safeguard.stage = "unavailable";
        run.executionSettled = true;
        if (
          run.view.phase !== "blocked" &&
          run.view.phase !== "terminal" &&
          run.view.phase !== "settling"
        ) {
          this.phase(run, "settling");
          this.progress(run);
        }
      },
      takeMessages: () => {
        if (!this.acceptingMessages(run)) return [];
        const messages = run.inbox.pending;
        for (const { messageId } of messages)
          run.inbox.receipts.get(messageId)!.state = "injected_not_confirmed";
        run.inbox.pending = [];
        run.inbox.bytes = 0;
        return messages;
      },
      stop: (reason) => this.stop(run, reason),
      partial: (update) => this.output(run, update),
      observation: (update) => {
        if (run.view.phase === "terminal") return;
        if ("selection" in update) {
          if (run.observation.selection) return;
          const { model, modelSource, thinkingLevel, thinkingSource } = update.selection;
          const selection = { model, modelSource, thinkingLevel, thinkingSource };
          if (Buffer.byteLength(JSON.stringify(selection)) <= LIMITS.selectionBytes)
            run.observation.selection = selection;
        } else if ("modelTokenBudget" in update) {
          run.observation.modelTokenBudget = structuredClone(update.modelTokenBudget);
        } else {
          run.observation.modelUsage = observedUsage(update.usage);
        }
      },
      activity: (update) => {
        if (run.view.phase === "terminal") return;
        if ("providerRequests" in update) {
          run.activity.providerRequests = update.providerRequests;
          run.activity.toolStarts = update.toolStarts;
          run.activity.codemodeStarts = update.codemodeStarts;
          return;
        }
        const id = boundedText(update.id, 256);
        const recent = run.activity.recentTools;
        if (update.type === "started") {
          recent.push({ id, name: boundedText(update.name, 128), state: "started" });
          if (recent.length > 8) recent.shift();
        } else {
          const entry = recent.findLast((item) => item.id === id);
          if (entry) entry.state = update.type;
        }
      },
      diagnostics: (update) => {
        if (run.view.phase === "terminal") return;
        if ("stage" in update) {
          if (run.view.diagnostics.stage === update.stage) return;
          run.view.diagnostics.stage = update.stage;
          run.view.diagnostics.stageStartedAt = Date.now();
          run.clock.stage = performance.now();
        } else {
          run.view.diagnostics.pendingTools = update.pendingTools;
          run.view.diagnostics.pendingTransports = update.pendingTransports;
        }
      },
    };
    const reservation: RunReservation = { runId, stop: (reason) => this.stop(run, reason) };
    let admissionFailure: RunSubmission["admissionFailure"];
    if (options) {
      try {
        options.commit(reservation);
        run.onProgress = onProgress;
      } catch (error) {
        // A failed synchronous commitment has not started the executor or acquired child resources.
        admissionFailure = { error };
      }
    }
    // The executor must resolve only after all owned operations and cleanup are safe.
    void Promise.resolve()
      .then(async () => {
        if (admissionFailure)
          return {
            outcome: "failed",
            text: "",
            error: "Admission was not committed.",
          } satisfies Settlement;
        // No executor has started, so an expired/cancelled admission is already safe.
        try {
          control.check();
          if (options) {
            // Logical commitment precedes publication; delivery never owns completion.
            this.progress(run);
            // Synchronous consumers may cancel or revoke authority before dispatch.
            control.check();
          }
          if (performance.now() >= startupDeadline) this.stop(run, "limit_exceeded: startup");
          run.abort.signal.throwIfAborted();
        } catch (error) {
          if (!run.abort.signal.aborted) throw error;
          const reason = safeErrorText(run.abort.signal.reason);
          return {
            outcome: reason === "cancelled" || reason === "shutdown" ? "cancelled" : "failed",
            text: "",
            error: reason,
          } satisfies Settlement;
        }
        return execute(control);
      })
      .then(async (settlement) => {
        if (!options) return settlement;
        try {
          return await options.afterSafe(settlement);
        } catch {
          // Logical finalization cannot undo the executor's proven resource safety.
          return {
            ...settlement,
            outcome: "failed" as const,
            text: "",
            error: "history_unusable",
          };
        }
      })
      .then(
        (settlement) => {
          // A startup failure can carry the Session's initial zero accumulator, not an observation.
          if (
            run.observation.modelUsage.status !== "not_observed" &&
            settlement.usage !== undefined
          )
            run.observation.modelUsage = observedUsage(settlement.usage);
          this.output(run, { type: "replace", text: settlement.text });
          this.phase(run, "terminal");
          run.view.diagnostics.executor = "resolved";
          run.clock.completed = performance.now();
          Object.assign(run.view, {
            outcome: settlement.outcome,
            error: settlement.error && boundedText(settlement.error, 4096),
            cleanupError: settlement.cleanupError && boundedText(settlement.cleanupError, 4096),
            usage: settlement.usage,
            cleanup: "safe",
            completedAt: Date.now(),
          });
          clearTimeout(run.invocation);
          clearTimeout(run.startup);
          clearTimeout(run.grace);
          clearTimeout(run.finishTimer);
          clearTimeout(run.safeguardTimer);
          signal?.removeEventListener("abort", onAbort);
          run.onProgress = undefined;
          run.release();
          this.prune();
        },
        (error: unknown) => {
          // An unexpected executor rejection supplies no evidence of quiescence.
          run.view.diagnostics.executor = "rejected";
          run.view.error = boundedText(
            safeErrorText(error, "Execution failed with a non-displayable error."),
            4096,
          );
          this.stop(run, "runner_failure");
          this.block(run);
        },
      );
    return {
      ...reservation,
      result: run.done.then(() => this.copy(run)),
      ...(admissionFailure ? { admissionFailure } : {}),
    };
  }

  private output(run: Run, update: OutputUpdate): void {
    run.output.apply(update);
    const { preview, ...view } = run.output.snapshot();
    run.preview = preview;
    Object.assign(run.view, view);
  }

  private block(run: Run): void {
    if (run.view.phase === "terminal") return;
    clearTimeout(run.grace);
    this.phase(run, "blocked");
    this.progress(run);
  }

  private progress(run: Run): void {
    if (!run.onProgress) return;
    const { runId, generation, phase, stopReason, error, identity } = run.view;
    const diagnostics = this.diagnostics(run);
    const failed = (error: unknown) => {
      try {
        run.view.progressError ??= boundedText(
          safeErrorText(error, "Progress publication failed."),
          4096,
        );
      } catch {
        run.view.progressError ??= "Progress publication failed.";
      }
    };
    try {
      // UI delivery does not own execution resources or hold the completion barrier.
      void Promise.resolve(
        run.onProgress({
          runId,
          generation,
          phase,
          stopReason,
          error,
          diagnostics,
          ...(identity ? { identity: { ...identity } } : {}),
        }),
      ).catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  private safeguard(run: Run, reason: SafeguardReason): void {
    if (run.abort.signal.aborted || run.view.safeguard || run.view.phase === "terminal") return;
    if (run.view.phase !== "running" || run.executionSettled) {
      this.stop(run, `limit_exceeded: ${reason}`);
      return;
    }
    run.view.safeguard = { reason, stage: "finishing" };
    run.view.stopReason = `limit_exceeded: ${reason}`;
    run.safeguardDeadline =
      performance.now() + LIMITS.safeguardFinishMs + LIMITS.safeguardSummaryMs;
    clearTimeout(run.invocation);
    clearTimeout(run.startup);
    this.phase(run, "safeguarding");
    run.finishTimer = setTimeout(() => run.work.abort(reason), LIMITS.safeguardFinishMs);
    run.safeguardTimer = setTimeout(
      () => this.stop(run, "limit_exceeded: safeguard"),
      LIMITS.safeguardFinishMs + LIMITS.safeguardSummaryMs,
    );
    run.safeguard.abort(reason);
    this.progress(run);
  }

  private stop(run: Run, reason: string): void {
    if (run.view.phase === "terminal" || run.abort.signal.aborted) return;
    this.closeInbox(run);
    run.view.stopReason = boundedText(reason, 4096);
    run.clock.stopped = performance.now();
    run.view.diagnostics.stopRequestedAt = Date.now();
    // Stop intent during cleanup cannot rewrite the executor's settled outcome.
    if (run.view.phase !== "blocked" && !run.executionSettled) this.phase(run, "cancelling");
    clearTimeout(run.finishTimer);
    clearTimeout(run.safeguardTimer);
    run.grace = setTimeout(() => this.block(run), LIMITS.graceMs);
    run.abort.abort(reason);
    run.work.abort(reason);
  }

  cancel(caller: Caller, runId: string): RunView | Rejection {
    this.prune();
    const run = this.runs.get(runId);
    if (!run || !this.owns(run, caller)) return this.reject("not_available");
    this.stop(run, "cancelled");
    return this.copy(run);
  }

  drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.draining = true;
    const runs = [...this.runs.values()];
    for (const run of runs) this.stop(run, "shutdown");
    this.drainPromise = Promise.all(runs.map((run) => run.done)).then(() => {
      this.runs.clear();
      clearTimeout(this.expiry?.timer);
      this.expiry = undefined;
    });
    return this.drainPromise;
  }
}
