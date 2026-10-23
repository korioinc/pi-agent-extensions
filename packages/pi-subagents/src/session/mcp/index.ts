import {
  createMcpExtension,
  type ExtensionFactory,
  type ExtensionContext,
  type ExtensionHandler,
  type SessionStartEvent,
  type SessionShutdownEvent,
  type McpServerEntry,
} from "@earendil-works/pi-coding-agent";
import type { McpTransport } from "@earendil-works/pi-mcp";
import type { McpServer } from "../../runtime/mcp.ts";
import { LIMITS } from "../../runtime/limits.ts";
import { createMcpTransport } from "./transport.ts";

/** Native registration/discovery, with separately owned transports and selected configuration only. */
export class ChildMcp {
  private readonly transports: McpTransport[] = [];
  private closing?: Promise<void>;
  private stopped = false;
  private catalogBytes = 0;
  private startupError = false;
  private context?: ExtensionContext;
  private shutdown?: ExtensionHandler<SessionShutdownEvent>;
  private nativeClosing?: Promise<void>;
  private readonly initialized = new Map<string, { tools: boolean }>();
  private readonly listed = new Set<string>();
  private readonly onAbort = () => {
    void this.close().catch(() => {});
  };

  private readonly servers: readonly McpServer[];
  private readonly signal: AbortSignal;
  private readonly checkStartup: () => void;

  constructor(servers: readonly McpServer[], signal: AbortSignal, checkStartup: () => void) {
    this.servers = servers;
    this.signal = signal;
    this.checkStartup = checkStartup;
    signal.addEventListener("abort", this.onAbort, { once: true });
  }

  extension(): ExtensionFactory {
    const entries: McpServerEntry[] = this.servers.map((server) => ({
      name: server.name,
      source: "internal:subagent-mcp",
      scope: "extension",
      config: {
        ...server.transport,
        // Disable the native ambient OAuth store. The owned transport uses the
        // original explicit headers, not this OAuth-selection sentinel.
        ...(server.transport.type === "http" ? { headers: { Authorization: "" } } : {}),
        exposure: server.exposure,
        toolExposure: server.toolExposure,
        description: server.description,
        timeout: server.timeoutMs / 1000,
      },
    }));
    const factory = createMcpExtension({
      loadConfig: () => ({ servers: entries, errors: [], autoEnableCodemode: true }),
      createTransport: (entry) => {
        this.signal.throwIfAborted();
        if (this.stopped) throw new Error("Child MCP is closed.");
        const server = this.servers.find((candidate) => candidate.name === entry.name);
        if (!server) throw new Error("MCP server was not selected.");
        this.initialized.delete(server.name);
        this.listed.delete(server.name);
        const transport = createMcpTransport(server, this.signal);
        this.transports.push(transport);
        const initializes = new Set<string | number>();
        const lists = new Set<string | number>();
        let capabilities: { tools: boolean } | undefined;
        return {
          ...transport,
          send: async (message, options) => {
            if ("method" in message && message.method === "initialize" && "id" in message)
              initializes.add(message.id);
            if ("method" in message && message.method === "tools/list" && "id" in message)
              lists.add(message.id);
            await transport.send(message, options);
            // The SDK validates initialization before sending this notification.
            if (
              "method" in message &&
              message.method === "notifications/initialized" &&
              capabilities
            )
              this.initialized.set(server.name, capabilities);
          },
          onMessage: (listener) =>
            transport.onMessage((message) => {
              // Child runs neither persist server logs nor inherit the parent log destination.
              if ("method" in message && message.method === "notifications/message") return;
              if (
                !("method" in message) &&
                "id" in message &&
                initializes.delete(message.id) &&
                "result" in message &&
                message.result &&
                typeof message.result === "object" &&
                "capabilities" in message.result
              ) {
                const declared = message.result.capabilities;
                if (declared && typeof declared === "object" && !Array.isArray(declared))
                  capabilities = { tools: "tools" in declared && Boolean(declared.tools) };
              }
              if ("id" in message && lists.delete(message.id)) {
                this.catalogBytes += Buffer.byteLength(JSON.stringify(message));
                if (this.catalogBytes > LIMITS.mcpCatalogBytes) {
                  this.startupError = true;
                  listener({
                    jsonrpc: "2.0",
                    id: message.id,
                    error: { code: -32603, message: "MCP catalog budget exceeded." },
                  });
                  return;
                }
                if ("result" in message && message.result && typeof message.result === "object") {
                  const result = message.result;
                  if (
                    !("nextCursor" in result) ||
                    result.nextCursor === null ||
                    result.nextCursor === ""
                  )
                    this.listed.add(server.name);
                }
              }
              listener(
                "error" in message
                  ? {
                      jsonrpc: "2.0",
                      id: message.id,
                      error: { code: message.error.code, message: "MCP protocol request failed." },
                    }
                  : message,
              );
            }),
        };
      },
      openUrl: () => {
        throw new Error("Child MCP interactive authentication is unavailable.");
      },
      updateConfig: () => {
        throw new Error("Child MCP configuration is read-only.");
      },
    });
    return (pi) =>
      factory(
        new Proxy(pi, {
          get: (target, key, receiver) => {
            if (key !== "on") return Reflect.get(target, key, receiver);
            const on = target.on.bind(target);
            return (
              event: string,
              handler: ExtensionHandler<SessionStartEvent> | ExtensionHandler<SessionShutdownEvent>,
            ) => {
              if (event === "session_shutdown") {
                this.shutdown = handler as ExtensionHandler<SessionShutdownEvent>;
                return target.on("session_shutdown", () => {
                  // close() owns and joins this promise; it must not gate idle SDK disposal.
                  void this.stopNative().catch(() => {});
                });
              }
              if (event === "session_start")
                return target.on("session_start", (value, ctx) => {
                  this.context = ctx;
                  if (this.stopped) throw new Error("Child MCP is closed.");
                  return (handler as ExtensionHandler<SessionStartEvent>)(value, ctx);
                });
              return Reflect.apply(on, target, [event, handler]);
            };
          },
        }),
      );
  }

  private stopNative(): Promise<void> {
    if (this.context && this.shutdown && !this.nativeClosing)
      this.nativeClosing = Promise.resolve(
        this.shutdown({ type: "session_shutdown", reason: "quit" }, this.context),
      ).then(() => undefined);
    return this.nativeClosing ?? Promise.resolve();
  }

  notify(): void {
    this.startupError = true;
  }

  ready(): void {
    this.checkStartup();
    if (
      this.startupError ||
      this.servers.some((server) => {
        const capabilities = this.initialized.get(server.name);
        return !capabilities || (capabilities.tools && !this.listed.has(server.name));
      })
    )
      throw new Error(
        "Selected MCP servers did not become ready. Check explicit configuration and credentials.",
      );
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.signal.removeEventListener("abort", this.onAbort);
    const native = Promise.resolve().then(() => this.stopNative());
    this.closing = Promise.allSettled([
      native,
      ...this.transports.map((transport) => transport.close()),
    ]).then((results) => {
      if (results.some((result) => result.status === "rejected"))
        throw new Error("Child MCP cleanup is unconfirmed.");
    });
    return this.closing;
  }
}
