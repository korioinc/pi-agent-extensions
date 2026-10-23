import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./agents.ts";
import { createResearchTools } from "./research-tools.ts";

export type ToolHost = Pick<ExtensionToolContext, "cwd" | "executeTool" | "signal"> & {
  toolMetadata?: readonly {
    name: string;
    namespace?: string;
    aggregator: boolean;
    source: string;
    annotations?: ToolDefinition["annotations"];
  }[];
  tools: readonly Pick<
    ExtensionToolContext["tools"][number],
    "name" | "label" | "description" | "parameters" | "executionMode"
  >[];
};

const PARENT_ORCHESTRATION_ROUTES = new Set([
  "spawn_agent",
  "followup_task",
  "close_agent",
  "list_agents",
  "interrupt_agent",
  "send_message",
  "codemode",
  "tool_search",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
  "mcp_search",
  "mcp_describe",
  "mcp_call",
]);

type ToolMetadata = NonNullable<ToolHost["toolMetadata"]>[number];
type HostTool = ToolHost["tools"][number];

function firstByName<T extends { name: string }>(values: readonly T[]): Map<string, T> {
  const index = new Map<string, T>();
  for (const value of values) {
    const name = value.name;
    if (!index.has(name)) index.set(name, value);
  }
  return index;
}

function blockedRoute(name: string, info: ToolMetadata | undefined): boolean {
  if (
    name.startsWith("subagent") ||
    name.startsWith("mcp__") ||
    PARENT_ORCHESTRATION_ROUTES.has(name)
  )
    return true;
  // The callable wrapper omits provenance. Never infer that an unclassified route is safe.
  return (
    !info ||
    info.aggregator ||
    info.namespace?.startsWith("mcp__") === true ||
    info.source === "mcp"
  );
}

function delegateTool(
  tool: HostTool,
  info: ToolMetadata | undefined,
  executeTool: ToolHost["executeTool"],
  parentSignal: AbortSignal | undefined,
): ToolDefinition {
  const name = tool.name;
  return {
    name,
    label: tool.label,
    description: tool.description,
    promptSnippet: tool.description,
    parameters: structuredClone(tool.parameters),
    executionMode: tool.executionMode,
    annotations: info?.annotations && structuredClone(info.annotations),
    async execute(_id, args, signal, onUpdate) {
      const combined = AbortSignal.any([
        ...(parentSignal ? [parentSignal] : []),
        ...(signal ? [signal] : []),
      ]);
      const outcome = await executeTool(name, args, {
        signal: combined,
        onUpdate: onUpdate && ((update) => onUpdate({ ...update, usage: undefined })),
      });
      // Parent dispatch accounts for nested tool usage; report only child model usage outside.
      return { ...outcome.result, usage: undefined, isError: outcome.isError };
    },
  };
}

/** Delegate ordinary tools through the parent; MCP routes belong to the child only. */
export async function selectTools(
  ctx: ToolHost,
  definition: AgentDefinition,
): Promise<ToolDefinition[]> {
  if (Array.isArray(definition.tools) && !definition.tools.length) return [];
  const metadata = firstByName(ctx.toolMetadata ?? []);
  const parent = firstByName(ctx.tools);
  const available = new Map(
    [...parent].filter(([name]) => !blockedRoute(name, metadata.get(name))),
  );
  const names =
    definition.tools === undefined || definition.tools === "all"
      ? [...available.keys()]
      : definition.tools;
  const entries = [...new Set(names)];
  // Snapshot selected declarations before local tool construction can yield.
  const selected = entries.map((name) => {
    if (parent.has(name) && !available.has(name))
      throw new Error(
        `Parent tool route cannot be inherited: ${name}. Agent controls stay parent-owned; select child MCP servers through mcp.`,
      );
    const tool = available.get(name);
    if (tool) return delegateTool(tool, metadata.get(name), ctx.executeTool, ctx.signal);
    if (name === "read_text" || name === "list_files") return name;
    throw new Error(
      `Agent ${definition.name}: tool is not callable in the parent session: ${name}`,
    );
  });
  const local = selected.some((tool) => typeof tool === "string")
    ? firstByName(await createResearchTools(ctx.cwd, ctx.signal))
    : new Map<string, ToolDefinition>();
  return selected.map((tool) => {
    if (typeof tool !== "string") return tool;
    const found = local.get(tool);
    if (!found) throw new Error(`Local research tool is unavailable: ${tool}`);
    return found;
  });
}
