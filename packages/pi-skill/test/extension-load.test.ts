import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const loaderUrl = pathToFileURL(join(dirname(codingAgentEntry), "core/extensions/loader.js")).href;

test("loads through Pi's real extension loader and registers handlers and renderer", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-skill-load-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  });

  const { loadExtensions } = await import(loaderUrl);
  const result = await loadExtensions([extensionPath], agentDir);
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  assert.equal(result.extensions[0]?.handlers.get("input")?.length, 1);
  assert.equal(result.extensions[0]?.handlers.get("session_start")?.length, 1);
  assert.ok(result.extensions[0]?.messageRenderers.has("skill"));
});
