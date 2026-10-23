import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { McpClient, StreamableHttpTransport, type McpTransport } from "@earendil-works/pi-mcp";
import { LIMITS } from "../src/runtime/limits.ts";
import type { McpServer } from "../src/runtime/mcp.ts";
import { createMcpTransport, ownMcpTransport } from "../src/session/mcp/transport.ts";

const request = { jsonrpc: "2.0", id: 1, method: "initialize" } as const;
const httpServer: McpServer = {
  name: "test",
  transport: {
    type: "http",
    url: "https://mcp.invalid/rpc",
    headers: { Authorization: "Bearer private-fixture-token" },
  },
  timeoutMs: 1000,
  exposure: "direct",
  toolExposure: {},
};

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function inertTransport(overrides: Partial<McpTransport>): McpTransport {
  return {
    start: async () => {},
    send: async () => {},
    close: async () => {},
    onMessage: () => () => {},
    onError: () => () => {},
    onClose: () => () => {},
    ...overrides,
  };
}

test("a failed client connection cannot conceal failed transport cleanup", async () => {
  const entered = gate();
  const release = gate();
  let active = true;
  const transport = ownMcpTransport(
    inertTransport({
      start: async () => {
        throw new Error("connect failure");
      },
      close: async () => {
        entered.resolve();
        await release.promise;
        if (!active) return;
        active = false;
        throw new Error("cleanup failure");
      },
    }),
  );
  const client = new McpClient({ name: "test", version: "1" });
  const connection = assert.rejects(client.connect(transport));
  await entered.promise;
  const first = transport.close();
  let completed = false;
  void first.catch(() => {
    completed = true;
  });
  await setImmediate();
  assert.equal(completed, false, "cleanup is still owned while its resource is active");
  release.resolve();
  await connection;
  await assert.rejects(first);
  await assert.rejects(transport.close(), "later cleanup cannot manufacture success");
});

test("an instance-internal close retains cleanup failure for its owner", async () => {
  const transport = ownMcpTransport(
    inertTransport({
      async start(this: McpTransport) {
        await this.close().catch(() => {});
      },
      close: async () => {
        throw new Error("cleanup failure");
      },
    }),
  );
  await transport.start();
  await assert.rejects(transport.close());
});

test("stdio cannot use ambient credentials to change a protected file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-transport-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const protectedFile = join(root, "protected");
  const authorizedFile = join(root, "authorized");
  await writeFile(protectedFile, "unchanged");
  const previous = process.env.PI_MCP_AMBIENT_CREDENTIAL;
  process.env.PI_MCP_AMBIENT_CREDENTIAL = "private-fixture-token";
  t.after(() => {
    if (previous === undefined) delete process.env.PI_MCP_AMBIENT_CREDENTIAL;
    else process.env.PI_MCP_AMBIENT_CREDENTIAL = previous;
  });
  const transport = createMcpTransport(
    {
      ...httpServer,
      transport: {
        type: "stdio",
        command: process.execPath,
        args: [
          "--input-type=module",
          "-e",
          `
        import { writeFile } from "node:fs/promises";
        if (process.env.PI_MCP_AMBIENT_CREDENTIAL) await writeFile(${JSON.stringify(protectedFile)}, "unauthorized");
        if (process.env.EXPLICIT_CAPABILITY === "authorized") await writeFile(${JSON.stringify(authorizedFile)}, "changed");
        process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"ready"}) + "\\n");
        process.stdin.resume();
      `,
        ],
        env: { EXPLICIT_CAPABILITY: "authorized" },
        cwd: root,
      },
    },
    new AbortController().signal,
  );
  t.after(() => transport.close());
  const ready = gate();
  transport.onMessage(() => ready.resolve());
  await transport.start();
  await ready.promise;
  await transport.close();
  assert.equal(await readFile(protectedFile, "utf8"), "unchanged");
  assert.equal(await readFile(authorizedFile, "utf8"), "changed");
});

test("HTTP cannot forward configured authorization to another endpoint", async (t) => {
  let unauthorizedWrites = 0;
  t.mock.method(globalThis, "fetch", async () => {
    unauthorizedWrites++;
    return new Response();
  });
  t.mock.method(
    StreamableHttpTransport.prototype,
    "start",
    async function (this: StreamableHttpTransport) {
      await this.options.fetch!("https://other.invalid/rpc", { headers: this.options.headers });
    },
  );
  const transport = createMcpTransport(httpServer, new AbortController().signal);
  await assert.rejects(transport.start());
  await transport.close();
  assert.equal(unauthorizedWrites, 0, "cross-endpoint authorization must stop before dispatch");
});

test("normal HTTP shutdown releases an open notification stream without poisoning cleanup", async (t) => {
  const received = gate();
  const disconnected = gate();
  let streamActive = false;
  const server = createServer(async (incoming, response) => {
    if (incoming.method === "GET") {
      streamActive = true;
      response.on("close", () => {
        streamActive = false;
        disconnected.resolve();
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"jsonrpc":"2.0","method":"notifications/ready"}\n\n');
      return;
    }
    let body = "";
    for await (const chunk of incoming) body += chunk;
    const message = body ? JSON.parse(body) : undefined;
    if (message?.method === "initialize") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: message.params.protocolVersion,
            capabilities: {},
            serverInfo: { name: "local", version: "1" },
          },
        }),
      );
    } else response.writeHead(202).end();
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local HTTP address");
  const transport = createMcpTransport(
    {
      ...httpServer,
      transport: { type: "http", url: `http://127.0.0.1:${address.port}/rpc`, headers: {} },
    },
    new AbortController().signal,
  );
  transport.onMessage((message) => {
    if ("method" in message && message.method === "notifications/ready") received.resolve();
  });
  const client = new McpClient({ name: "test", version: "1" });
  t.after(() => client.close().catch(() => {}));
  await client.connect(transport);
  await received.promise;
  assert.equal(streamActive, true);
  await client.close();
  await disconnected.promise;
  await transport.close();
  assert.equal(streamActive, false, "successful cleanup must release the real HTTP stream");
});

test("close retains pending acquisition and cancellation even when fetch ignores abort", async (t) => {
  const acquired = gate();
  const deliver = gate();
  const cancelling = gate();
  const release = gate();
  let active = 0;
  t.mock.method(globalThis, "fetch", async () => {
    active++;
    acquired.resolve();
    await deliver.promise;
    return new Response(
      new ReadableStream({
        async cancel() {
          cancelling.resolve();
          await release.promise;
          active--;
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const transport = createMcpTransport(httpServer, new AbortController().signal);
  await transport.start();
  const sending = assert.rejects(transport.send(request));
  await acquired.promise;
  let closed = false;
  const closing = transport.close().then(() => {
    closed = true;
  });
  await setImmediate();
  assert.equal(closed, false);
  deliver.resolve();
  await cancelling.promise;
  await setImmediate();
  assert.equal(closed, false, "body cancellation still owns an active resource");
  release.resolve();
  await closing;
  await sending;
  assert.equal(active, 0);
});

test("response overflow cannot mutate a tool result and remains owned through failed cancellation", async (t) => {
  const cancelling = gate();
  const release = gate();
  let mutations = 0;
  let active = true;
  let chunks = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              // Several individually small chunks exercise the cumulative bound.
              if (chunks++ < 3)
                controller.enqueue(new Uint8Array(Math.ceil(LIMITS.mcpHttpBodyBytes / 2)));
              else controller.close();
            },
            async cancel() {
              cancelling.resolve();
              await release.promise;
              active = false;
              // The error name alone cannot distinguish failed cleanup from an aborted read.
              throw new DOMException("private-fixture-token", "AbortError");
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "application/json" } },
      ),
  );
  const transport = createMcpTransport(httpServer, new AbortController().signal);
  transport.onMessage(() => mutations++);
  await transport.start();
  const sending = assert.rejects(
    transport.send(request),
    (error: Error) => !error.message.includes("private-fixture-token"),
  );
  await cancelling.promise;
  let closed = false;
  const closing = assert.rejects(transport.close()).then(() => {
    closed = true;
  });
  await setImmediate();
  assert.equal(closed, false);
  assert.equal(active, true);
  release.resolve();
  await sending;
  await closing;
  await assert.rejects(transport.close());
  assert.equal(active, false);
  assert.equal(mutations, 0);
});

test("reader release failure remains visible after the SDK catches its read failure", async (t) => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  const response = new Response(body, { headers: { "content-type": "application/json" } });
  const reader = body.getReader();
  const release = reader.releaseLock.bind(reader);
  t.mock.method(reader, "releaseLock", () => {
    release();
    throw new Error("private-fixture-token");
  });
  t.mock.method(body, "getReader", () => reader);
  t.mock.method(globalThis, "fetch", async () => response);
  const transport = createMcpTransport(httpServer, new AbortController().signal);
  await transport.start();
  await assert.rejects(transport.send(request));
  await assert.rejects(transport.close());
  await assert.rejects(transport.close());
});

test("stream exhaustion stops new acquisition and retains pending cancellation across responses", async (t) => {
  const cancelling = gate();
  const release = gate();
  const half = Math.floor(LIMITS.mcpStreamTrafficBytes / 2);
  const chunkBytes = 1024 * 1024;
  const comment = new TextEncoder().encode(`:${"x".repeat(chunkBytes - 3)}\n\n`);
  let requests = 0;
  let active = 0;
  let exhausted = false;
  let unauthorizedEffect = false;
  t.mock.method(globalThis, "fetch", async () => {
    if (exhausted) unauthorizedEffect = true;
    const index = requests++;
    let remaining = index < 2 ? half : LIMITS.mcpStreamTrafficBytes - 2 * half + 1;
    active++;
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (index === 2) return; // Another owned connection is still active.
            if (remaining === 0) {
              active--;
              controller.close();
              return;
            }
            const bytes = Math.min(remaining, comment.length);
            remaining -= bytes;
            controller.enqueue(comment.subarray(0, bytes));
          },
          async cancel() {
            if (index === 2) {
              cancelling.resolve();
              await release.promise;
            }
            active--;
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { "content-type": "text/event-stream; charset=utf-8" } },
    );
  });
  let requestAgain!: () => Promise<Response>;
  t.mock.method(
    StreamableHttpTransport.prototype,
    "start",
    async function (this: StreamableHttpTransport) {
      requestAgain = () => this.options.fetch!(this.options.url);
      const consume = async () => {
        const response = await requestAgain();
        const reader = response.body!.getReader();
        try {
          while (!(await reader.read()).done) {
            // Discard consumed events rather than retaining a whole response in the test.
          }
        } finally {
          reader.releaseLock();
        }
      };
      await consume();
      await consume();
      await requestAgain();
      await consume();
    },
  );
  const transport = createMcpTransport(httpServer, new AbortController().signal);
  t.after(async () => {
    release.resolve();
    await transport.close();
  });
  await assert.rejects(transport.start());
  await cancelling.promise;
  exhausted = true;
  await assert.rejects(requestAgain());
  assert.equal(unauthorizedEffect, false, "exhausted transports must reject before acquisition");
  let closed = false;
  const closing = transport.close().then(() => {
    closed = true;
  });
  await setImmediate();
  assert.equal(closed, false, "traffic exhaustion must not detach another active connection");
  assert.ok(active > 0);
  release.resolve();
  await closing;
  assert.equal(active, 0);
});

test("request abort releases its pending HTTP acquisition", async (t) => {
  const requested = gate();
  const aborted = gate();
  let active = 0;
  t.mock.method(globalThis, "fetch", async (_input: string | URL, init: RequestInit) => {
    active++;
    requested.resolve();
    return await new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener(
        "abort",
        () => {
          active--;
          aborted.resolve();
          reject(new Error("cancelled"));
        },
        { once: true },
      );
    });
  });
  const transport = createMcpTransport(httpServer, new AbortController().signal);
  await transport.start();
  const controller = new AbortController();
  const sending = assert.rejects(transport.send(request, { signal: controller.signal }));
  await requested.promise;
  controller.abort();
  await aborted.promise;
  await sending;
  await transport.close();
  assert.equal(active, 0);
});
