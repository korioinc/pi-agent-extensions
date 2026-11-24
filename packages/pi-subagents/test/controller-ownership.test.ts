import assert from "node:assert/strict";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createAssistantMessageEventStream, type Api, type Model } from "@earendil-works/pi-ai";
import { registerSubagents } from "../src/controller/index.ts";
import type { RunView } from "../src/runner-pool/index.ts";
import { LIMITS } from "../src/runtime/limits.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

function harness(root: string) {
  const history = SessionManager.inMemory(root);
  history.appendCustomEntry("test-origin", {});
  const tools = new Map<string, ToolDefinition>();
  const events = new Map<string, (event: unknown, ctx: ExtensionToolContext) => unknown>();
  let shutdown!: () => Promise<void>;
  registerSubagents({
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    appendEntry: (kind: string, data: unknown) => {
      history.appendCustomEntry(kind, data);
    },
    registerCommand: () => {},
    registerEntryRenderer: () => {},
    getAllTools: () => [],
    getSettings: () => ({}),
    on: (event: string, handler: (event: unknown, ctx: ExtensionToolContext) => unknown) => {
      events.set(event, handler);
      if (event === "session_shutdown")
        shutdown = () => Promise.resolve(handler({}, ctx)).then(() => {});
    },
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd: root,
    tools: [],
    thinkingLevel: "off",
    isProjectTrusted: () => false,
    getSystemPrompt: () => "Inherited policy",
    executeTool: () => {
      throw new Error("Forbidden tool effect");
    },
    modelRegistry: {
      getAll: () => [],
      streamSimple: () => {
        throw new Error("Forbidden provider effect");
      },
    },
    sessionManager: history,
  } as unknown as ExtensionToolContext;
  return {
    tools,
    ctx,
    shutdown: () => shutdown(),
    tree: () => events.get("session_tree")?.({}, ctx),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-owned-discovery-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  await fs.mkdir(join(root, "agents"));
  await fs.writeFile(
    join(root, "agents", "worker.md"),
    "---\nname: worker\ndescription: Worker\nenabled: false\n---\nDisabled",
  );
  t.after(async () => {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test("unsupported nested payloads cannot start work", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(
    join(root, "agents", "worker.md"),
    "---\nname: worker\ndescription: Worker\ntools: []\nprompt_mode: replace\n---\nResearch",
  );
  const app = harness(root);
  const model: Model<Api> = {
    api: "offline",
    provider: "offline",
    id: "child",
    name: "offline",
    baseUrl: "https://unused.invalid",
    reasoning: false,
    input: ["text"],
    contextWindow: 100000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  app.ctx.model = model;
  app.ctx.modelRegistry.getAll = () => [model];
  let modelWork = false;
  app.ctx.modelRegistry.streamSimple = (requested) => {
    modelWork = true;
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          api: requested.api,
          provider: requested.provider,
          model: requested.id,
          content: [{ type: "text", text: "Finished" }],
          stopReason: "stop",
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      });
      stream.end();
    });
    return stream;
  };
  const spawn = app.tools.get("subagent")!;
  await spawn.execute(
    "handoff",
    { agent: "worker", task: "Use the reference", handoff: { runId: "missing-source" } },
    undefined,
    undefined,
    app.ctx,
  );
  assert.equal(modelWork, false, "a denied source must not authorize model work");
  await spawn.execute(
    "ordinary",
    { agent: "worker", handoff: "Research" },
    undefined,
    undefined,
    app.ctx,
  );
  assert.equal(modelWork, true, "ordinary authorized execution can reach the same provider");
  await app.shutdown();
});

test("revoked task completion cannot disclose identity and preserves incurred usage", async (t) => {
  const root = await fixture(t);
  const privateAgent = "confidential-research-agent";
  await fs.writeFile(
    join(root, "agents", `${privateAgent}.md`),
    `---\nname: ${privateAgent}\ndescription: Worker\ntools: []\nprompt_mode: replace\n---\nResearch`,
  );
  const app = harness(root);
  const pending = deferred();
  const entered = deferred();
  t.after(() => pending.resolve());
  t.after(() => app.shutdown());
  const model: Model<Api> = {
    api: "offline",
    provider: "offline",
    id: "child",
    name: "offline",
    baseUrl: "https://unused.invalid",
    reasoning: false,
    input: ["text"],
    contextWindow: 100000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  app.ctx.model = model;
  app.ctx.modelRegistry.getAll = () => [model];
  const incurredTokens = 7;
  let hold = false;
  app.ctx.modelRegistry.streamSimple = (requested) => {
    const stream = createAssistantMessageEventStream();
    const finish = () => {
      stream.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          api: requested.api,
          provider: requested.provider,
          model: requested.id,
          content: [{ type: "text", text: "Private source finding" }],
          stopReason: "stop",
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: incurredTokens,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: incurredTokens,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      });
      stream.end();
    };
    if (hold) {
      entered.resolve();
      void pending.promise.then(finish);
    } else queueMicrotask(finish);
    return stream;
  };
  const history = app.ctx.sessionManager as SessionManager;
  const ancestor = history.getLeafId()!;
  const spawn = app.tools.get("subagent")!;
  const source = await spawn.execute(
    "source",
    { agent: privateAgent, handoff: "Research" },
    undefined,
    undefined,
    app.ctx,
  );
  const sourceRun = source.details as RunView;
  hold = true;
  const active = spawn.execute(
    "target",
    { agent: privateAgent, handoff: "Continue research" },
    undefined,
    undefined,
    app.ctx,
  );
  await entered.promise;
  history.branch(ancestor);
  history.appendCustomEntry("sibling", {});
  await app.tree();
  pending.resolve();
  const denied = await active;
  const disclosed = JSON.stringify(denied);
  assert(!disclosed.includes(privateAgent), "a sibling cannot obtain the private agent identity");
  assert(!disclosed.includes(sourceRun.runId), "a sibling cannot obtain the earlier run identity");
  assert.equal(
    denied.usage?.totalTokens,
    incurredTokens,
    "revocation must not lose incurred usage",
  );
});

test("busy admission avoids policy capture and filesystem preparation; shutdown awaits all admitted scans", async (t) => {
  const root = await fixture(t);
  const app = harness(root);
  const gate = deferred();
  t.after(() => gate.resolve());
  const entered = deferred();
  const real = fs.opendir;
  let scans = 0;
  let policies = 0;
  app.ctx.getSystemPrompt = () => {
    policies++;
    return "Inherited policy";
  };
  t.mock.method(fs, "opendir", async (...args: Parameters<typeof fs.opendir>) => {
    scans++;
    if (scans === LIMITS.runs) entered.resolve();
    await gate.promise;
    return real(...args);
  });
  const run = app.tools.get("subagent")!;
  const accepted = Array.from({ length: LIMITS.runs }, (_, i) =>
    run.execute(
      String(i),
      { agent: "worker", handoff: "No effects" },
      undefined,
      undefined,
      app.ctx,
    ),
  );
  await entered.promise;
  const capturedBeforeRejection = policies;
  const busy = await run.execute(
    "busy",
    { agent: "worker", handoff: "No effects" },
    undefined,
    undefined,
    app.ctx,
  );
  assert.equal((busy.details as { rejection: string }).rejection, "busy");
  assert.equal(scans, LIMITS.runs);
  assert.equal(policies, capturedBeforeRejection, "rejected work cannot capture parent policy");
  let drained = false;
  const drain = app.shutdown().then(() => {
    drained = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  gate.resolve();
  await Promise.all(accepted);
  await drain;
  assert.equal(drained, true);
});

test("unsafe list_agents cleanup cannot cancel active research or prevent independent research", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(
    join(root, "agents", "worker.md"),
    "---\nname: worker\ndescription: Worker\ntools: []\nprompt_mode: replace\n---\nResearch",
  );
  const app = harness(root);
  assert.equal(
    app.tools.has("subagent_preflight"),
    false,
    "subagent_preflight must not be registered",
  );
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const model: Model<Api> = {
    api: "offline",
    provider: "offline",
    id: "research",
    name: "Offline research",
    baseUrl: "https://unused.invalid",
    reasoning: false,
    input: ["text"],
    contextWindow: 100000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  app.ctx.model = model;
  app.ctx.modelRegistry.getAll = () => [model];
  app.ctx.modelRegistry.streamSimple = (requested) => {
    const stream = createAssistantMessageEventStream();
    entered.resolve();
    void release.promise.then(() => {
      stream.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          api: requested.api,
          provider: requested.provider,
          model: requested.id,
          content: [{ type: "text", text: "Research complete." }],
          stopReason: "stop",
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      });
      stream.end();
    });
    return stream;
  };
  const run = app.tools.get("subagent")!;
  const active = run.execute(
    "active",
    { agent: "worker", handoff: "Research" },
    undefined,
    undefined,
    app.ctx,
  );
  await entered.promise;

  const closed = deferred();
  const open = fs.opendir;
  const fault = t.mock.method(fs, "opendir", async (...args: Parameters<typeof fs.opendir>) => {
    const directory = await open(...args);
    const close = directory.close.bind(directory);
    t.mock.method(directory, "close", async () => {
      await close();
      closed.resolve();
      throw new Error("Unconfirmed catalog closure");
    });
    return directory;
  });
  let listed = false;
  const list = app.tools.get("list_agents")!;
  void list.execute("catalog", {}, undefined, undefined, app.ctx).then(() => {
    listed = true;
  });
  await closed.promise;
  await nextTurn();
  fault.mock.restore();
  release.resolve();
  const activeResult = await active;
  assert.equal(
    (activeResult.details as RunView).outcome,
    "succeeded",
    "catalog failure must not cancel already-running research",
  );
  const next = await run.execute(
    "next",
    { agent: "worker", handoff: "Research" },
    undefined,
    undefined,
    app.ctx,
  );
  assert.equal(
    (next.details as RunView).outcome,
    "succeeded",
    "catalog failure must not prevent independent named-agent discovery and research",
  );
  let drained = false;
  void app.shutdown().then(() => {
    drained = true;
  });
  await nextTurn();
  assert.equal(listed, false, "unknown closure cannot finalize the catalog");
  assert.equal(drained, false, "shutdown must still own the unsafe catalog");
});

test("one list_agents scan owns its pending acquisition through shutdown and rejects concurrent scans", async (t) => {
  const root = await fixture(t);
  const app = harness(root);
  const gate = deferred();
  t.after(() => gate.resolve());
  const entered = deferred();
  const real = fs.opendir;
  let scans = 0;
  t.mock.method(fs, "opendir", async (...args: Parameters<typeof fs.opendir>) => {
    scans++;
    entered.resolve();
    await gate.promise;
    return real(...args);
  });
  const list = app.tools.get("list_agents")!;
  const first = list.execute("first", {}, undefined, undefined, app.ctx);
  await entered.promise;
  const inspect = app.tools.get("subagent_inspect")!;
  const foreign = {
    ...app.ctx,
    sessionManager: SessionManager.inMemory(root),
  } as ExtensionToolContext;
  const owned = await inspect.execute("owned", {}, undefined, undefined, app.ctx);
  const denied = await inspect.execute("foreign", {}, undefined, undefined, foreign);
  const details = owned.details as { catalog: { diagnostics?: unknown } };
  const foreignDetails = denied.details as { catalog: { diagnostics?: unknown } };
  assert.ok(details.catalog.diagnostics, "the owning origin can diagnose its live scan");
  assert.equal(
    foreignDetails.catalog.diagnostics,
    undefined,
    "another session cannot obtain scan diagnostics",
  );
  const second = await list.execute("second", {}, undefined, undefined, app.ctx);
  assert.equal((second.details as { rejection: string }).rejection, "busy");
  assert.equal(scans, 1);
  let drained = false;
  const drain = app.shutdown().then(() => {
    drained = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  gate.resolve();
  await first;
  await drain;
  const after = await list.execute("after", {}, undefined, undefined, app.ctx);
  assert.equal((after.details as { rejection: string }).rejection, "unavailable");
});

function activityUI(app: ReturnType<typeof harness>) {
  const widgets = new Map<string, Component>();
  const theme = {
    fg: (_color: string, value: string) => value,
    bold: (value: string) => value,
  } as Theme;
  const tui = { terminal: { rows: 40 }, requestRender() {} } as unknown as TUI;
  Object.assign(app.ctx, {
    mode: "tui",
    hasUI: true,
    ui: {
      setWidget(key: string, factory: ((tui: TUI, theme: Theme) => Component) | undefined) {
        if (factory) widgets.set(key, factory(tui, theme));
        else widgets.delete(key);
      },
    },
  });
  return {
    widgets,
    tui,
    output: () => [...widgets.values()].flatMap((widget) => widget.render(100)).join("\n"),
  };
}

test("live activity cannot disclose a run after its parent leaves the origin branch", async (t) => {
  const root = await fixture(t);
  const app = harness(root);
  const ui = activityUI(app);
  const pending = deferred();
  const entered = deferred();
  t.after(() => pending.resolve());
  const real = fs.opendir;
  t.mock.method(fs, "opendir", async (...args: Parameters<typeof fs.opendir>) => {
    entered.resolve();
    await pending.promise;
    return real(...args);
  });
  const creationAncestor = app.ctx.sessionManager.getLeafId()!;
  const secret = "worker";
  const run = app.tools
    .get("subagent")!
    .execute("private", { agent: secret, handoff: "No effects" }, undefined, undefined, app.ctx);
  await entered.promise;
  assert(ui.output().includes(secret), "the authorized branch must be able to see its own run");
  const stale = [...ui.widgets.values()][0]!;
  const owningLeaf = app.ctx.sessionManager.getLeafId()!;
  const history = app.ctx.sessionManager as SessionManager;
  history.branch(creationAncestor);
  history.appendCustomEntry("sibling", {});
  assert(
    !stale.render(100).join("\n").includes(secret),
    "a queued render cannot disclose the old branch's identity",
  );
  await app.tree();
  assert(!ui.output().includes(secret));
  history.branch(owningLeaf);
  await app.tree();
  assert(
    ui.output().includes(secret),
    "returning to an eligible branch restores authorized observation",
  );
  pending.resolve();
  await run;
  assert(ui.output().includes(secret), "retained results remain visible to their owner");
  history.branch(creationAncestor);
  history.appendCustomEntry("another-sibling", {});
  assert(!stale.render(100).join("\n").includes(secret), "retained results must also reauthorize");
  await app.tree();
  assert(!ui.output().includes(secret));
  await app.shutdown();
});

test("reloading reused session and leaf IDs cannot preserve access to a removed owner branch", async (t) => {
  const root = await fixture(t);
  const app = harness(root);
  t.after(() => app.shutdown());
  const history = app.ctx.sessionManager as SessionManager;
  const ancestor = history.getLeafId();
  const privateAgent = "branch-private-agent";
  await app.tools
    .get("subagent")!
    .execute(
      "private",
      { agent: privateAgent, handoff: "Inspect private configuration" },
      undefined,
      undefined,
      app.ctx,
    );
  const fence = history.getLeafId();
  history.appendCustomEntry("shared-tip", {});
  const leaf = history.getLeafId();
  const visible = async () =>
    JSON.stringify(
      await app.tools
        .get("subagent_inspect")!
        .execute("inspect", { scope: "runs" }, undefined, undefined, app.ctx),
    );
  assert((await visible()).includes(privateAgent), "the owner can inspect its retained run");

  // Native reload replaces the graph while reusing the manager, session ID and tip ID.
  const entries = history
    .getEntries()
    .filter((entry) => entry.id !== fence)
    .map((entry) => (entry.id === leaf ? { ...entry, parentId: ancestor } : entry));
  const path = join(root, "reloaded.jsonl");
  await fs.writeFile(
    path,
    [history.getHeader(), ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  history.setSessionFile(path);
  assert(
    !(await visible()).includes(privateAgent),
    "reloaded ancestry cannot disclose another branch's run",
  );
});

for (const channel of ["setWidget", "requestRender"] as const) {
  test(`a failing activity ${channel} cannot lose admitted execution or its cleanup`, async (t) => {
    const root = await fixture(t);
    const app = harness(root);
    const ui = activityUI(app);
    const failure = () => {
      throw new Error("Unavailable UI");
    };
    if (channel === "requestRender") ui.tui.requestRender = failure;
    else app.ctx.ui[channel] = failure;
    const pending = deferred();
    const entered = deferred();
    t.after(() => pending.resolve());
    const real = fs.opendir;
    t.mock.method(fs, "opendir", async (...args: Parameters<typeof fs.opendir>) => {
      entered.resolve();
      await pending.promise;
      return real(...args);
    });
    let completed = false;
    const run = app.tools
      .get("subagent")!
      .execute(
        "ui-failure",
        { agent: "worker", handoff: "No effects" },
        undefined,
        undefined,
        app.ctx,
      )
      .then((value) => {
        completed = true;
        return value;
      });
    await entered.promise;
    let drained = false;
    const drain = app.shutdown().then(() => {
      drained = true;
    });
    await nextTurn();
    assert.equal(
      completed,
      false,
      "UI failure must not release the execution before owned work stops",
    );
    assert.equal(drained, false, "UI cleanup must not release the shutdown barrier");
    pending.resolve();
    const value = await run;
    await drain;
    assert.equal(
      (value.details as RunView).cleanup,
      "safe",
      "the original execution still reaches its real cleanup result",
    );
    assert.equal(
      JSON.stringify(value).includes("Unavailable UI"),
      false,
      "presentation failure must not overwrite the execution result",
    );
  });
}

test("shutdown revokes activity rendering while admitted cleanup is still pending", async (t) => {
  const root = await fixture(t);
  const app = harness(root);
  const ui = activityUI(app);
  const pending = deferred();
  const entered = deferred();
  t.after(() => pending.resolve());
  const real = fs.opendir;
  t.mock.method(fs, "opendir", async (...args: Parameters<typeof fs.opendir>) => {
    entered.resolve();
    await pending.promise;
    return real(...args);
  });
  const secret = "worker";
  const run = app.tools
    .get("subagent")!
    .execute("shutdown", { agent: secret, handoff: "No effects" }, undefined, undefined, app.ctx);
  await entered.promise;
  assert(ui.output().includes(secret));
  const stale = [...ui.widgets.values()][0]!;
  let drained = false;
  const drain = app.shutdown().then(() => {
    drained = true;
  });
  await nextTurn();
  assert.equal(drained, false);
  assert(
    !stale.render(100).join("\n").includes(secret),
    "disposed UI cannot disclose an old runtime while drain waits",
  );
  await app.tree();
  pending.resolve();
  await run;
  await drain;
  assert(!ui.output().includes(secret), "late completion cannot republish a disposed runtime");
});

test("pre-aborted subagent call returns not_accepting rather than invalid_input", async (t) => {
  const root = await fixture(t);
  const app = harness(root);
  t.after(() => app.shutdown());
  const controller = new AbortController();
  controller.abort();
  const spawn = app.tools.get("subagent")!;
  const response = await spawn.execute(
    "aborted",
    { agent: "worker", handoff: "Valid task" },
    controller.signal,
    undefined,
    app.ctx,
  );
  assert.equal(response.isError, true);
  assert.equal((response.details as { rejection?: string }).rejection, "not_accepting");
});

test("streaming provider events avoid synchronous workspace stat calls while still enforcing branch revocation", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(
    join(root, "agents", "worker.md"),
    "---\nname: worker\ndescription: Worker\ntools: []\nprompt_mode: replace\n---\nResearch",
  );
  const app = harness(root);
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await app.shutdown();
  });
  const model: Model<Api> = {
    api: "offline",
    provider: "offline",
    id: "child",
    name: "offline",
    baseUrl: "https://unused.invalid",
    reasoning: false,
    input: ["text"],
    contextWindow: 100000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  app.ctx.model = model;
  app.ctx.modelRegistry.getAll = () => [model];
  let statCallsDuringStream = 0;
  let inStreamEvents = false;
  const origStatSync = nodeFs.statSync;
  t.mock.method(nodeFs, "statSync", (...args: Parameters<typeof nodeFs.statSync>) => {
    if (inStreamEvents) statCallsDuringStream++;
    return origStatSync(...args);
  });
  syncBuiltinESMExports();
  let revokeMidStream = false;
  let midStreamThrew = false;
  const history = app.ctx.sessionManager as SessionManager;
  const ancestor = history.getLeafId()!;
  app.ctx.modelRegistry.streamSimple = (requested, _context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      inStreamEvents = true;
      try {
        for (let i = 0; i < 50; i++) {
          if (revokeMidStream && i === 10) {
            history.branch(ancestor);
            history.appendCustomEntry("sibling", {});
          }
          await options?.onProviderStreamEvent?.({ type: "delta", index: i }, requested);
        }
      } catch {
        midStreamThrew = true;
      } finally {
        inStreamEvents = false;
      }
      stream.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          api: requested.api,
          provider: requested.provider,
          model: requested.id,
          content: [{ type: "text", text: "Done" }],
          stopReason: "stop",
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      });
      stream.end();
    })();
    return stream;
  };
  const spawn = app.tools.get("subagent")!;
  const settled = await spawn.execute(
    "stream-hotpath",
    { agent: "worker", handoff: "Stream deltas" },
    undefined,
    undefined,
    app.ctx,
  );
  assert.equal((settled.details as RunView).outcome, "succeeded");
  assert.equal(
    statCallsDuringStream,
    0,
    "onProviderStreamEvent must not invoke synchronous statSync on every delta",
  );
  revokeMidStream = true;
  const revoked = await spawn.execute(
    "stream-revoked",
    { agent: "worker", handoff: "Stream deltas until revoked" },
    undefined,
    undefined,
    app.ctx,
  );
  assert.equal(midStreamThrew, true, "branch revocation must still stop streaming immediately");
  assert.equal((revoked.details as { rejection?: string }).rejection, "not_available");
});

test("tool onUpdate uses hot-path checkFast without synchronous workspace stat per progress tick", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(
    join(root, "agents", "worker.md"),
    "---\nname: worker\ndescription: Worker\ntools: [noisy]\nprompt_mode: replace\n---\nResearch",
  );
  const app = harness(root);
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await app.shutdown();
  });
  const model: Model<Api> = {
    api: "offline",
    provider: "offline",
    id: "child",
    name: "offline",
    baseUrl: "https://unused.invalid",
    reasoning: false,
    input: ["text"],
    contextWindow: 100000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  app.ctx.model = model;
  app.ctx.modelRegistry.getAll = () => [model];
  const { Type } = await import("typebox");
  Object.assign(app.ctx, {
    tools: [
      { name: "noisy", label: "Noisy", description: "Emits updates", parameters: Type.Object({}) },
    ],
  });
  let statCallsDuringUpdates = 0;
  let inUpdates = false;
  const origStatSync = nodeFs.statSync;
  t.mock.method(nodeFs, "statSync", (...args: Parameters<typeof nodeFs.statSync>) => {
    if (inUpdates) statCallsDuringUpdates++;
    return origStatSync(...args);
  });
  syncBuiltinESMExports();
  let toolDispatched = false;
  app.ctx.executeTool = async (_name, _args, options) => {
    toolDispatched = true;
    inUpdates = true;
    try {
      for (let i = 0; i < 40; i++)
        options?.onUpdate?.({ content: [{ type: "text", text: `tick ${i}` }], details: undefined });
    } finally {
      inUpdates = false;
    }
    return {
      toolCall: { type: "toolCall" as const, id: "t1", name: "noisy", arguments: {} },
      result: { content: [{ type: "text", text: "ok" }], details: undefined },
      isError: false,
    };
  };
  // Register tool metadata for noisy so selectTools allows delegation.
  const tools = new Map<string, ToolDefinition>();
  const history = app.ctx.sessionManager as SessionManager;
  let shutdown!: () => Promise<void>;
  registerSubagents({
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    appendEntry: (kind: string, data: unknown) => {
      history.appendCustomEntry(kind, data);
    },
    registerCommand: () => {},
    registerEntryRenderer: () => {},
    getAllTools: () => [
      {
        name: "noisy",
        description: "Emits updates",
        parameters: Type.Object({}),
        exposure: "direct",
        sourceInfo: { source: "builtin" },
      },
    ],
    getSettings: () => ({}),
    on: (event: string, handler: (event: unknown, ctx: ExtensionToolContext) => unknown) => {
      if (event === "session_shutdown")
        shutdown = () => Promise.resolve(handler({}, app.ctx)).then(() => {});
    },
  } as unknown as ExtensionAPI);
  t.after(() => shutdown());
  let turn = 0;
  app.ctx.modelRegistry.streamSimple = (requested) => {
    const stream = createAssistantMessageEventStream();
    const first = turn++ === 0;
    queueMicrotask(() => {
      stream.push({
        type: "done",
        reason: first ? "toolUse" : "stop",
        message: {
          role: "assistant",
          api: requested.api,
          provider: requested.provider,
          model: requested.id,
          content: first
            ? [{ type: "toolCall", id: "call-1", name: "noisy", arguments: {} }]
            : [{ type: "text", text: "Done" }],
          stopReason: first ? "toolUse" : "stop",
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      });
      stream.end();
    });
    return stream;
  };
  const settled = await tools
    .get("subagent")!
    .execute(
      "tool-hotpath",
      { agent: "worker", handoff: "Run noisy tool" },
      undefined,
      undefined,
      app.ctx,
    );
  assert.equal(toolDispatched, true);
  assert.equal((settled.details as RunView).outcome, "succeeded");
  assert.equal(
    statCallsDuringUpdates,
    0,
    "tool onUpdate must not invoke synchronous statSync on every progress tick",
  );
});

function rpcStatusUI(app: ReturnType<typeof harness>) {
  const history: Array<{ key: string; text: string | undefined }> = [];
  const active = new Map<string, string>();
  Object.assign(app.ctx, {
    mode: "rpc",
    hasUI: true,
    ui: {
      setStatus(key: string, text: string | undefined) {
        history.push({ key, text });
        if (text === undefined) active.delete(key);
        else active.set(key, text);
      },
      setWidget() {
        throw new Error("RPC mode must not call setWidget");
      },
    },
  });
  return {
    history,
    current: () => active.get("pi-subagents.activity"),
  };
}

test("RPC setStatus tracks active runs, reauthorizes across branches, clears on completion and shutdown", async (t) => {
  const root = await fixture(t);
  const app = harness(root);
  const ui = rpcStatusUI(app);
  const pending = deferred();
  const entered = deferred();
  t.after(() => pending.resolve());
  const real = fs.opendir;
  t.mock.method(fs, "opendir", async (...args: Parameters<typeof fs.opendir>) => {
    entered.resolve();
    await pending.promise;
    return real(...args);
  });
  const creationAncestor = app.ctx.sessionManager.getLeafId()!;
  const secret = "worker";
  const run = app.tools
    .get("subagent")!
    .execute("rpc-live", { agent: secret, handoff: "No effects" }, undefined, undefined, app.ctx);
  await entered.promise;
  assert.equal(ui.current(), "SubAgents (1): worker (Preparing)");
  const owningLeaf = app.ctx.sessionManager.getLeafId()!;
  const history = app.ctx.sessionManager as SessionManager;
  history.branch(creationAncestor);
  history.appendCustomEntry("sibling", {});
  await app.tree();
  assert.equal(ui.current(), undefined, "leaving the owning branch must clear RPC setStatus");
  history.branch(owningLeaf);
  await app.tree();
  assert.equal(
    ui.current(),
    "SubAgents (1): worker (Stopping)",
    "returning to the owning branch restores authorized RPC setStatus with current stopping phase",
  );
  pending.resolve();
  await run;
  assert.equal(
    ui.current(),
    undefined,
    "retained terminal runs must not leave a stale RPC status banner",
  );

  // Also verify shutdown clears an active RPC status before drain completes.
  const holdShutdown = deferred();
  const enteredShutdown = deferred();
  t.after(() => holdShutdown.resolve());
  t.mock.method(fs, "opendir", async (...args: Parameters<typeof fs.opendir>) => {
    enteredShutdown.resolve();
    await holdShutdown.promise;
    return real(...args);
  });
  const second = app.tools
    .get("subagent")!
    .execute(
      "rpc-shutdown",
      { agent: secret, handoff: "No effects" },
      undefined,
      undefined,
      app.ctx,
    );
  await enteredShutdown.promise;
  assert.equal(ui.current(), "SubAgents (1): worker (Preparing)");
  let drained = false;
  const drain = app.shutdown().then(() => {
    drained = true;
  });
  await nextTurn();
  assert.equal(drained, false);
  assert.equal(ui.current(), undefined, "shutdown must clear RPC setStatus before drain completes");
  holdShutdown.resolve();
  await second;
  await drain;
  assert.equal(ui.current(), undefined, "late completion cannot republish RPC setStatus");
});

test("TUI activity widget does not emit duplicate setStatus calls", async (t) => {
  const root = await fixture(t);
  const app = harness(root);
  const ui = activityUI(app);
  let statusCalls = 0;
  app.ctx.ui.setStatus = () => {
    statusCalls++;
  };
  await app.tools
    .get("subagent")!
    .execute("tui-only", { agent: "worker", handoff: "No effects" }, undefined, undefined, app.ctx);
  assert(ui.output().includes("worker"));
  assert.equal(statusCalls, 0, "TUI mode must not duplicate status into footer setStatus");
  await app.shutdown();
});

test("a failing RPC setStatus cannot lose admitted execution or retry within the same run", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(
    join(root, "agents", "worker.md"),
    "---\nname: worker\ndescription: Worker\ntools: []\nprompt_mode: replace\n---\nResearch",
  );
  const app = harness(root);
  rpcStatusUI(app);
  let statusAttempts = 0;
  app.ctx.ui.setStatus = (_key, text) => {
    if (text !== undefined) statusAttempts++;
    throw new Error("Unavailable RPC status");
  };
  const model: Model<Api> = {
    api: "offline",
    provider: "offline",
    id: "child",
    name: "offline",
    baseUrl: "https://unused.invalid",
    reasoning: false,
    input: ["text"],
    contextWindow: 100000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  app.ctx.model = model;
  app.ctx.modelRegistry.getAll = () => [model];
  const pending = deferred();
  const entered = deferred();
  t.after(() => pending.resolve());
  app.ctx.modelRegistry.streamSimple = (requested) => {
    const stream = createAssistantMessageEventStream();
    entered.resolve();
    void pending.promise.then(() => {
      stream.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          api: requested.api,
          provider: requested.provider,
          model: requested.id,
          content: [{ type: "text", text: "Done" }],
          stopReason: "stop",
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      });
      stream.end();
    });
    return stream;
  };
  let completed = false;
  const run = app.tools
    .get("subagent")!
    .execute(
      "rpc-ui-failure",
      { agent: "worker", handoff: "No effects" },
      undefined,
      undefined,
      app.ctx,
    )
    .then((value) => {
      completed = true;
      return value;
    });
  await entered.promise;
  let drained = false;
  const drain = app.shutdown().then(() => {
    drained = true;
  });
  await nextTurn();
  assert.equal(completed, false, "RPC status failure must not release execution early");
  assert.equal(drained, false, "RPC status failure must not release the shutdown barrier");
  pending.resolve();
  const value = await run;
  await drain;
  assert.equal(
    statusAttempts,
    1,
    "UI failure circuit breaker must not retry setStatus on later progress events in the same run",
  );
  assert.equal((value.details as RunView).cleanup, "safe");
  assert.equal(JSON.stringify(value).includes("Unavailable RPC status"), false);
});

test("expiring a retained run during TUI render does not mutate setWidget synchronously inside render", async (t) => {
  const root = await fixture(t);
  const app = harness(root);
  const ui = activityUI(app);
  let insideRender = false;
  let mutatedInRender = false;
  const origSetWidget = app.ctx.ui.setWidget as (...args: unknown[]) => void;
  app.ctx.ui.setWidget = ((...args: unknown[]) => {
    if (insideRender) mutatedInRender = true;
    return origSetWidget.apply(app.ctx.ui, args);
  }) as typeof app.ctx.ui.setWidget;
  await app.tools
    .get("subagent")!
    .execute(
      "expire-tui",
      { agent: "worker", handoff: "No effects" },
      undefined,
      undefined,
      app.ctx,
    );
  assert.equal(ui.widgets.size, 1);
  const widget = [...ui.widgets.values()][0]!;
  const future = Date.now() + LIMITS.retentionMs + 1000;
  t.mock.method(Date, "now", () => future);
  insideRender = true;
  const lines = widget.render(100);
  insideRender = false;
  assert.deepEqual(lines, []);
  assert.equal(
    mutatedInRender,
    false,
    "prune inside render() must not call setWidget synchronously",
  );
  await Promise.resolve();
  assert.equal(ui.widgets.size, 0, "deferred microtask still unmounts the expired empty widget");
  await app.shutdown();
});

test("RPC status summary sanitizes control chars, preserves overflow and balanced parens, and omits terminal runs", async () => {
  const { activityStatusText } = await import("../src/controller/render.ts");
  const { subagentResult } = await import("../src/controller/subagent-result.ts");
  const baseDiag = {
    stage: "execution" as const,
    executor: "pending" as const,
    pendingTools: 0,
    pendingTransports: 0,
    admittedAt: 0,
    phaseStartedAt: 0,
    stageStartedAt: 0,
    elapsedMs: 0,
    phaseElapsedMs: 0,
    stageElapsedMs: 0,
  };
  assert.equal(
    activityStatusText([
      {
        runId: "done",
        identity: { agent: "done-agent" },
        phase: "terminal",
        outcome: "succeeded",
        diagnostics: baseDiag,
      },
    ]),
    undefined,
  );
  const summary = activityStatusText([
    {
      runId: "1",
      identity: { agent: "\u001b[31mrev\niewer\u001b[0m" },
      phase: "running",
      diagnostics: { ...baseDiag, activeToolNames: ["read", "grep", "bash"] },
    },
    {
      runId: "2",
      identity: { agent: "explorer" },
      phase: "running",
      diagnostics: { ...baseDiag, queuedTools: 2, activeToolNames: ["read"] },
    },
    {
      runId: "3",
      identity: { agent: "tester" },
      phase: "preparing",
      diagnostics: baseDiag,
    },
    {
      runId: "4",
      identity: { agent: "fourth" },
      phase: "running",
      diagnostics: baseDiag,
    },
  ]);
  assert.equal(
    summary,
    "SubAgents (4): rev iewer (Running · read, grep +1), explorer (Running · Waiting for tool slot (2)), tester (Preparing) +1 more",
  );
  const longSummary = activityStatusText([
    {
      runId: "1",
      identity: { agent: "a".repeat(48) },
      phase: "blocked",
      stopReason: "e".repeat(96),
      failure: {
        code: "unknown",
        stage: "execution",
        nextAction: "containment_required",
        automaticReplay: false,
        toolEffects: "possible",
      },
      diagnostics: { ...baseDiag, recovery: "containment_required" },
    },
    {
      runId: "2",
      identity: { agent: "b".repeat(48) },
      phase: "blocked",
      stopReason: "e".repeat(96),
      failure: {
        code: "unknown",
        stage: "execution",
        nextAction: "containment_required",
        automaticReplay: false,
        toolEffects: "possible",
      },
      diagnostics: { ...baseDiag, recovery: "containment_required" },
    },
    {
      runId: "3",
      identity: { agent: "c".repeat(48) },
      phase: "blocked",
      stopReason: "e".repeat(96),
      failure: {
        code: "unknown",
        stage: "execution",
        nextAction: "containment_required",
        automaticReplay: false,
        toolEffects: "possible",
      },
      diagnostics: { ...baseDiag, recovery: "containment_required" },
    },
  ]);
  assert(longSummary !== undefined && Buffer.byteLength(longSummary) <= 300);
  assert(longSummary.endsWith(" +1 more") || longSummary.endsWith(" +2 more"));
  assert.equal(
    longSummary.split("(").length,
    longSummary.split(")").length,
    "truncated RPC status banner must keep balanced parentheses",
  );
  const projected = subagentResult({ details: {} }, "Review", {
    runId: "1",
    generation: "g",
    identity: { agent: "reviewer" },
    model: "\u001b[32manthropic/claude-sonnet-4-5\n\u001b[0m",
    phase: "running",
    diagnostics: {
      ...baseDiag,
      activeToolNames: [
        "\u001b[33mmcp__server__very_long_tool_name_alpha_1234567890\u001b[0m",
        "mcp__server__very_long_tool_name_beta_1234567890",
        "extra_tool",
      ],
    },
  });
  const runningText = projected.details.results[0]?.messages[0]?.content[0]?.text ?? "";
  assert.equal(projected.details.results[0]?.model, "anthropic/claude-sonnet-4-5");
  assert(runningText.endsWith(" +1"), "long active tool lists must preserve overflow count");
  assert(!runningText.includes("\u001b"), "status text must strip ANSI escapes");
  const failedProjection = subagentResult({ details: {} }, "Review", {
    runId: "2",
    generation: "g",
    identity: { agent: "reviewer" },
    phase: "terminal",
    outcome: "failed",
    cleanup: "safe",
    text: "",
    truncated: false,
    outputBytes: 0,
    persistence: "volatile",
    stopReason: "\u001b[31mbad\nreason\u001b[0m",
    diagnostics: baseDiag,
  });
  assert.equal(
    failedProjection.details.results[0]?.messages[0]?.content[0]?.text,
    "Status: Failed · bad reason",
  );
});
