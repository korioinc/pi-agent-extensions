import satisfies from "semver/functions/satisfies.js";
import { constants, lstatSync, realpathSync } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  VERSION,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  displayPath,
  isMissing,
  profileSettingsPath,
  readApprovals,
  rememberApproval,
  sameFile,
  supportsApprovalWrites,
} from "./approvals.ts";

const RPC_CONFIRM_TIMEOUT_MS = 15_000;

function fileError(error: unknown, path: string): Error {
  if (error instanceof Error && "code" in error)
    return new Error(`Cannot access ${displayPath(path)} (${error.code})`);
  return error instanceof Error ? error : new Error(`Cannot access ${displayPath(path)}`);
}

function requireSupportedPi() {
  if (!satisfies(VERSION, ">=1.6.0"))
    throw new Error(`@korioinc/pi-project-instructions requires Pi >=1.6.0; found ${VERSION}.`);
}

export default function projectInstructions(pi: ExtensionAPI) {
  requireSupportedPi();
  pi.registerFlag("project-instructions-agent-dir", {
    type: "string",
    description:
      "Approval profile for linked instructions: an absolute directory or 'default' for Pi's configured CLI profile",
  });
  // Pi applies extension flags after registration. Never infer this binding from
  // argv, cwd or the session store: SDK sessions can share all three.
  const defaultProfile = resolve(getAgentDir());
  register(pi, () => {
    const explicit = pi.getFlag("project-instructions-agent-dir");
    if (typeof explicit !== "string") return undefined;
    return profileSettingsPath(explicit === "default" ? defaultProfile : explicit);
  });
}

export function createProjectInstructions(agentDir: string): ExtensionFactory {
  requireSupportedPi();
  const path = profileSettingsPath(agentDir);
  return (pi) => register(pi, () => path);
}

function register(pi: ExtensionAPI, settingsFor: () => string | undefined) {
  pi.on("before_agent_start", async (event, ctx) => {
    if (!ctx.isProjectTrusted()) return;

    const path = join(ctx.cwd, "AGENTS.project.md");
    let file;
    try {
      const entry = await lstat(path, { bigint: true });
      const linked = entry.isSymbolicLink();
      const target = linked ? await realpath(path) : path;
      const expected = linked ? await lstat(target, { bigint: true }) : entry;
      if (!expected.isFile()) throw new Error(`Expected a regular file: ${displayPath(target)}`);
      const settingsPath = linked || expected.nlink > 1n ? settingsFor() : undefined;
      if (settingsPath === undefined && !linked && expected.nlink > 1n) {
        throw new Error("Hard-linked instructions require an explicit approval profile.");
      }
      if (settingsPath !== undefined && !linked && expected.nlink > 1n) {
        try {
          if (sameFile(expected, await stat(settingsPath, { bigint: true })))
            throw new Error(
              "A hard link to Pi's global settings cannot be used as project instructions.",
            );
        } catch (error) {
          if (!isMissing(error)) throw fileError(error, settingsPath);
        }
      }
      let remember = false;
      if (linked) {
        let approvals = null;
        if (settingsPath !== undefined) {
          try {
            approvals = readApprovals(settingsPath, expected);
          } catch (error) {
            if (!ctx.hasUI) throw fileError(error, settingsPath);
            ctx.ui.notify(fileError(error, settingsPath).message, "warning");
          }
        }
        if (!approvals?.targets.includes(target)) {
          if (!ctx.hasUI) {
            if (settingsPath === undefined)
              throw new Error(
                "Cannot approve linked instructions without a dialog or a bound profile. Use --project-instructions-agent-dir default or createProjectInstructions(agentDir).",
              );
            if (approvals === null)
              throw new Error(
                "The global settings file itself requires per-run confirmation. Use a dialog-capable session; standing approval is not permitted.",
              );
            throw new Error(
              `Symlink target ${displayPath(target)} is not approved. To allow it, add its exact path to projectInstructions.approvedSymlinkTargets in ${displayPath(settingsPath)}.`,
            );
          }
          remember = settingsPath !== undefined && approvals !== null && supportsApprovalWrites();
          let action = "Send this file to the model for this run only? No approval will be saved.";
          if (remember && settingsPath !== undefined) {
            action = `Yes sends this file now and saves its path in ${displayPath(settingsPath)}. Any trusted project linking to this path can send its contents, including future edits, without asking again.`;
            if (approvals?.info && (await lstat(settingsPath)).isSymbolicLink()) {
              action +=
                "\n\nIf another profile shares this file, wait until it has finished saving Pi settings before confirming. Its save can overwrite this approval.";
            }
          }
          if (
            !(await ctx.ui.confirm(
              remember
                ? "Save global approval for linked instructions?"
                : "Send linked project instructions once?",
              `Link: ${displayPath(path)}\nTarget: ${displayPath(target)}\n\n${action}`,
              ctx.mode === "rpc"
                ? { timeout: RPC_CONFIRM_TIMEOUT_MS, signal: ctx.signal }
                : undefined,
            ))
          )
            return;
        }
      }
      if (!ctx.isProjectTrusted()) return;
      const changed = () =>
        new Error(`Project instructions changed while opening: ${displayPath(path)}`);
      const checkTarget = () => {
        if (
          !ctx.isProjectTrusted() ||
          (linked && realpathSync.native(path) !== target) ||
          !sameFile(expected, lstatSync(target, { bigint: true }))
        )
          throw changed();
      };
      file = await open(target, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      const opened = await file.stat({ bigint: true });
      if (!opened.isFile() || !sameFile(opened, expected)) throw changed();
      checkTarget();
      const instructions = await file.readFile("utf8");
      let cleanupWarnings: string[] = [];
      if (remember && settingsPath !== undefined) {
        try {
          cleanupWarnings = await rememberApproval(settingsPath, target, expected, checkTarget);
        } catch (error) {
          throw new Error(
            `Approval not saved; instructions skipped. ${fileError(error, settingsPath).message}`,
          );
        }
      }
      if (instructions && ctx.isProjectTrusted())
        event.systemPromptOptions.contextFiles.push({ path, content: instructions });
      if (cleanupWarnings.length)
        ctx.ui.notify(`Approval is saved. ${cleanupWarnings.join(" ")}`, "warning");
    } catch (error) {
      if (isMissing(error)) return;
      throw fileError(error, path);
    } finally {
      await file?.close();
    }
  });
}
