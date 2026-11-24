import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { RunnerPool, type RunControl, type Settlement } from "../src/runner-pool/index.ts";
import { LIMITS } from "../src/runtime/limits.ts";

const origin = { sessionId: "parent", anchor: "submission" };
const caller = { sessionId: "parent", branch: new Set(["submission"]) };

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const success: Settlement = { outcome: "succeeded", text: "private research" };

function admitted(value: ReturnType<RunnerPool["submit"]>) {
  if ("rejection" in value) throw new Error(`Unexpected rejection: ${value.rejection}`);
  return value;
}

test("same-agent runs do not couple cancellation or grant name-based control", async (t) => {
  const pool = new RunnerPool();
  const release = gate<void>();
  t.after(() => release.resolve());
  const identity = { agent: "reviewer" };
  const effects: number[] = [];
  const runs = [0, 1].map((index) =>
    admitted(
      pool.submit(
        origin,
        async (control) => {
          control.running();
          await release.promise;
          if (!control.signal.aborted) effects.push(index);
          return { outcome: control.signal.aborted ? "cancelled" : "succeeded", text: "Done" };
        },
        undefined,
        undefined,
        identity,
      ),
    ),
  );
  await Promise.resolve();
  pool.cancel(caller, identity.agent);
  pool.cancel(caller, runs[0].runId);
  release.resolve();
  await Promise.all(runs.map((run) => run.result));
  assert.deepEqual(effects, [1], "only the run selected by UUID loses authority to continue");
  await pool.drain();
});

test("only the originating branch can enqueue or inspect active-run messages", async (t) => {
  const pool = new RunnerPool();
  const cleanup = gate<Settlement>();
  t.after(() => cleanup.resolve(success));
  let control!: RunControl;
  const run = admitted(
    pool.submit(origin, async (value) => {
      control = value;
      control.running();
      return cleanup.promise;
    }),
  );
  await Promise.resolve();
  const input = { runId: run.runId, messageId: "private-reference", message: "owner evidence" };
  pool.sendMessage({ ...caller, branch: new Set(["submission", "later-leaf"]) }, input);
  for (const foreign of [
    { sessionId: "other", branch: caller.branch },
    { sessionId: caller.sessionId, branch: new Set<string>() },
  ]) {
    pool.sendMessage(foreign, input);
    pool.sendMessage(foreign, { ...input, messageId: "foreign", message: "unauthorized data" });
    assert.equal(
      JSON.stringify(pool.inspect(foreign, run.runId)).includes(input.messageId),
      false,
      "foreign origins cannot learn accepted message identities",
    );
  }
  const consumed = control.takeMessages();
  assert.equal(
    consumed.some((message) => message.message === input.message),
    true,
  );
  assert.equal(
    consumed.some((message) => message.message === "unauthorized data"),
    false,
    "foreign origins cannot alter the child's next context",
  );
  cleanup.resolve(success);
  await run.result;
  await pool.drain();
});

test("closed runs cannot consume unread data or regain admission by retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const close of ["cancel", "deadline", "settle", "terminal", "drain", "reject"] as const) {
    const pool = new RunnerPool();
    const cleanup = gate<Settlement>();
    let control!: RunControl;
    const run = admitted(
      pool.submit(origin, async (value) => {
        control = value;
        control.running();
        const result = await cleanup.promise;
        if (close === "reject") throw new Error("Unconfirmed cleanup");
        return result;
      }),
    );
    await Promise.resolve();
    const input = { runId: run.runId, messageId: "unread", message: "unread data" };
    pool.sendMessage(caller, input);
    if (close === "cancel") pool.cancel(caller, run.runId);
    if (close === "deadline") t.mock.timers.tick(LIMITS.invocationMs);
    if (close === "settle") control.settling();
    if (close === "drain") void pool.drain();
    if (close === "terminal" || close === "reject") {
      cleanup.resolve(success);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    for (const messageId of [input.messageId, "new-after-close"])
      pool.sendMessage(caller, { ...input, messageId });
    assert.equal(control.takeMessages().length, 0, "closing ingress must prevent unread injection");
    const inspection = pool.inspect(caller, run.runId);
    if (!("inbox" in inspection)) throw new Error("Owner inbox unavailable");
    assert.equal(
      inspection.inbox.receipts.find((receipt) => receipt.messageId === input.messageId)?.state,
      "discarded",
      "accepted unread data must be accounted for, not silently lost",
    );
    cleanup.resolve(success);
    if (close !== "reject") {
      await run.result;
      await pool.drain();
    }
  }
});

test("configured capacity retains settling owners until resources are released", async (t) => {
  const capacity = LIMITS.runs + 2;
  const pool = new RunnerPool(capacity);
  const cleanups = Array.from({ length: capacity }, () => gate<Settlement>());
  t.after(() => cleanups.forEach((cleanup) => cleanup.resolve(success)));
  const runs = cleanups.map((cleanup) =>
    admitted(
      pool.submit(origin, async (control) => {
        control.settling();
        control.diagnostics({ stage: "operations" });
        control.diagnostics({ pendingTools: 0, pendingTransports: 0 });
        return cleanup.promise;
      }),
    ),
  );
  await Promise.resolve();
  let forbiddenWork = false;
  pool.submit(origin, async () => {
    forbiddenWork = true;
    return success;
  });
  await Promise.resolve();
  assert.equal(forbiddenWork, false, "cleanup is still owned; replacement work must not start");
  cleanups[0].resolve(success);
  await runs[0].result;
  const replacementCleanup = gate<Settlement>();
  t.after(() => replacementCleanup.resolve(success));
  let replacements = 0;
  const submit = () =>
    pool.submit(origin, async () => {
      replacements++;
      return replacementCleanup.promise;
    });
  const contenders = [submit(), submit()];
  await Promise.resolve();
  assert.equal(replacements, 1, "one safe release permits only one new owner");
  pool.cancel(caller, runs[0].runId);
  pool.submit(origin, async () => {
    forbiddenWork = true;
    return success;
  });
  await Promise.resolve();
  assert.equal(forbiddenWork, false, "cancelling a terminal run cannot release its slot twice");
  cleanups.slice(1).forEach((cleanup) => cleanup.resolve(success));
  replacementCleanup.resolve(success);
  await Promise.all(contenders.flatMap((run) => ("result" in run ? [run.result] : [])));
  await pool.drain();
});

test("foreign sessions and branches cannot read or cancel owned work", async () => {
  const pool = new RunnerPool();
  const cleanup = gate<Settlement>();
  let control!: RunControl;
  const run = admitted(
    pool.submit(
      origin,
      async (value) => {
        control = value;
        control.partial({ type: "replace", text: success.text });
        control.observation({
          selection: {
            model: "private-provider/private-model",
            modelSource: "agent",
            thinkingLevel: "off",
            thinkingSource: "parent",
          },
        });
        return cleanup.promise;
      },
      undefined,
      undefined,
      { agent: "private-agent-name" },
    ),
  );
  await Promise.resolve();
  assert.equal(
    JSON.stringify(pool.inspectActivity(caller)).includes(success.text),
    true,
    "the originating owner can observe its live response",
  );
  assert.equal(
    JSON.stringify(pool.inspect(caller, run.runId)).includes("private-provider/private-model"),
    true,
    "the owner can read the same selection withheld from foreign origins",
  );
  for (const foreign of [
    { sessionId: "other", branch: caller.branch },
    { sessionId: caller.sessionId, branch: new Set<string>() },
  ]) {
    assert.equal(
      JSON.stringify(pool.inspect(foreign, run.runId)).includes("private-provider/private-model"),
      false,
      "a foreign origin cannot read the live model selection",
    );
    assert.equal(JSON.stringify(pool.inspectActivity(foreign)).includes(success.text), false);
    assert.equal(
      JSON.stringify(pool.inspect(foreign, run.runId)).includes("private-agent-name"),
      false,
    );
    pool.cancel(foreign, run.runId);
    assert.equal(
      control.signal.aborted,
      false,
      "an unauthorized cancel must not affect owned work",
    );
  }
  cleanup.resolve(success);
  await run.result;
  for (const foreign of [
    { sessionId: "other", branch: caller.branch },
    { sessionId: caller.sessionId, branch: new Set<string>() },
  ]) {
    const visible = JSON.stringify(pool.inspect(foreign, run.runId));
    assert.equal(visible.includes(success.text), false);
    assert.equal(JSON.stringify(pool.inspectActivity(foreign)).includes(success.text), false);
    assert.equal(visible.includes("private-agent-name"), false);
    assert.equal(visible.includes("private-provider/private-model"), false);
  }
  assert.equal(JSON.stringify(pool.inspect(caller, run.runId)).includes(success.text), true);
  await pool.drain();
});

test("blocked cancellation retains its slot without blocking spare capacity or releasing shutdown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pool = new RunnerPool();
  const cleanup = gate<Settlement>();
  t.after(() => cleanup.resolve(success));
  const run = admitted(pool.submit(origin, async () => cleanup.promise));
  let completed = false;
  void run.result.then(() => {
    completed = true;
  });
  await Promise.resolve();
  pool.cancel(caller, run.runId);
  t.mock.timers.tick(LIMITS.graceMs);
  await Promise.resolve();
  assert.equal(completed, false, "blocked progress cannot finalize foreground accounting");

  const independent = admitted(pool.submit(origin, async () => success));
  assert.equal((await independent.result).outcome, "succeeded", "spare capacity remains usable");
  const siblings = Array.from({ length: LIMITS.runs - 1 }, () =>
    admitted(pool.submit(origin, async () => cleanup.promise)),
  );
  await Promise.resolve();
  let forbiddenWork = false;
  pool.submit(origin, async () => {
    forbiddenWork = true;
    return success;
  });
  await Promise.resolve();
  assert.equal(forbiddenWork, false, "the blocked owner still occupies its slot");

  let drained = false;
  const draining = pool.drain().then(() => {
    drained = true;
  });
  pool.submit(origin, async () => {
    forbiddenWork = true;
    return success;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(forbiddenWork, false, "shutdown cannot admit new work");
  assert.equal(drained, false, "a timeout is not evidence of quiescence");
  cleanup.resolve({ outcome: "cancelled", text: "" });
  await Promise.all([run, ...siblings].map((owned) => owned.result));
  await draining;
  assert.equal(completed, true);
  assert.equal(drained, true);
});

test("late safe completion restores its occupied slot without a force reset", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pool = new RunnerPool();
  const cleanups = Array.from({ length: LIMITS.runs }, () => gate<Settlement>());
  t.after(() => cleanups.forEach((cleanup) => cleanup.resolve(success)));
  const runs = cleanups.map((cleanup) =>
    admitted(pool.submit(origin, async () => cleanup.promise)),
  );
  await Promise.resolve();
  pool.cancel(caller, runs[0].runId);
  t.mock.timers.tick(LIMITS.graceMs);
  cleanups[0].resolve({ outcome: "cancelled", text: "" });
  await runs[0].result;
  const next = admitted(pool.submit(origin, async () => success));
  assert.equal((await next.result).outcome, "succeeded");
  cleanups.slice(1).forEach((cleanup) => cleanup.resolve(success));
  await pool.drain();
});

test("cancellation before executor dispatch prevents preparation effects", async () => {
  for (const cancelledAt of ["initial", "submitted", "progress"]) {
    const pool = new RunnerPool();
    const abort = new AbortController();
    if (cancelledAt === "initial") abort.abort();
    let forbiddenWork = false;
    const run = admitted(
      pool.submit(
        origin,
        async () => {
          forbiddenWork = true;
          return success;
        },
        abort.signal,
        cancelledAt === "progress"
          ? (progress) => {
              pool.cancel(caller, progress.runId);
            }
          : undefined,
      ),
    );
    if (cancelledAt === "submitted") abort.abort();
    const result = await run.result;
    assert.equal(forbiddenWork, false, "cancelled admission cannot start preparation");
    assert.equal(result.outcome, "cancelled");
    await pool.drain();
  }
});

test("committed progress cancellation, revocation and expiry prevent execution effects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const effect = join(root, "effect");
  await writeFile(effect, "unchanged");
  let now = performance.now();
  t.mock.method(performance, "now", () => now);
  for (const stop of ["cancel", "revoke", "expiry", "failed_commit"] as const) {
    const pool = new RunnerPool();
    let authorized = true;
    const run = admitted(
      pool.submit(
        origin,
        async () => {
          await writeFile(effect, "changed by unapproved execution");
          return success;
        },
        undefined,
        (progress) => {
          if (progress.phase !== "preparing") return;
          if (stop === "cancel") pool.cancel(caller, progress.runId);
          if (stop === "revoke") authorized = false;
          if (stop === "expiry") now += LIMITS.startupMs;
        },
        undefined,
        {
          commit() {
            if (stop === "failed_commit") throw new Error("Commit failed");
          },
          authorize: () => authorized,
          check() {
            if (!authorized) throw new Error("Authority revoked");
          },
          afterSafe: async (settlement) => settlement,
        },
      ),
    );
    await run.result;
    assert.equal(await readFile(effect, "utf8"), "unchanged");
    await pool.drain();
  }
});

test("running progress cancellation prevents execution effects after preparation", async () => {
  const pool = new RunnerPool();
  let forbiddenWork = false;
  const run = admitted(
    pool.submit(
      origin,
      async (control) => {
        try {
          control.running();
          forbiddenWork = true;
          return success;
        } catch {
          control.settling();
          return { outcome: "cancelled", text: "" };
        }
      },
      undefined,
      (progress) => {
        if (progress.phase === "running") pool.cancel(caller, progress.runId);
      },
    ),
  );
  await run.result;
  assert.equal(
    forbiddenWork,
    false,
    "progress cancellation cannot allow the next execution effect",
  );
  await pool.drain();
});

test("progress failures and pending delivery cannot change cleanup ownership", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const publish of [
    () => {
      throw new Error("Progress delivery failed");
    },
    () => Promise.reject(new Error("Progress delivery failed")),
    () => gate<void>().promise,
  ]) {
    const pool = new RunnerPool();
    const cleanup = gate<Settlement>();
    const run = admitted(pool.submit(origin, async () => cleanup.promise, undefined, publish));
    let completed = false;
    void run.result.then(() => {
      completed = true;
    });
    await Promise.resolve();
    pool.cancel(caller, run.runId);
    t.mock.timers.tick(LIMITS.graceMs);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(completed, false, "UI delivery is not evidence of resource safety");
    cleanup.resolve(success);
    const result = await run.result;
    assert.equal(result.outcome, success.outcome, "UI delivery cannot rewrite execution");
    await pool.drain();
  }
});

test("admission deadlines stop new effects even before timer callbacks run", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = performance.now();
  t.mock.method(performance, "now", () => now);
  for (const stage of ["preparing", "running"] as const) {
    const pool = new RunnerPool();
    const proceed = gate<void>();
    let forbiddenWork = false;
    const run = admitted(
      pool.submit(origin, async (control) => {
        if (stage === "running") control.running();
        await proceed.promise;
        now = stage === "preparing" ? control.startupDeadline : control.deadline;
        try {
          if (stage === "preparing") control.running();
          else {
            control.check();
            control.safeguardSignal.throwIfAborted();
          }
          forbiddenWork = true;
          return success;
        } catch {
          control.settling();
          return { outcome: "failed", text: "" };
        }
      }),
    );
    await Promise.resolve();
    proceed.resolve();
    await run.result;
    assert.equal(forbiddenWork, false, "expired ownership cannot authorize another effect");
    await pool.drain();
  }
});

test("time spent revalidating authority cannot admit an effect after expiry", async (t) => {
  let now = performance.now();
  t.mock.method(performance, "now", () => now);
  const pool = new RunnerPool();
  let deadline: number | undefined;
  let forbiddenEffect = false;
  const run = admitted(
    pool.submit(
      origin,
      async (control) => {
        control.running();
        deadline = control.deadline;
        try {
          control.check();
          control.safeguardSignal.throwIfAborted();
          forbiddenEffect = true;
        } catch {
          // Expiry during a synchronous authority check must still close ordinary work.
        }
        control.settling();
        return { outcome: "failed", text: "" };
      },
      undefined,
      undefined,
      undefined,
      {
        authorize: () => true,
        check: () => {
          if (deadline !== undefined) now = deadline;
        },
        commit: () => undefined,
        afterSafe: async (value) => value,
      },
    ),
  );
  await run.result;
  assert.equal(forbiddenEffect, false, "an expired authorization check cannot grant a new effect");
  await pool.drain();
});

test("startup ends at running or settling without renewing invocation or stop grace", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const stage of ["running", "settling"] as const) {
    const pool = new RunnerPool();
    const cleanup = gate<Settlement>();
    let control!: RunControl;
    const run = admitted(
      pool.submit(origin, async (value) => {
        control = value;
        control[stage]();
        return cleanup.promise;
      }),
    );
    await Promise.resolve();
    t.mock.timers.tick(LIMITS.startupMs);
    assert.equal(
      control.signal.aborted,
      false,
      "completed preparation cannot expire during execution",
    );
    if (stage === "running") control.running();
    t.mock.timers.tick(LIMITS.invocationMs - LIMITS.startupMs);
    if (stage === "running") {
      assert.equal(control.safeguardSignal.aborted, true, "execution must close normal work");
      t.mock.timers.tick(LIMITS.safeguardFinishMs + LIMITS.safeguardSummaryMs);
    }
    assert.equal(control.signal.aborted, true, "bounded finishing cannot renew ownership");
    const firstStop = control.signal.reason;
    t.mock.timers.tick(LIMITS.graceMs / 2);
    pool.cancel(caller, run.runId);
    control.stop("limit_exceeded: later");
    assert.equal(control.signal.reason, firstStop, "the first stop wins across stages");
    t.mock.timers.tick(LIMITS.graceMs / 2);
    const blocked = pool.inspect(caller, run.runId);
    assert.ok("phase" in blocked && blocked.phase === "blocked");
    cleanup.resolve(success);
    const result = await run.result;
    assert.equal(result.outcome, success.outcome, "cleanup stop cannot replace executor outcome");
    await pool.drain();
  }
});

test("startup expiry retains ownership until preparation has safely stopped", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pool = new RunnerPool();
  const cleanup = gate<Settlement>();
  let control!: RunControl;
  const run = admitted(
    pool.submit(origin, async (value) => {
      control = value;
      return cleanup.promise;
    }),
  );
  let completed = false;
  void run.result.then(() => {
    completed = true;
  });
  await Promise.resolve();
  t.mock.timers.tick(LIMITS.startupMs);
  assert.throws(() => control.check(), "expired preparation cannot authorize dispatch");
  const firstStop = control.signal.reason;
  t.mock.timers.tick(LIMITS.invocationMs);
  pool.cancel(caller, run.runId);
  assert.equal(
    control.signal.reason,
    firstStop,
    "invocation and cancellation cannot replace startup stop",
  );
  await Promise.resolve();
  assert.equal(completed, false, "a preparation deadline does not prove resource safety");
  cleanup.resolve({ outcome: "failed", text: "" });
  await run.result;
  await pool.drain();
});

for (const arrival of ["executor", "finalization"] as const) {
  test(`known unsafe cleanup during ${arrival} cannot release ownership`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pool = new RunnerPool(1);
    let control!: RunControl;
    pool.submit(
      origin,
      async (value) => {
        control = value;
        if (arrival === "executor") control.observation({ cleanupUnsafe: true });
        return success;
      },
      undefined,
      undefined,
      undefined,
      {
        authorize: () => true,
        check() {},
        commit: () => undefined,
        afterSafe: async (settlement) => {
          if (arrival === "finalization")
            queueMicrotask(() =>
              queueMicrotask(() => control.observation({ cleanupUnsafe: true })),
            );
          return settlement;
        },
      },
    );
    await nextTurn();
    let forbiddenEffect = false;
    pool.submit(origin, async () => {
      forbiddenEffect = true;
      return success;
    });
    await nextTurn();
    assert.equal(
      forbiddenEffect,
      false,
      "known unsafe ownership cannot authorize replacement work",
    );
  });
}

test("unexpected executor rejection cannot complete or release unresolved ownership", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pool = new RunnerPool();
  const run = admitted(
    pool.submit(origin, () => {
      throw new Error("Unconfirmed cleanup");
    }),
  );
  let completed = false;
  void run.result.then(() => {
    completed = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(LIMITS.invocationMs + LIMITS.retentionMs);
  const independent = admitted(pool.submit(origin, async () => success));
  assert.equal((await independent.result).outcome, "succeeded");
  const cleanup = gate<Settlement>();
  const siblings = Array.from({ length: LIMITS.runs - 1 }, () =>
    admitted(pool.submit(origin, async () => cleanup.promise)),
  );
  await Promise.resolve();
  let forbiddenWork = false;
  pool.submit(origin, async () => {
    forbiddenWork = true;
    return success;
  });
  await Promise.resolve();
  assert.equal(forbiddenWork, false, "elapsed limits cannot free the rejected owner's slot");
  cleanup.resolve(success);
  await Promise.all(siblings.map((owned) => owned.result));
  let drained = false;
  void pool.drain().then(() => {
    drained = true;
  });
  pool.submit(origin, async () => {
    forbiddenWork = true;
    return success;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(forbiddenWork, false, "shutdown rejects work even with spare slots");
  assert.equal(completed, false);
  assert.equal(drained, false);
});

test("hostile executor rejection formatting cannot escape containment", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pool = new RunnerPool();
  const hostile = {
    [Symbol.toPrimitive]() {
      throw new Error("format trap");
    },
  };
  const run = admitted(pool.submit(origin, async () => Promise.reject(hostile)));

  await new Promise<void>((resolve) => setImmediate(resolve));
  const view = pool.inspect(caller, run.runId);
  assert(!("rejection" in view));
  assert("phase" in view);
  assert.equal(view.phase, "blocked");
  assert.equal(view.diagnostics.executor, "rejected");
  assert.equal(view.error, "Execution failed with a non-displayable error.");
});

test("a changing error message cannot prevent cancellation after executor failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pool = new RunnerPool();
  let reads = 0;
  const error = new Error();
  Object.defineProperty(error, "message", {
    get() {
      return ++reads < 3 ? "Executor failed" : 42;
    },
  });
  let signal: AbortSignal | undefined;
  admitted(
    pool.submit(origin, async (control) => {
      signal = control.signal;
      throw error;
    }),
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(signal?.aborted, true, "executor failure must cancel its owned work");
});

test("pool pushes progress for model selection, active tools, queued slots, stopping and cleanup stages", async () => {
  const activityNotifications: number[] = [];
  const pool = new RunnerPool(undefined, undefined, () => {
    activityNotifications.push(activityNotifications.length + 1);
  });
  const updates: Array<{
    phase: string;
    model?: string;
    stage: string;
    queuedTools?: number;
    activeToolNames?: string[];
  }> = [];
  const run = admitted(
    pool.submit(
      origin,
      async (control) => {
        control.observation({
          selection: {
            model: "anthropic/claude-sonnet-4-5",
            modelSource: "agent",
            thinkingLevel: "off",
            thinkingSource: "parent",
          },
        });
        control.running();
        control.activity({ type: "started", id: "t1", name: "read" });
        // Same-name concurrent tool should not push a duplicate progress event.
        control.activity({ type: "started", id: "t2", name: "read" });
        control.activity({ type: "started", id: "t3", name: "grep" });
        control.diagnostics({
          pendingTools: 3,
          pendingTransports: 0,
          activeTools: 2,
          queuedTools: 1,
        });
        // Active tool changes while queued should not spam progress while tool-slot wait dominates.
        control.activity({ type: "returned", id: "t3", name: "grep" });
        control.diagnostics({
          pendingTools: 2,
          pendingTransports: 0,
          activeTools: 2,
          queuedTools: 0,
        });
        control.activity({ type: "returned", id: "t1", name: "read" });
        control.activity({ type: "returned", id: "t2", name: "read" });
        control.stop("cancelled");
        control.diagnostics({ stage: "abort" });
        control.settling();
        control.diagnostics({ stage: "operations" });
        control.diagnostics({ stage: "mcp_close" });
        control.diagnostics({ stage: "finished" });
        return { outcome: "cancelled", text: "" };
      },
      undefined,
      (progress) => {
        updates.push({
          phase: progress.phase,
          model: progress.model,
          stage: progress.diagnostics.stage,
          queuedTools: progress.diagnostics.queuedTools,
          activeToolNames: progress.diagnostics.activeToolNames,
        });
      },
      { agent: "reviewer" },
    ),
  );
  const settled = await run.result;
  assert.equal(settled.model, "anthropic/claude-sonnet-4-5");
  assert.equal(settled.diagnostics.activeToolNames, undefined);
  assert.deepEqual(updates, [
    {
      phase: "preparing",
      model: undefined,
      stage: "admitted",
      queuedTools: 0,
      activeToolNames: undefined,
    },
    {
      phase: "preparing",
      model: "anthropic/claude-sonnet-4-5",
      stage: "admitted",
      queuedTools: 0,
      activeToolNames: undefined,
    },
    {
      phase: "running",
      model: "anthropic/claude-sonnet-4-5",
      stage: "admitted",
      queuedTools: 0,
      activeToolNames: undefined,
    },
    {
      phase: "running",
      model: "anthropic/claude-sonnet-4-5",
      stage: "admitted",
      queuedTools: 0,
      activeToolNames: ["read"],
    },
    {
      phase: "running",
      model: "anthropic/claude-sonnet-4-5",
      stage: "admitted",
      queuedTools: 0,
      activeToolNames: ["read", "grep"],
    },
    {
      phase: "running",
      model: "anthropic/claude-sonnet-4-5",
      stage: "admitted",
      queuedTools: 1,
      activeToolNames: ["read", "grep"],
    },
    {
      phase: "running",
      model: "anthropic/claude-sonnet-4-5",
      stage: "admitted",
      queuedTools: 0,
      activeToolNames: ["read"],
    },
    {
      phase: "running",
      model: "anthropic/claude-sonnet-4-5",
      stage: "admitted",
      queuedTools: 0,
      activeToolNames: undefined,
    },
    {
      phase: "cancelling",
      model: "anthropic/claude-sonnet-4-5",
      stage: "admitted",
      queuedTools: 0,
      activeToolNames: undefined,
    },
    {
      phase: "settling",
      model: "anthropic/claude-sonnet-4-5",
      stage: "abort",
      queuedTools: 0,
      activeToolNames: undefined,
    },
    {
      phase: "settling",
      model: "anthropic/claude-sonnet-4-5",
      stage: "operations",
      queuedTools: 0,
      activeToolNames: undefined,
    },
    {
      phase: "settling",
      model: "anthropic/claude-sonnet-4-5",
      stage: "mcp_close",
      queuedTools: 0,
      activeToolNames: undefined,
    },
  ]);
  assert(activityNotifications.length > 0, "pool must notify activity listeners on state changes");
  await pool.drain();
});
