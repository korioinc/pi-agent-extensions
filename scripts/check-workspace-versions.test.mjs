import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("release validation rejects mismatched versions before publishing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-release-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  const script = join(root, "scripts/check-workspace-versions.mjs");
  await copyFile(new URL("./check-workspace-versions.mjs", import.meta.url), script);
  const writeManifest = (path, manifest) => writeFile(join(root, path), JSON.stringify(manifest));
  await writeManifest("package.json", { version: "1.2.3", workspaces: ["first", "second"] });
  for (const workspace of ["first", "second"]) {
    await mkdir(join(root, workspace));
    await writeManifest(`${workspace}/package.json`, { name: workspace, version: "1.2.3" });
  }
  const check = (...args) => execFileSync(process.execPath, [script, ...args], { stdio: "pipe" });

  assert.doesNotThrow(() => check());
  assert.doesNotThrow(() => check("1.2.3"));
  assert.throws(() => check("1.2.4"));
  assert.throws(() => check(""));

  await writeManifest("second/package.json", { name: "second", version: "1.2.4" });
  assert.throws(() => check());

  await writeManifest("package.json", { version: "1.2.3", workspaces: [] });
  assert.throws(() => check());
});
