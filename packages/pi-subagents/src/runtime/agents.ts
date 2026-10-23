import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  getAgentDir,
  parseFrontmatter,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Preparation, PreparationLimitError, PreparationSafetyError } from "./discovery.ts";
import { LIMITS } from "./limits.ts";
import { safeErrorText } from "./errors.ts";

export type AgentDefinition = {
  name: string;
  description: string;
  enabled?: boolean;
  model?: string;
  maxModelTokens?: number;
  thinkingLevel?: NonNullable<ExtensionContext["thinkingLevel"]>;
  tools?: string[] | "all";
  promptMode: "append" | "replace";
  promptInstructionPath?: string;
  skills: string[];
  mcp?: string[];
  systemPrompt: string;
  filePath: string;
};

type Diagnostic = { filePath: string; error: string };
const SEMANTIC_FIELDS = new Set([
  "name",
  "description",
  "enabled",
  "model",
  "max_model_tokens",
  "thinking",
  "ThinkingLevel",
  "thinkingLevel",
  "tools",
  "prompt_mode",
  "prompt_instruction_path",
  "skills",
  "mcp",
]);
const COSMETIC_FIELDS = new Set(["display_name", "color"]);
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly NonNullable<ExtensionContext["thinkingLevel"]>[];

function errorMessage(error: unknown): string {
  return safeErrorText(error, "Agent definition failed.");
}

class Diagnostics {
  readonly entries: Diagnostic[] = [];
  private bytes = 0;
  private omitted = 0;

  add(filePath: string, error: string): void {
    const entry = { filePath, error };
    const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (this.bytes + bytes > LIMITS.catalogBytes - 128) {
      this.omitted++;
      return;
    }
    this.entries.push(entry);
    this.bytes += bytes;
  }

  result(): Diagnostic[] {
    if (this.omitted)
      this.entries.push({
        filePath: "",
        error: `${this.omitted} additional diagnostics omitted.`,
      });
    return this.entries;
  }
}

function nonemptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`"${field}" must be a nonempty string.`);
  return value.trim();
}

function stringList(value: unknown, field: string): string[] {
  const entries: unknown[] =
    typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  if (typeof value !== "string" && !Array.isArray(value))
    throw new Error(
      `"${field}" must be a comma-separated string or an array of strings; use [] for none or "all" explicitly.`,
    );
  return entries.map((entry) => nonemptyString(entry, field));
}

function selection(value: unknown, field: string): string[] | "all" {
  const entries = stringList(value, field);
  if (entries.some((entry) => entry.includes("*")))
    throw new Error(
      `"${field}" requires exact names, [] or "all"; selectors such as "ext:*" are unsupported.`,
    );
  if (!entries.includes("all")) return entries;
  if (entries.length !== 1) throw new Error(`"${field}" must use "all" alone.`);
  return "all";
}

function parseThinkingLevel(
  frontmatter: Record<string, unknown>,
): AgentDefinition["thinkingLevel"] {
  let result: AgentDefinition["thinkingLevel"];
  for (const field of ["thinking", "ThinkingLevel", "thinkingLevel"]) {
    if (!Object.hasOwn(frontmatter, field)) continue;
    const value = THINKING_LEVELS.find((level) => level === frontmatter[field]);
    if (value === undefined)
      throw new Error(`"${field}" must be one of: ${THINKING_LEVELS.join(", ")}.`);
    if (result !== undefined && result !== value)
      throw new Error("Conflicting thinking, ThinkingLevel, or thinkingLevel values.");
    result = value;
  }
  return result;
}

function parseDefinition(
  filePath: string,
  { frontmatter, body }: ReturnType<typeof parseFrontmatter>,
): AgentDefinition {
  if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter))
    throw new Error("Agent frontmatter must be a YAML mapping.");
  for (const field of Object.keys(frontmatter)) {
    if (field === "skill_add_folders")
      throw new Error(
        '"skill_add_folders" is no longer supported. Use Pi skill source settings and select explicit skill names.',
      );
    if (field === "prompt_default_instruction_path")
      throw new Error(
        '"prompt_default_instruction_path" was renamed to "prompt_instruction_path".',
      );
    if (field === "prompt_default_instruction")
      throw new Error(
        '"prompt_default_instruction" was removed. Use "prompt_mode: replace" with "prompt_instruction_path" and a nonempty Markdown body.',
      );
    if (!SEMANTIC_FIELDS.has(field) && !COSMETIC_FIELDS.has(field))
      throw new Error(`Unsupported agent field ${JSON.stringify(field)}.`);
  }
  const has = (field: string) => Object.hasOwn(frontmatter, field);
  const model = has("model") ? nonemptyString(frontmatter.model, "model") : undefined;
  if (model !== undefined && (model.indexOf("/") <= 0 || model.indexOf("/") === model.length - 1))
    throw new Error('"model" must use provider/model-id; omit it to inherit the parent model.');
  if (has("enabled") && typeof frontmatter.enabled !== "boolean")
    throw new Error('"enabled" must be a boolean.');
  let maxModelTokens: number | undefined;
  if (has("max_model_tokens")) {
    const value = frontmatter.max_model_tokens;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
      throw new Error('"max_model_tokens" must be a positive safe integer; omit it for no limit.');
    maxModelTokens = value;
  }
  const promptMode = has("prompt_mode") ? frontmatter.prompt_mode : "append";
  if (promptMode === "append_custom")
    throw new Error(
      '"append_custom" was removed. Use "prompt_mode: replace" with "prompt_instruction_path" and a nonempty Markdown body.',
    );
  if (promptMode !== "append" && promptMode !== "replace")
    throw new Error('"prompt_mode" must be "append" or "replace".');
  const instruction = has("prompt_instruction_path")
    ? nonemptyString(frontmatter.prompt_instruction_path, "prompt_instruction_path")
    : undefined;
  if (instruction !== undefined && promptMode !== "replace")
    throw new Error('"prompt_instruction_path" is only supported with "prompt_mode: replace".');
  const skills = has("skills") ? selection(frontmatter.skills, "skills") : [];
  const mcp = has("mcp") ? frontmatter.mcp : [];
  if (
    !Array.isArray(mcp) ||
    !mcp.every(
      (name) => typeof name === "string" && /^[A-Za-z0-9_-]+$/.test(name) && name !== "all",
    )
  )
    throw new Error(
      '"mcp" must be an array of exact server names; selectors and "all" are unsupported.',
    );
  if (skills === "all")
    throw new Error('"skills" requires explicit skill names; "all" is no longer supported.');
  return {
    name: nonemptyString(frontmatter.name, "name"),
    description: nonemptyString(frontmatter.description, "description"),
    enabled: frontmatter.enabled !== false,
    model,
    maxModelTokens,
    thinkingLevel: parseThinkingLevel(frontmatter),
    tools: has("tools") ? selection(frontmatter.tools, "tools") : undefined,
    promptMode,
    skills: [...new Set(skills)],
    mcp: [...new Set(mcp)],
    promptInstructionPath:
      instruction === undefined
        ? undefined
        : resolve(
            dirname(filePath),
            instruction === "~"
              ? homedir()
              : instruction.startsWith("~/")
                ? join(homedir(), instruction.slice(2))
                : instruction,
          ),
    systemPrompt: body,
    filePath,
  };
}

async function loadDirectory(
  directory: string,
  diagnostics: Diagnostics,
  preparation: Preparation,
): Promise<Map<string, AgentDefinition | null>> {
  const agents = new Map<string, AgentDefinition | null>();
  const declared = new Set<string>();
  const report = (filePath: string, error: unknown) => {
    preparation.check();
    if (error instanceof PreparationLimitError || error instanceof PreparationSafetyError)
      throw error;
    diagnostics.add(filePath, errorMessage(error));
  };
  // A partial scan cannot prove name uniqueness. Directory failures abort discovery.
  if ((await preparation.root(directory)) === undefined) return agents;
  for await (const entry of preparation.directory(directory)) {
    if (!entry.name.endsWith(".md")) continue;
    const filePath = join(directory, entry.name);
    let declaredName: string | undefined;
    try {
      if (!entry.isFile())
        throw new Error("Agent definition must be a regular file; symlinks are unsupported.");
      const parsed = parseFrontmatter(await preparation.read(filePath, true));
      if (parsed.frontmatter && typeof parsed.frontmatter.name === "string")
        declaredName = parsed.frontmatter.name.trim() || undefined;
      if (declaredName) {
        if (declared.has(declaredName)) {
          agents.set(declaredName, null);
          throw new Error(`Duplicate agent name ${JSON.stringify(declaredName)}.`);
        }
        declared.add(declaredName);
      }
      const agent = parseDefinition(filePath, parsed);
      for (const field of Object.keys(parsed.frontmatter)) {
        if (COSMETIC_FIELDS.has(field))
          diagnostics.add(filePath, `Ignored cosmetic agent field ${JSON.stringify(field)}.`);
      }
      if (agent.enabled === false) {
        agents.set(agent.name, null);
        diagnostics.add(
          filePath,
          `Agent ${JSON.stringify(agent.name)} is disabled by "enabled: false".`,
        );
      } else {
        agents.set(agent.name, agent);
      }
    } catch (error) {
      report(filePath, error);
      if (declaredName) agents.set(declaredName, null);
    }
  }
  return agents;
}

export async function discoverAgents(
  preparation: Preparation,
): Promise<{ agents: AgentDefinition[]; diagnostics: Diagnostic[] }> {
  preparation.check();
  const diagnostics = new Diagnostics();
  const agents = await loadDirectory(resolve(getAgentDir(), "agents"), diagnostics, preparation);
  preparation.check();
  return {
    agents: [...agents.values()]
      .filter((agent): agent is AgentDefinition => agent !== null)
      .sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0)),
    diagnostics: diagnostics.result(),
  };
}
