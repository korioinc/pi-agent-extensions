import { Text, mixColors } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RunnerPool } from "../runner-pool/index.ts";
import { boundedText, LIMITS } from "../runtime/limits.ts";
import type { AgentCatalog } from "./catalog.ts";
import { SubagentsBrowser } from "./browser.ts";
import { runStatusText } from "./render.ts";
import { clean } from "./sanitize.ts";
import { caller, sameOrigin } from "./authority.ts";

const RUNS_ENTRY_TYPE = "pi-subagent-runs";

type CatalogResult = Awaited<ReturnType<AgentCatalog["list"]>> | { rejection: "not_available" };
type ListAgents = (ctx: ExtensionContext, signal?: AbortSignal) => Promise<CatalogResult>;

export function registerSubagentCommands(
  pi: ExtensionAPI,
  pool: RunnerPool,
  listAgents: ListAgents,
): { closeBrowser(): void } {
  let closeBrowser: (() => void) | undefined;

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
      const runs = pool.inspectActivity(origin);
      const query = args.trim().toLowerCase();
      const matches = runs.filter((run) =>
        [run.runId, run.identity?.agent].some((value) => value?.toLowerCase().includes(query)),
      );
      const footer = (count: number) => `Omitted: ${count} runs.`;
      const lines: string[] = [];
      let bytes = 0;
      let omitted = 0;
      const reserved = Buffer.byteLength(footer(matches.length)) + 1;
      for (const run of matches) {
        const row = [run.runId, runStatusText(run), run.identity?.agent]
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
      if (!sameOrigin(origin, caller(ctx))) return;
      const message = lines.join("\n");
      if (ctx.mode !== "tui") {
        ctx.ui.notify(message, "info");
        return;
      }
      // Persist a UI-only snapshot without adding model context or starting a turn.
      pi.appendEntry(RUNS_ENTRY_TYPE, message);
    },
  });

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
        const owns = () => sameOrigin(origin, caller(ctx));
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
        'Run a named agent: subagent({ agent: "name", handoff: "task" })',
        "Use @ autocomplete in the editor → @name task description: asks the parent model to call subagent.",
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

  return {
    closeBrowser() {
      closeBrowser?.();
    },
  };
}
