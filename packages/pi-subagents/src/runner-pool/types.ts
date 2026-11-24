import type { Usage } from "@earendil-works/pi-ai";
import type { ModelTokenBudget } from "../runner/budget.ts";
import type { ResolvedSelection } from "../runtime/index.ts";
import type { ExecutionLimits } from "../runtime/limits.ts";
import type { OutputBuffer, OutputUpdate } from "../runtime/output.ts";
import type { RunFailure, ModelFailureEvidence, ToolEffects } from "../runner/failure.ts";
import type { WorkspaceIdentity } from "../workspace/identity.ts";
import type { MessageState, PendingMessage } from "../runtime/messages.ts";

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

export type Phase =
  | "preparing"
  | "running"
  | "safeguarding"
  | "cancelling"
  | "settling"
  | "blocked"
  | "terminal";

export type SafeguardReason = "model turns" | "invocation" | "tool deadline" | "model output";

export interface Safeguard {
  reason: SafeguardReason;
  stage: "finishing" | "summarizing" | "summarized" | "unavailable";
}

export type Outcome = "succeeded" | "failed" | "cancelled";

export interface Settlement {
  outcome: Outcome;
  text: string;
  error?: string;
  cleanupError?: string;
  usage?: Usage;
  failure?: RunFailure;
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
  activeTools?: number;
  queuedTools?: number;
  activeToolNames?: string[];
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
  executionLimits?: ExecutionLimits;
  identity?: RunIdentity;
  model?: string;
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
  failure?: RunFailure;
}

export type RunProgress = Pick<
  RunView,
  | "runId"
  | "generation"
  | "phase"
  | "stopReason"
  | "error"
  | "diagnostics"
  | "identity"
  | "model"
  | "failure"
>;

export interface RunActivity {
  providerRequests: number;
  toolStarts: number;
  codemodeStarts: number;
  recentTools: { name: string; state: "started" | "returned" | "error" }[];
}

export type ActivityUpdate =
  | Pick<RunActivity, "providerRequests" | "toolStarts" | "codemodeStarts">
  | { type: "started" | "returned" | "error"; id: string; name: string };

export type ModelUsage =
  | { status: "not_observed" }
  | { status: "observed"; totals: Usage }
  | { status: "unavailable" };

export interface RunObservation {
  selection?: ResolvedSelection;
  modelUsage: ModelUsage;
  modelTokenBudget?: ModelTokenBudget;
  usageScope: "child_model_only";
}

export type ObservationUpdate =
  | { selection: ResolvedSelection }
  | { executionLimits: ExecutionLimits }
  | { modelFailure: ModelFailureEvidence; failureStage: RunStage }
  | { cleanupUnsafe: true }
  | { usage: Usage }
  | { modelTokenBudget: ModelTokenBudget };

export interface RunControl {
  executionLimits: ExecutionLimits;
  remainingMs(): number;
  signal: AbortSignal;
  safeguardSignal: AbortSignal;
  workSignal: AbortSignal;
  safeguard(reason: SafeguardReason): void;
  beginSummary(): boolean;
  finishSummary(summarized: boolean): void;
  deadline: number;
  startupDeadline: number;
  check(): void;
  checkFast?(): void;
  running(): void;
  settling(): void;
  takeMessages(): PendingMessage[];
  stop(reason: string): void;
  partial(update: OutputUpdate): void;
  activity(update: ActivityUpdate): void;
  observation(update: ObservationUpdate): void;
  diagnostics(
    update:
      | { stage: RunStage }
      | {
          pendingTools: number;
          pendingTransports: number;
          activeTools?: number;
          queuedTools?: number;
        },
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
  checkFast?(): void;
  /** Logical commitment is synchronous; no child work may start inside this callback. */
  commit(reservation: RunReservation): undefined;
  afterSafe(settlement: Settlement): Promise<Settlement>;
}

export interface RunInbox {
  pending: PendingMessage[];
  bytes: number;
  receipts: Map<string, { digest: string; state: MessageState }>;
}

export interface Run {
  effects: ToolEffects;
  /** Sticky owner evidence; false means unconfirmed, never proven safe. */
  cleanupUnsafe: boolean;
  modelFailure?: ModelFailureEvidence;
  failureStage?: RunStage;
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
  inbox: RunInbox;
  observation: RunObservation;
  activity: Omit<RunActivity, "recentTools"> & {
    recentTools: (RunActivity["recentTools"][number] & { id: string })[];
  };
  activeTools: Map<string, string>;
  clock: { admitted: number; phase: number; stage: number; stopped?: number; completed?: number };
}

/** Diagnostic projection only. Never return extra provider fields or change billing totals. */
export function observedUsage(value: Usage): ModelUsage {
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
