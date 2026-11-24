import { createHash, randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import {
  RunnerPool,
  type Caller,
  type RunProgress,
  type Settlement,
} from "../runner-pool/index.ts";
import { runResearch, type RunnerIngress } from "../runner/index.ts";
import type { ResearchSource } from "../runtime/index.ts";
import type { FollowupDelivery } from "../session/index.ts";
import { LIMITS } from "../runtime/limits.ts";
import { sameWorkspace, type WorkspaceIdentity } from "../workspace/identity.ts";

type State = "active" | "idle" | "blocked" | "history_unusable" | "closed";
type Disposition = FollowupDelivery | "admitted" | "terminal";
interface Receipt {
  requestId: string;
  digest: string;
  runId: string;
  fence: string;
  state: Disposition;
  delivery?: Disposition;
  outcome?: Settlement["outcome"];
}
interface Metadata {
  agentId: string;
  agent: string;
  state: State;
  cwd: string;
  revision: number;
  closedAt?: number;
  runId?: string;
  outcome?: Settlement["outcome"];
  receipts: Receipt[];
}
interface RecordOwner {
  meta: Metadata;
  authority: AgentAuthority;
  history?: SessionManager;
  historyBytes?: number;
  historyEntries?: number;
  historyError?: "history_capacity" | "history_unusable";
  ingress?: RunnerIngress;
  admission?: {
    request?: Pick<Receipt, "requestId" | "digest">;
    done: Promise<void>;
  };
  pending: Map<string, number>;
  stop?: (reason: string) => void;
  /** Owned exclusively by the active foreground run; never overwritten by steering or messages. */
  input?: ParentAccess;
}
export type ParentSnapshot = Caller & {
  cwd: string;
  rawCwd?: string;
  workspace: WorkspaceIdentity;
  anchor: string | null;
  trustedProject: boolean;
};

export type FastParentSnapshot = Omit<ParentSnapshot, "workspace">;

export interface ParentAccess extends ResearchSource {
  /** Capture live authority without throwing; unavailable context/workspace returns undefined. */
  current(): ParentSnapshot | undefined;
  /** Lightweight hot-path capture without synchronous filesystem syscalls; omits workspace stat. */
  currentFast?(): FastParentSnapshot | undefined;
  fence(data: {
    agentId: string;
    runId: string;
    requestId?: string;
    kind: string;
    revision: number;
    nonce: string;
  }): string;
}
const idSchema = Type.String({ minLength: 1, maxLength: LIMITS.messageBytes });
const requestSchema = Type.String({ minLength: 1, maxLength: LIMITS.messageBytes });
export const agentIdSchema = Type.String({
  ...idSchema,
  description: "An existing agentId returned by subagent. Treated as an opaque string.",
});
const followupParameters = Type.Object(
  {
    agentId: agentIdSchema,
    requestId: Type.String({
      ...requestSchema,
      description:
        "Internal request identity supplied by the SDK tool call ID, preserved without modification.",
    }),
    message: Type.String({
      minLength: 1,
      maxLength: LIMITS.taskBytes,
      description: "Continuation only: the next task for the existing agent.",
    }),
  },
  { additionalProperties: false },
);
export const closeParameters = Type.Object({ agentId: idSchema }, { additionalProperties: false });
const hash = (message: string) => createHash("sha256").update(message).digest("hex");
const rejectionCodes = new Set([
  "invalid_input",
  "not_available",
  "not_accepting",
  "request_conflict",
  "request_capacity",
  "agent_capacity",
  "history_unusable",
  "configuration_changed",
  "not_idle",
  "busy",
  "unavailable",
]);
const reject = (rejection: string) => ({
  rejection: rejectionCodes.has(rejection) ? rejection : "unavailable",
});

/** Retained runs share only current authority, never history or parent adapters. */
class AgentAuthority {
  private readonly sessionId: string;
  private readonly workspace: WorkspaceIdentity;
  private readonly rawCwd?: string;
  private readonly trustedProject: boolean;
  fence = "";

  constructor(caller: ParentSnapshot) {
    this.sessionId = caller.sessionId;
    this.workspace = caller.workspace;
    this.rawCwd = caller.rawCwd;
    this.trustedProject = caller.trustedProject;
  }

  allows(caller: Caller | undefined): caller is Caller {
    return (
      caller !== undefined &&
      caller.sessionId === this.sessionId &&
      sameWorkspace(caller.workspace, this.workspace) &&
      caller.trustedProject === this.trustedProject &&
      caller.branch.has(this.fence)
    );
  }

  /** Fast hot-path check without workspace statting. Returns false if cwd changed or needs full check. */
  allowsFast(caller: FastParentSnapshot | undefined): boolean {
    return (
      caller !== undefined &&
      caller.sessionId === this.sessionId &&
      (caller.cwd === this.workspace.root ||
        (this.rawCwd !== undefined && caller.cwd === this.rawCwd)) &&
      caller.trustedProject === this.trustedProject &&
      caller.branch.has(this.fence)
    );
  }
}

/** Generation-owned native histories with one serialized admission lane per conversation. */
export class AgentRegistry {
  private readonly agents = new Map<string, RecordOwner>();
  private closing = false;
  private readonly pool: RunnerPool;
  private readonly invoke: typeof runResearch;
  constructor(pool: RunnerPool, invoke: typeof runResearch = runResearch) {
    this.pool = pool;
    this.invoke = invoke;
  }

  private check(record: RecordOwner): void {
    if (this.closing || !record.authority.allows(record.input?.current()))
      throw new Error("not_available");
  }
  private checkFast(record: RecordOwner): void {
    if (this.closing) throw new Error("not_available");
    const input = record.input;
    if (!input) throw new Error("not_available");
    if (!input.currentFast) {
      this.check(record);
      return;
    }
    const fast = input.currentFast();
    if (!fast) throw new Error("not_available");
    if (!record.authority.allowsFast(fast)) this.check(record);
  }
  private checkHistory(record: RecordOwner): void {
    if (record.historyError) throw new Error(record.historyError);
    const history = record.history;
    if (!history) return;
    try {
      if (record.historyBytes === undefined)
        record.historyBytes = Buffer.byteLength(JSON.stringify(history.getHeader())) + 1;
      // Native child histories only append. An unchanged count needs no defensive
      // array copy, but both capacity checks below still apply on every visit.
      if (history.getEntryCount() !== record.historyEntries) {
        const entries = history.getEntries();
        for (let index = record.historyEntries ?? 0; index < entries.length; index++)
          record.historyBytes += Buffer.byteLength(JSON.stringify(entries[index])) + 1;
        record.historyEntries = entries.length;
      }
      const generationBytes = [...this.agents.values()]
        .filter((item) => item.meta.state !== "closed")
        .reduce((sum, item) => sum + (item.historyBytes ?? 0), 0);
      if (
        record.historyBytes > LIMITS.agentHistoryBytes ||
        generationBytes > LIMITS.generationHistoryBytes
      )
        throw new Error("history_capacity");
    } catch (error) {
      record.historyError =
        error instanceof Error && error.message === "history_capacity"
          ? "history_capacity"
          : "history_unusable";
      throw new Error(record.historyError, { cause: error });
    }
  }
  private fence(
    record: RecordOwner,
    input: ParentAccess,
    runId: string,
    kind: string,
    requestId?: string,
  ): string {
    if (this.closing) throw new Error("not_available");
    const before = input.current();
    if (!before) throw new Error("not_available");
    if (record.authority.fence) {
      if (!record.authority.allows(before)) throw new Error("not_available");
      if (record.input) this.check(record);
    }
    const revision = record.meta.revision + 1;
    const fence = input.fence({
      agentId: record.meta.agentId,
      runId,
      kind,
      requestId,
      revision,
      nonce: randomUUID(),
    });
    const after = input.current();
    if (
      !fence ||
      !after ||
      before.sessionId !== after.sessionId ||
      !sameWorkspace(before.workspace, after.workspace) ||
      before.trustedProject !== after.trustedProject ||
      (before.anchor !== null && !after.branch.has(before.anchor)) ||
      !after.branch.has(fence)
    )
      throw new Error("not_available");
    record.authority.fence = fence;
    record.meta.revision = revision;
    return fence;
  }
  private projection(record: RecordOwner) {
    const { agentId, agent, state, runId, outcome, receipts } = record.meta;
    return {
      agentId,
      agent,
      generation: this.pool.generation,
      historyLifetime: "generation" as const,
      state,
      runId,
      outcome,
      receipts: receipts.map(({ digest: _digest, fence: _fence, ...receipt }) => receipt),
    };
  }
  inspect(input: ParentAccess, agentId?: string) {
    if (this.closing) return reject("unavailable");
    this.prune();
    const caller = input.current();
    if (!caller) return reject("not_available");
    if (agentId !== undefined) {
      const record = this.agents.get(agentId);
      return record && record.authority.allows(caller) && record.meta.state !== "closed"
        ? this.projection(record)
        : reject("not_available");
    }
    return {
      generation: this.pool.generation,
      historyLifetime: "generation" as const,
      agents: [...this.agents.values()]
        .filter((record) => record.authority.allows(caller) && record.meta.state !== "closed")
        .map((record) => this.projection(record)),
    };
  }
  private reserve(
    record: RecordOwner,
    request?: Pick<Receipt, "requestId" | "digest">,
  ): () => void {
    let resolveDone!: () => void;
    const admission = {
      request,
      done: new Promise<void>((resolve) => {
        resolveDone = resolve;
      }),
    };
    record.admission = admission;
    return () => {
      // Delivery can finish after another caller reserves the lane.
      if (record.admission === admission) record.admission = undefined;
      resolveDone();
    };
  }
  async spawn(
    input: ParentAccess,
    agent: string,
    task: string,
    signal?: AbortSignal,
    progress?: (value: RunProgress & { agentId: string; state: State }) => void | Promise<void>,
    onRevokedSettlement?: () => void,
  ) {
    if (this.closing) return reject("unavailable");
    if (signal?.aborted) return reject("not_accepting");
    let record: RecordOwner;
    let release!: () => void;
    try {
      this.prune();
      const current = input.current();
      if (!current) return reject("not_available");
      if (
        [...this.agents.values()].filter((item) => item.meta.state !== "closed").length >=
        LIMITS.retainedAgents
      )
        return reject("agent_capacity");
      const agentId = randomUUID();
      record = {
        meta: {
          agentId,
          agent,
          cwd: current.cwd,
          state: "active",
          revision: 0,
          receipts: [],
        },
        authority: new AgentAuthority(current),
        pending: new Map(),
      };
      this.agents.set(agentId, record);
      release = this.reserve(record);
    } catch (error) {
      release?.();
      return reject(error instanceof Error ? error.message : "unavailable");
    }
    return this.start(
      record,
      input,
      task,
      release,
      undefined,
      signal,
      progress,
      onRevokedSettlement,
    );
  }
  private async start(
    record: RecordOwner,
    foregroundInput: ParentAccess,
    task: string,
    release: () => void,
    requestId?: string,
    signal?: AbortSignal,
    progress?: (value: RunProgress & { agentId: string; state: State }) => void | Promise<void>,
    onRevokedSettlement?: () => void,
  ) {
    let committed = false;
    let ownsInput = false;
    try {
      const initial = record.meta.revision === 0;
      const previous = structuredClone(record.meta);
      const previousFence = record.authority.fence;
      record.input = foregroundInput;
      ownsInput = true;
      const current = foregroundInput.current();
      if (!current) {
        if (initial) this.agents.delete(record.meta.agentId);
        return reject("not_available");
      }
      const submitted = this.pool.submit(
        { sessionId: current.sessionId, anchor: current.anchor },
        async (control) => {
          try {
            record.history ??= SessionManager.inMemory(record.meta.cwd, {
              id: record.meta.agentId,
            });
          } catch {
            record.historyError = "history_unusable";
            return { outcome: "failed", text: "", error: record.historyError };
          }
          return this.invoke(foregroundInput, { task, agent: record.meta.agent }, control, {
            requestId,
            history: record.history,
            checkHistory: () => this.checkHistory(record),
            onReady: (ingress) => {
              record.ingress = ingress;
            },
            delivery: (id, state) => this.delivery(record, id, state),
          });
        },
        signal,
        (value) => {
          if (value.phase === "blocked") record.meta.state = "blocked";
          if (record.authority.allows(record.input?.current()))
            return progress?.({
              ...value,
              agentId: record.meta.agentId,
              state: record.meta.state,
            });
        },
        { agent: record.meta.agent, agentId: record.meta.agentId },
        {
          authorize: record.authority.allows.bind(record.authority),
          check: () => this.check(record),
          checkFast: () => this.checkFast(record),
          commit: ({ runId, stop }) => {
            record.stop = stop;
            try {
              signal?.throwIfAborted();
              const fence = this.fence(
                record,
                foregroundInput,
                runId,
                initial ? "spawn" : "followup",
                requestId,
              );
              record.meta.runId = runId;
              record.meta.state = "active";
              if (requestId)
                record.meta.receipts.push({
                  requestId,
                  digest: hash(task),
                  runId,
                  fence,
                  state: "admitted",
                });
              committed = true;
              ownsInput = false;
              this.check(record);
            } catch (error) {
              if (!committed) {
                if (initial) this.agents.delete(record.meta.agentId);
                else {
                  record.meta = previous;
                  record.authority.fence = previousFence;
                }
                // Clear only this failed owner before another admission can reserve the lane.
                record.stop = undefined;
                if (ownsInput) {
                  record.input = undefined;
                  ownsInput = false;
                }
              }
              throw error;
            } finally {
              release();
            }
          },
          // A later reservation can own the record before this uncommitted run settles.
          afterSafe: async (settlement) =>
            committed ? this.finalize(record, settlement, initial) : settlement,
        },
      );
      if ("rejection" in submitted) {
        if (initial) this.agents.delete(record.meta.agentId);
        return submitted;
      }
      const result = await submitted.result;
      if (submitted.admissionFailure) {
        const { error } = submitted.admissionFailure;
        return reject(error instanceof Error ? error.message : "unavailable");
      }
      // Unavailable authority denies disclosure without discarding safely settled usage.
      if (!record.authority.allows(foregroundInput.current())) {
        if (committed && result.phase === "terminal" && result.cleanup === "safe") {
          try {
            onRevokedSettlement?.();
          } catch {
            // Display failure cannot discard safely settled usage.
          }
        }
        return {
          ...reject("not_available"),
          usage: result.usage,
        };
      }
      return {
        ...result,
        historyLifetime: "generation" as const,
        agentId: record.meta.agentId,
        requestId,
        state: record.meta.state,
      };
    } finally {
      if (ownsInput) {
        record.input = undefined;
        ownsInput = false;
      }
      release();
    }
  }

  /** Pool has already established resource safety; this finishes only the committed logical run. */
  private async finalize(
    record: RecordOwner,
    settlement: Settlement,
    initial: boolean,
  ): Promise<Settlement> {
    record.ingress = undefined;
    record.stop = undefined;
    const admission = record.admission;
    if (admission) await admission.done;
    record.input = undefined;
    let result = settlement;
    try {
      this.checkHistory(record);
      const admitted = record.history
        ?.getEntries()
        .some((entry) => entry.type === "message" && entry.message.role === "user");
      if (initial && !admitted) this.remove(record);
      else record.meta.state = "idle";
    } catch {
      record.meta.state = "history_unusable";
      result = {
        ...settlement,
        outcome: "failed",
        text: "",
        error: record.historyError ?? "history_unusable",
      };
    }
    record.meta.outcome = result.outcome;
    for (const receipt of record.meta.receipts)
      if (receipt.runId === record.meta.runId && receipt.state !== "terminal") {
        receipt.delivery = receipt.state === "queued" ? "discarded" : receipt.state;
        receipt.state = "terminal";
        receipt.outcome = result.outcome;
      }
    record.pending.clear();
    return result;
  }
  private delivery(record: RecordOwner, requestId: string, state: FollowupDelivery): void {
    const receipt = record.meta.receipts.find(
      (item) => item.requestId === requestId && item.runId === record.meta.runId,
    );
    if (!receipt || receipt.state === "terminal") return;
    if (receipt.state !== "injected_not_confirmed") receipt.state = state;
    if (state !== "queued") record.pending.delete(requestId);
  }
  async followup(
    input: ParentAccess,
    value: unknown,
    signal?: AbortSignal,
    progress?: (value: RunProgress & { agentId: string; state: State }) => void | Promise<void>,
    onRevokedSettlement?: () => void,
  ) {
    if (
      !Check(followupParameters, value) ||
      !value.requestId.trim() ||
      Buffer.byteLength(value.requestId) > LIMITS.messageBytes ||
      !value.message.trim() ||
      Buffer.byteLength(value.message) > LIMITS.taskBytes ||
      Buffer.from(value.message).toString("utf8") !== value.message
    )
      return reject("invalid_input");
    if (this.closing) return reject("unavailable");
    this.prune();
    const record = this.agents.get(value.agentId);
    if (!record || !record.authority.allows(input.current()) || record.meta.state === "closed")
      return reject("not_available");
    const prior = () => record.meta.receipts.find((item) => item.requestId === value.requestId);
    const admission = record.admission;
    if (admission) {
      const digest =
        prior()?.digest ??
        (admission.request?.requestId === value.requestId ? admission.request.digest : undefined);
      if (digest !== hash(value.message))
        return reject(digest ? "request_conflict" : "not_accepting");
      await admission.done;
      if (!record.authority.allows(input.current())) return reject("not_available");
      if (!prior()) return reject("not_accepting");
    }
    const receipt = prior();
    if (receipt)
      return receipt.digest === hash(value.message)
        ? {
            agentId: value.agentId,
            generation: this.pool.generation,
            historyLifetime: "generation" as const,
            ...this.projection(record).receipts.find((item) => item.requestId === value.requestId)!,
          }
        : reject("request_conflict");
    if (record.meta.state === "history_unusable") return reject("history_unusable");
    if (record.meta.receipts.length >= LIMITS.followupReceipts) return reject("request_capacity");
    if (signal?.aborted || record.meta.state === "blocked") return reject("not_accepting");
    const release = this.reserve(record, {
      requestId: value.requestId,
      digest: hash(value.message),
    });
    if (record.meta.state === "idle")
      return this.start(
        record,
        input,
        value.message,
        release,
        value.requestId,
        signal,
        progress,
        onRevokedSettlement,
      );
    const ingress = record.ingress;
    try {
      if (!ingress?.accepting()) return reject("not_accepting");
      const bytes = Buffer.byteLength(value.message);
      if (
        record.pending.size >= LIMITS.pendingMessages ||
        [...record.pending.values()].reduce((sum, size) => sum + size, 0) + bytes >
          LIMITS.pendingFollowupBytes
      )
        return reject("request_capacity");
      let valid = false;
      try {
        valid = await ingress.validate();
      } catch {
        /* Current preparation may revoke access. */
      }
      if (!ingress.accepting()) return reject("not_accepting");
      if (!valid) return reject("configuration_changed");
      if (signal?.aborted || !ingress.accepting()) return reject("not_accepting");
      this.check(record);
      const runId = record.meta.runId!;
      const fence = this.fence(record, input, runId, "followup", value.requestId);
      this.check(record);
      if (!record.authority.allows(input.current())) return reject("not_available");
      record.meta.receipts.push({
        requestId: value.requestId,
        digest: hash(value.message),
        runId,
        fence,
        state: "queued",
      });
      record.pending.set(value.requestId, bytes);
      const delivery = ingress.steer(value.requestId, value.message);
      release();
      const state = await delivery;
      this.delivery(record, value.requestId, state);
      if (!record.authority.allows(input.current())) return reject("not_available");
      return {
        agentId: value.agentId,
        requestId: value.requestId,
        runId,
        state,
        generation: this.pool.generation,
        historyLifetime: "generation" as const,
      };
    } catch (error) {
      return reject(error instanceof Error ? error.message : "not_accepting");
    } finally {
      release();
    }
  }
  message(input: ParentAccess, value: unknown, signal?: AbortSignal) {
    if (this.closing) return reject("unavailable");
    const caller = input.current();
    if (!caller) return reject("not_available");
    const runId = value && typeof value === "object" && "runId" in value ? value.runId : undefined;
    const record = [...this.agents.values()].find((item) => item.meta.runId === runId);
    if (!record) return this.pool.sendMessage(caller, value, signal);
    if (!record.authority.allows(caller)) return reject("not_available");
    let release: (() => void) | undefined;
    try {
      return this.pool.sendMessage(caller, value, signal, (messageId) => {
        if (record.admission) return false;
        release = this.reserve(record);
        this.fence(record, input, record.meta.runId!, "supplemental", messageId);
        this.check(record);
      });
    } catch {
      return reject("not_available");
    } finally {
      release?.();
    }
  }
  private remove(record: RecordOwner): void {
    record.meta.state = "closed";
    record.meta.closedAt = Date.now();
    record.input = undefined;
    record.history = undefined;
    record.historyBytes = undefined;
    record.historyEntries = undefined;
    record.meta.receipts = [];
    record.pending.clear();
  }
  close(input: ParentAccess, agentId: string) {
    if (this.closing) return reject("unavailable");
    this.prune();
    const record = this.agents.get(agentId);
    if (!record || !record.authority.allows(input.current())) return reject("not_available");
    if (record.admission || !["idle", "history_unusable", "closed"].includes(record.meta.state))
      return reject("not_idle");
    if (record.meta.state !== "closed") this.remove(record);
    return { agentId, state: "closed", deleted: true };
  }
  private prune(): void {
    const now = Date.now();
    const tombstones = [...this.agents.values()]
      .filter((record) => record.meta.state === "closed" && !record.admission)
      .sort((a, b) => a.meta.closedAt! - b.meta.closedAt!);
    for (const [index, record] of tombstones.entries())
      if (
        record.meta.closedAt! + LIMITS.retentionMs <= now ||
        index < tombstones.length - LIMITS.retained
      )
        this.agents.delete(record.meta.agentId);
  }
  revoke(): void {
    for (const record of this.agents.values())
      if (record.stop && !record.authority.allows(record.input?.current()))
        record.stop("authority_revoked");
  }
  async drain(): Promise<void> {
    this.closing = true;
    for (const record of this.agents.values()) record.stop?.("shutdown");
    await Promise.all(
      [...this.agents.values()].flatMap((record) =>
        record.admission ? [record.admission.done] : [],
      ),
    );
    await this.pool.drain();
    this.agents.clear();
  }
}
