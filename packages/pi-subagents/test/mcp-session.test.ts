import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type Api,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ResearchHost } from "../src/runtime/index.ts";
import { inspectWorkspace } from "../src/workspace/identity.ts";
import { runResearch } from "../src/runner/index.ts";
import { RunnerPool } from "../src/runner-pool/index.ts";

// A local protocol fixture, not a user's MCP process or remote service.
const SERVER = `
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const [file,label]=process.argv.slice(2);
appendFileSync(file,label+':start\\n');
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
const schema={type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false};
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
 if(m.method==='initialize')send(m.id,{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:label,version:'1'}});
 else if(m.method==='tools/list')send(m.id,{tools:[{name:'commit',description:'Commit controlled marker',inputSchema:schema},{name:'hidden',description:'Forbidden operation',inputSchema:schema}]});
 else if(m.method==='tools/call'){appendFileSync(file,label+':'+m.params.name+':'+m.params.arguments.value+'\\n');send(m.id,{content:[{type:'text',text:'committed'}]});}
}).on('close',()=>{appendFileSync(file,label+':closed\\n');process.exit(0)});
`;

for (const [exposure, failure, withContinuation = true] of [
  ["codemode", "none"],
  ["deferred", "none"],
  ["direct", "none"],
  ["codemode", "connection"],
  ["codemode", "skill"],
  ["codemode", "skill", false],
] as const) {
  const failStartup = failure === "connection";
  const invalidSkill = failure === "skill";
  test(
    invalidSkill
      ? `an invalid selected skill body cannot start an external MCP server ${withContinuation ? "with" : "without"} continuation`
      : failStartup
        ? "partial MCP startup failure closes acquired servers without prompting"
        : `child ${exposure} MCP calls only its selected server and closes it before completion`,
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "pi-child-mcp-"));
      const previous = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = root;
      t.after(async () => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        await rm(root, { recursive: true, force: true });
      });
      const file = join(root, "effects");
      await writeFile(file, "");
      const script = join(root, "server.mjs");
      await writeFile(script, SERVER);
      if (invalidSkill) {
        const directory = join(root, "skills", "selected");
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, "SKILL.md"),
          Buffer.concat([
            Buffer.from("---\nname: selected\ndescription: Selected instructions\n---\n"),
            Buffer.from([0xff]),
          ]),
        );
      }
      await mkdir(join(root, "agents"));
      await writeFile(
        join(root, "agents", "worker.md"),
        `---\nname: worker\ndescription: Work\nprompt_mode: replace\ntools: []\nskills: [${invalidSkill ? "selected" : ""}]\nmcp: [selected${failStartup ? ", unavailable" : ""}]\n---\nUse the selected MCP server.`,
      );
      await writeFile(
        join(root, "mcp-sub-agents.json"),
        JSON.stringify({
          mcpServers: Object.fromEntries(
            ["selected", "unselected", "unavailable"].map((name) => [
              name,
              {
                command:
                  name === "unavailable" ? join(root, "missing-executable") : process.execPath,
                args: [script, file, name],
                exposure,
                toolExposure: { hidden: "hidden" },
              },
            ]),
          ),
        }),
      );
      const model: Model<Api> = {
        provider: "offline",
        api: "offline",
        id: "model",
        name: "Offline",
        baseUrl: "https://unused.invalid",
        reasoning: false,
        input: ["text"],
        contextWindow: 100000,
        maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      let turn = 0;
      let parentCalled = false;
      const host: ResearchHost = {
        cwd: root,
        workspace: inspectWorkspace(root),
        parentPrompt: "Parent",
        trustedProject: false,
        model,
        models: [model],
        thinkingLevel: "off",
        tools: [],
        signal: undefined,
        async executeTool() {
          parentCalled = true;
          throw new Error("Parent MCP must never be called");
        },
        stream(requested) {
          const stream = createAssistantMessageEventStream();
          const index = turn++;
          const actions =
            exposure === "direct"
              ? [{ name: "mcp__selected__commit", arguments: { value: "authorized" } }]
              : [
                  {
                    name: "codemode",
                    arguments: {
                      code: `const all = ALL_TOOLS.filter(t => t.name.startsWith("mcp__")); if (all.some(t => t.name.includes("unselected") || t.name.endsWith("__hidden"))) throw new Error("Unauthorized registry"); text(all.map(t => t.name)); text(await searchTools("commit")); text(await describeTool("mcp__selected__commit"));`,
                    },
                  },
                  {
                    name: "codemode",
                    arguments: { code: `await tools.mcp__selected__hidden({value:"forbidden"});` },
                  },
                  {
                    name: "codemode",
                    arguments: {
                      code: `await tools.mcp__unselected__commit({value:"forbidden"});`,
                    },
                  },
                  {
                    name: "codemode",
                    arguments: { code: `await tools.mcp__selected__commit({});` },
                  },
                  {
                    name: "codemode",
                    arguments: {
                      code: `const result = await tools.mcp__selected__commit({value:"authorized"}); text(result);`,
                    },
                  },
                ];
          queueMicrotask(() => {
            const action = actions[index];
            const message: AssistantMessage = {
              role: "assistant",
              api: requested.api,
              provider: requested.provider,
              model: requested.id,
              content: action
                ? [
                    {
                      type: "toolCall",
                      id: String(index),
                      name: action.name,
                      arguments: JSON.parse(JSON.stringify(action.arguments)),
                    },
                  ]
                : [{ type: "text", text: "done" }],
              stopReason: action ? "toolUse" : "stop",
              timestamp: Date.now(),
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            };
            stream.push({
              type: "done",
              reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
              message,
            });
            stream.end();
          });
          return stream;
        },
      };
      const history = SessionManager.inMemory(root);
      const continuation = { history, checkHistory() {}, onReady() {}, delivery() {} };
      const pool = new RunnerPool();
      const run = pool.submit({ sessionId: "parent", anchor: null }, (control) =>
        runResearch(
          { scope: () => host, capture: () => host },
          { task: "Perform controlled operation", agent: "worker" },
          control,
          withContinuation ? continuation : undefined,
        ),
      );
      if ("rejection" in run) throw new Error("Unexpected admission failure");
      const result = await run.result;
      if (invalidSkill) {
        assert.equal(
          await readFile(file, "utf8"),
          "",
          "invalid selected instructions must fail before an external server produces startup effects",
        );
        await pool.drain();
        return;
      }
      if (failStartup) {
        assert.equal(result.outcome, "failed");
        assert.equal(turn, 0, "partial startup cannot reach model execution");
        assert.equal(
          await readFile(file, "utf8"),
          "selected:start\nselected:closed\n",
          "earlier acquisitions must close without effects",
        );
        await pool.drain();
        return;
      }
      assert.equal(result.outcome, "succeeded", result.error);
      assert.equal(
        await readFile(file, "utf8"),
        "selected:start\nselected:commit:authorized\nselected:closed\n",
        "only the selected validated operation may produce effects, and its process must stop before result",
      );
      assert.equal(parentCalled, false);
      if (exposure === "direct") {
        await writeFile(
          join(root, "agents", "worker.md"),
          "---\nname: worker\ndescription: Work\nprompt_mode: replace\ntools: []\nskills: []\nmcp: []\n---\nMCP access revoked.",
        );
        turn = 0; // The provider again attempts the formerly selected MCP operation.
        const resumed = pool.submit({ sessionId: "parent", anchor: null }, (control) =>
          runResearch(
            { scope: () => host, capture: () => host },
            { task: "Continue without prior MCP authority", agent: "worker" },
            control,
            continuation,
          ),
        );
        if ("rejection" in resumed) throw new Error("Unexpected admission failure");
        await resumed.result;
        assert.equal(
          await readFile(file, "utf8"),
          "selected:start\nselected:commit:authorized\nselected:closed\n",
          "revoked MCP selection cannot reopen its process or repeat its mutation on native history resume",
        );
      }
      await pool.drain();
    },
  );
}
