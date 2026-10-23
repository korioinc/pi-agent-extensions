import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { selectTools, type ToolHost } from "../src/runtime/tools.ts";
import type { AgentDefinition } from "../src/runtime/agents.ts";

const definition: AgentDefinition = {
  name: "worker",
  description: "Work",
  tools: "all",
  promptMode: "replace",
  skills: [],
  mcp: [],
  systemPrompt: "Work",
  filePath: "/agents/worker.md",
};

test("parent MCP and tool aggregators cannot grant a child unselected capabilities", async () => {
  let forbidden = false;
  let allowed = false;
  const names = [
    "read",
    "mcp__parent__write",
    "codemode",
    "tool_search",
    "read_mcp_resource",
    "mcp_describe",
    "spawn_agent",
    "list_agents",
    "interrupt_agent",
    "custom-router",
    "renamed-mcp",
    "conflicting-provenance",
  ];
  const host: ToolHost = {
    cwd: process.cwd(),
    signal: undefined,
    tools: names.map((name) => ({
      name,
      label: name,
      description: name,
      parameters: Type.Object({}),
    })),
    toolMetadata: [
      ...names.map((name) => ({
        name,
        source: name === "conflicting-provenance" ? "mcp" : "extension",
        aggregator: name === "custom-router",
        namespace: name === "renamed-mcp" ? "mcp__parent" : undefined,
      })),
      // Later duplicate metadata cannot override the authoritative first classification.
      { name: "conflicting-provenance", source: "extension", aggregator: false },
      { name: "read", source: "mcp", aggregator: false },
    ],
    async executeTool(name) {
      if (name === "read") allowed = true;
      else forbidden = true;
      return {
        toolCall: { type: "toolCall", id: "parent", name, arguments: {} },
        result: { content: [], details: undefined },
        isError: false,
      };
    },
  };
  for (const tool of await selectTools(host, definition))
    await tool.execute(
      "call",
      {},
      undefined,
      undefined,
      {} as import("@earendil-works/pi-coding-agent").ExtensionToolContext,
    );
  assert.equal(allowed, true, "ordinary authorized tools retain parent dispatch");
  assert.equal(forbidden, false, "all must not expose direct or indirect parent MCP routes");
  for (const name of names.slice(1))
    await assert.rejects(selectTools(host, { ...definition, tools: [name] }));
  await assert.rejects(
    selectTools({ ...host, toolMetadata: undefined }, { ...definition, tools: ["read"] }),
    "missing provenance cannot broaden inherited capabilities",
  );
});
