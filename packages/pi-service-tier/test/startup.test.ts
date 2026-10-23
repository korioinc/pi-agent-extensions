import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import serviceTierExtension from "../index.ts";
import { loadSettings } from "../settings.ts";

test("startup overrides never leak into saved settings and explicit commands take precedence", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-tier-startup-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });

  const path = join(agentDir, "extensions", "pi-service-tier.json");
  loadSettings(path);
  const original = readFileSync(path, "utf8");
  const flags = new Map<string, boolean>();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  let command: (args: string, ctx: ExtensionContext) => Promise<void>;
  serviceTierExtension({
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      handlers.set(event, handler);
    },
    registerFlag() {},
    getFlag(name: string) {
      return flags.get(name);
    },
    registerCommand(_name: string, options: { handler: typeof command }) {
      command = options.handler;
    },
  } as unknown as ExtensionAPI);
  const ctx = {
    hasUI: false,
    model: undefined,
    ui: { setStatus() {}, notify() {} },
  } as unknown as ExtensionContext;

  // Pi parses registered flags after loading the extension factory.
  flags.set("fast", true);
  flags.set("ultrafast", true);
  await handlers.get("session_start")!({}, ctx);
  assert.equal(readFileSync(path, "utf8"), original);

  await command!("", ctx);
  assert.equal(loadSettings(path).fast.enabled, false);
  assert.equal(loadSettings(path).ultrafast.enabled, false);

  await command!("", ctx);
  assert.equal(loadSettings(path).fast.enabled, true);
  assert.equal(loadSettings(path).ultrafast.enabled, false);

  await command!("ultra", ctx);
  assert.equal(loadSettings(path).fast.enabled, true);
  assert.equal(loadSettings(path).ultrafast.enabled, false);
  await command!("ultra", ctx);
  assert.equal(loadSettings(path).ultrafast.enabled, true);

  await command!("off", ctx);
  await handlers.get("model_select")!({}, ctx);
  await command!("", ctx);
  assert.equal(loadSettings(path).fast.enabled, true);
  assert.equal(loadSettings(path).ultrafast.enabled, false);
});
