import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isMissing, type Preparation } from "./discovery.ts";
import { LIMITS } from "./limits.ts";

type Exposure = "codemode" | "direct" | "deferred" | "hidden";

export type McpServer = {
  name: string;
  description?: string;
  transport:
    | { type: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd: string }
    | { type: "http"; url: string; headers: Record<string, string> };
  exposure: Exposure;
  toolExposure: Record<string, Exposure>;
  timeoutMs: number;
};

const CONFIG_FILE = "mcp-sub-agents.json";
const NAME = /^[a-zA-Z0-9_-]+$/;
const COMMON_FIELDS = ["type", "enabled", "description", "exposure", "toolExposure", "timeout"];

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(name: string, message: string): never {
  // Never attach raw parser, URL, header or environment errors: they can contain secrets.
  throw new Error(`MCP server "${name}": ${message}`);
}

function text(value: unknown, name: string, field: string, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.includes("\0"))
    invalid(name, `${field} must be ${empty ? "a string" : "a nonempty string"} without NUL.`);
  return value;
}

function exposure(value: unknown, name: string): Exposure {
  if (value === "codemode-deferred") return "codemode";
  if (value !== "codemode" && value !== "direct" && value !== "deferred" && value !== "hidden")
    invalid(name, 'exposure must be "codemode", "direct", "deferred", or "hidden".');
  return value;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\")))
    return join(homedir(), value.slice(2));
  return value;
}

function values(value: unknown, name: string, field: "env" | "headers"): Record<string, string> {
  if (value === undefined) return {};
  if (!object(value)) invalid(name, `${field} must map names to strings.`);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      const validKey =
        field === "env" ? /^[a-zA-Z_][a-zA-Z0-9_]*$/ : /^[!#$%&'*+.^_`|~a-zA-Z0-9-]+$/;
      if (!validKey.test(key)) invalid(name, `${field} contains an invalid name.`);
      const raw = text(entry, name, field, true);
      if (raw.trimStart().startsWith("!"))
        invalid(name, `${field} command-based secrets are unsupported; use \${NAME}.`);
      return [key, raw];
    }),
  );
}

function resolveValues(
  entries: Record<string, string>,
  name: string,
  field: "env" | "headers",
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(entries).map(([key, raw]) => {
      const resolved = raw.replace(/\$\{([^{}]*)\}/g, (_match: string, variable: string) => {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(variable))
          invalid(name, `${field} contains an invalid environment reference.`);
        const value = process.env[variable];
        if (value === undefined)
          invalid(name, `${field} references a missing environment variable.`);
        return value;
      });
      if (resolved.includes("\0")) invalid(name, `${field} contains NUL.`);
      if (field === "headers" && /[^\t\x20-\x7e\x80-\xff]/.test(resolved))
        invalid(name, "headers contain an invalid value.");
      return [key, resolved];
    }),
  );
}

function httpUrl(value: unknown, name: string): string {
  const raw = text(value, name, "url");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    invalid(name, "url must be an absolute HTTP(S) URL.");
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    invalid(name, "url requires HTTPS, except for loopback HTTP.");
  if (url.username || url.password || raw.includes("#"))
    invalid(name, "url must not contain credentials or a fragment.");
  return url.href;
}

function parseServer(name: string, raw: unknown, cwd: string): McpServer {
  if (!object(raw)) invalid(name, "configuration must be an object.");
  if ("auth" in raw || "oauth" in raw)
    invalid(name, "auth and oauth are unsupported; use explicit headers with ${NAME}.");
  const http = raw.type === "http" || raw.type === "streamable-http" || "url" in raw;
  const allowed = [
    ...COMMON_FIELDS,
    ...(http ? ["url", "headers"] : ["command", "args", "env", "cwd"]),
  ];
  if (Object.keys(raw).some((key) => !allowed.includes(key)))
    invalid(name, "configuration contains unsupported fields.");
  if (
    raw.type !== undefined &&
    raw.type !== (http ? "http" : "stdio") &&
    !(http && raw.type === "streamable-http")
  )
    invalid(name, 'type must be "stdio", "http", or "streamable-http".');
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean")
    invalid(name, "enabled must be a boolean.");
  if (raw.enabled === false) invalid(name, "selected server is disabled.");
  if (raw.description !== undefined) text(raw.description, name, "description", true);
  const selectedExposure = raw.exposure === undefined ? "codemode" : exposure(raw.exposure, name);
  const toolExposure: Record<string, Exposure> = {};
  if (raw.toolExposure !== undefined) {
    if (!object(raw.toolExposure))
      invalid(name, "toolExposure must map names or * patterns to exposures.");
    for (const [pattern, value] of Object.entries(raw.toolExposure)) {
      text(pattern, name, "toolExposure pattern");
      Object.defineProperty(toolExposure, pattern, {
        value: exposure(value, name),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  let timeoutMs = LIMITS.toolMs;
  if (raw.timeout !== undefined) {
    if (
      typeof raw.timeout !== "number" ||
      !Number.isFinite(raw.timeout) ||
      raw.timeout <= 0 ||
      raw.timeout > LIMITS.toolMs / 1000
    )
      invalid(name, `timeout must be positive seconds, at most ${LIMITS.toolMs / 1000}.`);
    timeoutMs = raw.timeout * 1000;
  }
  const common = {
    name,
    exposure: selectedExposure,
    toolExposure,
    timeoutMs,
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
  };
  if (http)
    return {
      ...common,
      transport: {
        type: "http",
        url: httpUrl(raw.url, name),
        headers: values(raw.headers, name, "headers"),
      },
    };
  const command = text(raw.command, name, "command");
  if (command.trimStart().startsWith("!"))
    invalid(name, "command must name one executable, not a ! command expression.");
  const args: string[] = [];
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args)) invalid(name, "args must be an array of strings.");
    for (const arg of raw.args) args.push(expandHome(text(arg, name, "args", true)));
  }
  return {
    ...common,
    transport: {
      type: "stdio",
      command: expandHome(command),
      args,
      env: values(raw.env, name, "env"),
      cwd: resolve(cwd, expandHome(raw.cwd === undefined ? "." : text(raw.cwd, name, "cwd"))),
    },
  };
}

/**
 * User-only, read-only selection; never inherits parent mcp.json or project configuration.
 * Preparation bounds this file to 64 KiB and charges its shared byte budget. Only selected
 * env/headers interpolate ${NAME}; no commands, OAuth, network or processes run here.
 * Timeout seconds above the hard tool limit fail rather than silently changing the request.
 */
export async function loadMcpServers(
  names: readonly string[],
  cwd: string,
  preparation: Preparation,
): Promise<McpServer[]> {
  if (names.length === 0) return [];
  preparation.check();
  const requested = new Map<string, string>();
  for (const name of names) {
    if (typeof name !== "string" || !NAME.test(name))
      throw new Error("Selected MCP names must match [a-zA-Z0-9_-]+ exactly.");
    const identity = name.replaceAll("-", "_");
    const previous = requested.get(identity);
    if (previous !== undefined && previous !== name)
      throw new Error("Selected MCP names share a normalized namespace.");
    requested.set(identity, name);
  }
  if (requested.size > LIMITS.mcpServers)
    throw new Error(`Selected MCP servers exceed ${LIMITS.mcpServers}.`);
  let source: string;
  try {
    source = await preparation.read(join(getAgentDir(), CONFIG_FILE));
  } catch (error) {
    if (isMissing(error))
      throw new Error(`Missing ${CONFIG_FILE}; selected MCP servers are unavailable.`);
    throw error;
  }
  let config: unknown;
  try {
    config = JSON.parse(source.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`Invalid JSON in ${CONFIG_FILE}.`);
  }
  if (!object(config) || !object(config.mcpServers))
    throw new Error(`${CONFIG_FILE} must contain an mcpServers object.`);
  if (Object.keys(config).some((key) => key !== "mcpServers"))
    throw new Error(`${CONFIG_FILE} contains unsupported top-level fields.`);
  const entries = config.mcpServers;
  for (const name of requested.values()) {
    if (!Object.hasOwn(entries, name)) invalid(name, `not defined in ${CONFIG_FILE}.`);
  }
  for (const key of Object.keys(entries)) {
    const selected = requested.get(key.replaceAll("-", "_"));
    if (selected !== undefined && key !== selected)
      invalid(selected, "configuration contains a conflicting normalized namespace.");
  }
  // Validate every selected entry before acquiring any selected environment values.
  const servers = [...requested.values()].map((name) => parseServer(name, entries[name], cwd));
  return servers.map((server) => {
    const transport = server.transport;
    return {
      ...server,
      transport:
        transport.type === "http"
          ? { ...transport, headers: resolveValues(transport.headers, server.name, "headers") }
          : { ...transport, env: resolveValues(transport.env, server.name, "env") },
    };
  });
}
