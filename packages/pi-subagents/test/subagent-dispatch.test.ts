import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { registerSubagents } from "../src/controller/index.ts";

// Exercise the real SDK dispatcher and package owners; substitute only the external provider.
test("subagent preserves authority, results and failure classification through native dispatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-contract-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "agents"));
  await writeFile(
    join(root, "agents", "worker.md"),
    "---\nname: worker\ndescription: Worker\nmodel: offline/child\ntools: [operation]\nprompt_mode: replace\n---\nPRIVATE_CHILD_POLICY",
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
  const child = { ...model, id: "child" };
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  let parentRequests = 0;
  let childRequests = 0;
  let writes = 0;
  let permitted = false;
  let providerFailure = false;
  let parentTool = "subagent";
  let parentCallId = "spawn-initial";
  const task = "Review the current operation";
  const finding = "Verified child finding." + "x".repeat(12_000);
  let args: ToolCall["arguments"] = { agent: "worker", handoff: task };
  runtime.registerNativeProvider({
    id: "offline",
    name: "Offline",
    getModels: () => [model, child],
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
    streamSimple(requested) {
      const parent = requested.id === model.id;
      const request = parent ? ++parentRequests : ++childRequests;
      const callsTool = request === 1;
      const failed = !parent && !callsTool && providerFailure;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message: AssistantMessage = {
          role: "assistant",
          api: requested.api,
          provider: requested.provider,
          model: requested.id,
          content: callsTool
            ? [
                {
                  type: "toolCall",
                  id: parent ? parentCallId : `inner-${permitted}-${providerFailure}`,
                  name: parent ? parentTool : "operation",
                  arguments: parent ? args : {},
                },
              ]
            : [{ type: "text", text: parent ? "Done" : finding }],
          stopReason: failed ? "error" : callsTool ? "toolUse" : "stop",
          ...(failed ? { errorMessage: "Controlled provider failure" } : {}),
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: parent ? 0 : 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: parent ? 0 : 1,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        if (failed) stream.push({ type: "error", reason: "error", error: message });
        else stream.push({ type: "done", reason: callsTool ? "toolUse" : "stop", message });
        stream.end();
      });
      return stream;
    },
  });
  const settings = SettingsManager.inMemory({
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
        pi.on("tool_call", (event) => {
          if (event.toolName === "operation" && !permitted)
            return { block: true, reason: "Permission denied" };
        });
        pi.registerTool({
          name: "operation",
          label: "Operation",
          description: "Protected operation",
          parameters: Type.Object({}),
          async execute() {
            writes++;
            return { content: [], details: undefined };
          },
        });
      },
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
  });
  const events: AgentSessionEvent[] = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  session.subscribe((event) => events.push(JSON.parse(JSON.stringify(event))));
  try {
    await session.bindExtensions({
      mode: "rpc",
      uiContext: {
        setStatus(key: string, text: string | undefined) {
          statuses.push({ key, text });
        },
      } as unknown as Parameters<typeof session.bindExtensions>[0]["uiContext"],
    });
    await session.prompt("Delegate the operation to worker");
    assert(childRequests > 0, "the delegated task must actually execute");
    assert.equal(writes, 0, "child tool execution must retain parent permission enforcement");
    const updates = events.filter(
      (event) => event.type === "tool_execution_update" && event.toolName === "subagent",
    );
    const end = events.find(
      (event) => event.type === "tool_execution_end" && event.toolName === "subagent",
    );
    assert(end?.type === "tool_execution_end", "the original SDK tool call must settle");
    assert(
      updates.some((event) => {
        if (event.type !== "tool_execution_update") return false;
        const row = (
          event.partialResult?.details as {
            results?: Array<{
              model?: string;
              messages?: Array<{ content?: Array<{ text?: string }> }>;
            }>;
          }
        )?.results?.[0];
        return (
          row?.model === "offline/child" &&
          row?.messages?.[0]?.content?.[0]?.text === "Status: Running · operation"
        );
      }),
      "running updates must project child model and active tool status to T3",
    );
    assert(
      statuses.some(
        (entry) =>
          entry.key === "pi-subagents.activity" &&
          entry.text === "SubAgents (1): worker (Running · operation)",
      ),
      "RPC setStatus must report active subagent tool status for T3 banners",
    );
    assert(
      !updates.some((event) => JSON.stringify(event).includes("Waiting for tool slot")),
      "uncontended tool calls must not flicker Waiting for tool slot in tool_execution_update",
    );
    assert(
      !statuses.some((entry) => entry.text?.includes("Waiting for tool slot")),
      "uncontended tool calls must not flicker Waiting for tool slot in RPC setStatus",
    );
    assert.equal(
      statuses.at(-1)?.text,
      undefined,
      "RPC setStatus must clear once all owned runs settle",
    );
    // T3 emitSubagentTasks reads details.results (including model), not the outer isError or outcome.
    assert.partialDeepStrictEqual(end.result.details, {
      outcome: "succeeded",
      results: [
        { agent: "worker", task, model: "offline/child", finished: true, stopReason: "stop" },
      ],
    });
    assert(
      JSON.stringify(end.result.content).includes(finding),
      "display truncation must not shorten the authorized result",
    );
    const disclosed = JSON.stringify([
      ...updates.map((event) =>
        event.type === "tool_execution_update" ? event.partialResult : undefined,
      ),
      end.result,
    ]);
    assert(
      !disclosed.includes("PRIVATE_CHILD_POLICY"),
      "child policy must remain private in progress and final disclosure",
    );
    permitted = true;
    parentCallId = "spawn-authorized";
    parentRequests = 0;
    childRequests = 0;
    await session.prompt("Delegate the now-authorized operation to worker");
    assert(writes > 0, "the same delegated operation must work when authorized");

    const completed = events.findLast(
      (event) => event.type === "tool_execution_end" && event.toolName === "subagent",
    );
    assert(completed?.type === "tool_execution_end");
    const details = completed.result.details as { agentId: string };
    parentTool = "followup_task";
    parentCallId = "call_followup|fc_검토 2차";
    args = {
      agentId: details.agentId,
      handoff: "Review earlier evidence",
      requestId: "ignored-caller-id",
    };
    parentRequests = 0;
    childRequests = 0;
    events.length = 0;
    statuses.length = 0;
    await session.prompt("Continue the same agent through followup_task");
    assert(childRequests > 0, "followup_task must execute in the retained conversation");
    assert(
      statuses.some(
        (entry) =>
          entry.key === "pi-subagents.activity" &&
          entry.text?.includes("worker (Running · operation)"),
      ),
      "followup_task must also surface live activity via RPC setStatus for T3 banners",
    );
    assert.equal(
      statuses.at(-1)?.text,
      undefined,
      "RPC setStatus must clear after followup_task settles",
    );
    const requestsAfterFollowup = childRequests;
    const writesAfterFollowup = writes;
    parentRequests = 0;
    await session.prompt("Retry the same accepted follow-up");
    assert.equal(childRequests, requestsAfterFollowup, "retry must not run another model turn");
    assert.equal(writes, writesAfterFollowup, "retry must not repeat tool effects");

    const acceptedFollowup = { ...args };
    args = { ...acceptedFollowup, handoff: "Different work with the same request ID" };
    parentRequests = 0;
    childRequests = 0;
    await session.prompt("Reject a conflicting follow-up without repeating work");
    assert.equal(writes, writesAfterFollowup, "a conflicting retry must not execute work");

    args = { ...acceptedFollowup, agent: "ignored-agent", requestId: "changed-extra-id" };
    parentRequests = 0;
    await session.prompt("Redeliver the same call with different extra fields");
    assert.equal(childRequests, 0, "extra fields must not change request identity");
    assert.equal(writes, writesAfterFollowup);

    parentTool = "subagent";
    let invalidCall = 0;
    for (const invalid of [
      acceptedFollowup,
      args,
      { agent: "worker", handoff: task, agentId: "" },
      { agent: "worker", handoff: task, requestId: null },
    ]) {
      args = invalid;
      parentCallId = "wrong-create-" + ++invalidCall;
      parentRequests = 0;
      childRequests = 0;
      await session.prompt("Reject continuation fields on creation without executing");
      assert.equal(writes, writesAfterFollowup, "wrong-tool input must not create work");
    }

    const writesBeforeNextTask = writes;
    parentCallId = "spawn-second";
    args = { agent: "worker", handoff: task };
    parentRequests = 0;
    childRequests = 0;
    events.length = 0;
    await session.prompt("Create a second conversation through subagent");
    assert.equal(writes, writesBeforeNextTask + 1, "the authorized task must execute once");
    const spawned = events.find(
      (event) => event.type === "tool_execution_end" && event.toolName === "subagent",
    );
    if (spawned?.type !== "tool_execution_end") throw new Error("Delegation did not settle");
    parentTool = "followup_task";
    parentCallId = "call_second|fc_first";
    args = {
      agentId: (spawned.result.details as { agentId: string }).agentId,
      handoff: "Perform the next authorized operation",
      requestId: "same-extra-id-for-distinct-calls",
      agent: "ignored-agent",
      task: "Ignored text",
      message: "Ignored text",
    };
    parentRequests = 0;
    childRequests = 0;
    await session.prompt("Continue the second conversation through followup_task");
    assert.equal(writes, writesBeforeNextTask + 2, "the next authorized task must execute");
    parentRequests = 0;
    childRequests = 0;
    await session.prompt("Redeliver the same SDK call");
    assert.equal(writes, writesBeforeNextTask + 2, "redelivery must not repeat effects");

    parentCallId = "call_second|fc_distinct";
    parentRequests = 0;
    childRequests = 0;
    await session.prompt("Submit the same text as a distinct SDK call");
    assert.equal(
      writes,
      writesBeforeNextTask + 3,
      "a new call must not be deduplicated by text or a partial ID",
    );
    const writesBeforeInvalid = writes;
    const invalidContinuations: ToolCall["arguments"][] = [
      { ...args, agentId: "" },
      { ...args, handoff: "" },
      { agent: "worker", handoff: task },
      { ...args, handoff: { text: "Do not execute this operation" } },
      { ...args, handoff: { text: "", runId: "source-run" } },
      { ...args, handoff: " " },
      { ...args, agentId: "not-a-uuid / 없는 대화" },
      { agentId: args.agentId, task: "No handoff provided", message: "Not a handoff alias" },
      { ...args, handoff: { text: "" } },
    ];
    for (const invalid of invalidContinuations) {
      args = invalid;
      parentCallId = "invalid-followup-" + ++invalidCall;
      parentRequests = 0;
      childRequests = 0;
      await session.prompt("Reject an incomplete or ambiguous continuation without executing");
      assert.equal(writes, writesBeforeInvalid, "invalid intent must not execute work");
    }

    parentTool = "subagent";
    args = { agent: "worker", handoff: task };
    providerFailure = true;
    parentCallId = "spawn-provider-failure";
    parentRequests = 0;
    childRequests = 0;
    events.length = 0;
    await session.prompt("Delegate the operation with a failing child provider");
    const failed = events.find(
      (event) => event.type === "tool_execution_end" && event.toolName === "subagent",
    );
    assert(failed?.type === "tool_execution_end");
    assert.partialDeepStrictEqual(
      failed.result.details,
      {
        outcome: "failed",
        cleanup: "safe",
        results: [{ agent: "worker", task, finished: true, stopReason: "error" }],
      },
      "an actual provider failure must reach T3 as failed, not interrupted or completed",
    );
  } finally {
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
});
