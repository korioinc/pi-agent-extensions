import assert from "node:assert/strict";
import fs, { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createResearchTools } from "../src/runtime/research-tools.ts";

test("research tools permit local research but deny reads and listings outside their root", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-research-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = join(fixture, "work");
  const outside = join(fixture, "work-private");
  const permittedText = "Research available to this workspace.";
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(root, "note.txt"), permittedText);
  await writeFile(join(outside, "secret.txt"), "Private data from another workspace.");
  await symlink(join(root, "note.txt"), join(root, "local-link"));
  await symlink(join(outside, "secret.txt"), join(root, "escape-file"));
  await symlink(outside, join(root, "escape-directory"));
  const tools = await createResearchTools(root);
  const read = tools.find((tool) => tool.name === "read_text");
  const list = tools.find((tool) => tool.name === "list_files");
  if (!read || !list) throw new Error("Research tools unavailable.");
  // These tools do not use host context or callbacks.
  const context = {} as ExtensionToolContext;

  for (const path of ["note.txt", "local-link"]) {
    const result = await read.execute("allowed", { path }, undefined, undefined, context);
    assert.ok(
      result.content.some((part) => part.type === "text" && part.text.includes(permittedText)),
    );
  }
  await list.execute("allowed", { path: "." }, undefined, undefined, context);

  for (const path of [
    join(outside, "secret.txt"),
    "../work-private/secret.txt",
    "escape-file",
    "escape-directory/secret.txt",
    "unused/../note.txt",
  ]) {
    await assert.rejects(read.execute("denied", { path }, undefined, undefined, context));
  }
  for (const path of [outside, "../work-private", "escape-directory"]) {
    await assert.rejects(list.execute("denied", { path }, undefined, undefined, context));
  }
});

for (const when of ["before_stat", "before_open", "restored_after_open"] as const) {
  test(`ancestor replacement ${when} cannot disclose outside-root file contents`, async (t) => {
    const fixture = await mkdtemp(join(tmpdir(), "pi-research-replacement-"));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    await mkdir(join(fixture, "work", "docs"), { recursive: true });
    const root = await fs.realpath(join(fixture, "work"));
    const outside = join(fixture, "private");
    await mkdir(outside);
    const target = join(root, "docs", "note.txt");
    const privateText = "Private file outside the authorized research root.";
    await writeFile(target, "Allowed workspace data.");
    await writeFile(join(outside, "note.txt"), privateText);
    const read = (await createResearchTools(root)).find((tool) => tool.name === "read_text")!;
    let replaced = false;
    const replace = async () => {
      await fs.rename(join(root, "docs"), join(root, "original"));
      await fs.symlink(outside, join(root, "docs"));
      replaced = true;
    };
    const stat = fs.stat;
    t.mock.method(fs, "stat", async (...args: Parameters<typeof fs.stat>) => {
      if (args[0] === target && !replaced && when !== "before_open") await replace();
      return stat(...args);
    });
    const open = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === target && !replaced && when === "before_open") await replace();
      const handle = await open(...args);
      if (args[0] === target && when === "restored_after_open") {
        await fs.unlink(join(root, "docs"));
        await fs.rename(join(root, "original"), join(root, "docs"));
      }
      return handle;
    });
    let disclosed = "";
    try {
      const result = await read.execute(
        "replacement",
        { path: "docs/note.txt" },
        undefined,
        undefined,
        {} as ExtensionToolContext,
      );
      disclosed = result.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
    } catch {
      // A changed file may be denied; returning previously authorized data is also safe.
    }
    assert(!disclosed.includes(privateText), "a pathname race must not grant private-file access");
  });
}
