import {
  createCodemodeExtension,
  createToolSearchExtension,
  type AgentSession,
  type CreateAgentSessionOptions,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ResearchConfig } from "../runtime/index.ts";
import { LIMITS } from "../runtime/limits.ts";
import type { SessionHooks } from "./index.ts";
import { ChildMcp } from "./mcp/index.ts";

type ToolConfig = Pick<ResearchConfig, "tools" | "mcp">;
type ToolHooks = Pick<SessionHooks, "signal" | "checkStartup" | "wrapTools" | "exceeded">;

/** Canonical metadata order, independent of MCP connection timing and tools/list order. */
function orderedTools<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.toSorted((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

/** Own native child tool installation and readiness, not SDK sessions or invocation budgets. */
export class ChildTools {
  private readonly config: ToolConfig;
  private readonly hooks: ToolHooks;
  private readonly mcp: ChildMcp;

  constructor(config: ToolConfig, hooks: ToolHooks) {
    this.config = config;
    this.hooks = hooks;
    // Defer factories and tool wrapping until ChildSession has stored this owner.
    this.mcp = new ChildMcp(config.mcp, hooks.signal, hooks.checkStartup);
  }

  sessionOptions(): Pick<CreateAgentSessionOptions, "noTools" | "tools" | "customTools"> {
    return {
      noTools: "builtin",
      tools: [
        ...this.config.tools.map((tool) => tool.name),
        ...(this.config.mcp.length
          ? [
              "codemode",
              "tool_search",
              "mcp__*",
              "list_mcp_resources",
              "list_mcp_resource_templates",
              "read_mcp_resource",
            ]
          : []),
      ],
      customTools: this.hooks.wrapTools(this.config.tools),
    };
  }

  extensions(): ExtensionFactory[] {
    const extensions: ExtensionFactory[] = this.config.mcp.length
      ? [
          this.bounded(createCodemodeExtension({ mode: "on", models: false })),
          this.bounded(createToolSearchExtension()),
          this.bounded(this.mcp.extension()),
        ]
      : [];
    extensions.push((pi) => {
      pi.on("before_agent_start", (event) => {
        // Earlier native handlers can finish discovery after the event's initial snapshot.
        // Preserve live membership, including revocations and the tool-free safeguard summary.
        event.systemPromptOptions.selectedTools = pi.getActiveTools().toSorted();
      });
    });
    return extensions;
  }

  /** Called after native extension binding has started the selected connections. */
  async ready(session: AgentSession): Promise<void> {
    if (!this.config.mcp.length) return;
    const runner = session.extensionRunner;
    const ui = runner.getUIContext();
    runner.setUIContext({ ...ui, notify: () => this.mcp.notify() }, "print");
    // Native first-prompt readiness only waits for direct tools. Require every selected server.
    const readiness = await runner.emitToolCall({
      type: "tool_call",
      toolCallId: "subagent-startup",
      toolName: "codemode",
      input: { code: "ALL_TOOLS" },
    });
    if (readiness?.block) throw new Error("Child MCP readiness failed.");
    this.mcp.ready();
    const declarations = runner.getAllRegisteredTools().map(({ definition }) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    }));
    if (
      Buffer.byteLength(session.systemPrompt) + Buffer.byteLength(JSON.stringify(declarations)) >
      LIMITS.promptBytes
    )
      this.hooks.exceeded("prompt and tools");
  }

  close(): Promise<void> {
    return this.mcp.close();
  }

  private bounded(factory: ExtensionFactory): ExtensionFactory {
    return (pi) =>
      factory(
        new Proxy(pi, {
          get: (target, key, receiver) => {
            if (key === "getAllTools") return () => orderedTools(target.getAllTools());
            if (key === "setActiveTools")
              return (names: string[]) => target.setActiveTools(names.toSorted());
            if (key !== "registerTool") return Reflect.get(target, key, receiver);
            return (tool: ToolDefinition) => {
              if (this.config.tools.some((ordinary) => ordinary.name === tool.name))
                throw new Error(`Child tool name collision: ${tool.name}`);
              if (tool.name.startsWith("mcp__")) {
                const metadata = {
                  description: tool.description,
                  parameters: tool.parameters,
                  namespace: tool.namespace,
                };
                if (Buffer.byteLength(JSON.stringify(metadata)) > LIMITS.promptBytes)
                  throw new Error("MCP tool declaration exceeds the prompt budget.");
              }
              const prepareLoadout = tool.prepareLoadout;
              const definition: ToolDefinition = prepareLoadout
                ? {
                    ...tool,
                    // Codemode renders callable tools from this hook, not getAllTools().
                    prepareLoadout: (loadout) =>
                      prepareLoadout.call(tool, {
                        ...loadout,
                        declared: orderedTools(loadout.declared),
                        callable: orderedTools(loadout.callable),
                        registered: orderedTools(loadout.registered),
                      }),
                  }
                : tool;
              target.registerTool(this.hooks.wrapTools([definition], tool.name === "codemode")[0]);
            };
          },
        }),
      );
  }
}
