import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResearchTools, ToolCleanupError } from "../src/runtime/research-tools.ts";
import { test } from "node:test";
import { Type } from "typebox";
import { defineTool, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Budget } from "../src/runner/budget.ts";
import { LIMITS, DEFAULT_EXECUTION_LIMITS } from "../src/runtime/limits.ts";

function controlledBudget(abort: AbortController, authorize: () => void = () => {}): Budget {
  const safeguard = new AbortController();
  return new Budget({
    executionLimits: DEFAULT_EXECUTION_LIMITS,
    remainingMs: () => DEFAULT_EXECUTION_LIMITS.invocationMs,
    signal: abort.signal,
    safeguardSignal: safeguard.signal,
    workSignal: abort.signal,
    safeguard: (reason) => safeguard.abort(reason),
    beginSummary: () => false,
    finishSummary() {},
    takeMessages: () => [],
    deadline: performance.now() + LIMITS.invocationMs,
    startupDeadline: performance.now() + LIMITS.startupMs,
    observation() {},
    check: () => {
      abort.signal.throwIfAborted();
      authorize();
    },
    stop: (reason) => abort.abort(reason),
    diagnostics() {},
    activity() {},
    running() {},
    settling() {},
    partial() {},
  });
}

test("cancelling a waiter preserves FIFO effects and releases its reservation", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-tool-batch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = join(root, "effects.txt");
  await fs.writeFile(file, "");
  const abort = new AbortController();
  const budget = controlledBudget(abort);
  const gates = Array.from({ length: LIMITS.toolConcurrency }, () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  });
  t.after(() => gates.forEach((gate) => gate.release()));
  const [commit] = budget.tools([
    defineTool({
      name: "commit",
      label: "Commit",
      description: "Commit one admitted effect",
      parameters: Type.Object({ record: Type.String() }),
      async execute(_id, { record }, signal) {
        if (record.startsWith("held-")) await gates[Number(record.slice(5))].promise;
        signal?.throwIfAborted();
        appendFileSync(file, `${record}\n`);
        return { content: [], details: undefined };
      },
    }),
  ]);
  const call = (record: string, signal?: AbortSignal) =>
    commit.execute(record, { record }, signal, undefined, {} as ExtensionToolContext);
  const active = gates.map((_, i) => call(`held-${i}`));
  const cancel = new AbortController();
  const waiting = [call("forbidden", cancel.signal), call("first"), call("second")];
  const results = Promise.allSettled([...active, ...waiting]);
  cancel.abort();
  gates[0].release();
  await active[0];
  await call("later");
  gates.forEach((gate) => gate.release());
  await results;
  await budget.drain();
  assert.deepEqual(
    (await fs.readFile(file, "utf8"))
      .trim()
      .split("\n")
      .filter((value) => !value.startsWith("held-")),
    ["first", "second", "later"],
    "a cancelled waiter must not commit or let a later writer overtake older work",
  );
});

for (const stop of ["cancel", "revoke"] as const) {
  test(`${stop} prevents queued effects without releasing uncooperative active work`, async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), "pi-tool-wait-stop-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const file = join(root, "effects.txt");
    await fs.writeFile(file, "");
    let permitted = true;
    const abort = new AbortController();
    const budget = controlledBudget(abort, () => {
      if (!permitted) throw new Error("Authority revoked");
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    const [commit] = budget.tools([
      defineTool({
        name: "commit",
        label: "Commit",
        description: "Commit an owned effect",
        parameters: Type.Object({ record: Type.String() }),
        async execute(_id, { record }) {
          if (record === "forbidden") appendFileSync(file, "forbidden\n");
          else {
            await held;
            appendFileSync(file, "owned-finished\n");
          }
          return { content: [], details: undefined };
        },
      }),
    ]);
    const active = Array.from({ length: LIMITS.toolConcurrency }, (_, i) =>
      commit.execute(
        String(i),
        { record: "owned" },
        undefined,
        undefined,
        {} as ExtensionToolContext,
      ),
    );
    const queued = commit.execute(
      "waiting",
      { record: "forbidden" },
      undefined,
      undefined,
      {} as ExtensionToolContext,
    );
    const all = Promise.allSettled([...active, queued]);
    if (stop === "cancel") abort.abort();
    else permitted = false;
    const drained = budget.drain().then(() => appendFileSync(file, "ownership-released\n"));
    await Promise.resolve();
    assert.equal(
      await fs.readFile(file, "utf8"),
      "",
      "owned work must finish before its barrier releases",
    );
    release();
    await all;
    await drained;
    assert.equal(
      await fs.readFile(file, "utf8"),
      "owned-finished\n".repeat(LIMITS.toolConcurrency) + "ownership-released\n",
      "queued work never acquires revoked authority, while existing effects finish before release",
    );
  });
}

test("queued cancellation returns unused effect allowance without admitting excess effects", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-tool-reservation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = join(root, "effects.txt");
  await fs.writeFile(file, "");
  const budget = controlledBudget(new AbortController());
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const [commit] = budget.tools([
    defineTool({
      name: "commit",
      label: "Commit",
      description: "Commit an admitted record",
      parameters: Type.Object({ record: Type.String() }),
      async execute(_id, { record }, signal) {
        await held;
        signal?.throwIfAborted();
        appendFileSync(file, `${record}\n`);
        return { content: [], details: undefined };
      },
    }),
  ]);
  const cancel = new AbortController();
  const records = Array.from({ length: LIMITS.toolCalls }, (_, i) => `owned-${i}`);
  const work = records.map((record, i) =>
    commit.execute(
      record,
      { record },
      i === records.length - 1 ? cancel.signal : undefined,
      undefined,
      {} as ExtensionToolContext,
    ),
  );
  const all = Promise.allSettled(work);
  cancel.abort();
  const replacement = commit.execute(
    "replacement",
    { record: "replacement" },
    undefined,
    undefined,
    {} as ExtensionToolContext,
  );
  release();
  await all;
  await replacement;
  await assert.rejects(
    commit.execute(
      "forbidden",
      { record: "forbidden" },
      undefined,
      undefined,
      {} as ExtensionToolContext,
    ),
  );
  await budget.drain();
  assert.deepEqual(
    (await fs.readFile(file, "utf8")).trim().split("\n").sort(),
    [...records.slice(0, -1), "replacement"].sort(),
    "a cancelled reservation consumes no effect and cannot increase the invocation allowance",
  );
});

for (const mode of [
  "direct",
  "individual codemode",
  "batched codemode",
  "failing nested tools",
] as const) {
  test(`${mode} preserves the full tool allowance and blocks excess effects`, async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), "pi-tool-allowance-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const file = join(root, "effects.txt");
    const budget = controlledBudget(new AbortController());
    const context = {} as ExtensionToolContext;
    const [commit] = budget.tools([
      defineTool({
        name: "commit",
        label: "Commit",
        description: "Commit an admitted record",
        parameters: Type.Object({ record: Type.String() }),
        async execute(_id, { record }) {
          await fs.appendFile(file, `${record}\n`);
          if (mode === "failing nested tools") throw new Error("Failed after committing effect");
          return { content: [], details: undefined };
        },
      }),
    ]);
    const [codemode] = budget.tools(
      [
        defineTool({
          name: "codemode",
          label: "Codemode",
          description: "Execute a sequence of individually admitted tools",
          parameters: Type.Object({ records: Type.Array(Type.String()) }),
          async execute(_id, { records }, signal) {
            for (const record of records) {
              try {
                await commit.execute(record, { record }, signal, undefined, context);
              } catch (error) {
                if (mode !== "failing nested tools") throw error;
              }
            }
            return { content: [], details: undefined };
          },
        }),
      ],
      true,
    );
    const records = Array.from({ length: LIMITS.toolCalls }, (_, index) => `record-${index}`);
    if (mode === "batched codemode" || mode === "failing nested tools") {
      await codemode.execute("batch", { records }, undefined, undefined, context);
    } else {
      for (const record of records) {
        if (mode === "direct")
          await commit.execute(record, { record }, undefined, undefined, context);
        else await codemode.execute(record, { records: [record] }, undefined, undefined, context);
      }
    }
    // A script that invokes no tools remains admissible at the tool allowance boundary.
    await codemode.execute("no-tools", { records: [] }, undefined, undefined, context);
    await assert.rejects(
      mode === "direct"
        ? commit.execute("excess", { record: "forbidden" }, undefined, undefined, context)
        : codemode.execute("excess", { records: ["forbidden"] }, undefined, undefined, context),
    );
    await budget.drain();
    assert.equal(await fs.readFile(file, "utf8"), `${records.join("\n")}\n`);
  });
}

test("repeated progress snapshots do not prevent an admitted operation from completing", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-tool-progress-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = join(root, "effect.txt");
  const abort = new AbortController();
  const budget = controlledBudget(abort);
  const snapshot = {
    content: [
      {
        type: "text" as const,
        text: "x".repeat(
          Math.floor(Math.min(LIMITS.toolBytes / 2, LIMITS.toolUpdateTrafficBytes / 3.5)),
        ),
      },
    ],
    details: undefined,
  };
  const [tool] = budget.tools([
    defineTool({
      name: "report_and_commit",
      label: "Commit",
      description: "Report progress before committing one result",
      parameters: Type.Object({}),
      async execute(_id, _args, _signal, onUpdate) {
        onUpdate?.(snapshot);
        onUpdate?.(snapshot);
        onUpdate?.(snapshot);
        await fs.appendFile(file, "committed\n");
        return snapshot;
      },
    }),
  ]);
  await tool.execute("progress", {}, undefined, undefined, {} as ExtensionToolContext);
  await budget.drain();
  assert.equal(await fs.readFile(file, "utf8"), "committed\n");
});

for (const excess of ["size", "count", "traffic"] as const) {
  test(`excessive update ${excess} stops new work and retains an uncooperative producer`, async (t) => {
    const abort = new AbortController();
    const budget = controlledBudget(abort);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const textBytes = excess === "size" ? LIMITS.toolBytes : Math.floor(LIMITS.toolBytes / 4);
    const update = {
      content: excess === "count" ? [] : [{ type: "text" as const, text: "x".repeat(textBytes) }],
      details: undefined,
    };
    const count =
      excess === "count"
        ? LIMITS.toolUpdates + 1
        : excess === "size"
          ? 1
          : Math.ceil(LIMITS.toolUpdateTrafficBytes / textBytes) + 1;
    let active = true;
    const [tool] = budget.tools([
      defineTool({
        name: "producer",
        label: "Producer",
        description: "A producer that ignores cancellation until explicitly released",
        parameters: Type.Object({}),
        async execute(_id, _args, _signal, onUpdate) {
          for (let i = 0; i < count; i++) {
            try {
              onUpdate?.(update);
            } catch {
              break;
            }
          }
          ready();
          await held;
          active = false;
          return { content: [], details: undefined };
        },
      }),
    ]);
    const work = tool.execute("producer", {}, undefined, undefined, {} as ExtensionToolContext);
    t.after(async () => {
      release();
      await work.catch(() => {});
      await budget.drain();
    });
    await started;
    assert.equal(abort.signal.aborted, true);
    let drained = false;
    const draining = budget.drain().then(() => {
      drained = true;
    });
    await assert.rejects(
      tool.execute("late", {}, undefined, undefined, {} as ExtensionToolContext),
    );
    assert.equal(active, true);
    assert.equal(drained, false, "an update limit cannot release an active producer");
    release();
    await assert.rejects(work);
    await draining;
    assert.equal(active, false);
  });
}

for (const codemode of [false, true]) {
  test(`budget stop retains a noncooperative ${codemode ? "codemode script" : "tool"} until it stops`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const abort = new AbortController();
    const budget = controlledBudget(abort);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stopped = false;
    const [tool] = budget.tools(
      [
        defineTool({
          name: codemode ? "codemode" : "controlled_io",
          label: "Controlled IO",
          description: "Controlled external IO lifetime",
          parameters: Type.Object({}),
          async execute() {
            await held;
            stopped = true;
            return { content: [{ type: "text", text: "finished" }], details: undefined };
          },
        }),
      ],
      codemode,
    );
    const work = tool.execute("active", {}, undefined, undefined, {} as ExtensionToolContext);
    await Promise.resolve();
    t.mock.timers.tick(LIMITS.toolMs);
    let drained = false;
    const drain = budget.drain().then(() => {
      drained = true;
    });
    await assert.rejects(
      tool.execute("late", {}, undefined, undefined, {} as ExtensionToolContext),
    );
    assert.throws(() => budget.request());
    assert.equal(stopped, false);
    assert.equal(drained, false, "a limit cannot detach an already-started effect");
    release();
    await work;
    await drain;
    assert.equal(stopped, true);
    assert.equal(drained, true);
  });
}

test("completed oversized output preserves committed effects and permits further work", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-tool-output-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = join(root, "effects.txt");
  const abort = new AbortController();
  const budget = controlledBudget(abort);
  const [tool] = budget.tools([
    defineTool({
      name: "append",
      label: "Append",
      description: "Append a record and return its report",
      parameters: Type.Object({ record: Type.String(), largeReport: Type.Boolean() }),
      async execute(_id, { record, largeReport }) {
        await fs.appendFile(file, `${record}\n`);
        return {
          content: [{ type: "text", text: largeReport ? "x".repeat(LIMITS.toolBytes) : "Done" }],
          details: undefined,
        };
      },
    }),
  ]);
  const context = {} as ExtensionToolContext;
  await assert.rejects(
    tool.execute("large", { record: "first", largeReport: true }, undefined, undefined, context),
  );
  budget.request();
  await tool.execute(
    "small",
    { record: "second", largeReport: false },
    undefined,
    undefined,
    context,
  );
  await budget.drain();
  assert.equal(
    await fs.readFile(file, "utf8"),
    "first\nsecond\n",
    "an oversized report must neither replay its committed effect nor prevent further work",
  );
});

test("local tool close failures cannot be swallowed into safe cleanup by the SDK", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-tool-close-"));
  const file = join(root, "input.txt");
  await fs.writeFile(file, "data");
  let close: (() => Promise<void>) | undefined;
  t.after(async () => {
    await close?.();
    await fs.rm(root, { recursive: true, force: true });
  });
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    close = handle.close.bind(handle);
    t.mock.method(handle, "close", async () => {
      throw new Error("Injected close failure");
    });
    return handle;
  });
  const abort = new AbortController();
  const budget = controlledBudget(abort);
  const [read] = budget.tools(await createResearchTools(root));
  await assert.rejects(
    read.execute("read", { path: "input.txt" }, undefined, undefined, {} as ExtensionToolContext),
    ToolCleanupError,
  );
  assert.equal(abort.signal.reason, "tool_cleanup_failed");
  await assert.rejects(
    budget.drain(),
    ToolCleanupError,
    "a consumed tool error does not prove descriptor safety",
  );
});
