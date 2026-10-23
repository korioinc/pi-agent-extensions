import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import {
  StdioTransport,
  StreamableHttpTransport,
  type McpFetch,
  type McpTransport,
} from "@earendil-works/pi-mcp";
import type { McpServer } from "../../runtime/mcp.ts";
import { LIMITS } from "../../runtime/limits.ts";
import { HttpResponseResources } from "../http-resources.ts";

const failed = () => new Error("MCP transport operation failed.");

/** Patch the instance too: SDK-internal close calls must join the first close, even after rejection. */
export function ownMcpTransport(transport: McpTransport): McpTransport {
  const close = transport.close.bind(transport);
  let closing: Promise<void> | undefined;
  transport.close = () => (closing ??= Promise.resolve().then(close));
  return transport;
}

async function settleClose(operations: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(operations);
  const errors = results.filter((result) => result.status === "rejected").map(() => failed());
  if (errors.length) throw new AggregateError(errors, "MCP transport cleanup failed.");
}

/** Keep endpoint, cancellation scope, and traffic policy local to the selected transport. */
class McpHttp {
  readonly controller = new AbortController();
  readonly requestSignal = new AsyncLocalStorage<AbortSignal | undefined>();
  private readonly resources = new HttpResponseResources(failed);
  private streamTrafficBytes = 0;

  private readonly endpoint: URL;
  private readonly signal: AbortSignal;
  private readonly request: McpFetch;

  constructor(endpoint: URL, signal: AbortSignal, request: McpFetch) {
    this.endpoint = endpoint;
    this.signal = signal;
    this.request = request;
  }

  readonly fetch: McpFetch = (input, init) =>
    this.resources.acquire(() => this.acquire(input, init));

  private async acquire(
    input: Parameters<McpFetch>[0],
    init?: Parameters<McpFetch>[1],
  ): Promise<Response> {
    try {
      const url = new URL(input.toString());
      if (url.href !== this.endpoint.href) throw failed();
      const signals = [
        this.signal,
        this.controller.signal,
        init?.signal,
        this.requestSignal.getStore(),
      ];
      const signal = AbortSignal.any(signals.filter((item): item is AbortSignal => item != null));
      signal.throwIfAborted();
      const response = await this.request(input, { ...init, redirect: "error", signal });
      const eventStream =
        response.ok &&
        response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ===
          "text/event-stream";
      let bytes = 0;
      const body = response.body
        ? this.resources.wrapBody(response.body, signal, (chunkBytes) => {
            if (eventStream) {
              // The SDK bounds each SSE event. Count traffic across streams and reconnects.
              this.streamTrafficBytes += chunkBytes;
              if (this.streamTrafficBytes > LIMITS.mcpStreamTrafficBytes) {
                this.controller.abort();
                throw failed();
              }
            } else {
              // SDK response.json()/text() otherwise buffer the entire JSON or error body.
              bytes += chunkBytes;
              if (bytes > LIMITS.mcpHttpBodyBytes) throw failed();
            }
          })
        : null;
      // A custom fetch must not bypass the redirect policy either. Never expose its raw body in errors.
      if (
        signal.aborted ||
        response.redirected ||
        (response.url && response.url !== this.endpoint.href)
      ) {
        await body?.cancel();
        throw failed();
      }
      return new Response(body, { status: response.status, headers: response.headers });
    } catch {
      throw failed();
    }
  }

  close(): Promise<void> {
    this.controller.abort();
    return this.resources.close();
  }
}

export function createMcpTransport(server: McpServer, signal: AbortSignal): McpTransport {
  const config = server.transport;
  let resources: McpHttp | undefined;
  let transport: McpTransport;
  if (config.type === "stdio") {
    const env: Record<string, string> = { HOME: process.env.HOME || homedir() };
    // Operational inheritance only; credentials still require explicit configuration.
    for (const name of ["PATH", "TMPDIR", "SYSTEMROOT", "WINDIR"]) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    transport = new StdioTransport({
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: { ...env, ...config.env },
      inheritEnv: false,
      maxStderrBytes: 64 * 1024,
    });
  } else {
    let endpoint: URL;
    try {
      endpoint = new URL(config.url);
      if (
        !["http:", "https:"].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.hash
      ) {
        throw failed();
      }
    } catch {
      throw failed();
    }
    resources = new McpHttp(endpoint, signal, globalThis.fetch);
    transport = new StreamableHttpTransport({
      url: endpoint.href,
      headers: config.headers,
      fetch: resources.fetch,
    });
    const close = transport.close.bind(transport);
    const ownedResources = resources;
    // Abort local I/O before SDK close. Its best-effort DELETE may be skipped; this is
    // transport resource closure, not a promise to roll back the remote session.
    transport.close = () => settleClose([ownedResources.close(), Promise.resolve().then(close)]);
  }
  ownMcpTransport(transport);
  const redact = async (operation: () => Promise<void>) => {
    try {
      signal.throwIfAborted();
      await operation();
    } catch {
      throw failed();
    }
  };
  return {
    start: () => redact(() => transport.start()),
    send: (message, options) =>
      redact(() =>
        resources
          ? resources.requestSignal.run(options?.signal, () => transport.send(message, options))
          : transport.send(message, options),
      ),
    close: transport.close,
    onMessage: (listener) => transport.onMessage(listener),
    onError: (listener) => transport.onError(() => listener(failed())),
    onClose: (listener) => transport.onClose(listener),
    setProtocolVersion: (version) => transport.setProtocolVersion?.(version),
  };
}
