import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { resolveSkills } from "../src/runtime/skills.ts";
import { Preparation } from "../src/runtime/discovery.ts";
import type { AgentDefinition } from "../src/runtime/agents.ts";

test("explicit child selection includes parent-disabled skills without enabling or rewriting parent resources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-skill-scope-"));
  const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  const user = join(root, "user");
  const project = join(root, "project");
  process.env.HOME = join(root, "home");
  process.env.PI_CODING_AGENT_DIR = user;
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const add = async (base: string, folder: string, name: string, body: string) => {
    const dir = join(base, "skills", folder);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: Selected instructions\n---\n${body}`,
    );
  };
  await add(user, "dormant", "review-guide", "AUTHORIZED_REVIEW_GUIDANCE");
  await add(user, "other", "unselected", "UNSELECTED_PRIVATE_GUIDANCE");
  await add(join(project, ".pi"), "injected", "project-only", "UNTRUSTED_PROJECT_GUIDANCE");
  const settingsPath = join(user, "settings.json");
  const settings = JSON.stringify({ skills: ["!skills/dormant/**"] });
  await writeFile(settingsPath, settings);
  const definition: AgentDefinition = {
    name: "reviewer",
    description: "Review",
    promptMode: "replace",
    skills: ["review-guide"],
    systemPrompt: "Review",
    filePath: join(user, "agents", "reviewer.md"),
  };
  const resolve = (names: string[], trusted = false) =>
    resolveSkills(
      { ...definition, skills: names },
      project,
      trusted,
      new Preparation(new AbortController().signal, Infinity),
    );
  await resolve(["review-guide"]);
  await assert.rejects(
    resolve(["project-only"]),
    "untrusted project instructions must not reach the child",
  );
  await resolve(["project-only"], true);
  assert.equal(
    await readFile(settingsPath, "utf8"),
    settings,
    "child selection must not rewrite the parent's activation policy",
  );
});
