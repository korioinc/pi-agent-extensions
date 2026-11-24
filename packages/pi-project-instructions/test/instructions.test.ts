import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, win32, posix } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  getPackageDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createProjectInstructions } from "../index.ts";
import { displayPath, profileSettingsPath, supportsApprovalWrites } from "../approvals.ts";

function dialogTarget(message: string | undefined): string {
  const line = message?.split("\n").find((line) => line.startsWith("Target: "));
  assert.ok(line, "dialog shows the resolved target");
  return line.slice("Target: ".length);
}

test("explicit Windows profiles are independent of the current drive", () => {
  for (const dir of [
    String.raw`\profiles\one`,
    "/profiles/one",
    String.raw`D:profiles\one`,
    "//server",
    "relative",
  ]) {
    assert.throws(() => profileSettingsPath(dir, win32), /drive|absolute/i);
  }
  for (const dir of [
    String.raw`D:\profiles\one`,
    "D:/profiles/one",
    String.raw`\\server\share\one`,
    "//server/share",
  ]) {
    const file = profileSettingsPath(dir, win32);
    assert.equal(file, win32.join(dir, "settings.json"));
    assert.equal(win32.resolve("C:/cwd", file), win32.resolve("E:/cwd", file));
  }
  assert.equal(profileSettingsPath("/profiles/one", posix), "/profiles/one/settings.json");
  assert.throws(() => createProjectInstructions("relative"), /absolute/i);
});

test("a Windows target is displayed with escaped path separators", () => {
  const path = String.raw`C:\Users\Tester\guide.md`;
  assert.equal(JSON.parse(dialogTarget(`Target: ${displayPath(path)}`)), path);
});

test("each run adds only the current trusted directory's instructions to the rendered prompt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-project-instructions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const defaultProfile = join(root, "default-profile");
  await mkdir(defaultProfile);
  process.env.PI_CODING_AGENT_DIR = defaultProfile;
  t.after(() => {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  });
  const cwd = join(root, "child");
  await mkdir(cwd);
  await writeFile(join(root, "AGENTS.md"), "global rule");
  await writeFile(join(cwd, "AGENTS.md"), "workspace rule");
  await writeFile(join(root, "AGENTS.project.md"), "parent-only rule");
  const file = join(cwd, "AGENTS.project.md");
  const settings = SettingsManager.inMemory();
  let prompt = "";
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: root,
    settingsManager: settings,
    noExtensions: true,
    extensionFactories: [
      createProjectInstructions(root),
      (pi) => {
        pi.on("before_agent_start", (event) => {
          prompt = event.systemPrompt;
        });
      },
    ],
  });
  await loader.reload();
  const { session, extensionsResult } = await createAgentSession({
    cwd,
    agentDir: root,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader: loader,
  });
  t.after(() => session.dispose());
  assert.deepEqual(extensionsResult.errors, []);
  const errors: string[] = [];
  session.extensionRunner.onError(({ error }) => errors.push(error));
  const run = async () => {
    await session.extensionRunner.emitBeforeAgentStart(
      { messageType: "user", prompt: "Hello" },
      {
        cwd,
        customPrompt: "base instructions",
        contextFiles: loader.getAgentsFiles().agentsFiles,
        sections: { project_instructions: "another extension's rule" },
      },
    );
    return prompt;
  };
  const baseline = await run();
  assert.match(baseline, /base instructions/);
  assert.match(baseline, /another extension's rule/);
  assert.match(baseline, /global rule[\s\S]*workspace rule/);
  assert.doesNotMatch(baseline, /parent-only rule/);

  const first = "# Project rules\n\nPreserve UTF-8: ✓\n";
  await writeFile(file, first);
  const withFile = await run();
  const entry = `<project_instructions path="${file}">\n${first}\n</project_instructions>`;
  assert.equal(withFile, baseline.replace("</project_context>", `\n${entry}\n</project_context>`));
  await writeFile(file, "updated instructions");
  const updated = await run();
  assert.match(updated, /updated instructions/);
  assert.ok(!updated.includes(first));

  settings.setProjectTrusted(false);
  assert.equal(await run(), baseline);
  await rm(file);
  await mkdir(file);
  assert.equal(await run(), baseline);
  assert.deepEqual(errors, [], "an untrusted directory must not even be read");
  settings.setProjectTrusted(true);
  assert.equal(await run(), baseline);
  assert.equal(errors.length, 1, "read errors other than ENOENT must reach Pi");

  await rm(file, { recursive: true });
  assert.equal(await run(), baseline);
  assert.equal(errors.length, 1, "a missing file is not an error");

  const target = await realpath(join(root, "AGENTS.project.md"));
  await symlink(target, file, "file");
  const approval = JSON.stringify({ projectInstructions: { approvedSymlinkTargets: [target] } });
  const defaultFile = join(defaultProfile, "settings.json");
  await writeFile(defaultFile, approval);
  const unbound = new DefaultResourceLoader({
    cwd,
    agentDir: root,
    settingsManager: settings,
    noExtensions: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../", import.meta.url))],
  });
  const argvEntry = process.argv[1];
  process.argv[1] = join(getPackageDir(), "dist", "bundle", "cli.js");
  try {
    await unbound.reload();
  } finally {
    process.argv[1] = argvEntry;
  }
  const { session: unboundSession, extensionsResult: unboundExtensions } = await createAgentSession(
    {
      cwd,
      agentDir: root,
      settingsManager: settings,
      sessionManager: SessionManager.create(cwd),
      resourceLoader: unbound,
    },
  );
  try {
    assert.deepEqual(unboundExtensions.errors, []);
    const unboundErrors: string[] = [];
    unboundSession.extensionRunner.onError(({ error }) => unboundErrors.push(error));
    const result = await unboundSession.extensionRunner.emitBeforeAgentStart(
      { messageType: "user", prompt: "test" },
      { cwd },
    );
    assert.deepEqual(result.systemPromptOptions.contextFiles, []);
    assert.match(unboundErrors[0] ?? "", /--project-instructions-agent-dir/);
    const unboundRunner = unboundSession.extensionRunner;
    let consent = true;
    const onceMessages: string[] = [];
    unboundRunner.setUIContext(
      {
        ...unboundRunner.getUIContext(),
        confirm: async (_title, message, options) => {
          assert.equal(
            options?.timeout,
            undefined,
            "the TUI lets the user decide without a deadline",
          );
          onceMessages.push(message);
          return consent;
        },
      },
      "tui",
    );
    const unboundRun = async () =>
      (await unboundRunner.emitBeforeAgentStart({ messageType: "user", prompt: "test" }, { cwd }))
        .systemPromptOptions.contextFiles;
    assert.deepEqual(await unboundRun(), [{ path: file, content: "parent-only rule" }]);
    consent = false;
    assert.deepEqual(await unboundRun(), []);
    assert.equal(onceMessages.length, 2);
    assert.match(onceMessages[0], /this run only/i);
    let rpcTimeout: number | undefined;
    unboundRunner.setUIContext(
      {
        ...unboundRunner.getUIContext(),
        confirm: async (_title, _message, options) => {
          rpcTimeout = options?.timeout;
          return false; // Pi resolves an unanswered RPC confirm as false on timeout.
        },
      },
      "rpc",
    );
    assert.deepEqual(await unboundRun(), []);
    assert.equal(rpcTimeout, 15_000);
    await assert.rejects(readFile(join(root, "settings.json")), { code: "ENOENT" });
  } finally {
    unboundSession.dispose();
  }
  await mkdir(join(cwd, ".pi"));
  await writeFile(join(cwd, ".pi", "settings.json"), approval);
  assert.equal(await run(), baseline, "project settings cannot approve a link");
  assert.match(errors.at(-1) ?? "", /approvedSymlinkTargets/);

  const runner = session.extensionRunner;
  const dialogs: string[] = [];
  const globalSettings = join(root, "settings.json");
  const warnings: string[] = [];
  let approve = false;
  let editSettings: string | undefined;
  const concurrentSettings = {
    theme: "dark",
    projectInstructions: { other: true, approvedSymlinkTargets: [join(root, "shared.md")] },
  };
  let swap: "link" | "file" | undefined;
  const replacement = join(root, "replacement.md");
  await writeFile(replacement, "must not be disclosed");
  runner.setUIContext(
    {
      ...runner.getUIContext(),
      notify: (message) => warnings.push(message),
      confirm: async (_title, message) => {
        dialogs.push(message);
        if (editSettings !== undefined) await writeFile(globalSettings, editSettings);
        if (swap === "file") {
          await rename(target, join(root, "original.md"));
          await writeFile(target, "replacement contents");
        } else if (swap === "link") {
          await rm(file);
          await symlink(replacement, file, "file");
        }
        return approve;
      },
    },
    "tui",
  );
  settings.setProjectTrusted(false);
  assert.equal(await run(), baseline);
  assert.equal(dialogs.length, 0);
  settings.setProjectTrusted(true);
  assert.equal(await run(), baseline, "decline skips the link");
  assert.equal(dialogTarget(dialogs[0]), displayPath(target));
  await assert.rejects(readFile(globalSettings), { code: "ENOENT" });
  approve = true;
  if (!supportsApprovalWrites()) {
    assert.match(await run(), /parent-only rule/);
    assert.match(dialogs.at(-1) ?? "", /this run only/i);
    await assert.rejects(readFile(globalSettings), { code: "ENOENT" });
    approve = false;
    assert.equal(
      await run(),
      baseline,
      "consent is not remembered when approval writes are unavailable",
    );
    await writeFile(globalSettings, approval);
    assert.match(
      await run(),
      /parent-only rule/,
      "manual approvals work without support for writing global settings",
    );
    assert.equal(await readFile(defaultFile, "utf8"), approval);
    return;
  }
  const sharedSettings = join(root, "shared-settings.json");
  await writeFile(sharedSettings, "{}");
  await symlink(sharedSettings, globalSettings, "file");
  approve = false;
  assert.equal(await run(), baseline);
  assert.match(dialogs.at(-1) ?? "", /another profile.*saving Pi settings/i);
  assert.equal(await readFile(sharedSettings, "utf8"), "{}");
  await rm(globalSettings);
  approve = true;
  editSettings = JSON.stringify(concurrentSettings);
  const originalRemove = fs.rmSync;
  fs.rmSync = (path, options) => {
    if (typeof path === "string" && basename(path).startsWith(".pi-settings-"))
      throw Object.assign(new Error("fixture cleanup denied"), { code: "EACCES" });
    originalRemove(path, options);
  };
  syncBuiltinESMExports();
  try {
    assert.match(
      await run(),
      /parent-only rule/,
      "post-commit cleanup failure must not skip this run",
    );
  } finally {
    fs.rmSync = originalRemove;
    syncBuiltinESMExports();
  }
  assert.match(warnings.pop() ?? "", /approval.*saved.*cleanup/i);
  editSettings = undefined;
  assert.deepEqual(
    JSON.parse(await readFile(globalSettings, "utf8")),
    {
      theme: "dark",
      projectInstructions: {
        other: true,
        approvedSymlinkTargets: [
          ...concurrentSettings.projectInstructions.approvedSymlinkTargets,
          target,
        ],
      },
    },
    "Yes merges the resolved path into the latest settings",
  );
  const countAfterYes = dialogs.length;
  approve = false;
  assert.match(await run(), /parent-only rule/);
  assert.equal(dialogs.length, countAfterYes, "a remembered path needs no dialog");
  assert.match(dialogs.at(-1) ?? "", /any trusted project/i);
  approve = true;
  await writeFile(globalSettings, "{}");
  editSettings = "invalid json";
  assert.equal(await run(), baseline, "a failed save must not send the file");
  assert.match(errors.at(-1) ?? "", /Approval not saved/);
  assert.equal(await readFile(globalSettings, "utf8"), editSettings);
  editSettings = undefined;
  assert.match(await run(), /parent-only rule/, "bad settings still allow explicit approval");
  assert.match(warnings.pop() ?? "", /Invalid JSON/);
  assert.match(dialogs.at(-1) ?? "", /this run only/i);
  assert.equal(await readFile(globalSettings, "utf8"), "invalid json");
  await rm(globalSettings);
  swap = "file";
  assert.equal(await run(), baseline, "replacing a file during confirmation invalidates consent");
  swap = "link";
  assert.equal(await run(), baseline, "a retargeted link cannot reuse an earlier confirmation");
  await assert.rejects(readFile(globalSettings), { code: "ENOENT" });
  swap = undefined;
  assert.match(await run(), /must not be disclosed/, "an explicitly approved new target is sent");
  assert.deepEqual(JSON.parse(await readFile(globalSettings, "utf8")), {
    projectInstructions: { approvedSymlinkTargets: [await realpath(replacement)] },
  });
  runner.setUIContext(undefined);

  await rename(join(root, "original.md"), target);
  await writeFile(globalSettings, approval);
  assert.equal(await run(), baseline, "approving one file cannot approve a different target");
  await rm(file);
  await symlink(target, file, "file");
  assert.match(await run(), /parent-only rule/, "global approval also works without a UI");
  settings.setProjectTrusted(false);
  assert.equal(await run(), baseline, "global approval cannot override project trust");
  settings.setProjectTrusted(true);
  await writeFile(globalSettings, "{}");
  assert.equal(await run(), baseline, "removing global approval takes effect on the next run");

  await rm(file);
  const alias = join(root, "settings-alias.json");
  await link(globalSettings, alias);
  await symlink(alias, file, "file");
  await writeFile(
    globalSettings,
    JSON.stringify({ projectInstructions: { approvedSymlinkTargets: [await realpath(alias)] } }),
  );
  assert.equal(
    await run(),
    baseline,
    "settings cannot authorize their own contents through an alias",
  );
  assert.match(errors.at(-1) ?? "", /settings file itself.*per-run confirmation/i);
  assert.doesNotMatch(errors.at(-1) ?? "", /approvedSymlinkTargets/);
  await rm(file);
  await link(globalSettings, file);
  assert.equal(await run(), baseline, "a direct hard link cannot disclose Pi settings either");
  assert.match(errors.at(-1) ?? "", /hard link/);
  assert.equal(
    await readFile(defaultFile, "utf8"),
    approval,
    "SDK never writes to the process profile",
  );
});
