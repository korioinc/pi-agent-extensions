import fs from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Preparation, isMissing } from "./discovery.ts";

export type SkillSource = {
  path: string;
  scope: "user" | "project";
  source: string;
  /** Package-relative declarations: positive roots/globs, then !, +exact and -exact overrides. */
  patterns?: string[];
};

type PackageEntry = {
  source: string;
  scope: SkillSource["scope"];
  path: string;
  identity: string;
  delta: boolean;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown, location: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (entry): entry is string =>
        typeof entry === "string" && !!entry.trim() && !entry.includes("\0"),
    )
  )
    throw new Error(`${location} must be an array of nonempty strings.`);
  return value;
}

function localPath(value: string, base: string): string {
  const path = value.trim();
  if (path.startsWith("file://")) return resolve(fileURLToPath(path));
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !isAbsolute(path))
    throw new Error(`Unsupported skill source ${value}; use an explicit local filesystem path.`);
  return resolve(base, path);
}

/** Only deterministic managed Git locations; no checkout, ref reconciliation or subprocess lookup. */
function gitLocation(source: string): { host: string; path: string } {
  const value = source.startsWith("git:") ? source.slice(4).trim() : source;
  const scp = /^git@([^:]+):(.+)$/.exec(value);
  let host: string;
  let path: string;
  try {
    if (scp) {
      host = scp[1]!;
      path = scp[2]!;
    } else {
      const url = new URL(value.includes("://") ? value : `https://${value}`);
      if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) throw new Error();
      if (url.search || url.hash || url.username || url.password || url.port) throw new Error();
      host = url.hostname;
      path = url.pathname.replace(/^\/+/, "");
    }
    if (value.includes("%") || /[?#]/.test(value) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(value))
      throw new Error();
    const separator = path.indexOf("@");
    if (separator >= 0 && !path.slice(separator + 1)) throw new Error();
    path = path.split("@")[0]!.replace(/\.git$/, "");
    const decoded = decodeURIComponent(path);
    if (
      !/^[a-z0-9.-]+$/i.test(host) ||
      host === "." ||
      host === ".." ||
      path.split("/").length !== 2 ||
      decoded.includes("\\") ||
      decoded.includes("\0") ||
      decoded.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error();
  } catch {
    throw new Error(
      `Unsupported installed Git source ${source}; use its explicit local directory in settings.`,
    );
  }
  return { host, path };
}

function packageEntry(
  source: string,
  scope: SkillSource["scope"],
  base: string,
  delta: boolean,
): PackageEntry {
  if (source.startsWith("npm:")) {
    const spec = source.slice(4).trim();
    const match = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@[^\s/\\\0:]+)?$/i.exec(
      spec,
    );
    if (!match)
      throw new Error(`Unsupported npm source ${source}; use an installed package's local path.`);
    const name = match[1]!;
    return {
      source,
      scope,
      delta,
      identity: `npm:${name}`,
      path: join(base, "npm", "node_modules", name),
    };
  }
  if (/^(git:|https?:\/\/|ssh:\/\/)/.test(source)) {
    const git = gitLocation(source);
    return {
      source,
      scope,
      delta,
      identity: `git:${git.host}/${git.path}`,
      path: join(base, "git", git.host, git.path),
    };
  }
  const path = localPath(source, base);
  return { source, scope, delta, identity: `local:${path}`, path };
}

async function readObject(
  path: string,
  preparation: Preparation,
): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await preparation.read(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (cause) {
    throw new Error(`Invalid JSON in skill source metadata: ${path}`, { cause });
  }
  if (!object(value)) throw new Error(`Skill source metadata must be a JSON object: ${path}`);
  return value;
}

function manifestPatterns(value: unknown, path: string): string[] {
  const entries = strings(value, `${path}: pi.skills`);
  for (const entry of entries) {
    const raw = entry.replace(/^[!+-]/, "");
    const pattern = raw === "./" ? "." : raw.replace(/^\.\//, "");
    if (
      !pattern ||
      isAbsolute(pattern) ||
      pattern.includes("\\") ||
      /[:\0]/.test(pattern) ||
      pattern.split("/").some((part) => part === ".." || part === "~")
    )
      throw new Error(
        `Unsupported package skill declaration ${entry} in ${path}; use package-relative paths or globs.`,
      );
  }
  return entries;
}

/**
 * Read-only local inventory, not the parent's active loadout. CLI/extension-injected roots and
 * legacy npm installations are unavailable: declare those directories explicitly in settings.
 * Every configured package must be locally resolvable, even if an unrelated skill was selected.
 * Package versions/refs describe existing storage; discovery never installs or reconciles them.
 */
export async function discoverSkillSources(
  cwd: string,
  trustedProject: boolean,
  preparation: Preparation,
): Promise<SkillSource[]> {
  preparation.check();
  const userBase = resolve(getAgentDir());
  const projectBase = resolve(cwd, ".pi");
  const scopes: { base: string; scope: SkillSource["scope"] }[] = [
    ...(trustedProject ? [{ base: projectBase, scope: "project" as const }] : []),
    { base: userBase, scope: "user" },
  ];
  const roots = new Map<string, SkillSource>();
  const packages = new Map<string, PackageEntry>();
  const users = new Map<string, PackageEntry>();
  const add = async (source: SkillSource, required = false) => {
    const canonical = await preparation.root(source.path);
    if (!canonical) {
      if (required)
        throw new Error(
          `Skill source does not exist: ${source.path}. Fix its settings path; discovery does not install packages.`,
        );
      return;
    }
    const stat = await preparation.io(() => fs.stat(canonical));
    if (!stat.isDirectory() && !(stat.isFile() && canonical.endsWith(".md")))
      throw new Error(`Skill source must be a directory or Markdown file: ${source.path}`);
    const previous = roots.get(canonical);
    if (!previous || (previous.patterns && !source.patterns))
      roots.set(canonical, { ...source, path: canonical });
  };

  for (const { base, scope } of scopes) {
    const settingsPath = join(base, "settings.json");
    const settings = await readObject(settingsPath, preparation);
    for (const entry of strings(
      settings?.skills === undefined ? [] : settings.skills,
      `${settingsPath}: skills`,
    )) {
      preparation.check();
      // SDK top-level globs and !/+/- entries select known candidates; they do not discover roots.
      if (/^[!+-]/.test(entry) || /[*?]/.test(entry)) continue;
      await add({ path: localPath(entry, base), scope, source: settingsPath }, true);
    }
    const entries = settings?.packages === undefined ? [] : settings.packages;
    if (!Array.isArray(entries)) throw new Error(`${settingsPath}: packages must be an array.`);
    for (const value of entries) {
      preparation.check();
      if (typeof value !== "string" && !object(value))
        throw new Error(`${settingsPath}: invalid package entry.`);
      const source = typeof value === "string" ? value : value.source;
      if (typeof source !== "string" || !source.trim() || source.includes("\0"))
        throw new Error(`${settingsPath}: package source must be a nonempty string.`);
      if (object(value) && value.autoload !== undefined && typeof value.autoload !== "boolean")
        throw new Error(`${settingsPath}: package autoload must be boolean.`);
      if (object(value) && value.skills !== undefined)
        strings(value.skills, `${settingsPath}: package skills`);
      const entry = packageEntry(
        source.trim(),
        scope,
        base,
        object(value) && value.autoload === false,
      );
      if (scope === "user") {
        if (!users.has(entry.identity)) users.set(entry.identity, entry);
      } else packages.set(entry.identity, entry);
    }
  }

  if (trustedProject) {
    await add({ path: join(projectBase, "skills"), scope: "project", source: "auto" });
    for (let current = resolve(cwd); ;) {
      await add({ path: join(current, ".agents", "skills"), scope: "project", source: "auto" });
      try {
        await preparation.io(() => fs.lstat(join(current, ".git")));
        break;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
      await preparation.yield();
    }
  }
  await add({ path: join(userBase, "skills"), scope: "user", source: "auto" });
  await add({ path: join(homedir(), ".agents", "skills"), scope: "user", source: "auto" });

  for (const [identity, entry] of users) if (!packages.has(identity)) packages.set(identity, entry);
  for (const entry of packages.values()) {
    // A project autoload:false entry overlays the user's installation, not project package storage.
    const installed =
      entry.scope === "project" && entry.delta ? (users.get(entry.identity) ?? entry) : entry;
    const canonical = await preparation.root(installed.path);
    if (!canonical)
      throw new Error(
        `Package ${entry.source} is not installed at ${installed.path}. Declare its existing local directory in settings; discovery never installs or searches legacy package-manager locations.`,
      );
    if (!(await preparation.io(() => fs.stat(canonical))).isDirectory())
      throw new Error(`Package skill source must be a directory: ${installed.path}`);
    const path = join(canonical, "package.json");
    const manifest = await readObject(path, preparation);
    if (manifest?.pi !== undefined && !object(manifest.pi))
      throw new Error(`Invalid pi manifest in ${path}.`);
    const declared =
      object(manifest?.pi) && manifest.pi.skills !== undefined
        ? manifestPatterns(manifest.pi.skills, path)
        : [];
    // SDK collectManifestFiles falls back to conventions for omitted or empty skill entries.
    const patterns = declared.length ? declared : ["skills"];
    if (patterns.some((pattern) => !/^[!+-]/.test(pattern)))
      await add({ path: canonical, scope: entry.scope, source: entry.source, patterns });
  }
  preparation.check();
  return [...roots.values()];
}
