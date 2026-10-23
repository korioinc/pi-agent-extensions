import assert from "node:assert/strict";
import { test } from "node:test";
import { McpClient } from "@earendil-works/pi-mcp";
import { createMcpTransport } from "../src/session/mcp/transport.ts";
import type { McpServer } from "../src/runtime/mcp.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const server: McpServer = {
  name: "selected",
  transport: { type: "http", url: "https://selected.invalid/mcp", headers: {} },
  exposure: "codemode",
  toolExposure: {},
  timeoutMs: 1000,
};

test("MCP cancellation retains delayed HTTP acquisition until the response reader closes", async (t) => {
  const entered = gate();
  const release = gate();
  const closing = gate();
  const releaseClose = gate();
  t.after(() => {
    release.resolve();
    releaseClose.resolve();
  });
  t.mock.method(globalThis, "fetch", async () => {
    entered.resolve();
    await release.promise;
    return new Response(
      new ReadableStream<Uint8Array>({
        cancel: async () => {
          closing.resolve();
          await releaseClose.promise;
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const abort = new AbortController();
  const transport = createMcpTransport(server, abort.signal);
  const client = new McpClient({
    name: "fixture",
    version: "1",
    requestTimeoutMs: server.timeoutMs,
  });
  const failed = assert.rejects(client.connect(transport));
  await entered.promise;
  abort.abort();
  let safe = false;
  const close = Promise.all([client.close(), transport.close()]).then(() => {
    safe = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(safe, false, "cancellation cannot detach a pending connection acquisition");
  release.resolve();
  await closing.promise;
  assert.equal(safe, false, "a cancelled response remains owned until its reader stops");
  releaseClose.resolve();
  await failed;
  await close;
  assert.equal(safe, true);
});
