import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";

const args = process.argv.slice(2);
assert.ok(
  args.length === 1 && args[0].length > 0,
  "Usage: npm run check:release -- <package-name>-<version>",
);
const tag = args[0];

const root = new URL("../", import.meta.url);
const readManifest = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));
const manifest = await readManifest("package.json");
assert.ok(
  Array.isArray(manifest.workspaces) && manifest.workspaces.length > 0,
  "Declare at least one workspace in package.json",
);
const packages = [];
for (const workspace of manifest.workspaces) {
  assert.ok(
    typeof workspace === "string" && workspace.length > 0 && !/[\r\n]/.test(workspace),
    "Declare workspaces as nonempty, single-line paths in package.json",
  );
  const pkg = await readManifest(`${workspace}/package.json`);
  assert.ok(
    typeof pkg.name === "string" && pkg.name.length > 0,
    `${workspace}: missing package name`,
  );
  assert.ok(
    typeof pkg.version === "string" && pkg.version.length > 0,
    `${workspace}: missing package version`,
  );
  const shortName = pkg.name.split("/").at(-1);
  packages.push({ ...pkg, workspace, tag: `${shortName}-${pkg.version}` });
}

const matches = packages.filter((pkg) => pkg.tag === tag);
assert.ok(
  matches.length > 0,
  `Tag ${tag} does not match a workspace package and version. Expected one of: ${packages.map((pkg) => pkg.tag).join(", ")}`,
);
assert.equal(matches.length, 1, `Ambiguous release tag: ${tag}`);
const target = matches[0];
assert.notEqual(target.private, true, `${target.name} is private and cannot be published`);

if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `workspace=${target.workspace}\n`);
}
console.log(`Validated ${target.name}@${target.version} in ${target.workspace}`);
