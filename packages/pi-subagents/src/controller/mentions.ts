import {
  parseSkillBlock,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  fuzzyFilter,
  type AutocompleteItem,
  type AutocompleteProvider,
} from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { boundedText, LIMITS } from "../runtime/limits.ts";
import { AgentCatalog } from "./catalog.ts";

type CatalogResult = Awaited<ReturnType<AgentCatalog["list"]>> | { rejection: "not_available" };
type ListAgents = (ctx: ExtensionContext, signal?: AbortSignal) => Promise<CatalogResult>;
type Candidate = { name: string; description: string; model?: string; thinkingLevel?: string };
const EMPTY: readonly Candidate[] = [];
const CACHE_MS = 1000;
const mentionName = /^[\p{L}\p{N}_-]+$/u;

/** Put matching agents before native file results at any standalone @ token. */
export function createAgentAutocompleteProvider(
  current: AutocompleteProvider,
  candidates: () => readonly Candidate[] | Promise<readonly Candidate[]>,
  presentation: (agent: Candidate) => Pick<AutocompleteItem, "label" | "description"> = (
    agent,
  ) => ({ label: `@${agent.name}`, description: "Subagent" }),
  isCurrent: (agents: readonly Candidate[]) => boolean = () => true,
): AutocompleteProvider {
  const owned = new WeakSet<AutocompleteItem>();
  return {
    triggerCharacters: ["@", ...(current.triggerCharacters ?? [])],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
      const match = /(?:^|\s)(@([\p{L}\p{N}_-]*))$/u.exec(before);
      if (!match || options.signal.aborted)
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      const prefix = match[1];
      const [available, fallback] = await Promise.all([
        candidates(),
        current.getSuggestions(lines, cursorLine, cursorCol, options),
      ]);
      if (options.signal.aborted) return null;
      if (!isCurrent(available)) return fallback;
      const eligible = available.filter((agent) => mentionName.test(agent.name));
      const matches = match[2] ? fuzzyFilter(eligible, match[2], (agent) => agent.name) : eligible;
      const items = matches.slice(0, 20).map((agent): AutocompleteItem => ({
        value: `@${agent.name}`,
        ...presentation(agent),
      }));
      for (const item of items) owned.add(item);
      if (!items.length) return fallback;
      // Some file providers emit a bare @ placeholder. Pi prefers exact matches and would
      // scroll past the agent rows to it; it is not a useful file completion.
      const files =
        fallback?.prefix === prefix ? fallback.items.filter((item) => item.value !== "@") : [];
      return { prefix, items: [...items, ...files] };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (!owned.has(item))
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      const line = lines[cursorLine] ?? "";
      const before = line.slice(0, cursorCol - prefix.length);
      const after = line.slice(cursorCol);
      const space = /^\s/.test(after) ? "" : " ";
      const next = [...lines];
      next[cursorLine] = before + item.value + space + after;
      return {
        lines: next,
        cursorLine,
        cursorCol: before.length + item.value.length + space.length,
      };
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

/** A hint to the parent model, never a second executor or a fabricated tool context. */
export function registerAgentMentions(pi: ExtensionAPI, list: ListAgents) {
  // Definitions are global user files, not branch-owned run data. Completion discovery has
  // its own bounded owner so ordinary /subagents queries cannot empty or block its cache.
  const completionCatalog = new AgentCatalog();
  let snapshot: { sessionId: string; agents: readonly Candidate[]; expires: number } | undefined;
  let pending: Promise<void> | undefined;
  let stopped = false;
  const candidates = async (ctx: ExtensionContext): Promise<readonly Candidate[]> => {
    if (stopped) return EMPTY;
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      if (snapshot?.sessionId === sessionId && performance.now() < snapshot.expires)
        return snapshot.agents;
      pending ??= (async () => {
        const value = await completionCatalog.list({ sessionId, anchor: null });
        if (stopped || ctx.sessionManager.getSessionId() !== sessionId) return;
        snapshot =
          "rejection" in value
            ? undefined
            : {
                sessionId,
                agents: value.agents,
                expires: performance.now() + CACHE_MS,
              };
      })()
        .catch(() => {
          snapshot = undefined;
        })
        .finally(() => {
          pending = undefined;
        });
      await pending;
      return !stopped &&
        ctx.sessionManager.getSessionId() === sessionId &&
        snapshot?.sessionId === sessionId
        ? snapshot.agents
        : EMPTY;
    } catch {
      return EMPTY;
    }
  };
  // File-search extensions can short-circuit @ queries. Compose after every session_start
  // handler has registered its provider, including pi-fff, on startup and reload alike.
  pi.on("resources_discover", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.addAutocompleteProvider((current) =>
      createAgentAutocompleteProvider(
        current,
        () => candidates(ctx),
        (agent) => {
          const model =
            agent.model ??
            (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "No model selected");
          const thinking = agent.thinkingLevel ?? ctx.thinkingLevel ?? "off";
          const metadata = stripVTControlCharacters(
            boundedText(`${model} · ${thinking}`, 240),
          ).replace(/[\r\n\t]/g, " ");
          return {
            label: ctx.ui.theme.fg("success", `@${agent.name}`),
            description: ctx.ui.theme.fg("success", `Subagent · ${metadata}`),
          };
        },
        (agents) => {
          try {
            return (
              !stopped &&
              snapshot?.sessionId === ctx.sessionManager.getSessionId() &&
              snapshot.agents === agents
            );
          } catch {
            return false;
          }
        },
      ),
    );
  });
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || stopped) return;
    let text = event.text;
    // pi-skill may prepend selected skill blocks to a queued user prompt before this handler.
    if (event.streamingBehavior) {
      for (;;) {
        const block = parseSkillBlock(text);
        if (!block?.userMessage) break;
        text = block.userMessage;
      }
    }
    const match = /^\s*@([\p{L}\p{N}_-]+)(?:\s+([\s\S]*))?$/u.exec(text);
    if (!match) return;
    const previouslyKnown =
      snapshot?.sessionId === ctx.sessionManager.getSessionId() &&
      snapshot.agents.some((agent) => agent.name === match[1]);
    const fail = (message: string) => {
      if (ctx.hasUI) ctx.ui.notify(message, "error");
      return { action: "handled" as const };
    };
    try {
      const value = await list(ctx, ctx.signal);
      if (stopped) return { action: "handled" as const };
      if ("rejection" in value) {
        if (value.rejection === "not_available") return { action: "handled" as const };
        if (!previouslyKnown) return;
        return fail(
          "Cannot retrieve the agent list. Check /subagents, then enter your request again.",
        );
      }
      if (!value.agents.some((agent) => agent.name === match[1])) {
        if (!previouslyKnown) return;
        return fail("This agent is unavailable. Check its definition with list_agents.");
      }
      if (!match[2]?.trim()) return fail("Usage: @agent-name task description");
      if (!pi.getActiveTools().includes("spawn_agent"))
        return fail(
          "The spawn_agent tool is inactive. Activate it, then enter your request again.",
        );
      const skillPrefix =
        text === event.text ? "" : event.text.slice(0, event.text.lastIndexOf(text));
      const task = skillPrefix + match[2].trim();
      if (Buffer.byteLength(task) > LIMITS.taskBytes)
        return fail("The mention task exceeds the subagent input size limit.");
      return {
        action: "transform" as const,
        text:
          "The user requests delegation to the named subagent. Call the existing spawn_agent tool with the following JSON arguments; do not perform the task in the parent instead. Report tool failure rather than claiming the child ran. Do not automatically replay an accepted run. This is a parent-model delegation request, not evidence of execution.\n" +
          JSON.stringify({ agent: match[1], task }),
        images: event.images,
      };
    } catch {
      if (!previouslyKnown) return;
      return fail("Could not prepare the subagent mention. Check the definition with list_agents.");
    }
  });
  return {
    async stop() {
      stopped = true;
      snapshot = undefined;
      await completionCatalog.drain();
      await pending;
    },
  };
}
