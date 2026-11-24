import { Type, type Static } from "typebox";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { RunnerPool } from "../runner-pool/index.ts";
import { validateTask } from "../runtime/index.ts";
import { AgentCatalog } from "./catalog.ts";
import { boundedText } from "../runtime/limits.ts";
import { messageParameters } from "../runtime/messages.ts";
import {
  followupTaskParameters,
  prepareFollowupArguments,
  prepareSubagentArguments,
  subagentParameters,
} from "./input.ts";
import { AgentRegistry, closeParameters } from "../agent-registry/index.ts";
import { loadSettings } from "../runtime/settings.ts";
import { registerAgentMentions } from "./mentions.ts";
import { registerParentPrompt } from "./parent-prompt.ts";
import { SUBAGENT_GUIDELINES, SUBAGENT_SNIPPET } from "../instructions/parent.ts";
import { spawnDescription } from "./spawn-description.ts";
import { subagentResult, SubagentDisplay } from "./subagent-result.ts";
import { ActivityPresenter } from "./activity.ts";
import { renderSpawnCall, renderFollowupResult } from "./render.ts";
import { safeErrorText } from "../runtime/errors.ts";
import { caller, controlResult, createParentAccess, sameOrigin, toolResult } from "./authority.ts";
import { registerSubagentCommands } from "./commands.ts";

export function registerSubagents(pi: ExtensionAPI): void {
  const { maxConcurrentRuns, executionLimits } = loadSettings();
  const activity = new ActivityPresenter();
  const pool = new RunnerPool(maxConcurrentRuns, executionLimits, () => activity.refresh());
  const registry = new AgentRegistry(pool);
  const reply = (ctx: ExtensionContext, value: unknown, isError = false) =>
    controlResult(ctx, pool.generation, value, isError);
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
  const access = (ctx: ExtensionToolContext) => createParentAccess(ctx, pi, parentPrompt);

  let advertise = (_value?: Awaited<ReturnType<AgentCatalog["list"]>>) => {};
  const listAgents = async (ctx: ExtensionContext, signal?: AbortSignal) => {
    const origin = caller(ctx);
    if (!origin) return { rejection: "not_available" as const };
    const value = await catalog.list(
      { sessionId: origin.sessionId, anchor: origin.anchor },
      signal,
    );
    if (!sameOrigin(origin, caller(ctx))) return { rejection: "not_available" as const };
    if (!("rejection" in value)) advertise(value);
    return value;
  };

  const commands = registerSubagentCommands(pi, pool, listAgents);
  const mentions = registerAgentMentions(pi, listAgents);

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
        return reply(ctx, value, "rejection" in value);
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "followup_task",
      label: "Follow up with agent",
      exposure: "model-only",
      executionMode: "parallel",
      renderShell: "self",
      renderCall: renderSpawnCall,
      renderResult: renderFollowupResult,
      description:
        "Send a task to an existing owned agent with { agentId, handoff }; handoff is one plain string. Idle agents start a new foreground run over retained history; active agents receive native steering at a safe message/tool boundary and return a receipt, not completion. The SDK call ID identifies this request internally. Redelivery of the same call does not repeat work; a new call is new work even with identical text. Inspect prior effects before resubmitting after an uncertain outcome. Call directly, never through codemode. This never creates or reopens an agent; use subagent to create one. No background mode or automatic replay.",
      parameters: followupTaskParameters,
      prepareArguments: prepareFollowupArguments,
      async execute(toolCallId, raw, signal, onUpdate, ctx) {
        const display = new SubagentDisplay();
        let params: Static<typeof followupTaskParameters>;
        try {
          params = prepareFollowupArguments(raw);
          validateTask(params.handoff);
        } catch (error) {
          return subagentResult(
            toolResult(
              {
                rejection: "invalid_input",
                reason: boundedText(safeErrorText(error, "Invalid followup_task input."), 4096),
              },
              true,
            ),
            "",
          );
        }
        let observed = false;
        const value = await registry.followup(
          access(ctx),
          { agentId: params.agentId, requestId: toolCallId, message: params.handoff },
          signal,
          (progress) => {
            if (!observed) {
              observed = true;
              observe(ctx, true);
            }
            if (onUpdate)
              return display.update(toolResult(progress), params.handoff, progress, onUpdate);
          },
          display.revoke,
        );
        activity.refresh();
        return display.finish(
          {
            ...reply(
              ctx,
              value,
              "rejection" in value || ("outcome" in value && value.outcome !== "succeeded"),
            ),
            ...("usage" in value ? { usage: value.usage } : {}),
          },
          params.handoff,
          "phase" in value ? value : undefined,
        );
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
        return reply(ctx, value, "rejection" in value);
      },
    }),
  );

  const spawnTool = defineTool({
    name: "subagent",
    label: "Create subagent",
    description: spawnDescription(),
    promptSnippet: SUBAGENT_SNIPPET,
    promptGuidelines: [...SUBAGENT_GUIDELINES],
    exposure: "model-only",
    executionMode: "parallel",
    renderShell: "self",
    renderCall: renderSpawnCall,
    renderResult: renderFollowupResult,
    parameters: subagentParameters,
    prepareArguments: prepareSubagentArguments,
    async execute(_id, raw, signal, onUpdate, ctx) {
      const display = new SubagentDisplay();
      let params: Static<typeof subagentParameters>;
      try {
        params = prepareSubagentArguments(raw);
        validateTask(params.handoff);
        validateTask(params.agent);
      } catch (error) {
        return subagentResult(
          toolResult(
            {
              rejection: "invalid_input",
              reason: boundedText(safeErrorText(error, "Invalid subagent input."), 4096),
            },
            true,
          ),
          "",
        );
      }
      let observed = false;
      const settled = await registry.spawn(
        access(ctx),
        params.agent,
        params.handoff,
        signal,
        (progress) => {
          if (!observed) {
            observed = true;
            observe(ctx, true);
          }
          if (!onUpdate) return;
          return display.update(toolResult(progress), params.handoff, progress, onUpdate);
        },
        display.revoke,
      );
      activity.refresh();
      const usage = "usage" in settled ? { usage: settled.usage } : {};
      if ("rejection" in settled)
        return display.finish({ ...reply(ctx, settled, true), ...usage }, params.handoff);
      return display.finish(
        {
          ...toolResult(
            { ...settled, agent: params.agent },
            "outcome" in settled && settled.outcome !== "succeeded",
          ),
          ...usage,
        },
        params.handoff,
        settled,
      );
    },
  });
  advertise = (value) => {
    const description = spawnDescription(value);
    if (spawnTool.description === description) return;
    const activeTools = pi.getActiveTools();
    try {
      spawnTool.description = description;
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
        'Inspect one generation-scoped run with {"runId":"<run-id>"}, one logical conversation with {"agentId":"<agent-id>"}, or list with {"scope":"runs"} or {"scope":"agents"}. Omit unused fields; empty ID strings are ignored. A scope matching the single ID is redundant and allowed. Two IDs or a mismatched scope are rejected. With no selector, inspect current runs and generation. Logical metadata contains state, run reference and bounded receipts, never transcript bodies. Conversations live only in memory until close or parent generation shutdown and require the same parent/workspace and latest accepted branch fence. Run results remain volatile for one hour. Diagnostics and usage observation do not prove safe cleanup and are not added to billing. Blocked recovery await_owned_work means owned work may still settle; containment_required requires operator investigation of external effects. Neither permits automatic replay or force release. Active receipt acceptance is not task completion. Unknown, closed and unauthorized logical targets are unavailable.',
      executionMode: "parallel",
      parameters: Type.Object(
        {
          runId: Type.Optional(
            Type.String({
              minLength: 1,
              description:
                'Inspect one run: {"runId":"<run-id>"}. Omit when unused; an exact empty string is ignored. Do not combine with agentId.',
            }),
          ),
          agentId: Type.Optional(
            Type.String({
              minLength: 1,
              description:
                'Inspect one logical conversation: {"agentId":"<agent-id>"}. Omit when unused; an exact empty string is ignored. Do not combine with runId.',
            }),
          ),
          scope: Type.Optional(
            Type.Union([Type.Literal("runs"), Type.Literal("agents")], {
              description:
                'List runs or agents, for example {"scope":"agents"}. Omit for an ID lookup; only a scope matching the single ID is also accepted.',
            }),
          ),
        },
        { additionalProperties: false },
      ),
      prepareArguments(args) {
        // The SDK still owns object-shape validation and optional null handling.
        if (typeof args !== "object" || args === null || Array.isArray(args)) return args as object;
        const prepared: Record<string, unknown> = { ...args };
        for (const key of ["runId", "agentId"] as const) {
          const value = prepared[key];
          if (value === undefined || value === null) continue;
          if (typeof value !== "string")
            throw new Error(
              "subagent_inspect runId and agentId must be strings, null, or omitted.",
            );
          if (value === "") delete prepared[key];
        }
        return prepared;
      },
      async execute(_id, params, _signal, _onUpdate, ctx) {
        if (
          (params.runId !== undefined && params.agentId !== undefined) ||
          (params.runId !== undefined && params.scope !== undefined && params.scope !== "runs") ||
          (params.agentId !== undefined && params.scope !== undefined && params.scope !== "agents")
        )
          return toolResult(
            {
              rejection: "invalid_input",
              reason: "conflicting_selectors",
              guidance:
                'Use one selector: {"agentId":"<agent-id>"}, {"runId":"<run-id>"}, or {"scope":"agents"}.',
            },
            true,
          );
        if (params.agentId !== undefined || params.scope === "agents") {
          const value = registry.inspect(access(ctx), params.agentId);
          return reply(ctx, value, "rejection" in value);
        }
        const current = caller(ctx);
        if (!current) return reply(ctx, { rejection: "not_available" }, true);
        const view = pool.inspect(current, params.runId);
        return reply(
          ctx,
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
        if (!current) return reply(ctx, { rejection: "not_available" }, true);
        const value = pool.cancel(current, params.runId);
        return reply(ctx, value, "rejection" in value);
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
        return toolResult(value, "rejection" in value);
      },
    }),
  );

  pi.on("session_shutdown", async () => {
    activity.dispose();
    commands.closeBrowser();
    await Promise.all([registry.drain(), catalog.drain(), mentions.stop()]);
  });
}
