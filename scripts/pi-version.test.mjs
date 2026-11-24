import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { minVersion, satisfies } from "semver";

const root = new URL("../", import.meta.url);
const readManifest = async (path) =>
  JSON.parse(await readFile(new URL(`${path}package.json`, root), "utf8"));
const host = "@earendil-works/pi-coding-agent";
const workspace = await readManifest("");
const packages = await Promise.all(
  workspace.workspaces.map(async (path) => ({ path, manifest: await readManifest(`${path}/`) })),
);

test("every workspace requires the security floor for its Pi dependencies", () => {
  for (const [name, version] of Object.entries(workspace.devDependencies)) {
    if (name.startsWith("@earendil-works/pi-")) assert.equal(version, "1.6.0", name);
  }
  for (const { manifest } of packages) {
    assert.ok(manifest.peerDependencies[host], manifest.name);
    for (const [name, range] of Object.entries({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
    })) {
      if (!name.startsWith("@earendil-works/pi-")) continue;
      assert.equal(minVersion(range)?.version, "1.6.0", `${manifest.name}: ${name} ${range}`);
      assert.ok(satisfies("1.6.1", range), `${manifest.name} must allow later patch releases`);
    }
  }
});

test("local extension entrypoints reject unsupported hosts before registration", async () => {
  let version;
  const actualHost = import.meta.resolve(host);
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier !== host) return nextResolve(specifier, context);
      const source = `export * from ${JSON.stringify(actualHost)}; export const VERSION = ${JSON.stringify(version)};`;
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    },
  });
  try {
    for (const { path, manifest } of packages) {
      const entry = new URL(manifest.pi.extensions[0], new URL(`${path}/`, root));
      const range = manifest.peerDependencies[host];
      const unsupported = ["1.4.0", "1.5.0", "1.5.2", "1.5.10", "1.6.0-beta.1"];
      if (!satisfies("2.0.0", range)) unsupported.push("2.0.0");
      for (version of unsupported) {
        const extension = await import(`${entry.href}?host=${version}`);
        const api = new Proxy(
          {},
          {
            get() {
              throw new Error("Touched the extension API before checking the host");
            },
          },
        );
        await assert.rejects(
          async () => extension.default(api),
          /requires Pi.*1\.6\.0/,
          `${manifest.name} on ${version}`,
        );
        if (extension.createProjectInstructions) {
          await assert.rejects(
            async () => extension.createProjectInstructions(import.meta.dirname)(api),
            /requires Pi.*1\.6\.0/,
          );
        }
      }
    }
  } finally {
    hook.deregister();
  }
});
