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

for (const name of ["write", "spawn_agent"])
  test(`${name} delegation follows tool selection and host authorization`, async () => {
    let committed = false;
    let permitted = false;
    const context = {
      cwd: process.cwd(),
      tools: [
        {
          name,
          label: "Operation",
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
          toolCall: { id: "host", name, arguments: {} },
          result: {
            content: [{ type: "text", text: permitted ? "Committed" : "Denied" }],
            details: undefined,
          },
          isError: !permitted,
        };
      },
    } as unknown as ExtensionToolContext;
    for (const tools of ["all", [name]] satisfies AgentDefinition["tools"][]) {
      committed = false;
      permitted = false;
      const [delegated] = await selectTools(
        { ...context, toolMetadata: [{ name, source: "extension", aggregator: false }] },
        { ...definition, tools },
      );
      await delegated.execute("child", {}, undefined, undefined, context);
      assert.equal(committed, false, "raw tool execution would bypass the host denial");
      permitted = true;
      await delegated.execute("child", {}, undefined, undefined, context);
      assert.equal(committed, true, "an authorized request must reach the host operation");
    }
  });

test("children cannot mutate parent conversations through inherited control tools", async () => {
  for (const name of ["subagent", "followup_task", "send_message", "close_agent"]) {
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

test("delegated tool promptSnippet uses a bounded first line instead of duplicating full descriptions", async () => {
  const longDescription = `${"Summary line ".repeat(30)}\nSecond line with detailed usage docs.`;
  const context = {
    cwd: process.cwd(),
    signal: undefined,
    tools: [
      {
        name: "write",
        label: "Write",
        description: longDescription,
        parameters: Type.Object({}),
      },
    ],
    toolMetadata: [{ name: "write", source: "builtin", aggregator: false }],
    async executeTool() {
      return {
        toolCall: { type: "toolCall" as const, id: "host", name: "write", arguments: {} },
        result: { content: [], details: undefined },
        isError: false,
      };
    },
  };
  const [delegated] = await selectTools(context, definition);
  assert.equal(delegated.description, longDescription);
  assert.ok(delegated.promptSnippet);
  assert.ok(!delegated.promptSnippet.includes("\n"));
  assert.ok(Buffer.byteLength(delegated.promptSnippet) <= 240);
});
