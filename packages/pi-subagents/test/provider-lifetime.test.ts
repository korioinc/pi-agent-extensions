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
} from "@earendil-works/pi-ai";
import { ParentProvider } from "../src/session/provider.ts";
import type { ResearchConfig } from "../src/runtime/index.ts";

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
    const owner = new ParentProvider(
      {
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
        request() {},
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
  const owner = new ParentProvider(
    {
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
      request() {},
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
