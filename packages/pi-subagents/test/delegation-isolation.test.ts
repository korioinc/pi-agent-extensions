import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAssistantMessageEventStream,
  getCurrentSystemMessage,
  getSystemMessageText,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { registerSubagents } from "../src/controller/index.ts";
import { SPAWN_GUIDELINES } from "../src/instructions/parent.ts";

for (const mode of ["append", "replace"]) {
  test(`${mode} children cannot receive parent delegation instructions or start nested work`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-parent-only-delegation-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    t.after(async () => {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    });
    await mkdir(join(root, "agents"));
    const definition = `---\nname: worker\ndescription: PARENT_ONLY_CATALOG_DATA\nmodel: offline/child\ntools: all\nprompt_mode: ${mode}\n---\nCHILD_ASSIGNMENT_POLICY`;
    await writeFile(join(root, "agents", "worker.md"), definition);
    const parent: Model<Api> = {
      api: "offline",
      provider: "offline",
      id: "parent",
      name: "Offline parent",
      baseUrl: "https://unused.invalid",
      reasoning: false,
      input: ["text"],
      contextWindow: 100000,
      maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const child = { ...parent, id: "child" };
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    let parentRequests = 0;
    let childRequests = 0;
    const childPrompts: { prompt: string; system: string }[] = [];
    let parentReceivedGuidance = false;
    let revoked = false;
    let workAfterRevocation = false;
    runtime.registerNativeProvider({
      id: "offline",
      name: "Offline",
      getModels: () => [parent, child],
      auth: {
        apiKey: {
          name: "Offline",
          check: async () => ({ type: "api_key" }),
          resolve: async () => ({ auth: {} }),
        },
      },
      stream: () => {
        throw new Error("unused");
      },
      streamSimple(model, context) {
        const isParent = model.id === parent.id;
        const request = isParent ? ++parentRequests : ++childRequests;
        const system = getCurrentSystemMessage(context.messages);
        const prompt = system ? getSystemMessageText(system) : "";
        if (isParent) {
          parentReceivedGuidance = SPAWN_GUIDELINES.every((rule) => prompt.includes(rule));
        } else {
          if (revoked) workAfterRevocation = true;
          childPrompts.push({ prompt, system: JSON.stringify(system) });
          if (childRequests > 2) throw new Error("Nested execution crossed the child boundary");
        }
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const callsTool = request === 1 || (isParent && (request === 3 || request === 4));
          const refresh = isParent && request === 3;
          const message: AssistantMessage = {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            content: callsTool
              ? [
                  {
                    type: "toolCall",
                    id: `${isParent ? "parent" : "child"}-${request}`,
                    name: refresh ? "list_agents" : "spawn_agent",
                    arguments: refresh
                      ? {}
                      : { agent: "worker", task: "Complete only this assignment" },
                  },
                ]
              : [{ type: "text", text: "Finished" }],
            stopReason: callsTool ? "toolUse" : "stop",
            timestamp: Date.now(),
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
          stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
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
        (pi) => {
          pi.on("before_agent_start", (event) => {
            event.systemPromptOptions.promptGuidelines.push("PRESERVED_USER_POLICY");
          });
        },
      ],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: root,
      model: parent,
      modelRuntime: runtime,
      settingsManager: settings,
      sessionManager: SessionManager.inMemory(root),
      resourceLoader: loader,
      tools: [
        "spawn_agent",
        "list_agents",
        "subagent_preflight",
        "subagent_inspect",
        "interrupt_agent",
        "send_message",
      ],
    });
    try {
      await session.bindExtensions({ mode: "print" });
      await session.prompt("Delegate this assignment to worker.");
      assert.ok(parentReceivedGuidance, "parent receives its delegation policy");
      assert.ok(childPrompts.length > 0, "the authorized child must actually reach the provider");
      assert.ok(childRequests <= 2, "an attempted nested spawn must not start another child");
      for (const { prompt, system } of childPrompts) {
        assert.ok(
          SPAWN_GUIDELINES.every((rule) => !prompt.includes(rule)),
          "parent orchestration instructions must not cross the child boundary",
        );
        assert.ok(
          !system.includes("PARENT_ONLY_CATALOG_DATA"),
          "parent catalog must not cross the child boundary",
        );
        assert.ok(prompt.includes("CHILD_ASSIGNMENT_POLICY"), "child's own policy is retained");
        if (mode === "append")
          assert.ok(
            prompt.includes("PRESERVED_USER_POLICY"),
            "unrelated inherited policy must survive filtering",
          );
      }
      // An explicit SDK allowlist must not undo a later tool revocation on metadata refresh.
      revoked = true;
      session.setActiveToolsByName(["list_agents"]);
      await writeFile(
        join(root, "agents", "worker.md"),
        definition.replace("PARENT_ONLY_CATALOG_DATA", "UPDATED_CATALOG_DATA"),
      );
      await session.prompt("Refresh the definitions, then attempt the now-revoked delegation.");
      assert.equal(workAfterRevocation, false, "catalog refresh must not authorize revoked work");
    } finally {
      await session.abort();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  });
}
