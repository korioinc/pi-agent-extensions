import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const readManifest = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));
const manifest = await readManifest("package.json");
assert.ok(
  Array.isArray(manifest.workspaces) && manifest.workspaces.length > 0,
  "Declare at least one workspace in package.json",
);
assert.equal(typeof manifest.version, "string", "The root package must have a version");

const expectedVersion = process.argv[2] ?? manifest.version;
assert.equal(manifest.version, expectedVersion, "The root version must match the release version");

for (const workspace of manifest.workspaces) {
  const pkg = await readManifest(`${workspace}/package.json`);
  assert.equal(pkg.version, expectedVersion, `${pkg.name}: version must match ${expectedVersion}`);
}

console.log(`All packages use version ${expectedVersion}`);
