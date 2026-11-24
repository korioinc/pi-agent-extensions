import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { McpClient, McpHttpError, type McpTransport } from "@earendil-works/pi-mcp";
import { DEFAULT_EXECUTION_LIMITS, LIMITS } from "../src/runtime/limits.ts";
import { ChildSession } from "../src/session/index.ts";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ResearchConfig } from "../src/runtime/index.ts";

for (const failure of ["transient", "oversized"] as const) {
  test(`child startup ${failure === "transient" ? "recovers from HTTP 503 across SDK instances" : "stops after an oversized HTTP 503 even when the server recovers"}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-startup-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    // The host can load another pi-mcp instance. Its HTTP errors have the same
    // fields but fail instanceof in this SDK. Keep the actual connection/retry code.
    const connect = McpClient.prototype.connect;
    t.mock.method(
      McpClient.prototype,
      "connect",
      async function (this: McpClient, transport: McpTransport) {
        try {
          return await connect.call(this, transport);
        } catch (error) {
          if (error instanceof McpHttpError)
            throw Object.assign(new Error(error.message), {
              name: error.name,
              status: error.status,
            });
          throw error;
        }
      },
    );
    let first = true;
    t.mock.method(
      globalThis,
      "fetch",
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (init?.method === "GET") return new Response(null, { status: 405 });
        const message = JSON.parse(String(init?.body));
        if (message.method !== "initialize") return new Response(null, { status: 202 });
        if (first) {
          first = false;
          const body =
            failure === "oversized"
              ? new ReadableStream<Uint8Array>(
                  {
                    pull(controller) {
                      controller.enqueue(new Uint8Array(LIMITS.mcpHttpBodyBytes + 1));
                    },
                  },
                  { highWaterMark: 0 },
                )
              : "Temporarily unavailable";
          return new Response(body, { status: 503 });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: message.params.protocolVersion,
            capabilities: {},
            serverInfo: { name: "selected", version: "1" },
          },
        });
      },
    );
    const model: ResearchConfig["model"] = {
      provider: "offline",
      api: "offline",
      id: "startup",
      name: "Startup",
      baseUrl: "https://unused.invalid",
      reasoning: false,
      input: ["text"],
      contextWindow: 100000,
      maxTokens: DEFAULT_EXECUTION_LIMITS.maxOutputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const child = new ChildSession(
      {
        retry: SettingsManager.inMemory().getRetrySettings(),
        executionLimits: DEFAULT_EXECUTION_LIMITS,
        cwd: root,
        task: "Start the selected server",
        model,
        thinkingLevel: "off",
        selection: {
          model: `${model.provider}/${model.id}`,
          modelSource: "agent",
          thinkingLevel: "off",
          thinkingSource: "agent",
        },
        agent: { name: "startup", description: "Startup" },
        promptMode: "replace",
        systemPrompt: "Use the selected server.",
        appendSystemPrompt: "",
        skills: [],
        tools: [],
        mcp: [
          {
            name: "selected",
            exposure: "codemode",
            toolExposure: {},
            timeoutMs: LIMITS.toolMs,
            transport: { type: "http", url: "https://mcp.invalid/rpc", headers: {} },
          },
        ],
        stream() {
          throw new Error("Startup must not dispatch a model request.");
        },
      },
      {
        signal: new AbortController().signal,
        safeguardSignal: new AbortController().signal,
        workSignal: new AbortController().signal,
        safeguard() {},
        wrapTools: (tools) => tools,
        check() {},
        checkStartup() {},
        cleanupUnsafe() {
          assert.fail("HTTP cleanup must settle safely.");
        },
        request() {
          throw new Error("Startup must not admit a model request.");
        },
        modelFailure() {},
        takeWrapUpNotice: () => undefined,
        takeMessages: () => [],
        exceeded(limit) {
          throw new Error(limit);
        },
        trackTransport() {},
        partial() {},
        usage() {},
        activity() {},
      },
    );
    try {
      if (failure === "oversized") await assert.rejects(child.start());
      else await child.start();
    } finally {
      await child.abort();
      await child.close(() => {});
    }
  });
}

test("ChildMcp.notify fails startup only on warning or error notifications, not info", async () => {
  const { ChildMcp } = await import("../src/session/mcp/index.ts");
  const infoOnly = new ChildMcp([], new AbortController().signal, () => {});
  infoOnly.notify("info");
  infoOnly.notify(undefined);
  assert.doesNotThrow(() => infoOnly.ready());
  await infoOnly.close();

  for (const level of ["warning", "error"] as const) {
    const failed = new ChildMcp([], new AbortController().signal, () => {});
    failed.notify(level);
    assert.throws(() => failed.ready(), /Selected MCP servers did not become ready/);
    await failed.close();
  }
});
