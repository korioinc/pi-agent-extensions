import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { rememberApproval, supportsApprovalWrites } from "../approvals.ts";

const persistentWrites = {
  skip: !supportsApprovalWrites() && "This platform only offers per-run confirmation",
};

test(
  "a write through another profile waits for the shared destination and merges its latest approvals",
  persistentWrites,
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-shared-approvals-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const backing = join(await realpath(root), "shared.json");
    const [a, b] = ["a", "b"].map((name) => join(root, name));
    await Promise.all([mkdir(a), mkdir(b)]);
    const profileA = join(a, "settings.json"),
      profileB = join(b, "settings.json");
    const first = join(root, "first.md"),
      second = join(root, "second.md");
    await writeFile(second, "rule");
    const info = await stat(second, { bigint: true });
    await writeFile(backing, "{}");
    await Promise.all([symlink(backing, profileA, "file"), symlink(backing, profileB, "file")]);

    // Simulate writer A holding Pi's profile lock and the destination lock while replacing the file.
    const unlockProfile = lockfile.lockSync(profileA, { realpath: false });
    const unlockBacking = lockfile.lockSync(backing, { realpath: false });
    let pending;
    try {
      pending = rememberApproval(profileB, second, info, () => {});
      const staged = join(root, "staged.json");
      await writeFile(
        staged,
        JSON.stringify({ projectInstructions: { approvedSymlinkTargets: [first] } }),
      );
      await rename(staged, backing);
    } finally {
      unlockBacking();
      unlockProfile();
    }
    assert.deepEqual(await pending, []);
    assert.deepEqual(
      JSON.parse(await readFile(backing, "utf8")).projectInstructions.approvedSymlinkTargets,
      [first, second],
    );
  },
);

test(
  "editing the approval array preserves every surrounding JSON byte",
  persistentWrites,
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-lossless-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const target = join(root, "shared.md");
    const path = join(root, "settings.json");
    const before =
      '\uFEFF{\r\n "other" : {"id":9007199254740993,"literal":"\\u0061", "ratio":1.00e-2},\r\n "projectInstructions": { "approvedSymlinkTargets" : [  ] }\r\n}\r\n';
    await writeFile(target, "rule");
    await writeFile(path, before);
    await rememberApproval(path, target, await stat(target, { bigint: true }), () => {});
    assert.equal((await readFile(path, "utf8")).replace(JSON.stringify(target), ""), before);
    const invalid = Buffer.concat([
      Buffer.from('{"plugin":"'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]);
    await writeFile(path, invalid);
    await assert.rejects(
      rememberApproval(path, target, await stat(target, { bigint: true }), () => {}),
      /Invalid UTF-8/,
    );
    assert.deepEqual(await readFile(path), invalid);
  },
);

test(
  "concurrent approvals merge without duplicates and preserve a symlinked settings file",
  persistentWrites,
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-remember-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const settings = join(root, "settings.json");
    const backing = join(root, "dotfiles.json");
    await writeFile(backing, JSON.stringify({ theme: "dark" }));
    await chmod(backing, 0o600);
    const acl = () =>
      execFileSync("/bin/ls", ["-le", backing], { encoding: "utf8" })
        .split("\n")
        .filter((line) => /^\s*\d+:/.test(line));
    if (process.platform === "darwin")
      execFileSync("/bin/chmod", ["+a", "everyone deny execute", backing]);
    const expectedAcl = process.platform === "darwin" ? acl() : [];
    await symlink(backing, settings, "file");
    const paths = [join(root, "a.md"), join(root, "b.md")];
    await Promise.all(paths.map((path) => writeFile(path, "shared rule")));
    const host = SettingsManager.create(root, root);
    host.setTheme("light");
    await Promise.all([
      host.flush(),
      ...[...paths, paths[0]].map(async (path) => {
        await rememberApproval(settings, path, await stat(path, { bigint: true }), () => {});
      }),
    ]);
    const result = JSON.parse(await readFile(backing, "utf8"));
    assert.equal(result.theme, "light");
    assert.deepEqual(result.projectInstructions.approvedSymlinkTargets.sort(), paths);
    assert.ok((await lstat(settings)).isSymbolicLink());
    if (process.platform === "darwin") {
      assert.ok(expectedAcl.length > 0);
      assert.deepEqual(acl(), expectedAcl);
    }
    if (process.platform !== "win32") assert.equal((await stat(backing)).mode & 0o777, 0o600);
  },
);
