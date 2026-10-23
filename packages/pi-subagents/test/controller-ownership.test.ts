import assert from "node:assert/strict";
import fs from "node:fs/promises";
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

test("unavailable handoff sources cannot start a new invocation", async (t) => {
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
  const spawn = app.tools.get("spawn_agent")!;
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
    { agent: "worker", task: "Research" },
    undefined,
    undefined,
    app.ctx,
  );
  assert.equal(modelWork, true, "ordinary authorized execution can reach the same provider");
  await app.shutdown();
});

test("revoked handoff completion cannot disclose source identity and preserves incurred usage", async (t) => {
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
  const spawn = app.tools.get("spawn_agent")!;
  const source = await spawn.execute(
    "source",
    { agent: privateAgent, task: "Research" },
    undefined,
    undefined,
    app.ctx,
  );
  const sourceRun = source.details as RunView;
  hold = true;
  const active = spawn.execute(
    "target",
    { agent: privateAgent, task: "Continue research", handoff: { runId: sourceRun.runId } },
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
  assert(!disclosed.includes(sourceRun.runId), "a sibling cannot obtain the handoff source");
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
  const run = app.tools.get("spawn_agent")!;
  const accepted = Array.from({ length: LIMITS.runs }, (_, i) =>
    run.execute(String(i), { agent: "worker", task: "No effects" }, undefined, undefined, app.ctx),
  );
  await entered.promise;
  const capturedBeforeRejection = policies;
  const busy = await run.execute(
    "busy",
    { agent: "worker", task: "No effects" },
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

for (const scanName of ["list_agents", "subagent_preflight"]) {
  test(`unsafe ${scanName} cleanup cannot cancel active research or prevent independent research`, async (t) => {
    const root = await fixture(t);
    await fs.writeFile(
      join(root, "agents", "worker.md"),
      "---\nname: worker\ndescription: Worker\ntools: []\nprompt_mode: replace\n---\nResearch",
    );
    const app = harness(root);
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
    const run = app.tools.get("spawn_agent")!;
    const active = run.execute(
      "active",
      { agent: "worker", task: "Research" },
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
    const list = app.tools.get(scanName)!;
    void list.execute("catalog", { agent: "worker" }, undefined, undefined, app.ctx).then(() => {
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
      { agent: "worker", task: "Research" },
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

  test(`one ${scanName} scan owns its pending acquisition through shutdown and rejects concurrent scans`, async (t) => {
    const root = await fixture(t);
    const app = harness(root);
    const gate = deferred();
    const entered = deferred();
    const real = fs.opendir;
    let scans = 0;
    t.mock.method(fs, "opendir", async (...args: Parameters<typeof fs.opendir>) => {
      scans++;
      entered.resolve();
      await gate.promise;
      return real(...args);
    });
    const list = app.tools.get(scanName)!;
    const first = list.execute("first", { agent: "worker" }, undefined, undefined, app.ctx);
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
    const other = app.tools.get(scanName === "list_agents" ? "subagent_preflight" : "list_agents")!;
    const second = await other.execute(
      "second",
      { agent: "worker" },
      undefined,
      undefined,
      app.ctx,
    );
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
    const after = await list.execute("after", { agent: "worker" }, undefined, undefined, app.ctx);
    assert.equal((after.details as { rejection: string }).rejection, "unavailable");
  });
}

test("preflight does not execute configured effects or expose secret-bearing failures", async (t) => {
  const root = await fixture(t);
  const app = harness(root);
  const secret = "private-preflight-marker";
  const marker = join(root, "forbidden-effect");
  const script = join(root, "server.mjs");
  await fs.writeFile(
    script,
    `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "effect");`,
  );
  const source = JSON.stringify({
    mcpServers: {
      selected: {
        command: process.execPath,
        args: [script],
        env: { TOKEN: secret },
      },
    },
  });
  await fs.writeFile(join(root, "mcp-sub-agents.json"), source);
  await fs.writeFile(
    join(root, "agents", "worker.md"),
    "---\nname: worker\ndescription: Worker\nprompt_mode: replace\ntools: []\nmcp: [selected]\n---\n" +
      secret,
  );
  const model: Model<Api> = {
    api: "offline",
    provider: "offline",
    id: "model",
    name: "Model",
    baseUrl: "https://unused.invalid",
    reasoning: false,
    input: ["text"],
    contextWindow: 100000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  app.ctx.model = model;
  app.ctx.modelRegistry.getAll = () => [model];
  const check = app.tools.get("subagent_preflight")!;
  const report = await check.execute("valid", { agent: "worker" }, undefined, undefined, app.ctx);
  assert.equal(report.isError, false, "the safe preparation path must actually complete");
  assert.equal(
    JSON.stringify(report).includes(secret),
    false,
    "selected secrets and instructions stay private",
  );
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
  assert.equal(await fs.readFile(join(root, "mcp-sub-agents.json"), "utf8"), source);
  await fs.writeFile(join(root, "mcp-sub-agents.json"), `{bad-json:${secret}}`);
  const failed = await check.execute("invalid", { agent: "worker" }, undefined, undefined, app.ctx);
  assert.equal(failed.isError, true, "the failure projection must also be exercised");
  assert.equal(
    JSON.stringify(failed).includes(secret),
    false,
    "parser failure cannot disclose config",
  );
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
  await app.shutdown();
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
    .get("spawn_agent")!
    .execute("private", { agent: secret, task: "No effects" }, undefined, undefined, app.ctx);
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
    .get("spawn_agent")!
    .execute(
      "private",
      { agent: privateAgent, task: "Inspect private configuration" },
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
      .get("spawn_agent")!
      .execute("ui-failure", { agent: "worker", task: "No effects" }, undefined, undefined, app.ctx)
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
    .get("spawn_agent")!
    .execute("shutdown", { agent: secret, task: "No effects" }, undefined, undefined, app.ctx);
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
