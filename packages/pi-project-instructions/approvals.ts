import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  type BigIntStats,
  constants,
  accessSync,
  closeSync,
  ftruncateSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import nativePath, { basename, dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseTree, type Node as JsonNode, type ParseError } from "jsonc-parser";
import lockfile from "proper-lockfile";

export function profileSettingsPath(agentDir: string, paths = nativePath): string {
  if (!paths.isAbsolute(agentDir))
    throw new Error("The Pi agent directory must be an absolute path.");
  // Windows treats a single leading separator as absolute, but its drive follows cwd.
  if (paths.sep === "\\" && paths.parse(agentDir).root.length === 1)
    throw new Error("The Pi agent directory must include a drive letter or a UNC share.");
  return paths.join(agentDir, "settings.json");
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function displayPath(path: string): string {
  return JSON.stringify(path).replace(
    /[\p{Cf}\p{Zl}\p{Zp}\u007f-\u009f]/gu,
    (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`,
  );
}

export function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function approvalProperty(object: JsonNode, key: string, path: string): JsonNode | undefined {
  const matches = object.children?.filter((property) => property.children?.[0].value === key) ?? [];
  if (matches.length > 1) throw new Error(`Duplicate ${key} in ${displayPath(path)}`);
  return matches[0]?.children?.[1];
}

// A null result means the settings file is itself the proposed instruction file.
export function readApprovals(path: string, target: BigIntStats) {
  let info: BigIntStats | undefined;
  let source = "{}\n";
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    info = fstatSync(fd, { bigint: true });
    if (!info.isFile()) throw new Error(`Expected a settings file: ${displayPath(path)}`);
    if (sameFile(info, target)) return null;
    const bytes = readFileSync(fd);
    try {
      source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new Error(`Invalid UTF-8 in ${displayPath(path)}`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const bomLength = source.startsWith("\uFEFF") ? 1 : 0;
  const errors: ParseError[] = [];
  const root = parseTree(source.slice(bomLength), errors, {
    disallowComments: true,
    allowTrailingComma: false,
  });
  if (!root || errors.length) throw new Error(`Invalid JSON in ${displayPath(path)}`);
  if (root.type !== "object") throw new Error(`Expected a settings object in ${displayPath(path)}`);
  const config = approvalProperty(root, "projectInstructions", path);
  if (config && config.type !== "object")
    throw new Error(`Expected a projectInstructions object in ${displayPath(path)}`);
  const array = config && approvalProperty(config, "approvedSymlinkTargets", path);
  const targets: string[] = [];
  if (array) {
    const elements = array.children ?? [];
    if (
      array.type !== "array" ||
      elements.some((item) => item.type !== "string" || !isAbsolute(item.value))
    )
      throw new Error(
        `Expected absolute file paths in projectInstructions.approvedSymlinkTargets in ${displayPath(path)}`,
      );
    for (const item of elements) targets.push(item.value);
  }
  const container = array ?? config ?? root;
  const last = container.children?.at(-1);
  const offset = bomLength + (last ? last.offset + last.length : container.offset + 1);
  function append(target: string) {
    const literal = JSON.stringify(target);
    const property = `"approvedSymlinkTargets": [${literal}]`;
    const insertion = array ? literal : config ? property : `"projectInstructions": {${property}}`;
    return source.slice(0, offset) + (last ? ", " : "") + insertion + source.slice(offset);
  }
  return { targets, info, append };
}

function windowsFileOperation(temp: string, destination: string, command: string) {
  execFileSync(
    join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; ${command}`],
    {
      env: { ...process.env, PI_APPROVAL_TEMP: temp, PI_APPROVAL_DEST: destination },
      stdio: "ignore",
    },
  );
}

let linuxCanCopyMetadata: boolean | undefined;
export function supportsApprovalWrites(): boolean {
  if (process.platform !== "linux") return true;
  if (linuxCanCopyMetadata === undefined) {
    try {
      linuxCanCopyMetadata = execFileSync("/bin/cp", ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).startsWith("cp (GNU coreutils)");
    } catch {
      linuxCanCopyMetadata = false;
    }
  }
  return linuxCanCopyMetadata;
}

// Cleanup must not undo the reported outcome of an atomic settings replacement.
function cleanup(warnings: string[], path: string, action: () => void) {
  try {
    action();
  } catch (error) {
    const code = error instanceof Error && "code" in error ? ` (${error.code})` : "";
    warnings.push(`Cleanup failed for ${displayPath(path)}${code}.`);
  }
}

function settingsDestination(path: string): string {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    if (lstatSync(path, { throwIfNoEntry: false }))
      throw new Error(`Cannot replace a dangling settings link: ${displayPath(path)}`);
    return join(realpathSync.native(dirname(path)), basename(path));
  }
}

function commitApproval(
  path: string,
  destination: string,
  target: string,
  expected: BigIntStats,
  checkTarget: () => void,
  warnings: string[],
) {
  const latest = readApprovals(destination, expected);
  if (!latest) throw new Error("Cannot save a standing approval for Pi's own settings.");
  checkTarget();
  if (latest.targets.includes(target)) return;
  if (latest.info && latest.info.nlink > 1n)
    throw new Error("Cannot atomically update hard-linked Pi settings.");
  if (latest.info) accessSync(destination, constants.W_OK);
  if (!supportsApprovalWrites())
    throw new Error("Saving approvals on Linux requires GNU cp at /bin/cp.");
  const stage = join(dirname(destination), `.pi-settings-${randomUUID()}.tmp`);
  if (process.platform === "win32") {
    // Create the staging directory with its final DACL; an inherited handle could outlive an ACL change.
    windowsFileOperation(
      stage,
      destination,
      [
        "$acl=New-Object System.Security.AccessControl.DirectorySecurity",
        "$acl.SetAccessRuleProtection($true,$false)",
        "$user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
        "$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($user,'FullControl','ContainerInherit,ObjectInherit','None','Allow')",
        "$acl.AddAccessRule($rule)",
        "[void][System.IO.Directory]::CreateDirectory($env:PI_APPROVAL_TEMP,$acl)",
      ].join("; "),
    );
  } else mkdirSync(stage, { mode: 0o700 });
  const temp = join(stage, "settings.json");
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      if (latest.info && process.platform !== "win32") {
        // Preserve access ACLs as well as mode bits; chmod alone can broaden access.
        const flags = process.platform === "linux" ? ["--preserve=mode,ownership,xattr"] : ["-p"];
        execFileSync("/bin/cp", [...flags, destination, temp], { stdio: "ignore" });
        const copied = fstatSync(fd, { bigint: true });
        if (
          copied.uid !== latest.info.uid ||
          copied.gid !== latest.info.gid ||
          copied.mode !== latest.info.mode ||
          !sameFile(copied, statSync(temp, { bigint: true }))
        )
          throw new Error("Cannot preserve global settings permissions.");
        ftruncateSync(fd, 0);
      }
      writeFileSync(fd, latest.append(target));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const current = lstatSync(destination, { bigint: true, throwIfNoEntry: false });
    if (
      settingsDestination(path) !== destination ||
      (latest.info
        ? !current || !sameFile(current, latest.info) || current.ctimeNs !== latest.info.ctimeNs
        : current !== undefined)
    )
      throw new Error(`Global settings changed; retry the approval: ${displayPath(path)}`);
    checkTarget();
    if (latest.info && process.platform === "win32") {
      // ReplaceFileW preserves the destination DACL. Pass paths as data, not shell code.
      windowsFileOperation(
        temp,
        destination,
        "[System.IO.File]::Replace($env:PI_APPROVAL_TEMP, $env:PI_APPROVAL_DEST, [System.Management.Automation.Language.NullString]::Value)",
      );
    } else renameSync(temp, destination);
  } finally {
    cleanup(warnings, stage, () => rmSync(stage, { recursive: true, force: true }));
  }
}

// Succeed with all locks held or release the partial set immediately.
function withSettingsLocks(keys: string[], warnings: string[], update: () => void): boolean {
  const held: { key: string; release: () => void }[] = [];
  try {
    for (const key of keys) {
      try {
        held.push({ key, release: lockfile.lockSync(key, { realpath: false }) });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ELOCKED") return false;
        throw error;
      }
    }
    update();
    return true;
  } finally {
    for (const { key, release } of held.reverse()) cleanup(warnings, `${key}.lock`, release);
  }
}

export async function rememberApproval(
  path: string,
  target: string,
  expected: BigIntStats,
  checkTarget: () => void,
): Promise<string[]> {
  const warnings: string[] = [];
  mkdirSync(dirname(path), { recursive: true });
  // Pi locks the profile entry. Profiles with different settings symlinks must also
  // serialize on the destination. Canonicalize the directory, not the entry, for Pi's key.
  const profile = join(realpathSync.native(dirname(path)), basename(path));
  for (let attempt = 0; ; attempt++) {
    const destination = settingsDestination(profile);
    const keys = lstatSync(profile, { throwIfNoEntry: false })?.isSymbolicLink()
      ? [profile, destination].sort()
      : [destination];
    try {
      const committed = withSettingsLocks(keys, warnings, () => {
        if (settingsDestination(path) !== destination)
          throw new Error(`Global settings changed; retry the approval: ${displayPath(path)}`);
        commitApproval(path, destination, target, expected, checkTarget, warnings);
      });
      if (committed) return warnings;
      if (attempt >= 10 || warnings.length)
        throw new Error(`Settings are busy; retry the approval: ${displayPath(path)}`);
    } catch (error) {
      if (!warnings.length) throw error;
      const reason =
        error instanceof Error && !("code" in error)
          ? error.message
          : `Could not update ${displayPath(path)}.`;
      throw new Error([reason, ...warnings].join(" "), { cause: error });
    }
    // Never wait with either lock held: Pi's own writes run synchronously.
    await delay(20);
  }
}
