import { createHash } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  VERSION,
  type ExtensionToolContext,
  type Skill,
  type ToolDefinition,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { discoverAgents, type AgentDefinition } from "./agents.ts";
import { Preparation } from "./discovery.ts";
import { selectTools, type ToolHost } from "./tools.ts";
import { resolveSkills } from "./skills.ts";
import { loadMcpServers, type McpServer } from "./mcp.ts";
import { LIMITS } from "./limits.ts";
import { SUBAGENT_ROLE_INSTRUCTIONS } from "../instructions/subagent.ts";
import type { HandoffReference } from "./handoff.ts";
import { inspectWorkspace, sameWorkspace, type WorkspaceIdentity } from "../workspace/identity.ts";

export interface ResearchScope extends Pick<ToolHost, "cwd" | "signal"> {
  workspace: WorkspaceIdentity;
  trustedProject: boolean;
}

/** Borrowed catalogs are consumed synchronously to snapshot only the selected capabilities. */
export interface ResearchHost extends ToolHost, ResearchScope {
  parentPrompt?: string;
  model?: Model<Api>;
  models: readonly Model<Api>[];
  thinkingLevel: NonNullable<ExtensionToolContext["thinkingLevel"]>;
  stream: ExtensionToolContext["modelRegistry"]["streamSimple"];
}

export interface ResearchSource {
  scope(): ResearchScope;
  capture(includeParentPrompt: boolean): ResearchHost;
}

export interface ResolvedSelection {
  model: string;
  modelSource: "agent" | "parent";
  thinkingLevel: ResearchHost["thinkingLevel"];
  thinkingSource: "agent" | "parent";
}

export interface ResearchConfig {
  cwd: string;
  task: string;
  handoff?: HandoffReference;
  followupRequestId?: string;
  model: Model<Api>;
  thinkingLevel: ResearchHost["thinkingLevel"];
  selection: ResolvedSelection;
  maxModelTokens?: number;
  stream: ResearchHost["stream"];
  agent: { name: string; description: string };
  promptMode: AgentDefinition["promptMode"];
  tools: ToolDefinition[];
  systemPrompt: string;
  appendSystemPrompt: string;
  skills: Skill[];
  mcp: McpServer[];
}

/** Lazy parent adapters. Catalogs and policy are read only after admitted definition discovery. */
export function createResearchSource(
  ctx: ExtensionToolContext,
  metadata?: () => readonly ToolInfo[],
  capturePrompt?: (ctx: ExtensionToolContext) => string,
): ResearchSource {
  const scope = (): ResearchScope => {
    const workspace = inspectWorkspace(ctx.cwd);
    return Object.freeze({
      cwd: workspace.root,
      workspace,
      trustedProject: ctx.isProjectTrusted(),
      signal: ctx.signal,
    });
  };
  return {
    scope,
    capture(includeParentPrompt) {
      const parentPrompt = includeParentPrompt ? capturePrompt?.(ctx) : undefined;
      if (includeParentPrompt && !parentPrompt?.trim())
        throw new Error("The parent policy snapshot is empty or unavailable.");
      if (parentPrompt !== undefined && Buffer.byteLength(parentPrompt) > LIMITS.promptBytes)
        throw new Error("Parent policy exceeds the prompt budget.");
      const current = scope();
      const registry = ctx.modelRegistry;
      return Object.freeze({
        ...current,
        parentPrompt,
        model: ctx.model,
        models: registry.getAll(),
        thinkingLevel: ctx.thinkingLevel ?? "off",
        stream: registry.streamSimple.bind(registry),
        tools: ctx.tools,
        executeTool: ctx.executeTool.bind(ctx),
        toolMetadata: metadata?.().map(
          ({ name, namespace, reachesTools, sourceInfo, annotations }) => ({
            name,
            namespace: namespace?.name,
            aggregator: reachesTools !== undefined,
            source: sourceInfo.source,
            annotations,
          }),
        ),
      });
    },
  };
}

export function validateTask(task: string): void {
  if (!task.trim()) throw new Error("Task must not be empty.");
  if (Buffer.byteLength(task) > LIMITS.taskBytes)
    throw new Error("Task exceeds the UTF-8 input limit.");
}

export type PreparationStage =
  | "compatibility"
  | "definition"
  | "host"
  | "model"
  | "skills"
  | "instructions"
  | "tools"
  | "mcp"
  | "prompt";

/** Prepares local configuration without reading selected skill bodies or executing capabilities. */
export async function prepareResearch(
  scope: ResearchScope,
  task: string,
  agent: string,
  preparation: Preparation,
  capture: ResearchSource["capture"],
  onStage?: (stage: PreparationStage) => void,
  handoff?: HandoffReference,
): Promise<ResearchConfig> {
  preparation.check();
  onStage?.("compatibility");
  const version =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      VERSION,
    );
  if (!version || Number(version[1]) !== 1 || Number(version[2]) < 4)
    throw new Error(
      `Unsupported Pi SDK ${VERSION}; this adapter requires a stable 1.x version >=1.4.0.`,
    );
  onStage?.("definition");
  if (typeof agent !== "string" || !agent.trim())
    throw new Error("Select an agent defined in your agents directory.");
  const catalog = await discoverAgents(preparation);
  const definition = catalog.agents.find((candidate) => candidate.name === agent);
  if (!definition)
    throw new Error(
      `Agent unavailable: ${agent}. ${catalog.diagnostics.map((item) => `${item.filePath}: ${item.error}`).join("; ")}`,
    );
  const mode = definition.promptMode;
  onStage?.("host");
  const host = capture(mode === "append");
  preparation.check();
  if (
    !sameWorkspace(host.workspace, scope.workspace) ||
    host.trustedProject !== scope.trustedProject
  )
    throw new Error("Parent workspace or trust changed during agent resolution.");
  onStage?.("model");
  const selected = structuredClone(selectModel(host, definition));
  if (selected.api === "pi-virtual")
    throw new Error(
      "Select a physical model for subagents; this SDK's direct virtual routing loses router state.",
    );
  onStage?.("tools");
  // Select and clone declarations before local tool construction or skill scanning can yield.
  const tools = await selectTools(host, definition);
  preparation.check();
  onStage?.("instructions");
  if (definition.promptMode === "replace" && !definition.systemPrompt.trim())
    throw new Error(`Agent ${definition.name}: replace mode requires a nonempty Markdown body.`);
  onStage?.("skills");
  const skills = await resolveSkills(definition, host.cwd, host.trustedProject, preparation);
  preparation.check();
  onStage?.("instructions");
  let base = "";
  if (mode === "append") {
    if (!host.parentPrompt?.trim())
      throw new Error("The parent policy snapshot is empty or unavailable.");
    base = host.parentPrompt;
  } else if (definition.promptInstructionPath) {
    base = await preparation.read(definition.promptInstructionPath);
    if (!base.trim()) throw new Error("The instruction file is empty.");
  }
  onStage?.("mcp");
  const mcp = await loadMcpServers(definition.mcp ?? [], host.cwd, preparation);
  preparation.check();
  onStage?.("prompt");
  const systemPrompt = [base, SUBAGENT_ROLE_INSTRUCTIONS].filter(Boolean).join("\n\n");
  const appendSystemPrompt = definition.systemPrompt;
  // Bound configuration inputs here; the SDK's final rendered prompt is checked at dispatch.
  const size =
    Buffer.byteLength(systemPrompt) +
    Buffer.byteLength(appendSystemPrompt) +
    Buffer.byteLength(
      JSON.stringify(
        skills.map(({ name, description, filePath }) => ({ name, description, filePath })),
      ),
    ) +
    Buffer.byteLength(
      JSON.stringify(
        tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
      ),
    );
  if (size > LIMITS.promptBytes)
    throw new Error(
      "Prepared instructions, selected skill metadata and tools exceed the preparation budget.",
    );
  return Object.freeze({
    cwd: host.cwd,
    task,
    ...(handoff ? { handoff: Object.freeze({ ...handoff }) } : {}),
    model: selected,
    thinkingLevel: definition.thinkingLevel ?? host.thinkingLevel,
    selection: Object.freeze({
      model: `${selected.provider}/${selected.id}`,
      modelSource: definition.model === undefined ? "parent" : "agent",
      thinkingLevel: definition.thinkingLevel ?? host.thinkingLevel,
      thinkingSource: definition.thinkingLevel === undefined ? "parent" : "agent",
    }),
    maxModelTokens: definition.maxModelTokens,
    stream: host.stream,
    agent: { name: definition.name, description: definition.description },
    promptMode: mode,
    tools,
    systemPrompt,
    appendSystemPrompt,
    skills,
    mcp,
  });
}

/** Validates execution inputs and returns an opaque identity for active revalidation. */
export async function prepareInvocation(
  scope: ResearchScope,
  task: string,
  agent: string,
  preparation: Preparation,
  capture: ResearchSource["capture"],
  handoff?: HandoffReference,
): Promise<{ config: ResearchConfig; fingerprint: string }> {
  const config = await prepareResearch(
    scope,
    task,
    agent,
    preparation,
    capture,
    undefined,
    handoff,
  );
  const policyFingerprint = await fingerprint(config, scope.trustedProject, preparation);
  preparation.check();
  return Object.freeze({ config, fingerprint: policyFingerprint });
}

async function fingerprint(
  config: ResearchConfig,
  trusted: boolean,
  preparation: Preparation,
): Promise<string> {
  const skillBodies: string[] = [];
  for (const skill of config.skills)
    skillBodies.push(
      createHash("sha256")
        .update(await preparation.read(skill.filePath))
        .digest("hex"),
    );
  const { task: _task, handoff: _handoff, stream: _stream, tools, ...policy } = config;
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...policy,
        trusted,
        skillBodies,
        tools: tools.map(({ execute: _execute, ...tool }) => tool),
      }),
    )
    .digest("hex");
}

function selectModel(host: ResearchHost, definition: AgentDefinition): Model<Api> {
  const requested = definition.model;
  if (requested === undefined) {
    if (!host.model)
      throw new Error(
        "Select a parent model or configure model: provider/model-id in the agent definition.",
      );
    return host.model;
  }
  const matches = host.models.filter((model) => `${model.provider}/${model.id}` === requested);
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? `Ambiguous agent model: ${requested}`
        : `Agent model not found: ${requested}`,
    );
  return matches[0];
}
