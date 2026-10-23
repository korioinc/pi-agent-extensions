import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { disableAllModes, loadSettings, setModeEnabled } from "../settings.ts";

function settingsPath(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-service-tier-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "settings.json");
}

test("setting each mode persists independently of the other mode", (t) => {
  const path = settingsPath(t);
  writeFileSync(
    path,
    JSON.stringify({
      fast: { enabled: false, serviceTier: "priority", supportedModels: [] },
      ultrafast: { enabled: false, serviceTier: "ultrafast", supportedModels: [] },
    }),
  );

  setModeEnabled(path, "fast", true);
  assert.equal(loadSettings(path).fast.enabled, true);
  assert.equal(loadSettings(path).ultrafast.enabled, false);

  setModeEnabled(path, "ultrafast", true);
  assert.equal(loadSettings(path).fast.enabled, true);
  assert.equal(loadSettings(path).ultrafast.enabled, true);

  setModeEnabled(path, "fast", false);
  assert.equal(loadSettings(path).fast.enabled, false);
  assert.equal(loadSettings(path).ultrafast.enabled, true);
});

test("initial creation and later updates retain manual edits and unknown data", (t) => {
  const path = join(settingsPath(t), "nested", "settings.json");
  const edited = loadSettings(path);
  edited.fast.enabled = true;
  edited.ultrafast.enabled = true;
  edited.fast.supportedModels = ["vendor/custom-fast"];
  edited.ultrafast.supportedModels = [];
  edited.fast.notes = { owner: "manual edit" };
  edited.future = { selected: "retained" };
  writeFileSync(path, JSON.stringify(edited));

  const saved = setModeEnabled(path, "fast", false);
  assert.equal(saved.fast.enabled, false);
  assert.equal(saved.ultrafast.enabled, true);
  const reloaded = loadSettings(path);
  assert.deepEqual(reloaded.fast.supportedModels, edited.fast.supportedModels);
  assert.deepEqual(reloaded.ultrafast.supportedModels, edited.ultrafast.supportedModels);
  assert.deepEqual(reloaded.fast.notes, edited.fast.notes);
  assert.deepEqual(reloaded.future, edited.future);
});

test("disabling all modes persists both flags without changing custom settings and is repeatable", (t) => {
  const path = settingsPath(t);
  const edited = loadSettings(path);
  edited.fast.enabled = true;
  edited.ultrafast.enabled = true;
  edited.fast.supportedModels = ["provider/custom-fast"];
  edited.ultrafast.supportedModels = ["provider/custom-ultra"];
  edited.notes = { owner: "manual edit" };
  writeFileSync(path, JSON.stringify(edited));

  disableAllModes(path);
  const saved = loadSettings(path);
  assert.equal(saved.fast.enabled, false);
  assert.equal(saved.ultrafast.enabled, false);
  assert.deepEqual(saved.fast.supportedModels, edited.fast.supportedModels);
  assert.deepEqual(saved.ultrafast.supportedModels, edited.ultrafast.supportedModels);
  assert.deepEqual(saved.notes, edited.notes);

  disableAllModes(path);
  assert.equal(loadSettings(path).fast.enabled, false);
  assert.equal(loadSettings(path).ultrafast.enabled, false);
});

test("malformed settings are rejected without replacing user data", (t) => {
  const path = settingsPath(t);
  const valid = loadSettings(path);
  const invalidFiles = [
    "{ unfinished manual edit",
    JSON.stringify({ ...valid, fast: { ...valid.fast, enabled: "true" } }),
    JSON.stringify({ ...valid, ultrafast: { ...valid.ultrafast, supportedModels: ["vendor/"] } }),
  ];
  for (const original of invalidFiles) {
    writeFileSync(path, original);
    assert.throws(() => loadSettings(path));
    assert.throws(() => setModeEnabled(path, "fast", true));
    assert.throws(() => disableAllModes(path));
    assert.equal(readFileSync(path, "utf8"), original);
  }
});

test("read failures propagate instead of creating replacement settings", (t) => {
  const path = settingsPath(t);
  writeFileSync(path, "unrelated file");
  assert.throws(() => loadSettings(join(path, "settings.json")));
  assert.throws(() => setModeEnabled(join(path, "settings.json"), "fast", true));
  assert.equal(readFileSync(path, "utf8"), "unrelated file");
});

test(
  "failed writes preserve existing settings and never report success",
  {
    skip: process.platform === "win32" || process.getuid?.() === 0,
  },
  (t) => {
    const path = settingsPath(t);
    loadSettings(path);
    const original = readFileSync(path, "utf8");
    const directory = dirname(path);
    chmodSync(directory, 0o500);
    try {
      assert.throws(() => setModeEnabled(path, "fast", true));
      assert.throws(() => disableAllModes(path));
      assert.equal(readFileSync(path, "utf8"), original);
      assert.throws(() => loadSettings(join(directory, "missing.json")));
    } finally {
      chmodSync(directory, 0o700);
    }
  },
);
