import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { Type } from "typebox";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { registerSubagents } from "../src/controller/index.ts";
import type { RunView } from "../src/runner-pool/index.ts";
import { LIMITS } from "../src/runtime/limits.ts";

for (const scenario of [
  "recover",
  "exhaust",
  "disabled",
  "nonretryable",
  "cancel",
  "deadline",
  "revoked",
  "tokens",
] as const) {
  test(`native child retry ${scenario} retains one execution owner and prior effects`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const root = await mkdtemp(join(tmpdir(), "pi-child-retry-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    t.after(async () => {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    });
    await mkdir(join(root, "agents"));
    const agent = "retry-worker";
    await writeFile(
      join(root, "agents", `${agent}.md`),
      `---\nname: ${agent}\ndescription: Worker\nmodel: offline/child\nprompt_mode: ${scenario === "recover" ? "replace" : "append"}\ntools: [effect]\n${scenario === "tokens" ? "max_model_tokens: 2\n" : ""}---\nFinish only the assigned operation.`,
    );
    const model: Model<Api> = {
      api: "offline",
      provider: "offline",
      id: "parent",
      name: "Offline",
      baseUrl: "https://unused.invalid",
      reasoning: false,
      input: ["text"],
      contextWindow: 100000,
      maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const childModel = { ...model, id: "child" };
    const settings = SettingsManager.inMemory({
      cacheWarming: "off",
      compaction: { enabled: false },
      retry: {
        enabled: scenario !== "disabled",
        maxRetries: 2,
        baseDelayMs: 10_000,
        maxAgentDelayMs: 10_000,
      },
    });
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const events: AgentSessionEvent[] = [];
    let nextRetry!: () => void;
    let retryNotice = new Promise<void>((resolve) => {
      nextRetry = resolve;
    });
    const bind = AgentSession.prototype.bindExtensions;
    t.mock.method(
      AgentSession.prototype,
      "bindExtensions",
      async function (this: AgentSession, ...args: Parameters<typeof bind>) {
        if (this.model?.id === "child") {
          this.subscribe((event) => {
            if (event.type === "auto_retry_start") {
              nextRetry();
            }
          });
        }
        return bind.apply(this, args);
      },
    );
    let parentRequests = 0;
    let childRequests = 0;
    let effects = 0;
    let receiptRetained = false;
    let followupAgentId: string | undefined;
    const historyIds = new Set<string | undefined>();
    runtime.registerNativeProvider({
      id: "offline",
      name: "Offline",
      getModels: () => [model, childModel],
      auth: {
        apiKey: {
          name: "Offline",
          check: async () => ({ type: "api_key" }),
          resolve: async () => ({ auth: {} }),
        },
      },
      stream() {
        throw new Error("unused");
      },
      streamSimple(requested, context, options) {
        const parent = requested.id === "parent";
        const request = parent ? ++parentRequests : ++childRequests;
        const tool = request === 1;
        const summary =
          !parent &&
          JSON.stringify(context.messages).includes(
            "The delegated run has stopped and remains incomplete.",
          );
        const recovered = scenario === "recover" && request >= 4 && !followupAgentId;
        const failed = !parent && !tool && !recovered;
        if (!parent) {
          historyIds.add(options?.sessionId);
          if (request > 2)
            receiptRetained ||= context.messages.some(
              (message) =>
                message.role === "toolResult" &&
                JSON.stringify(message.content).includes("effect receipt"),
            );
        }
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const errorMessage =
            scenario === "nonretryable"
              ? "401 Unauthorized"
              : request === 2
                ? "terminated"
                : "503 no available server";
          const message: AssistantMessage = {
            role: "assistant",
            api: requested.api,
            provider: requested.provider,
            model: requested.id,
            content: tool
              ? [
                  {
                    type: "toolCall",
                    id: parent ? (followupAgentId ? "followup" : "spawn") : "effect",
                    name: parent ? (followupAgentId ? "followup_task" : "subagent") : "effect",
                    arguments: parent
                      ? followupAgentId
                        ? {
                            agentId: followupAgentId,
                            handoff: "Verify without repeating the effect",
                          }
                        : { agent, handoff: "Record once, then verify" }
                      : {},
                  },
                ]
              : [
                  {
                    type: "text",
                    text: parent ? "Done" : failed ? "Partial evidence" : "Verified receipt",
                  },
                ],
            stopReason: failed ? "error" : tool ? "toolUse" : "stop",
            ...(failed ? { errorMessage: summary ? "503 summary unavailable" : errorMessage } : {}),
            timestamp: Date.now(),
            usage: {
              input: 0,
              output: parent ? 0 : 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: parent ? 0 : 1,
              cost: {
                input: 0,
                output: parent ? 0 : 0.25,
                cacheRead: 0,
                cacheWrite: 0,
                total: parent ? 0 : 0.25,
              },
            },
          };
          if (failed) stream.push({ type: "error", reason: "error", error: message });
          else stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message });
          stream.end();
        });
        return stream;
      },
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
            name: "effect",
            label: "Effect",
            description: "Record once",
            parameters: Type.Object({}),
            async execute() {
              effects++;
              return { content: [{ type: "text", text: "effect receipt" }], details: undefined };
            },
          }),
      ],
    });
    await loader.reload();
    const parentHistory = SessionManager.inMemory(root);
    const { session } = await createAgentSession({
      cwd: root,
      model,
      modelRuntime: runtime,
      settingsManager: settings,
      sessionManager: parentHistory,
      resourceLoader: loader,
    });
    session.subscribe((event) => events.push(event));
    try {
      await session.bindExtensions({ mode: "rpc" });
      const running = session.prompt("Delegate the operation");
      let settled = false;
      void running.then(() => {
        settled = true;
      });
      if (scenario !== "disabled" && scenario !== "nonretryable" && scenario !== "tokens") {
        await Promise.race([
          retryNotice,
          running.then(() => {
            throw new Error("Child ended without scheduling retry");
          }),
        ]);
        await setImmediate();
        assert.equal(settled, false, "backoff retains the original foreground call");
        // The invocation owns a snapshot, not subsequent parent settings edits.
        if (scenario === "recover") settings.applyOverrides({ retry: { enabled: false } });
        if (scenario === "cancel") {
          await session.abort();
        } else if (scenario === "revoked") {
          parentHistory.resetLeaf();
          parentHistory.appendCustomEntry("different-branch", {});
          t.mock.timers.tick(10_000);
        } else if (scenario === "deadline") {
          t.mock.timers.tick(LIMITS.invocationMs);
          await setImmediate();
          t.mock.timers.tick(LIMITS.safeguardFinishMs);
        } else {
          retryNotice = new Promise<void>((resolve) => {
            nextRetry = resolve;
          });
          t.mock.timers.tick(10_000);
          await Promise.race([
            retryNotice,
            running.then(() => {
              throw new Error("Second transient failure did not retry");
            }),
          ]);
          await setImmediate();
          t.mock.timers.tick(10_000);
        }
      }
      await running;
      const end = events.find(
        (event) => event.type === "tool_execution_end" && event.toolName === "subagent",
      );
      assert(end?.type === "tool_execution_end");
      const details = end.result.details as RunView & { rejection?: string };
      assert.equal(
        effects,
        1,
        "native recovery must retain the completed tool result instead of replaying it",
      );
      assert.equal(historyIds.size, 1, "recovery stays in the original child conversation");
      assert.equal(end.result.usage?.output, childRequests, "every attempt is billed once");
      assert.equal(end.result.usage?.cost.total, childRequests * 0.25);
      if (scenario === "recover") {
        assert.equal(details.outcome, "succeeded");
        assert.equal(details.error, undefined);
        assert.equal(details.failure, undefined);
        assert.equal(details.text, "Verified receipt");
        assert(receiptRetained);
        assert.equal(childRequests, 4);
        followupAgentId = details.agentId;
        assert(followupAgentId);
        parentRequests = 0;
        events.length = 0;
        await session.prompt("Continue the same conversation with the now-disabled retry policy");
        const followup = events.find(
          (event) => event.type === "tool_execution_end" && event.toolName === "followup_task",
        );
        assert(followup?.type === "tool_execution_end");
        assert.equal((followup.result.details as RunView).outcome, "failed");
        assert.equal(childRequests, 5, "a new invocation captures the changed parent retry policy");
        assert.equal(historyIds.size, 1, "idle continuation retains native history");
        assert.equal(effects, 1, "idle continuation must not replay a prior effect");
        assert.equal(
          followup.result.usage?.output,
          1,
          "continuation bills only its own failed request",
        );
      } else if (scenario === "exhaust") {
        assert.equal(details.outcome, "failed");
        assert.equal(details.error, "503 no available server");
        assert.equal(
          details.failure?.model?.requestIndex,
          4,
          "terminal diagnostics must not retain the first recovered attempt",
        );
        assert.equal(childRequests, 4);
      } else if (scenario === "cancel") {
        assert.equal(details.outcome, "cancelled");
        t.mock.timers.tick(60_000);
        await setImmediate();
        assert.equal(childRequests, 2, "cancelling backoff prevents another dispatch");
      } else if (scenario === "revoked") {
        assert.equal(details.rejection, "not_available");
        assert.equal(childRequests, 2, "revoked authority prevents retry dispatch");
      } else if (scenario === "tokens") {
        assert.equal(details.failure?.code, "model_token_limit");
        assert.equal(childRequests, 2);
      } else if (scenario === "deadline") {
        assert.equal(details.outcome, "failed");
        assert.equal(details.failure?.code, "invocation_limit");
        assert.equal(childRequests, 3, "expiry permits only one non-retrying summary request");
      } else {
        assert.equal(details.outcome, "failed");
        assert.equal(childRequests, 2, "disabled policy and non-transient errors must not retry");
      }
    } finally {
      await session.abort();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  });
}
