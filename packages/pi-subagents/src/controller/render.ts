import type { Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { RunView } from "../runner-pool/index.ts";
import { boundedText } from "../runtime/limits.ts";
import { clean } from "./sanitize.ts";
import type { RecoveryAction } from "../runner/failure.ts";

export type ActivityRun = Pick<
  RunView,
  | "runId"
  | "identity"
  | "phase"
  | "outcome"
  | "diagnostics"
  | "stopReason"
  | "error"
  | "failure"
  | "safeguard"
> & { preview?: string };
type Presentation = {
  label: string;
  marker: string;
  color: "dim" | "accent" | "warning" | "success" | "error";
  detail?: string;
};

const recoveryLabels: Record<RecoveryAction, string> = {
  await_owned_work: "Wait for owned work",
  containment_required: "Investigate owned effects",
  inspect_current_agents: "Inspect current agents",
  none: "Authority required",
  repair_configuration: "Check configuration",
  adjust_user_limits: "Check limits and prior effects",
  inspect_then_followup: "Inspect effects before follow-up",
};

function failureDetail(run: ActivityRun): string | undefined {
  if (!run.failure) return undefined;
  const cause =
    run.failure.code === "unknown" && run.stopReason
      ? `unknown: ${run.stopReason}`
      : run.failure.code;
  const httpStatus = run.failure.model?.httpStatus;
  return `${cause}${httpStatus === undefined ? "" : ` · ${httpStatus}`} · ${recoveryLabels[run.failure.nextAction]}`;
}

function formatActiveTools(tools: readonly string[] | undefined): string | undefined {
  if (!tools?.length) return undefined;
  const names = tools.map((name) => clean(name).replace(/\s+/gu, " ").trim()).filter(Boolean);
  if (!names.length) return undefined;
  const overflow = names.length > 2 ? ` +${names.length - 2}` : "";
  const budget = 64 - Buffer.byteLength(overflow);
  const shown = names.slice(0, 2);
  const perName = Math.max(8, Math.floor((budget - (shown.length > 1 ? 2 : 0)) / shown.length));
  const joined = shown.map((name) => boundedText(name, perName)).join(", ");
  return `${boundedText(joined, budget)}${overflow}`;
}

function state(run: ActivityRun): Presentation {
  switch (run.phase) {
    case "preparing":
      return { label: "Preparing", marker: "○", color: "dim" };
    case "running": {
      const detail = run.diagnostics.queuedTools
        ? `Waiting for tool slot (${run.diagnostics.queuedTools})`
        : formatActiveTools(run.diagnostics.activeToolNames);
      return {
        label: "Running",
        marker: "◐",
        color: "accent",
        ...(detail ? { detail } : {}),
      };
    }
    case "safeguarding":
      return {
        label: "Preparing handoff",
        marker: "◐",
        color: "warning",
        detail: run.diagnostics.stage.replaceAll("_", " "),
      };
    case "cancelling":
      return { label: "Stopping", marker: "◐", color: "warning" };
    case "settling":
      return {
        label: "Cleaning up",
        marker: "◐",
        color: "warning",
        detail: run.diagnostics.stage.replaceAll("_", " "),
      };
    case "blocked":
      return run.diagnostics.recovery === "containment_required"
        ? {
            label: "Needs attention",
            marker: "!",
            color: "error",
            detail: failureDetail(run) ?? "Cleanup unconfirmed",
          }
        : {
            label: "Cleanup pending",
            marker: "!",
            color: "warning",
            detail: failureDetail(run) ?? "Waiting for owned work",
          };
    case "terminal":
      if (run.outcome === "succeeded") return { label: "Completed", marker: "✓", color: "success" };
      if (run.outcome === "cancelled")
        return { label: "Cancelled", marker: "■", color: "warning", detail: failureDetail(run) };
      if (run.outcome === "failed" && run.safeguard?.stage === "summarized")
        return {
          label: "Incomplete · Summary delivered",
          marker: "!",
          color: "warning",
          detail: failureDetail(run) ?? run.stopReason ?? run.error,
        };
      return {
        label: "Failed",
        marker: "✗",
        color: "error",
        detail: failureDetail(run) ?? run.stopReason ?? run.error,
      };
  }
}

export function runStatusText(run: ActivityRun): string {
  const view = state(run);
  return clean([view.label, view.detail].filter(Boolean).join(" · ")).replace(/\s+/gu, " ").trim();
}

/** Compact single-line RPC status summary for active runs only; clears when all runs settle. */
export function activityStatusText(runs: readonly ActivityRun[]): string | undefined {
  const active = runs.filter((run) => run.phase !== "terminal");
  if (!active.length) return undefined;
  const prefix = `SubAgents (${active.length}): `;
  const formatName = (run: ActivityRun) =>
    boundedText(
      clean(run.identity?.agent ?? "Agent")
        .replace(/\s+/gu, " ")
        .trim(),
      48,
    ) || "Agent";
  const entries = active.map(
    (run) => `${formatName(run)} (${boundedText(runStatusText(run), 96)})`,
  );
  const maxBytes = 300;
  const shown: string[] = [];
  for (let index = 0; index < Math.min(3, entries.length); index++) {
    const candidate = [...shown, entries[index]!];
    const remaining = entries.length - candidate.length;
    const suffix = remaining > 0 ? ` +${remaining} more` : "";
    if (Buffer.byteLength(`${prefix}${candidate.join(", ")}${suffix}`) <= maxBytes) {
      shown.push(entries[index]!);
      continue;
    }
    if (shown.length === 0) {
      const name = formatName(active[0]!);
      const firstRemaining = entries.length - 1;
      const firstSuffix = firstRemaining > 0 ? ` +${firstRemaining} more` : "";
      const statusBudget = Math.max(
        8,
        maxBytes - Buffer.byteLength(`${prefix}${name} ()${firstSuffix}`),
      );
      return `${prefix}${name} (${boundedText(runStatusText(active[0]!), statusBudget)})${firstSuffix}`;
    }
    break;
  }
  const remaining = entries.length - shown.length;
  const suffix = remaining > 0 ? ` +${remaining} more` : "";
  return `${prefix}${shown.join(", ")}${suffix}`;
}

function duration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const s = String(seconds % 60).padStart(2, "0");
  const m = String(Math.floor(seconds / 60) % 60).padStart(2, "0");
  return seconds < 3600 ? `${m}:${s}` : `${Math.floor(seconds / 3600)}:${m}:${s}`;
}

function shortId(id: string, ids: readonly string[]): string {
  let length = 4;
  while (
    length < id.length &&
    ids.some((other) => other !== id && other.startsWith(id.slice(0, length)))
  )
    length++;
  return clean(id.slice(0, length));
}

// Legacy terminals can allocate cells to both emoji components and the joiner.
function activityWidth(text: string): number {
  const parts = text.split("\u200d");
  return parts.reduce((sum, part) => sum + visibleWidth(part), parts.length - 1);
}

function fitActivity(text: string, width: number): string {
  let budget = Math.max(0, width);
  let line = truncateToWidth(text, budget, "…");
  while (budget > 0) {
    const cells = activityWidth(line);
    if (cells <= width) break;
    budget = Math.max(0, budget - (cells - width));
    line = truncateToWidth(text, budget, "…");
  }
  return line;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function fitPreview(text: string, width: number): string {
  if (activityWidth(text) <= width) return text;
  let tail = "";
  let cells = 1;
  for (const { segment } of [...graphemes.segment(text)].reverse()) {
    cells += activityWidth(segment);
    if (cells > width) break;
    tail = segment + tail;
  }
  return `…${tail}`;
}

export function activityLines(
  runs: readonly ActivityRun[],
  width: number,
  rows: number,
  theme: Theme,
): string[] {
  if (width < 1 || !runs.length) return [];
  const ordered = runs;
  const runIds = ordered.map((run) => run.runId);
  const agentIds = ordered.flatMap((run) => (run.identity?.agentId ? [run.identity.agentId] : []));
  const height = Math.min(8, Math.max(1, Math.floor(rows * 0.25)));
  const fit = (line: string) => fitActivity(line, width);
  const lines = [fit(theme.fg("accent", `SubAgents (${ordered.length})`))];
  if (height <= 2) {
    const active = ordered.filter((run) => run.phase !== "terminal").length;
    lines[0] = fit(theme.fg("accent", `SubAgents (${ordered.length}) · ${active} active`));
    return lines;
  }
  const overflow = ordered.length > height - 1;
  const shown = ordered.slice(0, height - (overflow ? 2 : 1));
  for (const [index, run] of shown.entries()) {
    const view = state(run);
    const branch = index === ordered.length - 1 ? "└─" : "├─";
    const prefix = `${branch} ${view.marker} `;
    const runId = shortId(run.runId, runIds);
    const agentId = run.identity?.agentId;
    const id =
      width >= 80 && agentId
        ? ` (agent ${shortId(agentId, agentIds)} · run ${runId})`
        : ` (run ${runId})`;
    const elapsed = width >= 60 ? ` · ${duration(run.diagnostics.elapsedMs)}` : "";
    const suffix = ` (${view.label}${elapsed})`;
    const name = fitActivity(
      clean(run.identity?.agent ?? "Agent"),
      width - visibleWidth(prefix + id + suffix),
    );
    const detail =
      width >= 40
        ? clean(view.detail ?? run.preview ?? "")
            .replace(/\s+/gu, " ")
            .trim()
        : "";
    const room = width - activityWidth(prefix + name + id + suffix) - 3;
    const extra =
      detail && room >= 4
        ? ` · ${view.detail ? fitActivity(detail, room) : fitPreview(detail, room)}`
        : "";
    const label = theme.fg(run.phase === "terminal" ? "muted" : "text", name);
    lines.push(
      fit(
        `${theme.fg("dim", `${branch} `)}${theme.fg(view.color, `${view.marker} `)}${label}${theme.fg("dim", id)} ${theme.fg(view.color, `(${view.label}${elapsed}${extra})`)}`,
      ),
    );
  }
  if (overflow)
    lines.push(
      fit(theme.fg("muted", `└─ +${ordered.length - shown.length} more · /subagent-runs`)),
    );
  return lines;
}

const hidden: Component = { render: () => [], invalidate() {} };

export function renderSpawnCall(): Component {
  return hidden;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRunResult(value: unknown): boolean {
  if (!record(value) || typeof value.runId !== "string" || !record(value.diagnostics)) return false;
  if (
    typeof value.diagnostics.elapsedMs !== "number" ||
    !Number.isFinite(value.diagnostics.elapsedMs)
  )
    return false;
  switch (value.phase) {
    case "preparing":
    case "running":
    case "safeguarding":
    case "cancelling":
    case "settling":
    case "blocked":
      return true;
    case "terminal":
      return (
        value.cleanup === "safe" &&
        (value.outcome === "succeeded" ||
          value.outcome === "failed" ||
          value.outcome === "cancelled")
      );
    default:
      return false;
  }
}

function renderSpawnResult(
  result: { content: readonly { type: string; text?: string }[]; details?: unknown },
  _options: ToolRenderResultOptions,
  theme: Theme,
): Component {
  // Admitted runs live only in the list. Keep pre-admission errors readable.
  if (isRunResult(result.details)) return hidden;
  const details = result.details;
  if (
    record(details) &&
    typeof details.generation === "string" &&
    (details.rejection === "busy" ||
      details.rejection === "unavailable" ||
      details.rejection === "denied")
  ) {
    const reason = typeof details.reason === "string" ? details.reason : details.rejection;
    return new Text(theme.fg("warning", `SubAgents · Not started: ${clean(reason)}`), 0, 0);
  }
  return new Text(
    result.content
      .filter((part) => part.type === "text")
      .map((part) =>
        (part.text ?? "")
          .split(/\r\n|\r|\n/)
          .map(clean)
          .join("\n"),
      )
      .join("\n"),
    0,
    0,
  );
}

export function renderFollowupResult(
  result: { content: readonly { type: string; text?: string }[]; details?: unknown },
  options: ToolRenderResultOptions,
  theme: Theme,
): Component {
  const details = result.details;
  if (
    record(details) &&
    typeof details.agentId === "string" &&
    typeof details.runId === "string" &&
    typeof details.requestId === "string"
  ) {
    // A delivery receipt does not confirm that the follow-up task completed.
    switch (details.state) {
      case "queued":
        return new Text(theme.fg("dim", "SubAgents · Follow-up queued · Not completion"), 0, 0);
      case "injected_not_confirmed":
        return new Text(
          theme.fg("dim", "SubAgents · Follow-up injected · Completion unconfirmed"),
          0,
          0,
        );
      case "discarded":
        return new Text(
          theme.fg("warning", "SubAgents · Follow-up discarded · Not delivered"),
          0,
          0,
        );
      case "admitted":
      case "terminal":
        return hidden;
    }
  }
  return renderSpawnResult(result, options, theme);
}
