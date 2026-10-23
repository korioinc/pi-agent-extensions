import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { Type } from "typebox";
import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { RunnerPool } from "../src/runner-pool/index.ts";
import { runResearch, type RunnerContinuation, type RunnerIngress } from "../src/runner/index.ts";
import type { ResearchHost } from "../src/runtime/index.ts";
import { inspectWorkspace } from "../src/workspace/identity.ts";
import { ChildMcp } from "../src/session/mcp/index.ts";
import { LIMITS } from "../src/runtime/limits.ts";

const origin = { sessionId: "parent", anchor: null };

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function admitted(value: ReturnType<RunnerPool["submit"]>) {
  if ("rejection" in value) throw new Error(`Unexpected rejection: ${value.rejection}`);
  return value;
}

async function fixture(
  t: TestContext,
  stream?: ResearchHost["stream"],
  options: {
    maxModelTokens?: number;
    mutate?: () => string | void | Promise<string | void>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "pi-session-lifecycle-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  await mkdir(join(root, "agents"));
  await writeFile(
    join(root, "agents", "research.md"),
    `---\nname: research\ndescription: Research\ntools: ${options.mutate ? "[controlled_write]" : "[read_text, list_files]"}\n` +
      (options.maxModelTokens === undefined
        ? ""
        : `max_model_tokens: ${options.maxModelTokens}\n`) +
      "---\nInspect the assigned workspace.",
  );
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const model: Model<Api> = {
    api: "offline",
    provider: "offline",
    id: "child",
    name: "Offline child",
    baseUrl: "https://unused.invalid",
    reasoning: false,
    input: ["text"],
    contextWindow: 100000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  let dispatched = false;
  const host: ResearchHost = {
    cwd: root,
    workspace: inspectWorkspace(root),
    parentPrompt: "Do only the assigned research.",
    trustedProject: false,
    model,
    models: [model],
    thinkingLevel: "off",
    tools: options.mutate
      ? [
          {
            name: "controlled_write",
            label: "Write",
            description: "Protected effect",
            parameters: Type.Object({}),
          },
        ]
      : [],
    toolMetadata: [{ name: "controlled_write", source: "extension", aggregator: false }],
    signal: undefined,
    executeTool: async () => {
      if (!options.mutate) throw new Error("No delegated tools are available.");
      const text = await options.mutate();
      return {
        toolCall: { type: "toolCall", id: "write", name: "controlled_write", arguments: {} },
        result: {
          content: text ? [{ type: "text", text }] : [],
          details: undefined,
        },
        isError: false,
      };
    },
    stream(requested) {
      dispatched = true;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message: AssistantMessage = {
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
        };
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      });
      return stream;
    },
  };
  if (stream) host.stream = stream;
  const pool = new RunnerPool();
  const executionFinished = gate();
  return {
    cwd: root,
    pool,
    executionFinished: executionFinished.promise,
    dispatched: () => dispatched,
    start: (
      signal?: AbortSignal,
      continuation?: RunnerContinuation,
      task = "Inspect the workspace.",
    ) =>
      admitted(
        pool.submit(
          origin,
          async (control) => {
            try {
              return await runResearch(
                { scope: () => host, capture: () => host },
                { task, agent: "research" },
                control,
                continuation,
              );
            } finally {
              executionFinished.resolve();
            }
          },
          signal,
        ),
      ),
  };
}

test("caller-owned history continues through fresh SDK invocations without repeating effects or usage and remains private", async (t) => {
  const task = "Record the private finding for project Cedar.";
  const toolEvidence = "Private ledger evidence: Cedar has six verified samples.";
  const assistantEvidence = "Private assessment: retain Cedar's samples for review.";
  const followup = "Review the earlier finding without recording it again.";
  const independentTask = "Investigate an unrelated project in a separate conversation.";
  const effect = "recorded finding\n";
  const toolTokens = 7;
  const answerTokens = 11;
  const followupTokens = 3;
  let effectPath: string;
  let evidencePath: string;
  let reads = 0;
  let continuedTask = false;
  let continuedTool = false;
  let continuedAssistant = false;
  let independentRequest = false;
  let privateContextLeaked = false;

  const f = await fixture(
    t,
    (requested, context) => {
      const contains = (role: "user" | "assistant" | "toolResult", text: string) =>
        context.messages.some(
          (message) =>
            message.role === role &&
            (typeof message.content === "string"
              ? message.content.includes(text)
              : message.content.some(
                  (block) => block.type === "text" && block.text.includes(text),
                )),
        );
      const followingUp = contains("user", followup);
      const independent = contains("user", independentTask);
      if (followingUp) {
        continuedTask = contains("user", task);
        continuedTool = contains("toolResult", toolEvidence);
        continuedAssistant = contains("assistant", assistantEvidence);
      }
      if (independent) {
        independentRequest = true;
        privateContextLeaked = context.messages.some((message) => {
          const text =
            typeof message.content === "string"
              ? message.content
              : message.content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("\n");
          return [task, toolEvidence, assistantEvidence].some((privateText) =>
            text.includes(privateText),
          );
        });
      }
      const write = !followingUp && !independent && !contains("toolResult", toolEvidence);
      const output = independent
        ? 1
        : followingUp
          ? followupTokens
          : write
            ? toolTokens
            : answerTokens;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message: AssistantMessage = {
          role: "assistant",
          api: requested.api,
          provider: requested.provider,
          model: requested.id,
          content: write
            ? [
                {
                  type: "toolCall",
                  id: "record-finding",
                  name: "controlled_write",
                  arguments: {},
                },
              ]
            : [
                {
                  type: "text",
                  text: followingUp || independent ? "Review complete." : assistantEvidence,
                },
              ],
          stopReason: write ? "toolUse" : "stop",
          timestamp: Date.now(),
          usage: {
            input: 0,
            output,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: output,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        stream.push({ type: "done", reason: write ? "toolUse" : "stop", message });
        stream.end();
      });
      return stream;
    },
    {
      maxModelTokens: toolTokens + answerTokens + 1,
      mutate: async () => {
        const evidence = await readFile(evidencePath, "utf8");
        reads++;
        await appendFile(effectPath, effect);
        return evidence;
      },
    },
  );
  effectPath = join(f.cwd, "committed-findings.txt");
  evidencePath = join(f.cwd, "private-evidence.txt");
  await writeFile(evidencePath, toolEvidence);
  const continuation: RunnerContinuation = {
    history: SessionManager.inMemory(f.cwd),
    checkHistory() {},
    onReady() {},
    delivery() {},
  };
  t.after(() => f.pool.drain());

  const first = await f.start(undefined, continuation, task).result;
  assert.equal(first.outcome, "succeeded", "the first invocation must finish real SDK tool work");
  assert.equal(
    await readFile(effectPath, "utf8"),
    effect,
    "the first invocation commits the finding",
  );
  assert.equal(first.usage?.totalTokens, toolTokens + answerTokens);

  const second = await f.start(undefined, continuation, followup).result;
  assert.equal(second.outcome, "succeeded", "a disposed SDK session must not prevent continuation");
  assert.equal(continuedTask, true, "the new provider request retains the original private task");
  assert.equal(continuedTool, true, "the new provider request retains the actual tool's evidence");
  assert.equal(continuedAssistant, true, "the new provider request retains the earlier assessment");
  assert.equal(second.usage?.totalTokens, followupTokens, "historical usage is not charged again");
  assert.equal(
    await readFile(effectPath, "utf8"),
    effect,
    "continuation must not replay the committed effect",
  );

  const independent = await f.start(
    undefined,
    { ...continuation, history: SessionManager.inMemory(f.cwd) },
    independentTask,
  ).result;
  assert.equal(independent.outcome, "succeeded");
  assert.equal(independentRequest, true, "the isolation check must reach the provider");
  assert.equal(
    privateContextLeaked,
    false,
    "a different native history cannot disclose the private conversation",
  );
  assert.equal(reads, 1, "retained evidence must not require another local fixture read");
  assert.equal(
    await readFile(effectPath, "utf8"),
    effect,
    "separate history must not replay another conversation's effect",
  );
});

test("exhausted model allowance preserves incurred usage but denies the response's mutation", async (t) => {
  for (const total of [10, 11]) {
    let mutations = 0;
    let requests = 0;
    const text = "Evidence collected before exhausting the allowance.";
    const f = await fixture(
      t,
      (requested) => {
        const stream = createAssistantMessageEventStream();
        const first = requests++ === 0;
        queueMicrotask(() => {
          const message: AssistantMessage = {
            role: "assistant",
            api: requested.api,
            provider: requested.provider,
            model: requested.id,
            content: first
              ? [
                  { type: "text", text },
                  { type: "toolCall", id: "mutation", name: "controlled_write", arguments: {} },
                ]
              : [{ type: "text", text: "Unexpected continuation." }],
            stopReason: first ? "toolUse" : "stop",
            timestamp: Date.now(),
            usage: {
              input: 0,
              output: first ? total : 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: first ? total : 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
          stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
          stream.end();
        });
        return stream;
      },
      {
        maxModelTokens: 10,
        mutate: () => {
          mutations++;
        },
      },
    );
    const result = await f.start().result;
    assert.equal(mutations, 0, "reported exhaustion must deny effects from that same response");
    assert.equal(requests, 1, "exhaustion must not authorize another model request");
    assert.equal(
      result.usage?.totalTokens,
      total,
      "already incurred model usage cannot be discarded",
    );
    assert.equal(result.outcome, "failed", "exhaustion is not successful completion");
    assert.equal(result.text, text, "budget failure preserves collected evidence");
    await f.pool.drain();
  }
});

test("accepted data reaches only one natural child request despite retries", async (t) => {
  const entered = gate();
  const release = gate();
  t.after(() => release.resolve());
  const evidence = "Unique evidence from the owner: correction α.";
  const observations: boolean[] = [];
  let turn = 0;
  const f = await fixture(t, (requested, context) => {
    observations.push(JSON.stringify(context).includes(evidence));
    const current = ++turn;
    const stream = createAssistantMessageEventStream();
    void (async () => {
      await Promise.resolve();
      if (current === 1) {
        entered.resolve();
        await release.promise;
      }
      const continuing = current < 3;
      const message: AssistantMessage = {
        role: "assistant",
        api: requested.api,
        provider: requested.provider,
        model: requested.id,
        content: continuing
          ? [
              {
                type: "toolCall",
                id: `natural-${current}`,
                name: "list_files",
                arguments: { path: "." },
              },
            ]
          : [{ type: "text", text: "Finished." }],
        stopReason: continuing ? "toolUse" : "stop",
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
      stream.push({ type: "done", reason: continuing ? "toolUse" : "stop", message });
      stream.end();
    })();
    return stream;
  });
  const run = f.start();
  await Promise.race([
    entered.promise,
    run.result.then((result) => {
      throw new Error(`Child did not reach provider: ${JSON.stringify(result)}`);
    }),
  ]);
  const owner = { sessionId: origin.sessionId, branch: new Set<string>() };
  const input = { runId: run.runId, messageId: "correction", message: evidence };
  f.pool.sendMessage(owner, input);
  f.pool.sendMessage(owner, input);
  f.pool.sendMessage(owner, { ...input, message: "Conflicting evidence" });
  release.resolve();
  await run.result;
  assert.equal(observations[0], false, "data cannot retroactively enter a dispatched request");
  assert.equal(observations[1], true, "the next natural request receives accepted data");
  assert.equal(
    observations.filter(Boolean).length,
    1,
    "retries cannot duplicate request-local data",
  );
  f.pool.sendMessage(owner, input);
  await setImmediate();
  assert.equal(observations.length, 3, "a completed run cannot be awakened by a retry");
  await f.pool.drain();
});

test("a long tool chain finishes from its final evidence without repeating effects", async (t) => {
  const records = Array.from({ length: 40 }, (_, index) => `Evidence ${index + 1}`);
  let writes = 0;
  const f = await fixture(
    t,
    (requested, context) => {
      const stream = createAssistantMessageEventStream();
      const done = writes >= records.length;
      const evidence = context.messages.findLast((message) => message.role === "toolResult");
      const text =
        evidence?.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n") ?? "Missing evidence";
      queueMicrotask(() => {
        const message: AssistantMessage = {
          role: "assistant",
          api: requested.api,
          provider: requested.provider,
          model: requested.id,
          content: done
            ? [{ type: "text", text }]
            : [
                {
                  type: "toolCall",
                  id: `record-${writes}`,
                  name: "controlled_write",
                  arguments: {},
                },
              ],
          stopReason: done ? "stop" : "toolUse",
          timestamp: Date.now(),
          usage: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        stream.push({ type: "done", reason: done ? "stop" : "toolUse", message });
        stream.end();
      });
      return stream;
    },
    {
      mutate: async () => {
        await appendFile(join(f.cwd, "evidence"), `${records[writes++]}\n`);
        return readFile(join(f.cwd, "evidence"), "utf8");
      },
    },
  );
  const result = await f.start().result;
  const expected = records.join("\n") + "\n";
  assert.equal(result.outcome, "succeeded", "the assigned chain must reach safe completion");
  assert.equal(result.text, expected, "completion must include the final tool's actual evidence");
  assert.equal(
    await readFile(join(f.cwd, "evidence"), "utf8"),
    expected,
    "each effect occurs once",
  );
  assert.equal(
    result.usage?.totalTokens,
    (records.length + 1) * 3,
    "every response is accounted once",
  );
  await f.pool.drain();
});

for (const handoff of ["summary", "mutation"] as const)
  test(`turn boundary retains evidence with a safeguard ${handoff} and forbids later effects`, async (t) => {
    let ingress: RunnerIngress;
    let turn = 0;
    let evidenceRead = false;
    const effects: string[] = [];
    const forbidden = "Unauthorized work after the turn allowance";
    const evidence = "Boundary evidence was verified.";
    const f = await fixture(
      t,
      (requested, context) => {
        turn++;
        const finalTurn = turn === LIMITS.turns;
        const interpreting = turn === LIMITS.turns + 1;
        const overBudget = turn > LIMITS.turns + 1;
        if (interpreting) {
          evidenceRead = context.messages.some(
            (message) =>
              message.role === "toolResult" &&
              message.content.some((block) => block.type === "text" && block.text === evidence),
          );
        }
        const stream = createAssistantMessageEventStream();
        void (async () => {
          if (!overBudget) await ingress.steer(`next-${turn}`, "Continue the assigned work.");
          const message: AssistantMessage = {
            role: "assistant",
            api: requested.api,
            provider: requested.provider,
            model: requested.id,
            content: finalTurn
              ? ["first", "second"].map((id) => ({
                  type: "toolCall" as const,
                  id,
                  name: "controlled_write",
                  arguments: {},
                }))
              : overBudget && handoff === "mutation"
                ? [
                    {
                      type: "toolCall",
                      id: `write-${turn}`,
                      name: "controlled_write",
                      arguments: {},
                    },
                  ]
                : [
                    {
                      type: "text",
                      text: interpreting || overBudget ? evidence : "Work in progress.",
                    },
                  ],
            stopReason: finalTurn || (overBudget && handoff === "mutation") ? "toolUse" : "stop",
            timestamp: Date.now(),
            usage: {
              input: 1,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 3,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
          stream.push({
            type: "done",
            reason: finalTurn || (overBudget && handoff === "mutation") ? "toolUse" : "stop",
            message,
          });
          stream.end();
        })();
        return stream;
      },
      {
        mutate: () => {
          effects.push(turn === LIMITS.turns ? evidence : forbidden);
          return evidence;
        },
      },
    );
    t.after(() => f.pool.drain());
    const result = await f.start(undefined, {
      history: SessionManager.inMemory(f.cwd),
      checkHistory() {},
      delivery() {},
      onReady(value) {
        ingress = value;
      },
    }).result;
    assert(evidenceRead, "the final allowed tool result must reach the model despite steering");
    assert.equal(result.text, evidence, "interpreted evidence must survive turn exhaustion");
    assert.deepEqual(
      effects,
      [evidence, evidence],
      "a result batch cannot authorize later user-only work",
    );
  });

for (const trigger of ["tool", "invocation"] as const)
  test(`${trigger} deadline safeguard hands off committed work without replaying its effects`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const started = gate();
    const finish = gate();
    const ledger: string[] = [];
    let dispatched = false;
    const evidence = "Committed receipt: invoice-17";
    const f = await fixture(
      t,
      (model, context) => {
        const stream = createAssistantMessageEventStream();
        const first = !dispatched;
        dispatched = true;
        const hasReceipt = context.messages.some(
          (message) =>
            message.role === "toolResult" &&
            message.content.some((block) => block.type === "text" && block.text.includes(evidence)),
        );
        queueMicrotask(() => {
          const message: AssistantMessage = {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            content: first
              ? [{ type: "toolCall", id: "commit", name: "controlled_write", arguments: {} }]
              : [
                  {
                    type: "text",
                    text: hasReceipt
                      ? `${evidence}; remaining invoices need review.`
                      : "No receipt available.",
                  },
                ],
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
          };
          stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
          stream.end();
        });
        return stream;
      },
      {
        mutate: async () => {
          ledger.push("invoice-17");
          started.resolve();
          await finish.promise;
          return evidence;
        },
      },
    );
    const run = f.start();
    t.after(async () => {
      finish.resolve();
      await f.pool.drain();
    });
    await started.promise;
    t.mock.timers.tick(trigger === "tool" ? LIMITS.toolMs : LIMITS.invocationMs);
    finish.resolve();
    const result = await run.result;
    assert.match(
      result.text,
      /Committed receipt: invoice-17/,
      "the parent must receive the committed effect from the safeguard handoff",
    );
    assert.deepEqual(ledger, ["invoice-17"], "handoff must not replay the effect");
  });

for (const summary of ["rejected mutation", "cancelled", "stalled"] as const)
  test(`safeguard ${summary} preserves prior evidence and cannot create new effects`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const entered = gate();
    const workDone = gate();
    const summaryEntered = gate();
    const releaseSummary = gate();
    const abort = new AbortController();
    const evidence = "Verified account balance before interruption.";
    const workTokens = 7;
    const summaryTokens = 11;
    const workCost = 0.5;
    const summaryCost = 0.75;
    let phase = 0;
    const effects: string[] = [];
    const f = await fixture(
      t,
      (model) => {
        const isWork = phase++ === 0;
        const stream = createAssistantMessageEventStream();
        void (async () => {
          if (!isWork) {
            summaryEntered.resolve();
            if (summary !== "rejected mutation") await releaseSummary.promise;
          }
          const message: AssistantMessage = {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            content: isWork
              ? [
                  { type: "text", text: evidence },
                  { type: "toolCall", id: "first", name: "controlled_write", arguments: {} },
                ]
              : summary === "rejected mutation"
                ? [{ type: "toolCall", id: "forbidden", name: "controlled_write", arguments: {} }]
                : [{ type: "text", text: "Unverified replacement for previous evidence." }],
            stopReason: isWork || summary === "rejected mutation" ? "toolUse" : "stop",
            timestamp: Date.now(),
            usage: {
              input: 0,
              output: isWork ? workTokens : summaryTokens,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: isWork ? workTokens : summaryTokens,
              cost: {
                input: 0,
                output: isWork ? workCost : summaryCost,
                cacheRead: 0,
                cacheWrite: 0,
                total: isWork ? workCost : summaryCost,
              },
            },
          };
          stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
          stream.end();
        })();
        return stream;
      },
      {
        mutate: async () => {
          effects.push("existing effect");
          entered.resolve();
          await workDone.promise;
        },
      },
    );
    const run = f.start(abort.signal);
    t.after(async () => {
      workDone.resolve();
      releaseSummary.resolve();
      await f.pool.drain();
    });
    await entered.promise;
    t.mock.timers.tick(LIMITS.toolMs);
    workDone.resolve();
    await summaryEntered.promise;
    if (summary === "cancelled") abort.abort();
    if (summary === "stalled") t.mock.timers.tick(LIMITS.safeguardSummaryMs + LIMITS.graceMs);
    if (summary !== "rejected mutation") {
      let settled = false;
      void run.result.then(() => {
        settled = true;
      });
      await setImmediate();
      assert.equal(settled, false, "an uncooperative provider retains ownership until drained");
      releaseSummary.resolve();
    }
    const result = await run.result;
    assert.equal(result.text, evidence, "an unusable handoff cannot erase verified prior evidence");
    assert.deepEqual(effects, ["existing effect"], "summary must not authorize another effect");
    assert.equal(
      result.usage?.totalTokens,
      workTokens + summaryTokens,
      "discarding the handoff must retain every incurred model token exactly once",
    );
    assert.equal(
      result.usage?.cost.total,
      workCost + summaryCost,
      "discarding the handoff must not roll back or repeat its incurred cost",
    );
  });

test("invocation expiry hands off evidence from an in-flight model without restarting work", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entered = gate();
  const finish = gate();
  const evidence = "Reconciliation found an unpaid invoice; no payment was made.";
  const handoff = "The unpaid invoice still needs review. No payment effect occurred.";
  let first = true;
  const f = await fixture(t, (model, context) => {
    const working = first;
    first = false;
    const stream = createAssistantMessageEventStream();
    void (async () => {
      if (working) {
        entered.resolve();
        await finish.promise;
      }
      const known = context.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.content.some((block) => block.type === "text" && block.text === evidence),
      );
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [
          { type: "text", text: working ? evidence : known ? handoff : "Evidence was lost." },
        ],
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
      };
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
    })();
    return stream;
  });
  const run = f.start();
  t.after(async () => {
    finish.resolve();
    await f.pool.drain();
  });
  await entered.promise;
  t.mock.timers.tick(LIMITS.invocationMs);
  finish.resolve();
  const result = await run.result;
  assert.equal(result.text, handoff, "the parent needs a handoff grounded in in-flight findings");
});

test("safeguard handoff preserves aborted partial evidence after SDK request transformation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entered = gate();
  const finish = gate();
  const evidence = "Invoice 17 remains unpaid; no payment was made.";
  let first = true;
  const f = await fixture(t, (model, context, options) => {
    const working = first;
    first = false;
    const stream = createAssistantMessageEventStream();
    void (async () => {
      // Providers remove aborted assistant turns before building the actual model request.
      const known = transformMessages(context.messages, model).some((message) =>
        typeof message.content === "string"
          ? message.content.includes(evidence)
          : message.content.some((block) => block.type === "text" && block.text.includes(evidence)),
      );
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [
          {
            type: "text",
            text: working
              ? evidence
              : known
                ? `${evidence} Further review is needed.`
                : "No findings available.",
          },
        ],
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
      };
      if (working) {
        options?.signal?.addEventListener("abort", finish.resolve, { once: true });
        stream.push({ type: "text_delta", contentIndex: 0, delta: evidence, partial: message });
        entered.resolve();
        await finish.promise;
        message.stopReason = "aborted";
        message.errorMessage = "Request aborted.";
        stream.push({ type: "error", reason: "aborted", error: message });
      } else {
        stream.push({ type: "done", reason: "stop", message });
      }
      stream.end();
    })();
    return stream;
  });
  const run = f.start();
  t.after(async () => {
    finish.resolve();
    await f.pool.drain();
  });
  await entered.promise;
  t.mock.timers.tick(LIMITS.invocationMs);
  t.mock.timers.tick(LIMITS.safeguardFinishMs);
  const result = await run.result;
  assert.ok(
    result.text.includes(evidence),
    "a successful handoff must not erase aborted partial findings",
  );
});

test("hard cancellation during safeguard finishing never starts a handoff or replays work", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entered = gate();
  const finish = gate();
  const abort = new AbortController();
  let calls = 0;
  let effects = 0;
  const f = await fixture(
    t,
    (model) => {
      calls++;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [{ type: "toolCall", id: "commit", name: "controlled_write", arguments: {} }],
          stopReason: "toolUse",
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
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end();
      });
      return stream;
    },
    {
      mutate: async () => {
        effects++;
        entered.resolve();
        await finish.promise;
      },
    },
  );
  const run = f.start(abort.signal);
  t.after(async () => {
    finish.resolve();
    await f.pool.drain();
  });
  await entered.promise;
  t.mock.timers.tick(LIMITS.toolMs);
  abort.abort();
  finish.resolve();
  await run.result;
  assert.equal(effects, 1, "cancellation cannot replay the committed effect");
  assert.equal(calls, 1, "revoked execution authority forbids even a summary dispatch");
});

test("cancellation preserves partial work through unknown-tool continuations without reporting success", async (t) => {
  const abort = new AbortController();
  const entered = gate();
  const release = gate();
  t.after(() => {
    abort.abort();
    release.resolve();
  });
  let turn = 0;
  const partial = "Collected evidence before cancellation.";
  const f = await fixture(t, (requested) => {
    const stream = createAssistantMessageEventStream();
    const first = turn++ === 0;
    const waiting = turn === 3;
    if (waiting) entered.resolve();
    void (waiting ? release.promise : Promise.resolve()).then(() => {
      const message: AssistantMessage = {
        role: "assistant",
        api: requested.api,
        provider: requested.provider,
        model: requested.id,
        content: [
          ...(first ? [{ type: "text" as const, text: partial }] : []),
          { type: "toolCall", id: `call-${turn}`, name: "missing_tool", arguments: {} },
        ],
        stopReason: "toolUse",
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
      stream.push({ type: "done", reason: "toolUse", message });
      stream.end();
    });
    return stream;
  });
  const run = f.start(abort.signal);
  await entered.promise;
  abort.abort();
  release.resolve();
  const result = await run.result;
  assert.equal(result.text, partial, "empty tool/error turns must not erase collected work");
  assert.notEqual(
    result.outcome,
    "succeeded",
    "retained partial work is not successful completion",
  );
  const foreign = { sessionId: "other", branch: new Set<string>() };
  assert.equal(
    JSON.stringify(f.pool.inspect(foreign, run.runId)).includes("missing_tool"),
    false,
    "another parent cannot learn the owned child's tool activity",
  );
  const owner = { sessionId: origin.sessionId, branch: new Set<string>() };
  assert.ok(JSON.stringify(f.pool.inspect(owner, run.runId)).includes("missing_tool"));
  await f.pool.drain();
});

test("a token-limited final answer cannot complete the delegated task", async (t) => {
  const f = await fixture(t, (requested) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message: AssistantMessage = {
        role: "assistant",
        api: requested.api,
        provider: requested.provider,
        model: requested.id,
        content: [{ type: "text", text: "Incomplete research findings" }],
        stopReason: "length",
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
      stream.push({ type: "done", reason: "length", message });
      stream.end();
    });
    return stream;
  });
  const result = await f.start().result;
  assert.equal(result.outcome, "failed", "provider cutoff cannot establish task completion");
  await f.pool.drain();
});

test("binding failure disposes the acquired SDK session before releasing admission", async (t) => {
  const f = await fixture(t);
  const shutdownEntered = gate();
  const releaseShutdown = gate();
  t.after(() => releaseShutdown.resolve());
  const bind = AgentSession.prototype.bindExtensions;
  let context: ReturnType<AgentSession["extensionRunner"]["createContext"]> | undefined;
  t.mock.method(
    AgentSession.prototype,
    "bindExtensions",
    async function (this: AgentSession, ...args: Parameters<typeof bind>) {
      await bind.apply(this, args);
      context = this.extensionRunner.createContext();
      const runner = this.extensionRunner;
      const emit = runner.emit;
      t.mock.method(runner, "emit", async function (...events: Parameters<typeof emit>) {
        if (events[0].type === "session_shutdown") {
          shutdownEntered.resolve();
          await releaseShutdown.promise;
        }
        return emit.apply(runner, events);
      });
      throw new Error("Injected binding failure after acquisition.");
    },
  );
  const run = f.start();
  let completed = false;
  void run.result.then(() => {
    completed = true;
  });
  await shutdownEntered.promise;
  await setImmediate();
  assert.equal(
    completed,
    false,
    "binding failure cannot release an SDK resource still being cleaned up",
  );
  releaseShutdown.resolve();
  const result = await run.result;
  assert.equal(result.outcome, "failed");
  assert.ok(context);
  const isIdle = context.isIdle;
  assert.throws(isIdle, "disposed SDK contexts must no longer authorize work");
  assert.equal(f.dispatched(), false, "failed initialization cannot request model work");
  await f.pool.drain();
});

test("pending MCP closure does not retain an idle SDK context or release owned capacity", async (t) => {
  const f = await fixture(t);
  const closing = gate();
  const release = gate();
  const bind = AgentSession.prototype.bindExtensions;
  const close = ChildMcp.prototype.close;
  let context: ReturnType<AgentSession["extensionRunner"]["createContext"]> | undefined;
  t.mock.method(
    AgentSession.prototype,
    "bindExtensions",
    async function (this: AgentSession, ...args: Parameters<typeof bind>) {
      await bind.apply(this, args);
      context = this.extensionRunner.createContext();
    },
  );
  t.mock.method(ChildMcp.prototype, "close", async function (this: ChildMcp) {
    closing.resolve();
    await release.promise;
    await close.call(this);
  });
  const runs = Array.from({ length: LIMITS.runs }, () => f.start());
  let completed = false;
  void runs[0].result.then(() => {
    completed = true;
  });
  try {
    await closing.promise;
    await setImmediate();
    assert.ok(context);
    assert.throws(
      context.isIdle,
      "an idle SDK context must be invalidated despite pending MCP closure",
    );
    let replacementStarted = false;
    f.pool.submit(origin, async () => {
      replacementStarted = true;
      return { outcome: "succeeded", text: "" };
    });
    await setImmediate();
    assert.equal(replacementStarted, false, "MCP ownership still holds every occupied slot");
    assert.equal(completed, false, "SDK disposal alone cannot finalize foreground accounting");
  } finally {
    release.resolve();
    await Promise.all(runs.map((run) => run.result));
    await f.pool.drain();
  }
});

test("SDK shutdown rejection still disposes resources but cannot release unsafe ownership", async (t) => {
  const hostile = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error("prototype trap");
      },
    },
  );
  for (const [name, rejection] of [
    ["error", new Error("Injected SDK shutdown rejection.")],
    ["null", null],
    ["undefined", undefined],
    ["hostile_proxy", hostile],
  ] as const) {
    await t.test(name, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const f = await fixture(t);
      const bind = AgentSession.prototype.bindExtensions;
      let context: ReturnType<AgentSession["extensionRunner"]["createContext"]> | undefined;
      t.mock.method(
        AgentSession.prototype,
        "bindExtensions",
        async function (this: AgentSession, ...args: Parameters<typeof bind>) {
          await bind.apply(this, args);
          context = this.extensionRunner.createContext();
          const runner = this.extensionRunner;
          const emit = runner.emit;
          t.mock.method(runner, "emit", async function (...events: Parameters<typeof emit>) {
            if (events[0].type === "session_shutdown") throw rejection;
            return emit.apply(runner, events);
          });
        },
      );
      const run = f.start();
      let completed = false;
      void run.result.then(() => {
        completed = true;
      });
      // Observe executor rejection without awaiting the intentionally unreleased pool result.
      await f.executionFinished;
      await setImmediate();
      t.mock.timers.tick(LIMITS.invocationMs + LIMITS.graceMs);
      await setImmediate();
      assert.equal(f.dispatched(), true, "shutdown failure follows a real SDK provider dispatch");
      assert.ok(context);
      const isIdle = context.isIdle;
      assert.throws(isIdle, "shutdown rejection must not skip real SDK disposal");
      let drained = false;
      void f.pool.drain().then(() => {
        drained = true;
      });
      await setImmediate();
      assert.equal(completed, false, "uncertain shutdown cannot finalize ownership");
      assert.equal(drained, false, "uncertain shutdown cannot release the pool barrier");
    });
  }
});

test("cancellation during SDK binding prevents provider dispatch and safely disposes the child", async (t) => {
  const f = await fixture(t);
  const entered = gate();
  const release = gate();
  t.after(() => release.resolve());
  const bind = AgentSession.prototype.bindExtensions;
  let context: ReturnType<AgentSession["extensionRunner"]["createContext"]> | undefined;
  t.mock.method(
    AgentSession.prototype,
    "bindExtensions",
    async function (this: AgentSession, ...args: Parameters<typeof bind>) {
      await bind.apply(this, args);
      context = this.extensionRunner.createContext();
      entered.resolve();
      await release.promise;
    },
  );
  const abort = new AbortController();
  const run = f.start(abort.signal);
  let completed = false;
  void run.result.then(() => {
    completed = true;
  });
  await entered.promise;
  abort.abort();
  await setImmediate();
  assert.equal(completed, false, "pending binding remains owned after cancellation");
  release.resolve();
  const result = await run.result;
  assert.equal(result.outcome, "cancelled");
  assert.equal(f.dispatched(), false, "cancelled binding cannot reach the provider");
  assert.ok(context);
  const isIdle = context.isIdle;
  assert.throws(isIdle, "safe cancellation must invalidate the SDK resource");
  await f.pool.drain();
});
