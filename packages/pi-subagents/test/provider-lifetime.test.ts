import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import {
  createAssistantMessageEventStream,
  normalizeContext,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { streamSimple as streamGoogleGenerativeAI } from "@earendil-works/pi-ai/api/google-generative-ai";
import { streamSimple as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { ParentProvider } from "../src/session/provider.ts";
import type { ResearchConfig } from "../src/runtime/index.ts";
import { DEFAULT_EXECUTION_LIMITS, modelExecutionLimits } from "../src/runtime/limits.ts";

const model: ResearchConfig["model"] = {
  api: "openai-completions",
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

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function answer(): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: "text", text: "Result" }],
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
}

test("preparation rejects a fractional effective model output allowance", () => {
  assert.throws(() => modelExecutionLimits(DEFAULT_EXECUTION_LIMITS, { maxTokens: 0.75 }));
});

for (const summary of [false, true]) {
  for (const maxTokens of [0.75, 1024.5, 1024]) {
    const admitted = maxTokens === 1024;
    test(`${summary ? "summary" : "ordinary"} request ${admitted ? "accepts an integer" : "rejects a fractional"} model output ceiling of ${maxTokens}`, async (t) => {
      const selected: Model<"openai-responses"> = {
        ...model,
        api: "openai-responses",
        provider: "openai",
        maxTokens,
      };
      let dispatched = false;
      t.mock.method(
        globalThis,
        "fetch",
        async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          dispatched = true;
          const request = JSON.parse(String(init?.body));
          assert.ok(Number.isSafeInteger(request.max_output_tokens));
          assert.ok(request.max_output_tokens > 0 && request.max_output_tokens <= maxTokens);
          return new Response(
            `data: ${JSON.stringify({
              type: "response.completed",
              response: { id: "resp_offline", status: "completed", output: [] },
            })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      );
      const owner = new ParentProvider(
        {
          executionLimits: DEFAULT_EXECUTION_LIMITS,
          model: selected,
          thinkingLevel: "off",
          stream: (_model, context, options) =>
            streamOpenAIResponses(selected, normalizeContext(context), {
              ...options,
              apiKey: "offline-not-a-credential",
            }),
        },
        {
          signal: new AbortController().signal,
          summary: () => summary,
          check() {},
          cleanupUnsafe() {},
          request: () => ({
            requestIndex: 1,
            remainingMs: DEFAULT_EXECUTION_LIMITS.invocationMs - 0.25,
          }),
          trackTransport() {},
          exceeded(limit) {
            throw new Error(limit);
          },
        },
        "child-output-limit",
      );
      t.after(() => owner.close());
      const result = await owner.provider
        .streamSimple(selected, normalizeContext({ messages: [] }))
        .result();
      assert.equal(dispatched, admitted, "fractional allowances must fail before model dispatch");
      assert.equal(result.stopReason, admitted ? "stop" : "error");
    });
  }
}

for (const rejectClose of [false, true]) {
  test(`provider ownership waits for late acquisition and ${rejectClose ? "retains failed" : "awaits"} cleanup`, async (t) => {
    const acquired = gate();
    const cancelling = gate();
    const released = gate();
    t.after(() => {
      acquired.resolve();
      released.resolve();
    });
    t.mock.method(globalThis, "fetch", async () => {
      await acquired.promise;
      return new Response(
        new ReadableStream<Uint8Array>({
          async cancel() {
            cancelling.resolve();
            await released.promise;
            if (rejectClose) throw new Error("Reader closure failed");
          },
        }),
      );
    });
    let dispatched = 0;
    let requestIndex = 0;
    const owner = new ParentProvider(
      {
        executionLimits: DEFAULT_EXECUTION_LIMITS,
        model,
        thinkingLevel: "off",
        stream(_model, _context, options) {
          dispatched++;
          if (dispatched === 1) void options!.fetch!("https://unused.invalid");
          const source = createAssistantMessageEventStream();
          queueMicrotask(() => {
            const message = answer();
            source.push({ type: "done", reason: "stop", message });
            source.end();
          });
          return source;
        },
      },
      {
        signal: new AbortController().signal,
        check() {},
        cleanupUnsafe() {},
        request: () => ({
          requestIndex: ++requestIndex,
          remainingMs: DEFAULT_EXECUTION_LIMITS.invocationMs,
        }),
        trackTransport() {},
        exceeded(limit) {
          throw new Error(limit);
        },
      },
      "child",
    );
    const context = normalizeContext({ messages: [] });
    const first = owner.provider.streamSimple(model, context);
    const second = owner.provider.streamSimple(model, context);
    await first.result();
    await setImmediate();
    assert.equal(dispatched, 1, "a later request cannot dispatch while acquisition is owned");
    acquired.resolve();
    await cancelling.promise;
    await setImmediate();
    assert.equal(dispatched, 1, "a later request must also wait for reader closure");
    released.resolve();
    await second.result();
    if (rejectClose) {
      assert.equal(dispatched, 1, "unsafe cleanup must prevent every later dispatch");
      await assert.rejects(owner.close(), "unsafe ownership must not become safe on close");
      await assert.rejects(owner.close(), "repeated close must retain the first failure");
    } else {
      assert.equal(dispatched, 2, "safe closure permits the reserved next request");
      await owner.close();
    }
  });
}

test("consumer-handled cancellation failure cannot permit later provider effects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-provider-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const effect = join(root, "effect");
  await writeFile(effect, "unchanged");
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            throw new Error("Reader cancellation failed");
          },
        }),
      ),
  );
  let initial = true;
  let requestIndex = 0;
  const owner = new ParentProvider(
    {
      executionLimits: DEFAULT_EXECUTION_LIMITS,
      model,
      thinkingLevel: "off",
      stream(_model, _context, options) {
        const first = initial;
        initial = false;
        const source = createAssistantMessageEventStream();
        void (async () => {
          if (first) {
            const response = await options!.fetch!("https://unused.invalid");
            // A consumer can handle this error and still finish its model result normally.
            await response.body!.cancel().catch(() => {});
          } else await writeFile(effect, "changed by later provider work");
          const message = answer();
          source.push({ type: "done", reason: "stop", message });
          source.end();
        })();
        return source;
      },
    },
    {
      signal: new AbortController().signal,
      check() {},
      cleanupUnsafe() {},
      request: () => ({
        requestIndex: ++requestIndex,
        remainingMs: DEFAULT_EXECUTION_LIMITS.invocationMs,
      }),
      trackTransport() {},
      exceeded(limit) {
        throw new Error(limit);
      },
    },
    "child",
  );
  const context = normalizeContext({ messages: [] });
  const first = owner.provider.streamSimple(model, context);
  const second = owner.provider.streamSimple(model, context);
  await first.result();
  await second.result();
  assert.equal(await readFile(effect, "utf8"), "unchanged");
  await assert.rejects(owner.close());
  await assert.rejects(owner.close());
});

for (const api of ["google-generative-ai", "google-vertex"] as const) {
  test(`${api} receives owned fetch wrapper for httpStatus observation and wire bounds`, async (t) => {
    const selected: ResearchConfig["model"] = { ...model, api, provider: "google" };
    let fetched = false;
    t.mock.method(globalThis, "fetch", async () => {
      fetched = true;
      return new Response("Unauthorized", { status: 401 });
    });
    let requestIndex = 0;
    let fastChecks = 0;
    let fullChecks = 0;
    const owner = new ParentProvider(
      {
        executionLimits: DEFAULT_EXECUTION_LIMITS,
        model: selected,
        thinkingLevel: "off",
        stream(_model, _context, options) {
          const source = createAssistantMessageEventStream();
          void (async () => {
            assert.equal(typeof options?.fetch, "function", `${api} must receive wrapped fetch`);
            await options!.fetch!("https://unused.invalid");
            await options?.onProviderStreamEvent?.({ type: "delta" }, selected);
            const message: AssistantMessage = {
              ...answer(),
              api,
              stopReason: "error",
              errorMessage: "HTTP 401",
            };
            source.push({ type: "error", reason: "error", error: message });
            source.end();
          })();
          return source;
        },
      },
      {
        signal: new AbortController().signal,
        check() {
          fullChecks++;
        },
        checkFast() {
          fastChecks++;
        },
        cleanupUnsafe() {},
        request: () => ({
          requestIndex: ++requestIndex,
          remainingMs: DEFAULT_EXECUTION_LIMITS.invocationMs,
        }),
        trackTransport() {},
        exceeded(limit) {
          throw new Error(limit);
        },
      },
      "child-google",
    );
    t.after(() => owner.close());
    const result = await owner.provider
      .streamSimple(selected, normalizeContext({ messages: [] }))
      .result();
    assert.equal(fetched, true);
    assert.equal(owner.evidence(result)?.httpStatus, 401);
    assert.equal(fullChecks, 1, "dispatch must run full authority check");
    assert.equal(fastChecks, 1, "stream events must use hot-path checkFast");
  });
}

test("real google-generative-ai adapter uses ParentProvider wrapped fetch and records HTTP status", async (t) => {
  const selected: Model<"google-generative-ai"> = {
    api: "google-generative-ai",
    provider: "google",
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: false,
    input: ["text"],
    contextWindow: 100000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls++;
    return new Response(
      JSON.stringify({ error: { code: 401, message: "Invalid key", status: "UNAUTHENTICATED" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  });
  let requestIndex = 0;
  const owner = new ParentProvider(
    {
      executionLimits: DEFAULT_EXECUTION_LIMITS,
      model: selected,
      thinkingLevel: "off",
      stream: (_model, context, options) =>
        streamGoogleGenerativeAI(selected, normalizeContext(context), {
          ...options,
          apiKey: "offline-not-a-credential",
        }),
    },
    {
      signal: new AbortController().signal,
      check() {},
      checkFast() {},
      cleanupUnsafe() {},
      request: () => ({
        requestIndex: ++requestIndex,
        remainingMs: DEFAULT_EXECUTION_LIMITS.invocationMs,
      }),
      trackTransport() {},
      exceeded(limit) {
        throw new Error(limit);
      },
    },
    "child-google-real",
  );
  t.after(() => owner.close());
  const result = await owner.provider
    .streamSimple(
      selected,
      normalizeContext({
        messages: [{ role: "user", content: "Check status", timestamp: Date.now() }],
      }),
    )
    .result();
  assert.equal(fetchCalls, 1);
  assert.equal(result.stopReason, "error");
  assert.equal(owner.evidence(result)?.httpStatus, 401);
});
