import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "../src/runtime/agents.ts";
import { selectTools } from "../src/runtime/tools.ts";

const definition: AgentDefinition = {
  name: "worker",
  description: "Bounded worker",
  tools: ["write"],
  promptMode: "append",
  skills: [],
  systemPrompt: "Do the assigned work.",
  filePath: "/agents/worker.md",
};

test("named tool delegation preserves host authorization instead of bypassing its dispatcher", async () => {
  let committed = false;
  let permitted = false;
  const context = {
    cwd: process.cwd(),
    tools: [
      {
        name: "write",
        label: "Write",
        description: "Commit a change",
        parameters: Type.Object({}),
        async execute() {
          committed = true;
          return { content: [], details: undefined };
        },
      },
    ],
    async executeTool() {
      if (permitted) committed = true;
      return {
        toolCall: { id: "host", name: "write", arguments: {} },
        result: {
          content: [{ type: "text", text: permitted ? "Committed" : "Denied" }],
          details: undefined,
        },
        isError: !permitted,
      };
    },
  } as unknown as ExtensionToolContext;
  const [write] = await selectTools(
    { ...context, toolMetadata: [{ name: "write", source: "builtin", aggregator: false }] },
    definition,
  );
  await write.execute("child", {}, undefined, undefined, context);
  assert.equal(committed, false, "raw tool execution would bypass the host denial");
  permitted = true;
  await write.execute("child", {}, undefined, undefined, context);
  assert.equal(committed, true, "an authorized request must reach the host operation");
});

test("children cannot mutate parent conversations through inherited control tools", async () => {
  for (const name of ["send_message", "followup_task", "close_agent"]) {
    let changedInbox = false;
    const host = {
      cwd: process.cwd(),
      signal: undefined,
      tools: [
        {
          name,
          label: "Message",
          description: "Message",
          parameters: Type.Object({}),
        },
      ],
      toolMetadata: [{ name, source: "extension", aggregator: false }],
      async executeTool() {
        changedInbox = true;
        return {
          toolCall: { type: "toolCall" as const, id: "host", name, arguments: {} },
          result: { content: [], details: undefined },
          isError: false,
        };
      },
    };
    for (const tools of ["all", [name]] satisfies AgentDefinition["tools"][]) {
      try {
        const inherited = await selectTools(host, { ...definition, tools });
        for (const tool of inherited)
          await tool.execute("child", {}, undefined, undefined, {} as ExtensionToolContext);
      } catch {
        // Explicit selection may reject before any child capability is created.
      }
      assert.equal(
        changedInbox,
        false,
        "child selection must not authorize parent conversation effects",
      );
    }
  }
});

test("parent cancellation remains effective when a child supplies its own signal", async () => {
  const parent = new AbortController();
  const child = new AbortController();
  let committed = false;
  const context = {
    cwd: process.cwd(),
    signal: parent.signal,
    tools: [{ name: "write", label: "Write", description: "Commit", parameters: Type.Object({}) }],
    async executeTool(_name: string, _args: unknown, options: { signal: AbortSignal }) {
      await new Promise<void>((resolve) =>
        options.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      if (!options.signal.aborted) committed = true;
      return {
        toolCall: { id: "host", name: "write", arguments: {} },
        result: { content: [], details: undefined },
        isError: true,
      };
    },
  } as unknown as ExtensionToolContext;
  const [write] = await selectTools(
    { ...context, toolMetadata: [{ name: "write", source: "builtin", aggregator: false }] },
    definition,
  );
  const work = write.execute("child", {}, child.signal, undefined, context);
  parent.abort();
  await work;
  assert.equal(committed, false);
});
