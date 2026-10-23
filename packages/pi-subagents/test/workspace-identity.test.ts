import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectWorkspace, sameWorkspace } from "../src/workspace/identity.ts";

test("workspace identity rejects filesystems without a creation identifier", (t) => {
  const actual = fs.statSync(".", { bigint: true });
  const missingBirthtime = Object.assign(Object.create(Object.getPrototypeOf(actual)), actual, {
    birthtimeNs: 0n,
  });
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(fs, "statSync", () => missingBirthtime);
  syncBuiltinESMExports();

  assert.throws(() => inspectWorkspace("."), /Workspace identity is unavailable/);
});

test("workspace identity rejects ctime substituted for creation time", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-workspace-fallback-"));
  const stat = fs.statSync;
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  });
  // When libuv disables statx, every subsequent stat uses ctime as birthtime.
  t.mock.method(fs, "statSync", (path: string) => {
    const info = stat(path, { bigint: true });
    return Object.assign(info, { birthtimeNs: info.ctimeNs });
  });
  syncBuiltinESMExports();

  assert.throws(() => inspectWorkspace(root));
  await writeFile(join(root, "ordinary-change"), "data");
  assert.throws(() => inspectWorkspace(root));
});

test("workspace identity accepts a new directory with equal creation and change times", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-workspace-new-"));
  const stat = fs.statSync;
  const canonical = fs.realpathSync(root);
  let changed = false;
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  });
  t.mock.method(fs, "statSync", (path: string) => {
    const info = stat(path, { bigint: true });
    // A new directory can have equal times while its older ancestors do not.
    const ctimeNs = info.birthtimeNs + (path === canonical && !changed ? 0n : 1n);
    return Object.assign(info, { ctimeNs });
  });
  syncBuiltinESMExports();

  const before = inspectWorkspace(root);
  await writeFile(join(root, "ordinary-change"), "data");
  changed = true;
  assert(sameWorkspace(before, inspectWorkspace(root)));
  await rm(join(root, "ordinary-change"));
  assert(sameWorkspace(before, inspectWorkspace(root)));
});

test("workspace identity cannot infer creation time support from another filesystem", (t) => {
  const root = fs.realpathSync(".");
  const stat = fs.statSync;
  const device = stat(root, { bigint: true }).dev;
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(fs, "statSync", (path: string) => {
    const info = stat(path, { bigint: true });
    return Object.assign(info, {
      dev: path === root ? device : device + 1n,
      birthtimeNs: path === root ? info.ctimeNs : info.ctimeNs - 1n,
    });
  });
  syncBuiltinESMExports();

  assert.throws(() => inspectWorkspace(root));
});

test("workspace identity changes when a directory is replaced at the same path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-workspace-identity-"));
  const replaced = `${root}-replaced`;
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(replaced, { recursive: true, force: true });
  });
  const before = inspectWorkspace(root);
  await writeFile(join(root, "ordinary-change"), "data");
  assert(sameWorkspace(before, inspectWorkspace(root)));

  await rename(root, replaced);
  await mkdir(root);
  const after = inspectWorkspace(root);
  assert.equal(after.root, before.root);
  assert.equal(sameWorkspace(before, after), false);
  assert.notEqual(after.key, before.key);
});
