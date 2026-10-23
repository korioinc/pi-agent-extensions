import { Type } from "typebox";
import { Text, mixColors } from "@earendil-works/pi-tui";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { RunnerPool, type Origin, type RunIdentity } from "../runner-pool/index.ts";
import { createResearchSource, validateTask } from "../runtime/index.ts";
import { AgentCatalog, preflightFailure } from "./catalog.ts";
import { boundedText, LIMITS } from "../runtime/limits.ts";
import { messageParameters } from "../runtime/messages.ts";
import {
  handoffParameters,
  validateHandoff,
  type HandoffReference,
  type HandoffMetadata,
} from "../runtime/handoff.ts";
import {
  AgentRegistry,
  followupParameters,
  closeParameters,
  type ParentAccess,
  type ParentSnapshot,
} from "../agent-registry/index.ts";
import { loadSettings } from "../runtime/settings.ts";
import { SubagentsBrowser, clean } from "./browser.ts";
import { registerAgentMentions } from "./mentions.ts";
import { registerParentPrompt } from "./parent-prompt.ts";
import { SPAWN_GUIDELINES, SPAWN_SNIPPET } from "../instructions/parent.ts";
import { spawnDescription } from "./spawn-description.ts";
import { ActivityPresenter } from "./activity.ts";
import { renderSpawnCall, renderSpawnResult, renderFollowupResult } from "./render.ts";
import { safeErrorText } from "../runtime/errors.ts";
import { inspectWorkspace, sameWorkspace } from "../workspace/identity.ts";

const RUNS_ENTRY_TYPE = "pi-subagent-runs";

// Native history is append-only. Reloading the same IDs replaces the leaf object,
// so identity also invalidates ancestry without retaining a second transcript.
const branches = new WeakMap<
  ExtensionContext["sessionManager"],
  {
    sessionId: string;
    anchor: string | null;
    leaf: ReturnType<ExtensionContext["sessionManager"]["getLeafEntry"]>;
    ids: ReadonlySet<string>;
  }
>();

function caller(ctx: ExtensionContext): ParentSnapshot | undefined {
  try {
    const history = ctx.sessionManager;
    const workspace = inspectWorkspace(ctx.cwd);
    const sessionId = history.getSessionId();
    const anchor = history.getLeafId();
    const leaf = history.getLeafEntry();
    let branch = branches.get(history);
    if (branch?.sessionId !== sessionId || branch.anchor !== anchor || branch.leaf !== leaf) {
      branch = {
        sessionId,
        anchor,
        leaf,
        ids: new Set(history.getBranch().map((entry) => entry.id)),
      };
      branches.set(history, branch);
    }
    return {
      sessionId,
      cwd: workspace.root,
      workspace,
      branch: branch.ids,
      anchor,
      trustedProject: ctx.isProjectTrusted(),
    };
  } catch {
    // Disposed SDK contexts and missing workspaces have no usable authority snapshot.
    return undefined;
  }
}

function result(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: value,
    isError,
  };
}

export function registerSubagents(pi: ExtensionAPI): void {
  const { maxConcurrentRuns } = loadSettings();
  const pool = new RunnerPool(maxConcurrentRuns);
  const registry = new AgentRegistry(pool);
  const activity = new ActivityPresenter();
  const observe = (ctx: ExtensionContext, retry = false) =>
    activity.bind(
      ctx,
      () => {
        const current = caller(ctx);
        return current ? pool.inspectActivity(current) : [];
      },
      retry,
    );
  const catalog = new AgentCatalog();
  const parentPrompt = registerParentPrompt(pi);
  const access = (ctx: ExtensionToolContext): ParentAccess => ({
    ...createResearchSource(ctx, () => pi.getAllTools(), parentPrompt),
    current: () => caller(ctx),
    fence: (data) => {
      pi.appendEntry("pi-subagent-fence", data);
      const id = ctx.sessionManager.getLeafId();
      const entry = id ? ctx.sessionManager.getEntry(id) : undefined;
      if (
        !entry ||
        entry.type !== "custom" ||
        entry.customType !== "pi-subagent-fence" ||
        JSON.stringify(entry.data) !== JSON.stringify(data)
      )
        throw new Error("Parent acceptance fence is unavailable.");
      return entry.id;
    },
  });
  let advertise = (_value?: Awaited<ReturnType<AgentCatalog["list"]>>) => {};
  const listAgents = async (ctx: ExtensionContext, signal?: AbortSignal) => {
    const origin = caller(ctx);
    if (!origin) return { rejection: "not_available" as const };
    const { sessionId, anchor, workspace, trustedProject: trusted } = origin;
    const value = await catalog.list({ sessionId, anchor }, signal);
    const current = caller(ctx);
    if (
      !current ||
      current.sessionId !== sessionId ||
      !sameWorkspace(current.workspace, workspace) ||
      current.trustedProject !== trusted ||
      (anchor !== null && !current.branch.has(anchor))
    )
      return { rejection: "not_available" as const };
    if (!("rejection" in value)) advertise(value);
    return value;
  };

  pi.registerEntryRenderer<string>(RUNS_ENTRY_TYPE, (entry, _options, theme) => {
    if (typeof entry.data !== "string") return;
    const bg = mixColors(theme.colors.toolPendingBg, theme.colors.text, 0.12, "srgb");
    return new Text(entry.data, 1, 1, (line) => theme.style(line, { fg: theme.colors.text, bg }));
  });

  pi.registerCommand("subagent-runs", {
    description: "List owned active and retained runs; optionally filter runId or agent",
    async handler(args, ctx) {
      if (!ctx.hasUI)
        throw new Error("/subagent-runs requires a TUI or RPC UI. Use subagent_inspect instead.");
      const origin = caller(ctx);
      if (!origin) return;
      const view = pool.inspect(origin);
      if (!("runs" in view) || !view.runs) return;
      const query = args.trim().toLowerCase();
      const matches = view.runs.filter((run) =>
        [run.runId, run.identity?.agent].some((value) => value?.toLowerCase().includes(query)),
      );
      const footer = (count: number) => `Omitted: ${count} runs.`;
      const lines: string[] = [];
      let bytes = 0;
      let omitted = 0;
      const reserved = Buffer.byteLength(footer(matches.length)) + 1;
      for (const run of matches) {
        const row = [run.runId, run.phase, run.identity?.agent]
          .filter((value): value is string => value !== undefined)
          .map(clean)
          .join(" · ");
        const size = Buffer.byteLength(row) + (lines.length ? 1 : 0);
        if (bytes + size + reserved > LIMITS.catalogBytes) {
          omitted++;
          continue;
        }
        lines.push(row);
        bytes += size;
      }
      if (omitted) lines.push(footer(omitted));
      if (!lines.length) lines.push("No owned runs match.");
      const current = caller(ctx);
      if (
        !current ||
        current.sessionId !== origin.sessionId ||
        !sameWorkspace(current.workspace, origin.workspace) ||
        (origin.anchor !== null && !current.branch.has(origin.anchor))
      )
        return;
      const message = lines.join("\n");
      if (ctx.mode !== "tui") {
        ctx.ui.notify(message, "info");
        return;
      }
      // Persist a UI-only snapshot without adding model context or starting a turn.
      pi.appendEntry(RUNS_ENTRY_TYPE, message);
    },
  });

  pi.registerTool(
    defineTool({
      name: "send_message",
      label: "Message active subagent",
      description:
        "Queue bounded additional data for an owned running runId, not a new task or resumed session. Use a stable messageId for retries. A receipt reports queued, injected_not_confirmed, or discarded; it never proves the model read or acted on the data. The next natural request may consume it once. Completed or cancelling runs reject new IDs; accepted IDs remain idempotent for this run's retention. No wake-up, extra turn or new authority.",
      executionMode: "parallel",
      parameters: messageParameters,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const value = registry.message(access(ctx), params, signal);
        return result(value, "rejection" in value);
      },
    }),
  );

  const mentions = registerAgentMentions(pi, listAgents);
  let closeBrowser: (() => void) | undefined;

  pi.registerCommand("subagents", {
    description: "Inspect subagent definitions, models and thinking settings",
    async handler(args, ctx) {
      if (!ctx.hasUI)
        throw new Error("/subagents requires a TUI or RPC UI. Use the list_agents tool instead.");
      if (ctx.mode === "tui") {
        if (closeBrowser) {
          ctx.ui.notify("The subagent browser is already open.", "info");
          return;
        }
        const origin = caller(ctx);
        if (!origin) return;
        const { sessionId, anchor, workspace, trustedProject: trusted } = origin;
        const owns = () => {
          const current = caller(ctx);
          return (
            current !== undefined &&
            current.sessionId === sessionId &&
            sameWorkspace(current.workspace, workspace) &&
            current.trustedProject === trusted &&
            (anchor === null || current.branch.has(anchor))
          );
        };
        let browser: SubagentsBrowser | undefined;
        const abort = new AbortController();
        closeBrowser = () => {
          abort.abort();
          browser?.dispose();
        };
        try {
          await ctx.ui.custom<void>((tui, theme, _kb, done) => {
            if (abort.signal.aborted || !owns()) {
              done(undefined);
              return { render: () => [], invalidate() {} };
            }
            browser = new SubagentsBrowser({
              theme,
              rows: () => Math.max(1, Math.floor(tui.terminal.rows * 0.85) - 2),
              requestRender: () => tui.requestRender(),
              initialQuery: args.trim(),
              parentModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
              parentThinking: ctx.thinkingLevel ?? "off",
              load: async (signal) => {
                if (!owns()) return { rejection: "not_available" as const };
                const value = await listAgents(
                  ctx,
                  AbortSignal.any([signal, abort.signal, ...(ctx.signal ? [ctx.signal] : [])]),
                );
                if (!owns()) return { rejection: "not_available" as const };
                return value;
              },
              done,
            });
            closeBrowser = () => {
              abort.abort();
              browser?.dispose();
              done(undefined);
            };
            browser.start();
            return browser;
          });
        } finally {
          abort.abort();
          browser?.dispose();
          closeBrowser = undefined;
        }
        return;
      }
      if (args.trim()) {
        ctx.ui.notify(
          "RPC listing: /subagents (search is available in the TUI browser).",
          "warning",
        );
        return;
      }
      const value = await listAgents(ctx, ctx.signal);
      if ("rejection" in value) {
        if (value.rejection === "not_available") return;
        const message =
          value.rejection === "busy"
            ? "The agent list is already loading. Run /subagents again after it finishes."
            : value.rejection === "unavailable"
              ? "The catalog is shutting down or unavailable after cleanup failure. Check subagent_inspect."
              : `Could not read agent definitions: ${JSON.stringify(value.error)}`;
        ctx.ui.notify(message, "error");
        return;
      }
      const lines = [
        `Subagents extension active · ${value.agents.length} definitions shown`,
        "Available = enabled and valid definition. Model, skills and MCP readiness are checked at execution.",
        "",
      ];
      if (!value.agents.length) lines.push("No named agents are available.");
      for (const agent of value.agents) {
        const description = boundedText(agent.description, 240);
        lines.push(
          `${JSON.stringify(agent.name)} — ${JSON.stringify(description + (description === agent.description ? "" : "…"))}`,
          `  ${JSON.stringify(agent.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "No model selected"))} · ${agent.thinkingLevel ?? ctx.thinkingLevel ?? "off"}`,
        );
      }
      if (value.diagnostics.length) {
        lines.push("", "Definition diagnostics (errors, disabled definitions, warnings):");
        for (const diagnostic of value.diagnostics)
          lines.push(`${JSON.stringify(diagnostic.filePath)}: ${JSON.stringify(diagnostic.error)}`);
      }
      if (value.omittedAgents || value.omittedDiagnostics)
        lines.push(
          `Omitted due to catalog limits: ${value.omittedAgents} definitions, ${value.omittedDiagnostics} diagnostics`,
        );
      lines.push(
        "",
        'Run a named agent: spawn_agent({ agent: "name", task: "task" })',
        "Use @ autocomplete in the editor → @name task description: asks the parent model to call spawn_agent.",
        "Execution is not forced; the parent model makes the call. Full configuration: list_agents({})",
      );
      const text = lines.join("\n");
      const truncated = Buffer.byteLength(text) > LIMITS.catalogBytes;
      ctx.ui.notify(
        truncated
          ? `${boundedText(text, LIMITS.catalogBytes)}\n[Truncated to the display limit. Use list_agents({}) for full configuration.]`
          : text,
        value.diagnostics.length || value.omittedAgents || value.omittedDiagnostics || truncated
          ? "warning"
          : "info",
      );
    },
  });

  pi.registerTool(
    defineTool({
      name: "followup_task",
      renderShell: "self",
      renderCall: renderSpawnCall,
      renderResult: renderFollowupResult,
      label: "Follow up with agent",
      exposure: "model-only",
      executionMode: "parallel",
      description:
        "Assign another task to an owned agentId using a stable requestId. Call directly, never tools.followup_task in codemode. Idle agents resume native history with fresh current configuration and a new foreground run. Active agents receive steering within the same run and remaining budget; a receipt is not completion and contains no usage. Identical retries never execute again. No background mode or automatic replay.",
      parameters: followupParameters,
      async execute(_id, params, signal, onUpdate, ctx) {
        const value = await registry.followup(access(ctx), params, signal, (progress) => {
          observe(ctx, true);
          return onUpdate?.(result(progress));
        });
        activity.refresh();
        return {
          ...result(
            value,
            "rejection" in value || ("outcome" in value && value.outcome !== "succeeded"),
          ),
          ...("usage" in value ? { usage: value.usage } : {}),
        };
      },
    }),
  );
  pi.registerTool(
    defineTool({
      name: "close_agent",
      label: "Close agent history",
      exposure: "model-only",
      executionMode: "parallel",
      description:
        "Close an owned idle or history-unusable agentId and release retained memory history. Call directly. Active or unsafe owners must be interrupted and safely settled first. Idempotent; deletion does not undo effects or erase parent logs.",
      parameters: closeParameters,
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const value = registry.close(access(ctx), params.agentId);
        return result(value, "rejection" in value);
      },
    }),
  );

  const spawnTool = defineTool({
    name: "spawn_agent",
    label: "Spawn agent",
    description: spawnDescription(),
    promptSnippet: SPAWN_SNIPPET,
    promptGuidelines: [...SPAWN_GUIDELINES],
    exposure: "model-only",
    executionMode: "parallel",
    renderShell: "self",
    renderCall: renderSpawnCall,
    renderResult: renderSpawnResult,
    parameters: Type.Object(
      {
        task: Type.String({ minLength: 1, maxLength: LIMITS.taskBytes }),
        agent: Type.String({ minLength: 1 }),
        handoff: Type.Optional(handoffParameters),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, onUpdate, ctx) {
      let identity: RunIdentity;
      try {
        validateTask(params.task);
        if (typeof params.agent !== "string")
          throw new Error("Select a user-defined agent by name.");
        validateTask(params.agent);
        validateHandoff(params.handoff);
        identity = Object.freeze({ agent: params.agent });
        signal?.throwIfAborted();
      } catch (error) {
        return result(
          {
            rejection: "denied",
            reason: boundedText(safeErrorText(error, "Agent execution failed."), 4096),
            generation: pool.generation,
          },
          true,
        );
      }
      let handoff: HandoffReference | undefined;
      let handoffMetadata: HandoffMetadata | undefined;
      if (params.handoff) {
        if ("text" in params.handoff) handoff = { source: "text", text: params.handoff.text };
        else {
          const current = caller(ctx);
          if (!current) return result({ rejection: "not_available" }, true);
          const source = pool.handoff(current, params.handoff.runId);
          if ("rejection" in source) return result(source, true);
          handoff = source;
        }
        const { text: _text, ...metadata } = handoff;
        handoffMetadata = metadata;
      }
      const settled = await registry.spawn(
        access(ctx),
        identity.agent,
        params.task,
        handoff,
        signal,
        (progress) => {
          observe(ctx, true);
          return onUpdate?.(result(progress));
        },
      );
      activity.refresh();
      const usage = "usage" in settled ? { usage: settled.usage } : {};
      if ("rejection" in settled) return { ...result(settled, true), ...usage };
      return {
        ...result(
          {
            ...settled,
            agent: identity.agent,
            ...(handoffMetadata ? { handoff: handoffMetadata } : {}),
          },
          "outcome" in settled && settled.outcome !== "succeeded",
        ),
        ...usage,
      };
    },
  });
  advertise = (value) => {
    const description = spawnDescription(value);
    if (spawnTool.description === description) return;
    const activeTools = pi.getActiveTools();
    spawnTool.description = description;
    try {
      pi.registerTool(spawnTool);
    } finally {
      // SDK refresh can reactivate an explicit --tools allowlist, including unrelated tools.
      pi.setActiveTools(activeTools);
    }
  };
  pi.registerTool(spawnTool);
  pi.on("session_tree", (_event, ctx) => {
    registry.revoke();
    observe(ctx);
  });
  pi.on("session_start", async (_event, ctx) => {
    observe(ctx, true);
    advertise();
    await listAgents(ctx, ctx.signal);
  });

  pi.registerTool(
    defineTool({
      name: "subagent_inspect",
      label: "Inspect subagent",
      description:
        "Inspect generation-scoped runs with runId or scope runs, or logical conversations with agentId or scope agents. Selectors are mutually exclusive. Logical metadata contains state, run reference and bounded receipts, never transcript bodies. Conversations live only in memory until close or parent generation shutdown and require the same parent/workspace and latest accepted branch fence. Run results remain volatile for one hour. Diagnostics and usage observation do not prove safe cleanup and are not added to billing. Blocked recovery await_owned_work means owned work may still settle; containment_required requires operator investigation of external effects. Neither permits automatic replay or force release. Active receipt acceptance is not task completion. Unknown, closed and unauthorized logical targets are unavailable.",
      executionMode: "parallel",
      parameters: Type.Object(
        {
          runId: Type.Optional(Type.String({ minLength: 1 })),
          agentId: Type.Optional(Type.String({ minLength: 1 })),
          scope: Type.Optional(Type.Union([Type.Literal("runs"), Type.Literal("agents")])),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        if (
          [params.runId, params.agentId, params.scope].filter((value) => value !== undefined)
            .length > 1
        )
          return result({ rejection: "invalid_input" }, true);
        if (params.agentId !== undefined || params.scope === "agents") {
          const value = registry.inspect(access(ctx), params.agentId);
          return result(value, "rejection" in value);
        }
        const current = caller(ctx);
        if (!current) return result({ rejection: "not_available" }, true);
        const view = pool.inspect(current, params.runId);
        return result(
          params.runId === undefined ? { ...view, catalog: catalog.inspect(current) } : view,
        );
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "interrupt_agent",
      label: "Interrupt agent",
      description:
        "Request cancellation of an owned foreground run, not a resumable agent session. Repeated cancellation is safe; acceptance does not prove that resources stopped. Blocked runs retain their own slots until safe cleanup; other free slots remain usable.",
      executionMode: "parallel",
      parameters: Type.Object(
        { runId: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const current = caller(ctx);
        if (!current) return result({ rejection: "not_available" }, true);
        const value = pool.cancel(current, params.runId);
        return result(value, "rejection" in value);
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "subagent_preflight",
      label: "Check subagent configuration",
      description:
        "Check one named agent using bounded local preparation without a child session, model call, tool execution or MCP connection. Checks selected skill metadata, not skill bodies or the rendered prompt. Configuration validity does not prove authentication, connectivity, MCP catalog readiness, task validity or tool permissions. Shares catalog capacity; busy requests are not queued. Execution always prepares again. Returns only bounded selection/counts and fixed failure codes, never prompts or credentials.",
      executionMode: "parallel",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      parameters: Type.Object(
        { agent: Type.String({ minLength: 1, maxLength: LIMITS.taskBytes }) },
        { additionalProperties: false },
      ),
      async execute(_id, params, signal, _onUpdate, ctx) {
        try {
          if (typeof params.agent !== "string") throw new Error("Invalid agent name.");
          validateTask(params.agent);
        } catch {
          return result(preflightFailure("invalid_input", "input"), true);
        }
        let origin: Origin;
        let workspace: ParentSnapshot["workspace"];
        let trusted: boolean;
        let combined: AbortSignal;
        try {
          const current = caller(ctx);
          if (!current) return result({ rejection: "not_available" }, true);
          origin = current;
          workspace = current.workspace;
          trusted = current.trustedProject;
          const parentSignal = ctx.signal;
          combined = AbortSignal.any([
            ...(signal ? [signal] : []),
            ...(parentSignal ? [parentSignal] : []),
          ]);
        } catch {
          return result({ rejection: "not_available" }, true);
        }
        const value = await catalog.preflight(
          origin,
          params.agent,
          createResearchSource(ctx, () => pi.getAllTools(), parentPrompt),
          combined,
        );
        try {
          const current = caller(ctx);
          if (
            !current ||
            current.sessionId !== origin.sessionId ||
            !sameWorkspace(current.workspace, workspace) ||
            current.trustedProject !== trusted ||
            (origin.anchor !== null && !current.branch.has(origin.anchor))
          )
            return result({ rejection: "not_available" }, true);
        } catch {
          return result({ rejection: "not_available" }, true);
        }
        return result(value, "rejection" in value || value.status !== "configuration_valid");
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "list_agents",
      label: "List agents",
      description:
        "List available manually created Markdown definitions, not live runs, from the user agents directory with descriptions and configuration. No built-in, project, or package agents are loaded. Invalid files are reported, not silently activated.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_id, _params, signal, _onUpdate, ctx) {
        const value = await listAgents(ctx, signal);
        return result(value, "rejection" in value);
      },
    }),
  );

  pi.on("session_shutdown", async () => {
    activity.dispose();
    closeBrowser?.();
    await Promise.all([registry.drain(), catalog.drain(), mentions.stop()]);
  });
}
