import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type Api,
} from "@earendil-works/pi-ai";
import { ChildSession } from "../src/session/index.ts";

/** Real SDK/codemode path: server content stays in its authorized boundary. */
test("native child discovery and calls cannot grant hidden or unselected effects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-native-mcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const effects = join(root, "effects");
  const script = join(root, "server.mjs");
  await writeFile(effects, "");
  await writeFile(
    script,
    `
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const [file]=process.argv.slice(2);
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
if(m.method==='initialize')send(m.id,{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'selected',version:'1'}});
else if(m.method==='tools/list')send(m.id,{tools:[{name:'fail',inputSchema:{type:'object',properties:{}}},{name:'hidden',description:'PRIVATE_TOOL_INSTRUCTION',inputSchema:{type:'object',properties:{}}},{name:'commit',inputSchema:{type:'object',properties:{confirmation:{const:'yes'}},required:['confirmation'],additionalProperties:false}}]});
else if(m.method==='tools/call'){if(m.params.name==='fail'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'PRIVATE_EXCEPTION_CREDENTIAL'}})+'\\n');return;}appendFileSync(file,m.params.name+'\\n');send(m.id,{content:[{type:'text',text:'done'}]});}
});
`,
  );
  // These project resources must never execute in the isolated child loader.
  await mkdir(join(root, ".pi", "extensions"), { recursive: true });
  const forbidden = join(root, "ambient-extension-ran");
  await writeFile(
    join(root, ".pi", "extensions", "unsafe.ts"),
    `import {writeFileSync} from 'node:fs'; export default ()=>writeFileSync(${JSON.stringify(forbidden)},'bad');`,
  );
  const model: Model<Api> = {
    provider: "offline",
    api: "offline",
    id: "probe",
    name: "probe",
    baseUrl: "https://unused.invalid",
    reasoning: false,
    input: ["text"],
    contextWindow: 100000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const pending: Promise<void>[] = [];
  let turn = 0;
  let leaked = false;
  let exceptionLeaked = false;
  const scripts = [
    `text(ALL_TOOLS.filter(t=>t.name.startsWith("mcp__"))); text(await describeTool("mcp__selected__hidden")); text(await describeNamespace("unselected"));`,
    `await tools.mcp__selected__hidden({});`,
    `await tools.mcp__unselected__commit({confirmation:"yes"});`,
    `await tools.mcp__selected__commit({confirmation:"no"});`,
    `try { await tools.mcp__selected__fail({}); } catch (error) { text(String(error)); }`,
    `text(await tools.mcp__selected__commit({confirmation:"yes"}));`,
  ];
  const child = new ChildSession(
    {
      cwd: root,
      task: "Use selected tools",
      model,
      thinkingLevel: "off",
      selection: {
        model: `${model.provider}/${model.id}`,
        modelSource: "agent",
        thinkingLevel: "off",
        thinkingSource: "agent",
      },
      agent: { name: "fixture", description: "fixture" },
      promptMode: "replace",
      systemPrompt: "Use only selected tools.",
      appendSystemPrompt: "",
      skills: [],
      tools: [],
      mcp: [
        {
          name: "selected",
          exposure: "codemode",
          toolExposure: { hidden: "hidden" },
          timeoutMs: 1000,
          transport: {
            type: "stdio",
            command: process.execPath,
            args: [script, effects],
            env: {},
            cwd: root,
          },
        },
      ],
      stream(requested, context) {
        leaked ||= JSON.stringify(context).includes("PRIVATE_TOOL_INSTRUCTION");
        exceptionLeaked ||= JSON.stringify(context).includes("PRIVATE_EXCEPTION_CREDENTIAL");
        const code = scripts[turn++];
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const message: AssistantMessage = {
            role: "assistant",
            api: requested.api,
            provider: requested.provider,
            model: requested.id,
            content: code
              ? [{ type: "toolCall", id: String(turn), name: "codemode", arguments: { code } }]
              : [{ type: "text", text: "done" }],
            stopReason: code ? "toolUse" : "stop",
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
          stream.push({ type: "done", reason: code ? "toolUse" : "stop", message });
          stream.end();
        });
        return stream;
      },
    },
    {
      signal: new AbortController().signal,
      safeguardSignal: new AbortController().signal,
      workSignal: new AbortController().signal,
      wrapTools: (t) => t,
      check() {},
      checkStartup() {},
      request() {},
      takeWrapUpNotice: () => undefined,
      takeMessages: () => [],
      exceeded(limit) {
        throw new Error(limit);
      },
      trackTransport: (p) => {
        pending.push(p);
      },
      partial() {},
      usage() {},
      activity() {},
    },
  );
  try {
    await child.start();
    await child.prompt();
  } finally {
    await child.abort();
    await Promise.allSettled(pending);
    await child.close(() => {});
  }
  assert.equal(
    await readFile(effects, "utf8"),
    "commit\n",
    "only the validated selected tool may commit an effect",
  );
  assert.equal(leaked, false, "hidden tool instructions must not enter the model context");
  assert.equal(exceptionLeaked, false, "protocol exceptions must not disclose server credentials");
  await assert.rejects(
    readFile(forbidden),
    { code: "ENOENT" },
    "project extensions cannot run in the child",
  );
});
