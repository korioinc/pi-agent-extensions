import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rename, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import { SessionManager, AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AgentRegistry, type ParentAccess } from "../src/agent-registry/index.ts";
import { RunnerPool } from "../src/runner-pool/index.ts";
import { runResearch, type RunnerIngress } from "../src/runner/index.ts";
import type { ResearchHost } from "../src/runtime/index.ts";
import { inspectWorkspace } from "../src/workspace/identity.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function withIngress(adapt: (ingress: RunnerIngress) => RunnerIngress): typeof runResearch {
  return (source, input, control, continuation) =>
    runResearch(
      source,
      input,
      control,
      continuation && {
        ...continuation,
        onReady: (ingress) => continuation.onReady(adapt(ingress)),
      },
    );
}
async function fixture(t: TestContext, invoke: typeof runResearch = runResearch) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "pi-continuation-")));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  await mkdir(join(root, "agents"));
  const definition = join(root, "agents", "worker.md");
  await writeFile(
    definition,
    "---\nname: worker\ndescription: Worker\nprompt_mode: replace\ntools: [effect]\n---\nComplete the assignment.",
  );
  const parent = SessionManager.inMemory(root);
  parent.appendMessage({ role: "user", content: "Parent task", timestamp: Date.now() });
  const model: Model<Api> = {
    api: "offline",
    provider: "offline",
    id: "child",
    name: "Offline",
    baseUrl: "https://unused.invalid",
    reasoning: false,
    input: ["text"],
    contextWindow: 100000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const entered = deferred();
  const release = deferred();
  let hold = false;
  let reached = 0;
  const waiting = new Map<number, () => void>();
  let requests = 0;
  let effects = 0;
  let observedPrivate = false;
  let observedSteering = false;
  const host: ResearchHost = {
    cwd: root,
    workspace: inspectWorkspace(root),
    signal: undefined,
    trustedProject: false,
    model,
    models: [model],
    thinkingLevel: "off",
    tools: [
      {
        name: "effect",
        label: "Effect",
        description: "Record local evidence",
        parameters: Type.Object({}),
      },
    ],
    toolMetadata: [{ name: "effect", source: "extension", aggregator: false }],
    executeTool: async () => {
      effects++;
      await appendFile(join(root, "effects"), "effect\n");
      entered.resolve();
      reached++;
      waiting.get(reached)?.();
      if (hold) await release.promise;
      return {
        toolCall: { type: "toolCall", id: "effect", name: "effect", arguments: {} },
        result: {
          content: [{ type: "text", text: "Private evidence from local tool" }],
          details: undefined,
        },
        isError: false,
      };
    },
    stream(requested, context) {
      requests++;
      const text = JSON.stringify(context.messages);
      const isFollowup = text.includes("Review earlier evidence");
      const isSteered = text.includes("Additional assigned task");
      if (isFollowup)
        observedPrivate =
          text.includes("Private evidence from local tool") &&
          text.includes("Private finding recorded");
      if (isSteered) observedSteering = true;
      const tool = !context.messages.some((message) => message.role === "toolResult");
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message: AssistantMessage = {
          role: "assistant",
          api: requested.api,
          provider: requested.provider,
          model: requested.id,
          content: tool
            ? [{ type: "toolCall", id: `effect-${requests}`, name: "effect", arguments: {} }]
            : [
                {
                  type: "text",
                  text: isFollowup
                    ? observedPrivate
                      ? "Prior finding verified"
                      : "Missing evidence"
                    : "Private finding recorded",
                },
              ],
          stopReason: tool ? "toolUse" : "stop",
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 2,
            totalTokens: 2,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message });
        stream.end();
      });
      return stream;
    },
  };
  const input = {
    current: () => ({
      sessionId: parent.getSessionId(),
      cwd: root,
      workspace: inspectWorkspace(root),
      anchor: parent.getLeafId(),
      branch: new Set(parent.getBranch().map((entry) => entry.id)),
      trustedProject: host.trustedProject,
    }),
    fence: (data) => parent.appendCustomEntry("pi-subagent-fence", data),
    scope: () => host,
    capture: () => host,
  } satisfies ParentAccess;
  const pool = new RunnerPool();
  const registry = new AgentRegistry(pool, invoke);
  t.after(async () => {
    release.resolve();
    await registry.drain();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    definition,
    parent,
    host,
    pool,
    registry,
    input,
    entered,
    release,
    hold: () => {
      hold = true;
    },
    waitForEffects: (count: number) =>
      reached >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiting.set(count, resolve);
          }),
    requests: () => requests,
    effects: () => effects,
    observedPrivate: () => observedPrivate,
    observedSteering: () => observedSteering,
  };
}
function accepted(value: unknown): {
  agentId: string;
  runId: string;
  text: string;
  usage: { totalTokens: number };
} {
  if (!value || typeof value !== "object" || !("agentId" in value))
    throw new Error(`Not admitted: ${JSON.stringify(value)}`);
  return value as { agentId: string; runId: string; text: string; usage: { totalTokens: number } };
}

for (const stop of ["cancel", "revoke"] as const)
  test(`initial committed progress can ${stop} before child effects`, async (t) => {
    const f = await fixture(t);
    const ancestor = f.parent.getLeafId()!;
    let stopped = false;
    await f.registry.spawn(
      f.input,
      "worker",
      "Record a private finding",
      undefined,
      undefined,
      (value) => {
        if (stopped || value.phase !== "preparing") return;
        stopped = true;
        if (stop === "cancel") f.pool.cancel(f.input.current(), value.runId);
        else f.parent.branch(ancestor);
      },
    );
    await assert.rejects(readFile(join(f.root, "effects")), { code: "ENOENT" });
  });

test("idle continuation retains real evidence, deduplicates concurrent retries and rejects sibling disclosure", async (t) => {
  const f = await fixture(t);
  const first = accepted(await f.registry.spawn(f.input, "worker", "Record a private finding"));
  const ancestor = f.parent.getLeafId()!;
  const input = { agentId: first.agentId, requestId: "review", message: "Review earlier evidence" };
  const [second, duplicate, competing] = await Promise.all([
    f.registry.followup(f.input, input),
    f.registry.followup(f.input, input),
    f.registry.followup(f.input, { ...input, requestId: "competing" }),
  ]);
  assert.equal(accepted(second).text, "Prior finding verified");
  assert(f.observedPrivate());
  assert.equal(f.effects(), 1, "native continuation must not replay prior local effects");
  assert.equal(accepted(second).usage.totalTokens, 2, "only the new request is billed");
  const requests = f.requests();
  await f.registry.followup(f.input, input);
  await f.registry.followup(f.input, { ...input, message: "Substituted task" });
  assert.equal(f.requests(), requests, "retries and conflicting payloads cannot dispatch");
  assert(!("usage" in duplicate), "retry does not bill the foreground owner's usage");
  assert("rejection" in competing, "competing idle task cannot silently become steering");
  const ownerLeaf = f.parent.getLeafId()!;
  f.parent.branch(ancestor);
  f.parent.appendCustomEntry("sibling", {});
  assert(!JSON.stringify(f.registry.inspect(f.input, first.agentId)).includes("Private"));
  assert("rejection" in f.pool.handoff(f.input.current(), accepted(second).runId));
  assert.equal(
    f.pool.inspectActivity(f.input.current()).length,
    0,
    "latest fence hides even old run projections",
  );
  await f.registry.followup(f.input, { ...input, requestId: "foreign" });
  assert.equal(f.requests(), requests, "sibling branch cannot execute a new task");
  f.parent.branch(ownerLeaf);
  f.registry.close(f.input, first.agentId);
  f.registry.close(f.input, first.agentId);
  await f.registry.followup(f.input, { ...input, requestId: "after-close" });
  assert.equal(f.requests(), requests, "closed histories never restart");
});

test("failed admission cannot revoke a same-turn retry's retained history access", async (t) => {
  const f = await fixture(t);
  const first = accepted(await f.registry.spawn(f.input, "worker", "Record a private finding"));
  const evidence = await readFile(join(f.root, "effects"), "utf8");
  const request = {
    agentId: first.agentId,
    requestId: "retry",
    message: "Review earlier evidence",
  };
  const failed = f.registry.followup(
    {
      ...f.input,
      fence() {
        throw new Error("Fence write failed");
      },
    },
    request,
  );
  const retry = f.registry.followup(f.input, request);
  await Promise.all([failed, retry]);
  assert(f.observedPrivate(), "the authorized retry must receive its retained private evidence");
  assert.equal(await readFile(join(f.root, "effects"), "utf8"), evidence);
});

test("active steering returns before held work, stays in one run and supplemental input advances branch authority", async (t) => {
  const f = await fixture(t);
  f.hold();
  let agentId = "";
  let runId = "";
  let finished = false;
  const foreground = f.registry
    .spawn(f.input, "worker", "Record a private finding", undefined, undefined, (value) => {
      agentId = value.agentId;
      runId = value.runId;
    })
    .then((result) => {
      finished = true;
      return result;
    });
  await f.entered.promise;
  const ancestor = f.parent.getLeafId()!;
  const receipt = await f.registry.followup(f.input, {
    agentId,
    requestId: "active",
    message: "Additional assigned task",
  });
  assert.equal(finished, false, "active receipt cannot wait for the foreground owner");
  assert(!("usage" in receipt));
  f.registry.message(f.input, {
    runId,
    messageId: "supplement",
    message: "Private supplemental evidence",
  });
  const ownerLeaf = f.parent.getLeafId()!;
  f.parent.branch(ancestor);
  f.parent.appendCustomEntry("sibling", {});
  assert.equal(f.pool.inspectActivity(f.input.current()).length, 0);
  assert(
    "rejection" in f.pool.cancel(f.input.current(), runId),
    "a sibling cannot control newly private input",
  );
  f.parent.branch(ownerLeaf);
  f.release.resolve();
  const completed = accepted(await foreground);
  assert(f.observedSteering(), "same SDK execution consumes the framed active task");
  assert.equal(completed.runId, runId);
  assert.equal(f.effects(), 1);
  const before = f.requests();
  await f.registry.followup(f.input, {
    agentId,
    requestId: "active",
    message: "Additional assigned task",
  });
  assert.equal(f.requests(), before, "active task receipt cannot replay after settlement");
});

test("an active follow-up can steer an idle continuation while its foreground owner remains pending", async (t) => {
  const f = await fixture(t);
  const first = accepted(await f.registry.spawn(f.input, "worker", "Record initial finding"));
  f.hold();
  const stream = f.host.stream;
  let requested = false;
  f.host.stream = (model, context, options) => {
    if (requested) return stream(model, context, options);
    requested = true;
    const events = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [{ type: "toolCall", id: "followup-effect", name: "effect", arguments: {} }],
        stopReason: "toolUse",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      events.push({ type: "done", reason: "toolUse", message });
      events.end();
    });
    return events;
  };
  let completed = false;
  const idle = f.registry
    .followup(f.input, {
      agentId: first.agentId,
      requestId: "idle-owner",
      message: "Review earlier evidence",
    })
    .then((value) => {
      completed = true;
      return value;
    });
  await f.waitForEffects(2);
  await f.registry.followup(f.input, {
    agentId: first.agentId,
    requestId: "steer-idle",
    message: "Additional assigned task",
  });
  assert.equal(
    completed,
    false,
    "steering receipt returns while the idle continuation still owns its tool",
  );
  f.release.resolve();
  const result = accepted(await idle);
  assert.notEqual(result.runId, first.runId, "idle continuation has its own invocation");
  assert(f.observedSteering(), "the active task reaches that same continuation runtime");
  assert.equal(f.effects(), 2, "each explicit foreground assignment commits once");
});

test("current preparation revokes idle authority without replaying effects", async (t) => {
  const f = await fixture(t);
  const first = accepted(await f.registry.spawn(f.input, "worker", "Record a private finding"));
  await writeFile(
    f.definition,
    "---\nname: worker\ndescription: Worker\nenabled: false\n---\nDisabled",
  );
  const requests = f.requests();
  await f.registry.followup(f.input, {
    agentId: first.agentId,
    requestId: "disabled",
    message: "Review earlier evidence",
  });
  assert.equal(f.requests(), requests, "disabled definition cannot make a provider request");
  assert.equal(await readFile(join(f.root, "effects"), "utf8"), "effect\n");
});

for (const stop of ["cancel", "shutdown"])
  test(`${stop} during active validation cannot orphan a late steering turn`, async (t) => {
    const preparing = deferred();
    const resume = deferred();
    const f = await fixture(
      t,
      withIngress((ingress) => ({
        ...ingress,
        validate: async () => {
          preparing.resolve();
          await resume.promise;
          return ingress.validate();
        },
      })),
    );
    f.hold();
    let agentId = "";
    let runId = "";
    const foreground = f.registry.spawn(
      f.input,
      "worker",
      "Record a private finding",
      undefined,
      undefined,
      (value) => {
        agentId = value.agentId;
        runId = value.runId;
      },
    );
    await f.entered.promise;
    const followup = f.registry.followup(f.input, {
      agentId,
      requestId: "late",
      message: "Additional assigned task",
    });
    let shutdown: Promise<void> | undefined;
    try {
      await preparing.promise;
      const ownerLeaf = f.parent.getLeafId();
      shutdown = stop === "shutdown" ? f.registry.drain() : undefined;
      if (stop === "cancel") f.pool.cancel(f.input.current(), runId);
      const before = f.requests();
      f.release.resolve();
      resume.resolve();
      await followup;
      await foreground;
      await shutdown;
      assert.equal(
        f.parent.getLeafId(),
        ownerLeaf,
        "cancelled validation cannot commit a new parent authority fence",
      );
      assert.equal(f.requests(), before, "a late validation result cannot start an orphan request");
      assert.equal(f.effects(), 1, "cancel cannot replay an already committed local effect");
      assert.equal(f.observedSteering(), false);
    } finally {
      resume.resolve();
      f.release.resolve();
      await Promise.allSettled([foreground, followup, shutdown]);
    }
  });

test("active configuration changes reject steering without changing the existing runtime", async (t) => {
  const f = await fixture(t);
  f.hold();
  let agentId = "";
  const foreground = f.registry.spawn(
    f.input,
    "worker",
    "Record a private finding",
    undefined,
    undefined,
    (value) => {
      agentId = value.agentId;
    },
  );
  await f.entered.promise;
  await writeFile(
    f.definition,
    "---\nname: worker\ndescription: Changed\nprompt_mode: replace\ntools: []\n---\nNew policy",
  );
  await f.registry.followup(f.input, {
    agentId,
    requestId: "changed",
    message: "Additional assigned task",
  });
  f.release.resolve();
  await foreground;
  assert.equal(
    f.observedSteering(),
    false,
    "changed preparation must not admit a task to stale authority",
  );
  assert.equal(f.effects(), 1);
});

test("idle continuation replaces revoked tools in the provider policy and execution loadout", async (t) => {
  const f = await fixture(t);
  const first = accepted(await f.registry.spawn(f.input, "worker", "Record a private finding"));
  await writeFile(
    f.definition,
    "---\nname: worker\ndescription: Worker\nprompt_mode: replace\ntools: []\n---\nNew policy without effect authority",
  );
  const { getCurrentSystemMessage, getSystemMessageText } = await import("@earendil-works/pi-ai");
  let currentPolicy = false;
  f.host.stream = (requested, context) => {
    const system = getCurrentSystemMessage(context.messages);
    currentPolicy =
      !!system &&
      getSystemMessageText(system).includes("New policy without effect authority") &&
      !system.toolsAdded?.some((tool) => tool.name === "effect");
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const attempted = context.messages.some(
        (message) => message.role === "toolResult" && message.toolCallId === "revoked",
      );
      const message: AssistantMessage = {
        role: "assistant",
        api: requested.api,
        provider: requested.provider,
        model: requested.id,
        content: attempted
          ? [{ type: "text", text: "Revoked tool denied" }]
          : [{ type: "toolCall", id: "revoked", name: "effect", arguments: {} }],
        stopReason: attempted ? "stop" : "toolUse",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      stream.push({ type: "done", reason: attempted ? "stop" : "toolUse", message });
      stream.end();
    });
    return stream;
  };
  await f.registry.followup(f.input, {
    agentId: first.agentId,
    requestId: "revoked",
    message: "Review earlier evidence",
  });
  assert(
    currentPolicy,
    "provider request receives current system/loadout, not historical authority",
  );
  assert.equal(f.effects(), 1, "historical tool declarations cannot execute a removed tool");
});

test("settlement during asynchronous steering never starts a hidden turn", async (t) => {
  const f = await fixture(t);
  f.hold();
  let agentId = "";
  const foreground = f.registry.spawn(
    f.input,
    "worker",
    "Record private finding",
    undefined,
    undefined,
    (value) => {
      agentId = value.agentId;
    },
  );
  await f.entered.promise;
  const entered = deferred();
  const release = deferred();
  const settled = deferred();
  const original = AgentSession.prototype.steer;
  const hook = t.mock.method(
    AgentSession.prototype,
    "steer",
    async function (this: AgentSession, ...args: Parameters<typeof original>) {
      this.subscribe((event) => {
        if (event.type === "agent_settled") settled.resolve();
      });
      entered.resolve();
      await release.promise;
      return original.apply(this, args);
    },
  );
  const followup = f.registry.followup(f.input, {
    agentId,
    requestId: "settled-race",
    message: "Additional assigned task",
  });
  await entered.promise;
  f.release.resolve();
  await settled.promise;
  const before = f.requests();
  release.resolve();
  await followup;
  await foreground;
  hook.mock.restore();
  assert.equal(f.requests(), before, "late steer cannot call prompt after settlement");
  assert.equal(f.observedSteering(), false);
  assert.equal(f.effects(), 1);
});

for (const ending of ["settlement", "cancellation"] as const) {
  test(
    `native follow-up admission survives delayed steering completion during ${ending}`,
    { timeout: 30_000 },
    async (t) => {
      const f = await fixture(t);
      f.hold();
      let agentId = "";
      let runId = "";
      let foregroundFinished = false;
      let followupFinished = false;
      let nativeHistory: SessionManager | undefined;
      let nativePrompt = "";
      const foreground = f.registry
        .spawn(f.input, "worker", "Record private finding", undefined, undefined, (value) => {
          agentId = value.agentId;
          runId = value.runId;
        })
        .then((value) => {
          foregroundFinished = true;
          return value;
        });
      const queued = deferred();
      const admitted = deferred();
      const nativeSettled = deferred();
      const permitReturn = deferred();
      const wait = async (promise: Promise<unknown>) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            promise,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error("Steering gate did not open.")), 10_000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      await wait(f.entered.promise);
      const original = AgentSession.prototype.steer;
      const hook = t.mock.method(
        AgentSession.prototype,
        "steer",
        async function (this: AgentSession, ...args: Parameters<typeof original>) {
          nativeHistory = this.sessionManager;
          nativePrompt = args[0];
          this.subscribe((event) => {
            if (event.type === "message_end" && event.message.role === "user") admitted.resolve();
            if (event.type === "agent_settled") nativeSettled.resolve();
          });
          const result = await original.apply(this, args);
          queued.resolve();
          await permitReturn.promise;
          return result;
        },
      );
      let followup: ReturnType<typeof f.registry.followup> | undefined;
      try {
        followup = f.registry
          .followup(f.input, {
            agentId,
            requestId: "held-native-return",
            message: "Additional assigned task",
          })
          .then((value) => {
            followupFinished = true;
            return value;
          });
        await wait(queued.promise);
        f.release.resolve();
        await wait(admitted.promise);
        assert(nativeHistory);
        // Public message_end precedes the native append; verify the actual history too.
        assert(
          nativeHistory.getEntries().some((entry) => {
            if (entry.type !== "message" || entry.message.role !== "user") return false;
            const content = entry.message.content;
            return typeof content === "string"
              ? content === nativePrompt
              : content.some((block) => block.type === "text" && block.text === nativePrompt);
          }),
          "the follow-up is in native history before cancellation or steering completion",
        );
        if (ending === "cancellation") f.pool.cancel(f.input.current(), runId);
        await wait(nativeSettled.promise);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(
          foregroundFinished,
          false,
          "native settlement cannot release a still-owned steering operation",
        );
        assert.equal(followupFinished, false, "the delayed delivery still owns its receipt");
        const requestsAtSettlement = f.requests();
        const committedEffects = await readFile(join(f.root, "effects"), "utf8");
        permitReturn.resolve();
        const receipt = await followup;
        assert.equal(
          "state" in receipt ? receipt.state : undefined,
          "injected_not_confirmed",
          "late steering completion cannot discard an input already admitted to native history",
        );
        const completed = await foreground;
        assert.equal(
          "outcome" in completed ? completed.outcome : undefined,
          ending === "cancellation" ? "cancelled" : "succeeded",
          "the foreground run reaches the exercised lifecycle outcome",
        );
        const retained = f.registry.inspect(f.input, agentId);
        const delivery =
          "receipts" in retained
            ? retained.receipts.find((item) => item.requestId === "held-native-return")?.delivery
            : undefined;
        assert.equal(delivery, "injected_not_confirmed", "termination preserves admitted input");
        assert.equal(
          f.requests(),
          requestsAtSettlement,
          "late completion cannot start another turn",
        );
        assert.equal(
          await readFile(join(f.root, "effects"), "utf8"),
          committedEffects,
          "late completion cannot repeat committed effects",
        );
      } finally {
        permitReturn.resolve();
        f.release.resolve();
        hook.mock.restore();
        await Promise.allSettled([foreground, followup]);
      }
    },
  );
}

test("a completed steering delivery cannot release a newer admission", async (t) => {
  const delivering = deferred();
  const resumeDelivery = deferred();
  const preparing = deferred();
  const resumePreparation = deferred();
  let holdPreparation = false;
  const f = await fixture(
    t,
    withIngress((ingress) => ({
      ...ingress,
      validate: async () => {
        if (holdPreparation) {
          preparing.resolve();
          await resumePreparation.promise;
        }
        return ingress.validate();
      },
      steer: async (requestId, message) => {
        delivering.resolve();
        await resumeDelivery.promise;
        return ingress.steer(requestId, message);
      },
    })),
  );
  f.hold();
  let agentId = "";
  let runId = "";
  const foreground = f.registry.spawn(
    f.input,
    "worker",
    "Record private finding",
    undefined,
    undefined,
    (value) => {
      agentId = value.agentId;
      runId = value.runId;
    },
  );
  await f.entered.promise;
  const first = f.registry.followup(f.input, {
    agentId,
    requestId: "early-owner",
    message: "Additional assigned task",
  });
  await delivering.promise;
  holdPreparation = true;
  const second = f.registry.followup(f.input, {
    agentId,
    requestId: "new-owner",
    message: "Review earlier evidence",
  });
  try {
    await preparing.promise;
    resumeDelivery.resolve();
    await first;
    const ownerLeaf = f.parent.getLeafId();
    f.registry.message(f.input, {
      runId,
      messageId: "competing-supplement",
      message: "Competing private evidence",
    });
    assert.equal(
      f.parent.getLeafId(),
      ownerLeaf,
      "competing input cannot advance parent authority while the newer admission is preparing",
    );
  } finally {
    resumeDelivery.resolve();
    resumePreparation.resolve();
    await Promise.all([first, second]);
    f.release.resolve();
    await foreground;
  }
});

test("intercepted active input cannot discard another queued task", async (t) => {
  const f = await fixture(t);
  f.hold();
  let agentId = "";
  const foreground = f.registry.spawn(
    f.input,
    "worker",
    "Record private finding",
    undefined,
    undefined,
    (value) => {
      agentId = value.agentId;
    },
  );
  await f.entered.promise;
  await f.registry.followup(f.input, {
    agentId,
    requestId: "queued-first",
    message: "Additional assigned task",
  });
  const hook = t.mock.method(AgentSession.prototype, "steer", async () => "handled" as const);
  await f.registry.followup(f.input, {
    agentId,
    requestId: "handled-second",
    message: "Intercepted task",
  });
  hook.mock.restore();
  f.release.resolve();
  await foreground;
  assert(
    f.observedSteering(),
    "handled input cannot erase another accepted task from the native queue",
  );
});

test("supplemental input alone tightens every retained run fence", async (t) => {
  const f = await fixture(t);
  f.hold();
  let agentId = "";
  let runId = "";
  const foreground = f.registry.spawn(
    f.input,
    "worker",
    "Record private finding",
    undefined,
    undefined,
    (value) => {
      agentId = value.agentId;
      runId = value.runId;
    },
  );
  await f.entered.promise;
  const ancestor = f.parent.getLeafId()!;
  f.registry.message(f.input, {
    runId,
    messageId: "private",
    message: "Branch-private supplemental data",
  });
  const owner = f.parent.getLeafId()!;
  f.release.resolve();
  await foreground;
  f.parent.branch(ancestor);
  f.parent.appendCustomEntry("sibling", {});
  assert("rejection" in f.pool.handoff(f.input.current(), runId));
  assert("rejection" in f.pool.cancel(f.input.current(), runId));
  assert.equal(f.pool.inspectActivity(f.input.current()).length, 0);
  assert("rejection" in f.registry.inspect(f.input, agentId));
  f.parent.branch(owner);
  assert(!("rejection" in f.pool.handoff(f.input.current(), runId)));
});

test("idle memory outlives run result retention while active ownership remains", async (t) => {
  const f = await fixture(t);
  const { LIMITS } = await import("../src/runtime/limits.ts");
  const first = accepted(await f.registry.spawn(f.input, "worker", "Record idle finding"));
  f.hold();
  let activeId = "";
  const active = f.registry.spawn(
    f.input,
    "worker",
    "Record active finding",
    undefined,
    undefined,
    (value) => {
      activeId = value.agentId;
    },
  );
  await f.waitForEffects(2);
  const now = Date.now();
  const clock = t.mock.method(Date, "now", () => now + LIMITS.retentionMs + 1);
  assert(!("rejection" in f.registry.inspect(f.input, activeId)), "active owner cannot expire");
  const continued = accepted(
    await f.registry.followup(f.input, {
      agentId: first.agentId,
      requestId: "after-retention",
      message: "Review earlier evidence",
    }),
  );
  assert.equal(continued.text, "Prior finding verified", "idle history outlives run result expiry");
  assert.equal(f.effects(), 2, "continuation cannot repeat either earlier effect");
  clock.mock.restore();
  f.release.resolve();
  await active;
});

test("a later task revokes earlier retained answers from the formerly authorized branch", async (t) => {
  const f = await fixture(t);
  const first = accepted(await f.registry.spawn(f.input, "worker", "Record a private finding"));
  const previousOwner = f.parent.getLeafId()!;
  await f.registry.followup(f.input, {
    agentId: first.agentId,
    requestId: "advance-owner",
    message: "Review earlier evidence",
  });
  const owner = f.parent.getLeafId()!;
  const visible = () => JSON.stringify(f.pool.handoff(f.input.current(), first.runId));
  assert(visible().includes(first.text), "the current owner retains access to earlier evidence");
  f.parent.branch(previousOwner);
  f.parent.appendCustomEntry("sibling", {});
  assert(!visible().includes(first.text), "an old result cannot retain stale branch authority");
  f.parent.branch(owner);
  assert(visible().includes(first.text), "returning to the current owner restores access");
});

test("lost parent access revokes every active owner before further effects", async (t) => {
  const f = await fixture(t);
  f.hold();
  let available = true;
  const input: ParentAccess = {
    ...f.input,
    current: () => (available ? f.input.current() : undefined),
  };
  const execute = f.host.executeTool;
  f.host.executeTool = async (...args) => {
    const result = await execute(...args);
    if (!args[2]?.signal?.aborted) await appendFile(join(f.root, "effects"), "late effect\n");
    return result;
  };
  const runs = [
    f.registry.spawn(input, "worker", "Record the first finding"),
    f.registry.spawn(input, "worker", "Record the second finding"),
  ];
  await f.waitForEffects(2);
  available = false;
  try {
    f.registry.revoke();
  } catch {
    // Even if one owner cannot be queried, all owned work must lose effect authority.
  }
  f.release.resolve();
  const results = await Promise.all(runs);
  assert.equal(await readFile(join(f.root, "effects"), "utf8"), "effect\neffect\n");
  assert(
    !JSON.stringify(results).includes("worker"),
    "lost authority cannot disclose agent identity",
  );
});

test("project trust revocation stops an active owner before another effect", async (t) => {
  const f = await fixture(t);
  f.host.trustedProject = true;
  f.hold();
  let trustedProject = true;
  const input: ParentAccess = {
    ...f.input,
    current: () => {
      const current = f.input.current();
      return current && { ...current, trustedProject };
    },
  };
  const execute = f.host.executeTool;
  f.host.executeTool = async (...args) => {
    const result = await execute(...args);
    if (!args[2]?.signal?.aborted) await appendFile(join(f.root, "effects"), "late effect\n");
    return result;
  };

  const running = f.registry.spawn(input, "worker", "Record a private finding");
  await f.waitForEffects(1);
  trustedProject = false;
  f.registry.revoke();
  f.release.resolve();
  const result = await running;

  assert.equal(await readFile(join(f.root, "effects"), "utf8"), "effect\n");
  assert.equal(JSON.stringify(result).includes("worker"), false);
});

test("unavailable parent access cannot close or continue retained private history", async (t) => {
  const f = await fixture(t);
  const first = accepted(await f.registry.spawn(f.input, "worker", "Record a private finding"));
  const unavailable: ParentAccess = { ...f.input, current: () => undefined };
  f.registry.close(unavailable, first.agentId);
  await f.registry.followup(unavailable, {
    agentId: first.agentId,
    requestId: "unavailable",
    message: "Review earlier evidence",
  });
  assert.equal(
    f.observedPrivate(),
    false,
    "unavailable authority cannot send private history to a model",
  );
  accepted(
    await f.registry.followup(f.input, {
      agentId: first.agentId,
      requestId: "restored",
      message: "Review earlier evidence",
    }),
  );
  assert(
    f.observedPrivate(),
    "authorized continuation can still read the retained private history",
  );
  assert.equal(await readFile(join(f.root, "effects"), "utf8"), "effect\n");
});

test("generation shutdown discards conversations without replaying their effects", async (t) => {
  const f = await fixture(t);
  const first = accepted(await f.registry.spawn(f.input, "worker", "Record private finding"));
  await f.registry.drain();
  const next = new AgentRegistry(new RunnerPool());
  try {
    const requests = f.requests();
    await f.registry.followup(f.input, {
      agentId: first.agentId,
      requestId: "old-owner",
      message: "Review earlier evidence",
    });
    await next.followup(f.input, {
      agentId: first.agentId,
      requestId: "new-owner",
      message: "Review earlier evidence",
    });
    assert.equal(f.requests(), requests, "neither a drained nor a new owner can resume old memory");
    assert.equal(await readFile(join(f.root, "effects"), "utf8"), "effect\n");
    const fresh = accepted(await next.spawn(f.input, "worker", "Record an independent finding"));
    assert.equal(fresh.text, "Private finding recorded");
    assert.equal(await readFile(join(f.root, "effects"), "utf8"), "effect\neffect\n");
  } finally {
    await next.drain();
  }
});

test("same-path directory replacement revokes retained workspace authority", async (t) => {
  const f = await fixture(t);
  const first = accepted(await f.registry.spawn(f.input, "worker", "Record private finding"));
  const replaced = `${f.root}-replaced`;
  t.after(() => rm(replaced, { recursive: true, force: true }));
  await rename(f.root, replaced);
  await mkdir(f.root);
  const requests = f.requests();

  const result = await f.registry.followup(f.input, {
    agentId: first.agentId,
    requestId: "replacement",
    message: "Review earlier evidence",
  });

  assert.deepEqual(result, { rejection: "not_available" });
  assert.equal(f.requests(), requests);
  assert.deepEqual(f.registry.inspect(f.input, first.agentId), { rejection: "not_available" });
});
