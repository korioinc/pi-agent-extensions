import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function releaseFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-release-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  const script = join(root, "scripts/check-release.mjs");
  await copyFile(new URL("./check-release.mjs", import.meta.url), script);
  const writeManifest = (path, manifest) => writeFile(join(root, path), JSON.stringify(manifest));
  await writeManifest("package.json", {
    private: true,
    version: "9.0.0",
    workspaces: ["first", "second"],
  });
  await mkdir(join(root, "first"));
  await mkdir(join(root, "second"));
  await writeManifest("first/package.json", { name: "@example/pi-first", version: "1.2.3" });
  await writeManifest("second/package.json", { name: "@example/pi-second", version: "4.5.6" });
  const output = join(root, "github-output");
  await writeFile(output, "existing=value\n");
  const check = (...args) =>
    execFileSync(process.execPath, [script, ...args], {
      stdio: "pipe",
      env: { ...process.env, GITHUB_OUTPUT: output },
    });
  return { check, output, writeManifest };
}

test("release validation accepts independently versioned workspace packages", async (t) => {
  const { check } = await releaseFixture(t);
  assert.doesNotThrow(() => check("pi-first-1.2.3"));
  assert.doesNotThrow(() => check("pi-second-4.5.6"));
});

test("invalid release tags cannot authorize a publish target", async (t) => {
  const { check, output } = await releaseFixture(t);
  const before = await readFile(output, "utf8");
  for (const args of [
    [],
    [""],
    ["v1.2.3"],
    ["pi-first-v1.2.3"],
    ["pi-missing-1.2.3"],
    ["pi-first-4.5.6"],
    ["pi-first-1.2.4"],
    ["pi-first-1.2.3", "pi-second-4.5.6"],
  ]) {
    assert.throws(() => check(...args));
  }
  assert.equal(await readFile(output, "utf8"), before);
});

test("private workspace packages cannot authorize a publish target", async (t) => {
  const { check, output, writeManifest } = await releaseFixture(t);
  await writeManifest("first/package.json", {
    name: "@example/pi-first",
    version: "1.2.3",
    private: true,
  });
  const before = await readFile(output, "utf8");
  assert.throws(() => check("pi-first-1.2.3"));
  assert.equal(await readFile(output, "utf8"), before);
});

test("ambiguous tags cannot authorize either workspace", async (t) => {
  const { check, output, writeManifest } = await releaseFixture(t);
  await writeManifest("second/package.json", { name: "@other/pi-first", version: "1.2.3" });
  const before = await readFile(output, "utf8");
  assert.throws(() => check("pi-first-1.2.3"));
  assert.equal(await readFile(output, "utf8"), before);
});
