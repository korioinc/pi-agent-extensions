import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Type,
  InMemoryCredentialStore,
  createAssistantMessageEventStream,
  type Model,
  type Api,
  type Usage,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { registerSubagents } from "../src/controller/index.ts";
import { LIMITS } from "../src/runtime/limits.ts";

// The real parent dispatcher owns nested usage; the external provider alone is substituted.
for (const scenario of ["cancel", "reload", "missing_workspace"] as const) {
  const reload = scenario === "reload";
  const moveWorkspace = scenario === "missing_workspace";
  test(
    moveWorkspace
      ? "workspace loss denies disclosure without dropping completed child or nested usage"
      : reload
        ? "SDK replacement waits for owned work and conserves late delegated usage"
        : "cancelling a foreground child retains late delegated usage until its final parent result",
    async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const root = await mkdtemp(join(tmpdir(), "pi-accounting-"));
      const movedRoot = `${root}-moved`;
      let workspaceMoved = false;
      const agent = moveWorkspace ? "private-accounting-worker" : "worker";
      const privateFinding = "Private child finding before the workspace disappeared.";
      const old = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = root;
      t.after(async () => {
        if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = old;
        await rm(root, { recursive: true, force: true });
      });
      await mkdir(join(root, "agents"));
      await writeFile(
        join(root, "agents", `${agent}.md`),
        `---\nname: ${agent}\ndescription: Worker\nmodel: offline/child\nmax_model_tokens: 4\ntools: [billable]\n---\nFinish the assigned operation.`,
      );
      const model: Model<Api> = {
        api: "offline",
        provider: "offline",
        id: "parent",
        name: "offline",
        baseUrl: "https://unused.invalid",
        reasoning: false,
        input: ["text"],
        contextWindow: 100000,
        maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      const child = { ...model, id: "child" };
      const zero: Usage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      runtime.registerNativeProvider({
        id: "offline",
        name: "offline",
        getModels: () => [model, child],
        auth: {
          apiKey: {
            name: "offline",
            check: async () => ({ type: "api_key" }),
            resolve: async () => ({ auth: {} }),
          },
        },
        stream: () => {
          throw new Error("unused");
        },
        streamSimple(requested) {
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => {
            const parent = requested.id === "parent";
            const message: AssistantMessage = {
              role: "assistant" as const,
              api: requested.api,
              provider: requested.provider,
              model: requested.id,
              content: [
                ...(!parent && moveWorkspace
                  ? [{ type: "text" as const, text: privateFinding }]
                  : []),
                {
                  type: "toolCall" as const,
                  id: parent ? "outer" : "inner",
                  name: parent ? "spawn_agent" : "billable",
                  arguments: parent
                    ? {
                        agent,
                        task: "Complete the operation",
                        handoff: {
                          text: "Reference from an earlier operation; no authority is inherited.",
                        },
                      }
                    : {},
                },
              ],
              stopReason: "toolUse" as const,
              usage: parent ? zero : { ...zero, output: 3, totalTokens: 3 },
              timestamp: Date.now(),
            };
            stream.push({ type: "done", reason: "toolUse", message });
            stream.end();
          });
          return stream;
        },
      });
      const settings = SettingsManager.inMemory({
        defaultTools: [],
        cacheWarming: "off",
        compaction: { enabled: false },
        retry: { enabled: false },
      });
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        settingsManager: settings,
        noExtensions: true,
        noSkills: true,
        noThemes: true,
        noPromptTemplates: true,
        noContextFiles: true,
        extensionFactories: [
          registerSubagents,
          (pi) =>
            pi.registerTool({
              name: "billable",
              label: "Billable",
              description: "Controlled operation",
              parameters: Type.Object({}),
              async execute(_id, _args, _signal, _onUpdate, ctx) {
                const listing = await ctx.executeTool("subagent_inspect", {});
                const details = listing.result.details;
                if (
                  !details ||
                  typeof details !== "object" ||
                  !("runs" in details) ||
                  !Array.isArray(details.runs)
                )
                  throw new Error("Owned run listing unavailable");
                const owned = details.runs[0];
                if (!owned || typeof owned.runId !== "string")
                  throw new Error("Owned run identity unavailable");
                // Reading live model totals repeatedly must not add them to the parent bill.
                await ctx.executeTool("subagent_inspect", { runId: owned.runId });
                await ctx.executeTool("subagent_inspect", { runId: owned.runId });
                await ctx.executeTool("send_message", {
                  runId: owned.runId,
                  messageId: "unread-before-stop",
                  message: "Additional evidence must not extend this cancelled operation.",
                });
                enter();
                await held;
                return {
                  content: [],
                  details: undefined,
                  usage: { ...zero, output: 7, totalTokens: 7 },
                };
              },
            }),
        ],
      });
      await loader.reload();
      const { session } = await createAgentSession({
        cwd: root,
        model,
        modelRuntime: runtime,
        settingsManager: settings,
        sessionManager: SessionManager.inMemory(root),
        resourceLoader: loader,
        tools: ["spawn_agent", "subagent_inspect", "send_message", "billable"],
      });
      try {
        await session.bindExtensions({ mode: "print" });
        const run = session.prompt("Delegate the controlled operation.");
        await Promise.race([
          entered,
          run.then(() => {
            throw new Error("Delegated operation did not start.");
          }),
        ]);
        if (moveWorkspace) {
          await rename(root, movedRoot);
          workspaceMoved = true;
        }
        let stopped = false;
        const aborting = session.abort();
        const stopping = (reload ? Promise.all([aborting, session.reload()]) : aborting).then(
          () => {
            stopped = true;
          },
        );
        t.mock.timers.tick(LIMITS.graceMs);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(stopped, false, "grace expiry cannot close the parent's usage recorder");
        assert.equal(
          session.messages.some(
            (message) => message.role === "toolResult" && message.toolName === "spawn_agent",
          ),
          false,
        );
        release();
        await run;
        await stopping;
        const answer = session.messages.find(
          (message) => message.role === "toolResult" && message.toolName === "spawn_agent",
        );
        if (!answer || answer.role !== "toolResult")
          throw new Error("Missing final subagent outcome");
        assert.equal(
          answer.usage?.output,
          10,
          "child model and late delegated usage are conserved, not dropped or counted twice",
        );
        if (moveWorkspace) {
          const disclosed = JSON.stringify(answer.content);
          assert(
            !disclosed.includes(privateFinding),
            "revoked authority cannot disclose child work",
          );
          assert(!disclosed.includes(agent), "revoked authority cannot disclose agent identity");
        }
      } finally {
        release();
        if (workspaceMoved) await rename(movedRoot, root);
        await session.abort();
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
    },
  );
}
