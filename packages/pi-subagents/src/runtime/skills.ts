import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import { basename, dirname, join, matchesGlob, relative, sep } from "node:path";
import {
  createSyntheticSourceInfo,
  parseFrontmatter,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./agents.ts";
import { Preparation, PreparationLimitError, isMissing } from "./discovery.ts";
import { LIMITS, boundedText } from "./limits.ts";
import { discoverSkillSources } from "./skill-sources.ts";

function metadata(content: string, path: string) {
  try {
    const { frontmatter } = parseFrontmatter(content);
    if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) return;
    const description = frontmatter.description;
    if (typeof description !== "string" || !description.trim()) return;
    const name =
      typeof frontmatter.name === "string" && frontmatter.name
        ? frontmatter.name
        : basename(dirname(path));
    return {
      name,
      description,
      disableModelInvocation: frontmatter["disable-model-invocation"] === true,
    };
  } catch {
    return;
  }
}

function sourcePatternMatches(path: string, pattern: string, descendants = false): boolean {
  const target = pattern.replace(/^\.\//, "").replace(/\/$/, "");
  if (target === "" || target === ".") return descendants || path === "" || path === ".";
  return matchesGlob(path, target) || (descendants && matchesGlob(path, `${target}/**`));
}

function matchesSource(path: string, root: string, patterns?: string[]): boolean {
  if (patterns === undefined) return true;
  const local = relative(root, path).split(sep).join("/");
  const parent =
    basename(path) === "SKILL.md" ? relative(root, dirname(path)).split(sep).join("/") : undefined;
  const exact = (pattern: string) => {
    const target = pattern.slice(1).replace(/^\.\//, "").replace(/\/$/, "");
    return target === local || target === parent;
  };
  const glob = (pattern: string) =>
    [local, basename(path), ...(parent === undefined ? [] : [parent, basename(parent)])].some(
      (candidate) => sourcePatternMatches(candidate, pattern),
    );
  let included = patterns.some(
    (pattern) => !/^[!+-]/.test(pattern) && sourcePatternMatches(local, pattern, true),
  );
  if (!included) return false;
  if (patterns.some((pattern) => pattern.startsWith("!") && glob(pattern.slice(1))))
    included = false;
  if (patterns.some((pattern) => pattern.startsWith("+") && exact(pattern))) included = true;
  if (patterns.some((pattern) => pattern.startsWith("-") && exact(pattern))) included = false;
  return included;
}

/** Fixed declaration prefixes avoid walking unrelated package trees; glob suffixes stay bounded. */
function sourceDirectory(path: string, root: string, patterns?: string[]): boolean {
  if (patterns === undefined) return true;
  const local = relative(root, path).split(sep).join("/");
  if (!local) return true;
  return patterns.some((pattern) => {
    if (/^[!+-]/.test(pattern)) return false;
    const target = pattern.replace(/^\.\//, "").replace(/\/$/, "");
    if (target === "" || target === ".") return true;
    const wildcard = target.search(/[*?[{(]/);
    const prefix =
      wildcard < 0
        ? target
        : target.slice(0, target.lastIndexOf("/", wildcard) + 1).replace(/\/$/, "");
    return (
      !prefix ||
      local === prefix ||
      prefix.startsWith(`${local}/`) ||
      local.startsWith(`${prefix}/`)
    );
  });
}

export async function resolveSkills(
  definition: AgentDefinition,
  cwd: string,
  trustedProject: boolean,
  preparation: Preparation,
): Promise<Skill[]> {
  preparation.check();
  if (definition.skills.length === 0) return [];

  const names = [...new Set(definition.skills)];
  const selectedNames = new Set(names);
  const candidates = new Map<string, Skill>();
  const sources = await discoverSkillSources(cwd, trustedProject, preparation);

  for (const source of sources) {
    const directories = new Set<string>();
    const load = async (path: string) => {
      if (!matchesSource(path, source.path, source.patterns)) return;
      const filePath = await preparation.io(() => fs.realpath(path));
      if (!(await preparation.visitFile(filePath))) return;
      const header = await preparation.readFrontmatter(filePath);
      const parsed = metadata(header, filePath);
      if (!parsed || !selectedNames.has(parsed.name)) return;
      if (candidates.has(parsed.name)) return;
      candidates.set(parsed.name, {
        ...parsed,
        filePath,
        baseDir: dirname(filePath),
        sourceInfo: createSyntheticSourceInfo(filePath, {
          source: source.source,
          scope: source.scope,
          baseDir: dirname(filePath),
        }),
      });
    };

    const walk = async (directory: string, depth: number, rootFiles: boolean): Promise<void> => {
      if (!sourceDirectory(directory, source.path, source.patterns)) return;
      const canonical = await preparation.io(() => fs.realpath(directory));
      if (directories.has(canonical)) return;
      directories.add(canonical);
      // Separate source filters may revisit a directory; cycles never do.
      if (depth > LIMITS.preparationDepth)
        throw new PreparationLimitError(
          `Preparation depth exceeds ${LIMITS.preparationDepth}: ${directory}`,
        );
      await preparation.visitDirectory(directory, depth);
      const entries: Dirent[] = [];
      for await (const entry of preparation.directory(directory)) entries.push(entry);
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const kind = async (entry: Dirent) => {
        if (!entry.isSymbolicLink()) return entry;
        try {
          return await preparation.io(() => fs.stat(join(directory, entry.name)));
        } catch (error) {
          if (
            isMissing(error) ||
            (error instanceof Error && "code" in error && error.code === "ELOOP")
          )
            return undefined;
          throw error;
        }
      };
      const declared = entries.find((entry) => entry.name === "SKILL.md");
      if (declared && (await kind(declared))?.isFile()) {
        const path = join(directory, declared.name);
        await load(path);
        if (
          source.patterns === undefined ||
          source.patterns.some(
            (pattern) =>
              !/^[!+-]/.test(pattern) &&
              sourcePatternMatches(relative(source.path, path).split(sep).join("/"), pattern, true),
          )
        )
          return;
      }
      if (source.patterns) {
        const local = relative(source.path, directory).split(sep).join("/");
        rootFiles = source.patterns.some(
          (pattern) => !/^[!+-]/.test(pattern) && sourcePatternMatches(local, pattern),
        );
      }
      for (const entry of entries) {
        const local = relative(source.path, join(directory, entry.name)).split(sep).join("/");
        const explicitlyReached = source.patterns?.some((pattern) => {
          if (/^[!+-]/.test(pattern)) return false;
          const target = pattern.replace(/^\.\//, "").replace(/\/$/, "");
          const prefix = target.split(/[*?[{(]/, 1)[0]!;
          return target === local || prefix.startsWith(`${local}/`);
        });
        if ((entry.name.startsWith(".") || entry.name === "node_modules") && !explicitlyReached)
          continue;
        const stat = await kind(entry);
        if (stat?.isDirectory()) await walk(join(directory, entry.name), depth + 1, false);
        else if (
          stat?.isFile() &&
          entry.name.endsWith(".md") &&
          (rootFiles ||
            (source.patterns !== undefined &&
              source.patterns.some(
                (pattern) =>
                  !/^[!+-]/.test(pattern) &&
                  sourcePatternMatches(
                    relative(source.path, join(directory, entry.name)).split(sep).join("/"),
                    pattern,
                  ),
              )))
        )
          await load(join(directory, entry.name));
      }
    };

    const canonical = await preparation.root(source.path);
    if (canonical === undefined) continue;
    const stat = await preparation.io(() => fs.stat(source.path));
    if (stat.isDirectory()) await walk(source.path, 0, true);
    else if (stat.isFile() && source.path.endsWith(".md")) await load(source.path);
    else throw new Error(`Skill path is not a Markdown file or directory: ${source.path}`);
  }

  const skills = names.map((name) => {
    const skill = candidates.get(name);
    if (!skill) throw new Error(`Agent ${definition.name}: skill not found: ${name}`);
    return skill;
  });
  for (const skill of skills) {
    const header = await preparation.readFrontmatter(skill.filePath);
    const current = metadata(header, skill.filePath);
    if (!current || current.name !== skill.name || current.description !== skill.description)
      throw new Error(
        `Selected skill changed during preparation: ${boundedText(skill.filePath, 512)}`,
      );
    // Explicit agent selection authorizes advertising even an opt-in-only skill.
    skill.disableModelInvocation = false;
  }
  preparation.check();
  return skills;
}
