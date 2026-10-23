import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  fuzzyFilter,
  getKeybindings,
  stripTerminalSequences,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { AgentCatalog } from "./catalog.ts";

type CatalogView = Awaited<ReturnType<AgentCatalog["list"]>> | { rejection: "not_available" };
type Catalog = Extract<CatalogView, { agents: unknown }>;
type Agent = Catalog["agents"][number];
type Options = {
  theme: Theme;
  rows: () => number;
  requestRender: () => void;
  load: (signal: AbortSignal) => Promise<CatalogView>;
  done: () => void;
  initialQuery?: string;
  parentModel?: string;
  parentThinking?: string;
};
export const clean = (text: string) =>
  stripTerminalSequences(text).replace(
    /[\p{Cc}\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu,
    " ",
  );

/** Inspect definitions with Pi-style inline search; invocation belongs to @ autocomplete. */
export class SubagentsBrowser implements Component, Focusable {
  private readonly options: Options;
  private readonly input = new Input({ placeholder: "Search subagents…" });
  private readonly border: DynamicBorder;
  private readonly abort = new AbortController();
  private catalog?: Catalog;
  private filtered: Agent[] = [];
  private index = 0;
  private loading = true;
  private error?: string;
  private disposed = false;
  private started = false;
  private pasting = false;

  constructor(options: Options) {
    this.options = options;
    this.border = new DynamicBorder((text) => options.theme.fg("borderAccent", text));
    this.input.setValue(clean(options.initialQuery ?? ""));
  }
  get focused(): boolean {
    return this.input.focused;
  }
  set focused(value: boolean) {
    this.input.focused = value;
  }
  invalidate(): void {
    this.input.invalidate();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.focused = false;
    this.abort.abort();
  }
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    void this.options
      .load(this.abort.signal)
      .then((value) => {
        if (this.disposed) return;
        if ("rejection" in value) {
          this.error =
            value.rejection === "busy"
              ? "The list is loading. Reopen shortly."
              : value.rejection === "not_available"
                ? "The session changed. Reopen the browser."
                : value.rejection === "denied"
                  ? `Definition error: ${clean(value.error)}`
                  : "Catalog unavailable. Check subagent_inspect.";
        } else {
          this.catalog = value;
          this.filter();
        }
      })
      .catch(() => {
        if (!this.disposed) this.error = "Could not read the list. Close and reopen the browser.";
      })
      .finally(() => {
        if (this.disposed) return;
        this.loading = false;
        this.options.requestRender();
      });
  }
  private filter(): void {
    const query = clean(this.input.getValue()).trim();
    this.filtered = query
      ? fuzzyFilter(
          this.catalog?.agents ?? [],
          query,
          (agent) => `${agent.name} ${agent.description}`,
        )
      : (this.catalog?.agents ?? []);
    this.index = 0;
  }
  private executionLabel(agent: Agent): string {
    return `${clean(agent.model ?? this.options.parentModel ?? "No model selected")} · ${clean(agent.thinkingLevel ?? this.options.parentThinking ?? "off")}`;
  }
  private finish(): void {
    this.dispose();
    this.options.done();
  }
  handleInput(data: string): void {
    if (this.disposed) return;
    const kb = getKeybindings();
    if (this.pasting || data.includes("\x1b[200~")) {
      this.pasting = !data.includes("\x1b[201~");
      this.input.handleInput(data);
      this.input.setValue(clean(this.input.getValue()));
      this.filter();
    } else if (kb.matches(data, "tui.select.cancel")) return this.finish();
    else if (kb.matches(data, "tui.select.up"))
      this.index = this.filtered.length
        ? (this.index + this.filtered.length - 1) % this.filtered.length
        : 0;
    else if (kb.matches(data, "tui.select.down"))
      this.index = this.filtered.length ? (this.index + 1) % this.filtered.length : 0;
    else if (kb.matches(data, "tui.select.confirm")) return this.finish();
    else {
      this.input.handleInput(data);
      const safe = clean(this.input.getValue());
      if (safe !== this.input.getValue()) this.input.setValue(safe);
      this.filter();
    }
    this.options.requestRender();
  }
  render(width: number): string[] {
    if (this.disposed || width < 1) return [];
    const { theme } = this.options;
    const fit = (text: string) => truncateToWidth(text, width, "…");
    const height = Math.max(1, Math.floor(this.options.rows()));
    const border = this.border.render(width);
    const header = [
      theme.fg("accent", theme.bold("Inspect subagents")),
      "",
      ...this.input.render(width),
      "",
    ];
    const footer = theme.fg("dim", "↑↓ Browse · Enter/Esc Close · Invoke with @name in the editor");
    const selected = this.filtered[this.index];
    const indent = width > 2 ? "  " : "";
    const renderDescription = (maxRows: number): string[] => {
      if (!selected || this.loading || this.error || maxRows < 1) return [];
      const descriptionWidth = Math.max(1, width - indent.length);
      const wrapped = wrapTextWithAnsi(clean(selected.description), descriptionWidth);
      return wrapped.slice(0, maxRows).map((line, index) => {
        const text =
          index === maxRows - 1 && wrapped.length > maxRows
            ? truncateToWidth(`${line}…`, descriptionWidth, "…")
            : line;
        return theme.fg("muted", indent + text);
      });
    };
    if (height < 14) {
      const item = selected;
      const status = this.loading
        ? "Loading…"
        : (this.error ??
          (item ? `→ ${clean(item.name)} ${this.executionLabel(item)}` : "No matching agents"));
      const compact = [header[0], ...this.input.render(width), status].slice(
        0,
        Math.max(0, height - 1),
      );
      return [...compact, ...renderDescription(height - compact.length - 1), footer].map(fit);
    }
    const lines = [...border, "", ...header];
    const warning =
      this.catalog &&
      (this.catalog.diagnostics.length ||
        this.catalog.omittedAgents ||
        this.catalog.omittedDiagnostics);
    const availableRows = height - 12 - (warning ? 1 : 0);
    const description = renderDescription(availableRows - 1);
    const count = Math.min(10, Math.max(1, availableRows - description.length));
    const start = Math.max(
      0,
      Math.min(this.index - Math.floor(count / 2), this.filtered.length - count),
    );
    const end = Math.min(this.filtered.length, start + count);
    if (this.loading) lines.push(theme.fg("muted", "  Loading agent list…"));
    else if (this.error) lines.push(theme.fg("error", `  ${this.error}`));
    else if (!this.filtered.length)
      lines.push(
        theme.fg(
          "muted",
          this.catalog?.agents.length
            ? "  No matching agents."
            : "  No available definitions. Check diagnostics with list_agents.",
        ),
      );
    else {
      for (const agent of this.filtered.slice(start, end)) {
        const active = agent === selected;
        lines.push(
          `${active ? theme.fg("accent", "→ ") : "  "}${theme.fg(active ? "accent" : "text", clean(agent.name))} ${theme.fg("muted", this.executionLabel(agent))}`,
        );
      }
      if (start > 0 || end < this.filtered.length)
        lines.push(theme.fg("muted", `  (${this.index + 1}/${this.filtered.length})`));
      lines.push("", ...description);
    }
    if (warning)
      lines.push(
        theme.fg(
          "warning",
          `  Diagnostics ${this.catalog!.diagnostics.length} · Omitted ${this.catalog!.omittedAgents + this.catalog!.omittedDiagnostics} — check list_agents`,
        ),
      );
    lines.push("", footer, ...border);
    return lines.map(fit);
  }
}
