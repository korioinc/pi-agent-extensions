import { randomUUID } from "node:crypto";
import {
  boundedText,
  DEFAULT_EXECUTION_LIMITS,
  LIMITS,
  type ExecutionLimits,
} from "../runtime/limits.ts";
import { OutputBuffer, type OutputUpdate } from "../runtime/output.ts";
import { safeErrorText } from "../runtime/errors.ts";
import { classifyFailure } from "../runner/failure.ts";
import { validMessage, type MessageResult } from "../runtime/messages.ts";
import { closeInbox, createInbox, enqueueInboxMessage, takeInboxMessages } from "./inbox.ts";
import {
  copyRunView,
  projectActivityRun,
  projectDiagnostics,
  projectFailure,
  projectRunDetail,
  projectRunSummary,
} from "./projections.ts";
import {
  observedUsage,
  type Caller,
  type ExecuteRun,
  type Origin,
  type Phase,
  type Rejection,
  type Run,
  type RunControl,
  type RunIdentity,
  type RunOptions,
  type RunProgress,
  type RunReservation,
  type RunSubmission,
  type RunView,
  type SafeguardReason,
  type Settlement,
} from "./types.ts";

export type {
  Caller,
  ExecuteRun,
  Origin,
  Rejection,
  RunActivity,
  RunControl,
  RunDiagnostics,
  RunIdentity,
  RunOptions,
  RunProgress,
  RunReservation,
  RunStage,
  RunSubmission,
  RunView,
  Safeguard,
  SafeguardReason,
  Settlement,
} from "./types.ts";

/** One generation owns every run until its executor proves resource safety. */
export class RunnerPool {
  readonly generation = randomUUID();
  readonly executionLimits: ExecutionLimits;
  private readonly runs = new Map<string, Run>();
  private draining = false;
  private drainPromise?: Promise<void>;
  private expiry?: { at: number; timer: ReturnType<typeof setTimeout> };
  private readonly maxConcurrentRuns: number;
  private readonly onActivity?: () => void;

  constructor(
    maxConcurrentRuns: number = LIMITS.runs,
    executionLimits: ExecutionLimits = DEFAULT_EXECUTION_LIMITS,
    onActivity?: () => void,
  ) {
    if (
      !Number.isSafeInteger(maxConcurrentRuns) ||
      maxConcurrentRuns < 1 ||
      maxConcurrentRuns > LIMITS.retainedAgents
    )
      throw new Error(
        `Runner pool capacity must be an integer between 1 and ${LIMITS.retainedAgents}.`,
      );
    this.maxConcurrentRuns = maxConcurrentRuns;
    this.executionLimits = Object.freeze({ ...executionLimits });
    this.onActivity = onActivity;
  }

  private notifyActivity(): void {
    if (!this.onActivity) return;
    try {
      this.onActivity();
    } catch {
      /* Presentation failure never affects pool state. */
    }
  }

  private prune(notify: "none" | "sync" | "async" = "none"): void {
    const now = Date.now();
    const terminal = [...this.runs.values()]
      .filter((run) => run.view.phase === "terminal")
      .sort(
        (a, b) =>
          a.view.completedAt! - b.view.completedAt! || a.view.runId.localeCompare(b.view.runId),
      );
    let deleted = false;
    for (const [index, run] of terminal.entries()) {
      if (
        now - run.view.completedAt! >= LIMITS.retentionMs ||
        index < terminal.length - LIMITS.retained
      ) {
        this.runs.delete(run.view.runId);
        deleted = true;
      }
    }
    const oldest = terminal.find((run) => this.runs.has(run.view.runId));
    const at = oldest && oldest.view.completedAt! + LIMITS.retentionMs;
    if (at !== this.expiry?.at) {
      clearTimeout(this.expiry?.timer);
      this.expiry = undefined;
      if (at !== undefined) {
        const timer = setTimeout(
          () => {
            this.expiry = undefined;
            this.prune("sync");
          },
          Math.max(0, at - Date.now()),
        );
        timer.unref();
        this.expiry = { at, timer };
      }
    }
    if (deleted) {
      if (notify === "sync") this.notifyActivity();
      else if (notify === "async") queueMicrotask(() => this.notifyActivity());
    }
  }

  private owns(run: Run, caller: Caller): boolean {
    return (
      run.origin.sessionId === caller.sessionId &&
      (!run.authorize || run.authorize(caller)) &&
      (run.origin.anchor === null || caller.branch.has(run.origin.anchor))
    );
  }

  private phase(run: Run, phase: Phase): void {
    if (run.view.phase === phase) return;
    run.view.phase = phase;
    if (phase !== "running") {
      closeInbox(run.inbox);
      run.activeTools.clear();
    }
    run.clock.phase = performance.now();
    run.view.diagnostics.phaseStartedAt = Date.now();
  }

  inspect(caller: Caller, runId?: string) {
    this.prune("async");
    if (runId !== undefined) {
      const run = this.runs.get(runId);
      return run && this.owns(run, caller) ? projectRunDetail(run) : this.reject("not_available");
    }
    return {
      generation: this.generation,
      health: this.health(),
      maxConcurrentRuns: this.maxConcurrentRuns,
      runs: [...this.runs.values()]
        .filter((run) => this.owns(run, caller))
        .map((run) => projectRunSummary(run)),
    };
  }

  /** TUI/RPC activity projection: authorize before reading text; Map order is admission order. */
  inspectActivity(caller: Caller) {
    this.prune("async");
    return [...this.runs.values()]
      .filter((run) => this.owns(run, caller))
      .map((run) => projectActivityRun(run));
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

  sendMessage(
    caller: Caller,
    input: unknown,
    signal?: AbortSignal,
    beforePublish?: (messageId: string) => void | false,
  ): MessageResult {
    if (!validMessage(input)) return { rejection: "invalid_input" as const };
    this.prune("async");
    const run = this.runs.get(input.runId);
    if (!run || !this.owns(run, caller))
      return { rejection: "not_available", generation: this.generation };
    return enqueueInboxMessage(
      run.inbox,
      input,
      () => this.acceptingMessages(run),
      signal,
      beforePublish,
    );
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

  private createRun(
    origin: Origin,
    admittedAt: number,
    deadline: number,
    startupDeadline: number,
    onProgress?: (progress: RunProgress) => void | Promise<void>,
    identity?: RunIdentity,
    options?: RunOptions,
  ): Run {
    const wallTime = Date.now();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runId = randomUUID();
    const run: Run = {
      effects: "unknown",
      cleanupUnsafe: false,
      authorize: options?.authorize,
      origin: { ...origin },
      view: {
        executionLimits: this.executionLimits,
        ...(identity ? { identity: Object.freeze({ ...identity }) } : {}),
        diagnostics: {
          stage: "admitted",
          executor: "pending",
          pendingTools: 0,
          pendingTransports: 0,
          activeTools: 0,
          queuedTools: 0,
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
      onProgress: undefined,
      executionSettled: false,
      inbox: createInbox(),
      observation: { modelUsage: { status: "not_observed" }, usageScope: "child_model_only" },
      activity: { providerRequests: 0, toolStarts: 0, codemodeStarts: 0, recentTools: [] },
      activeTools: new Map(),
      clock: { admitted: admittedAt, phase: admittedAt, stage: admittedAt },
    };
    return run;
  }

  private createRunControl(
    run: Run,
    deadline: number,
    startupDeadline: number,
    options?: RunOptions,
  ): RunControl {
    const checkDeadline = () => {
      if (run.executionSettled) return;
      if (!run.view.safeguard && performance.now() >= deadline) this.safeguard(run, "invocation");
      const end = run.summaryDeadline ?? run.safeguardDeadline;
      if (end !== undefined && performance.now() >= end)
        this.stop(run, "limit_exceeded: safeguard");
    };
    const runCheck = (authorityCheck?: () => void) => {
      checkDeadline();
      run.abort.signal.throwIfAborted();
      if (authorityCheck) {
        try {
          authorityCheck();
        } catch (error) {
          this.stop(run, "authority_revoked");
          throw error;
        }
      }
      checkDeadline();
      run.abort.signal.throwIfAborted();
    };
    const control: RunControl = {
      executionLimits: this.executionLimits,
      remainingMs: () => {
        control.check();
        return Math.max(0, (run.summaryDeadline ?? deadline) - performance.now());
      },
      signal: run.abort.signal,
      safeguardSignal: run.safeguard.signal,
      workSignal: run.work.signal,
      safeguard: (reason) => this.safeguard(run, reason),
      beginSummary: () => {
        control.check();
        if (run.cleanupUnsafe) return false;
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
      check: () => runCheck(options?.check),
      checkFast: () => runCheck(options?.checkFast ?? options?.check),
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
      takeMessages: () => (this.acceptingMessages(run) ? takeInboxMessages(run.inbox) : []),
      stop: (reason) => this.stop(run, reason),
      partial: (update) => this.output(run, update),
      observation: (update) => {
        if (run.view.phase === "terminal") return;
        if ("cleanupUnsafe" in update) {
          if (!run.cleanupUnsafe) {
            run.cleanupUnsafe = true;
            run.failureStage ??= run.view.diagnostics.stage;
            this.stop(run, "cleanup_unconfirmed", false);
            this.block(run);
          }
        } else if ("modelFailure" in update) {
          run.modelFailure ??= Object.freeze({ ...update.modelFailure });
          run.failureStage ??= update.failureStage;
        } else if ("executionLimits" in update) {
          run.view.executionLimits = Object.freeze({ ...update.executionLimits });
        } else if ("selection" in update) {
          if (run.observation.selection) return;
          const { model, modelSource, thinkingLevel, thinkingSource } = update.selection;
          const selection = { model, modelSource, thinkingLevel, thinkingSource };
          if (Buffer.byteLength(JSON.stringify(selection)) <= LIMITS.selectionBytes) {
            run.observation.selection = selection;
            run.view.model = selection.model;
            if (run.view.phase === "preparing") this.progress(run);
          }
        } else if ("modelTokenBudget" in update) {
          run.observation.modelTokenBudget = structuredClone(update.modelTokenBudget);
        } else {
          run.observation.modelUsage = observedUsage(update.usage);
        }
      },
      activity: (update) => {
        if (run.view.phase === "terminal") return;
        if ("providerRequests" in update) {
          run.effects = update.toolStarts > 0 ? "possible" : "none_started";
          run.activity.providerRequests = update.providerRequests;
          run.activity.toolStarts = update.toolStarts;
          run.activity.codemodeStarts = update.codemodeStarts;
          return;
        }
        const id = boundedText(update.id, 256);
        const name = boundedText(update.name, 128);
        const recent = run.activity.recentTools;
        const prevTools = [...new Set(run.activeTools.values())];
        if (update.type === "started") {
          recent.push({ id, name, state: "started" });
          if (recent.length > 8) recent.shift();
          if (run.activeTools.has(id) || run.activeTools.size < 16) run.activeTools.set(id, name);
        } else {
          const entry = recent.findLast((item) => item.id === id);
          if (entry) entry.state = update.type;
          run.activeTools.delete(id);
        }
        const nextTools = [...new Set(run.activeTools.values())];
        const changed =
          prevTools.length !== nextTools.length ||
          prevTools.some((tool, index) => tool !== nextTools[index]);
        if (run.view.phase === "running" && changed) {
          if (!(run.view.diagnostics.queuedTools ?? 0)) this.progress(run);
          else this.notifyActivity();
        }
      },
      diagnostics: (update) => {
        if (run.view.phase === "terminal") return;
        if ("stage" in update) {
          if (run.view.diagnostics.stage === update.stage) return;
          run.view.diagnostics.stage = update.stage;
          run.view.diagnostics.stageStartedAt = Date.now();
          run.clock.stage = performance.now();
          if (
            (run.view.phase === "settling" || run.view.phase === "safeguarding") &&
            update.stage !== "finished" &&
            update.stage !== "cleanup_unconfirmed"
          )
            this.progress(run);
        } else {
          const prevQueued = run.view.diagnostics.queuedTools ?? 0;
          run.view.diagnostics.pendingTools = update.pendingTools;
          run.view.diagnostics.pendingTransports = update.pendingTransports;
          if (update.activeTools !== undefined)
            run.view.diagnostics.activeTools = update.activeTools;
          if (update.queuedTools !== undefined)
            run.view.diagnostics.queuedTools = update.queuedTools;
          if (
            run.view.phase === "running" &&
            (run.view.diagnostics.queuedTools ?? 0) !== prevQueued
          )
            this.progress(run);
        }
      },
    };
    return control;
  }

  private settleRun(
    run: Run,
    settlement: Settlement,
    signal: AbortSignal | undefined,
    onAbort: () => void,
    rejectExecutor: (error: unknown) => void,
  ): void {
    // No promise hop may separate this final safety check from the terminal commit.
    if (run.cleanupUnsafe) {
      rejectExecutor(new Error("Known cleanup failure cannot establish safe settlement."));
      return;
    }
    // A startup failure can carry the Session's initial zero accumulator, not an observation.
    if (run.observation.modelUsage.status !== "not_observed" && settlement.usage !== undefined)
      run.observation.modelUsage = observedUsage(settlement.usage);
    this.output(run, { type: "replace", text: settlement.text });
    if (run.view.safeguard?.stage === "summarized" && !settlement.text.trim())
      run.view.safeguard.stage = "unavailable";
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
      failure:
        settlement.failure ??
        classifyFailure({
          outcome: settlement.outcome,
          stage: run.failureStage ?? run.view.diagnostics.stage,
          stopReason: run.view.stopReason,
          model: run.modelFailure,
          toolEffects: run.effects,
        }),
    });
    clearTimeout(run.invocation);
    clearTimeout(run.startup);
    clearTimeout(run.grace);
    clearTimeout(run.finishTimer);
    clearTimeout(run.safeguardTimer);
    signal?.removeEventListener("abort", onAbort);
    run.onProgress = undefined;
    run.activeTools.clear();
    run.release();
    this.prune();
    this.notifyActivity();
  }

  submit(
    origin: Origin,
    execute: ExecuteRun,
    signal?: AbortSignal,
    onProgress?: (progress: RunProgress) => void | Promise<void>,
    identity?: RunIdentity,
    options?: RunOptions,
  ): Rejection | RunSubmission {
    this.prune("async");
    // Degraded health is diagnostic; unresolved runs retain only their own slots.
    if (this.draining) return this.reject("unavailable");
    if (
      [...this.runs.values()].filter((run) => run.view.phase !== "terminal").length >=
      this.maxConcurrentRuns
    ) {
      return this.reject("busy");
    }
    const admittedAt = performance.now();
    const deadline = admittedAt + this.executionLimits.invocationMs;
    const startupDeadline = Math.min(deadline, admittedAt + LIMITS.startupMs);
    const run = this.createRun(
      origin,
      admittedAt,
      deadline,
      startupDeadline,
      onProgress,
      identity,
      options,
    );
    const runId = run.view.runId;
    this.runs.set(runId, run);
    const onAbort = () => this.stop(run, "cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (!options) {
      run.onProgress = onProgress;
      this.progress(run);
    }
    const control = this.createRunControl(run, deadline, startupDeadline, options);
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
    const rejectExecutor = (error: unknown) => {
      // A rejection supplies no evidence of quiescence, even after finalization.
      run.view.diagnostics.executor = "rejected";
      run.view.error = boundedText(
        safeErrorText(error, "Execution failed with a non-displayable error."),
        4096,
      );
      this.stop(run, "runner_failure", false);
      this.block(run);
    };
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
        if (run.cleanupUnsafe)
          throw new Error("Known cleanup failure cannot establish safe settlement.");
        if (!options) return settlement;
        let finalized: Settlement;
        try {
          finalized = await options.afterSafe(settlement);
        } catch {
          // Logical finalization cannot undo the executor's proven resource safety.
          finalized = {
            ...settlement,
            outcome: "failed" as const,
            text: "",
            error: "history_unusable",
          };
        }
        if (run.cleanupUnsafe)
          throw new Error("Known cleanup failure cannot establish safe settlement.");
        return finalized;
      })
      .then(
        (settlement) => this.settleRun(run, settlement, signal, onAbort, rejectExecutor),
        rejectExecutor,
      );
    return {
      ...reservation,
      result: run.done.then(() => copyRunView(run)),
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
    if (!run.onProgress) {
      this.notifyActivity();
      return;
    }
    const { runId, generation, phase, stopReason, error, identity, model } = run.view;
    const diagnostics = projectDiagnostics(run);
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
          failure: projectFailure(run),
          ...(identity ? { identity: { ...identity } } : {}),
          ...(model ? { model } : {}),
        }),
      ).catch(failed);
    } catch (error) {
      failed(error);
    }
    this.notifyActivity();
  }

  private safeguard(run: Run, reason: SafeguardReason): void {
    if (run.abort.signal.aborted || run.view.safeguard || run.view.phase === "terminal") return;
    if (run.view.phase !== "running" || run.executionSettled) {
      this.stop(run, `limit_exceeded: ${reason}`);
      return;
    }
    run.failureStage ??= run.view.diagnostics.stage;
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

  private stop(run: Run, reason: string, notify = true): void {
    if (run.view.phase === "terminal" || run.abort.signal.aborted) return;
    closeInbox(run.inbox);
    run.failureStage ??= run.view.diagnostics.stage;
    run.view.stopReason = boundedText(reason, 4096);
    run.clock.stopped = performance.now();
    run.view.diagnostics.stopRequestedAt = Date.now();
    const transitioned =
      run.view.phase !== "blocked" && !run.executionSettled && run.view.phase !== "cancelling";
    // Stop intent during cleanup cannot rewrite the executor's settled outcome.
    if (run.view.phase !== "blocked" && !run.executionSettled) this.phase(run, "cancelling");
    clearTimeout(run.finishTimer);
    clearTimeout(run.safeguardTimer);
    run.grace = setTimeout(() => this.block(run), LIMITS.graceMs);
    run.abort.abort(reason);
    run.work.abort(reason);
    if (notify && transitioned && run.view.phase === "cancelling") this.progress(run);
  }

  cancel(caller: Caller, runId: string): RunView | Rejection {
    this.prune("async");
    const run = this.runs.get(runId);
    if (!run || !this.owns(run, caller)) return this.reject("not_available");
    this.stop(run, "cancelled");
    return copyRunView(run);
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
