import type { Caller, Origin } from "../runner-pool/index.ts";
import { discoverAgents, type AgentDefinition } from "../runtime/agents.ts";
import {
  Preparation,
  PreparationLimitError,
  PreparationSafetyError,
} from "../runtime/discovery.ts";
import { boundedText, LIMITS } from "../runtime/limits.ts";
import { safeErrorText } from "../runtime/errors.ts";
import {
  prepareResearch,
  type PreparationStage,
  type ResearchConfig,
  type ResearchSource,
  type ResolvedSelection,
} from "../runtime/index.ts";

type PreflightStage = PreparationStage | "input" | "report";
type PreflightCode =
  | "invalid_input"
  | "preparation_failed"
  | "host_unavailable"
  | "limit_exceeded"
  | "cancelled"
  | "report_unavailable";

export function preflightFailure(code: PreflightCode, stage: PreflightStage) {
  return { status: "invalid_configuration" as const, code, stage };
}

type Catalog = Awaited<ReturnType<typeof discoverAgents>>;
type Entry = Omit<AgentDefinition, "systemPrompt">;

/** One bounded list/check owns its lifetime without an execution slot or child effects. */
export class AgentCatalog {
  private active?: {
    abort: AbortController;
    done: Promise<unknown>;
    origin: Origin;
    kind: "list" | "preflight";
    startedAt: number;
    started: number;
    stage: "discovering" | "cancelling" | "unsafe";
    stageStartedAt: number;
    stageStarted: number;
  };
  private draining = false;

  inspect(caller: Caller) {
    const active = this.active;
    const state = { health: this.draining ? "draining" : "ready", active: !!active };
    if (
      !active ||
      active.origin.sessionId !== caller.sessionId ||
      (active.origin.anchor !== null && !caller.branch.has(active.origin.anchor))
    )
      return state;
    return {
      ...state,
      diagnostics: {
        kind: active.kind,
        stage: active.stage,
        startedAt: active.startedAt,
        stageStartedAt: active.stageStartedAt,
        elapsedMs: Math.max(0, performance.now() - active.started),
        stageElapsedMs: Math.max(0, performance.now() - active.stageStarted),
        recovery: active.stage === "unsafe" ? "containment_required" : "await_owned_work",
      },
    };
  }

  private stage(stage: "cancelling" | "unsafe"): void {
    const active = this.active;
    if (!active || active.stage === "unsafe" || active.stage === stage) return;
    active.stage = stage;
    active.stageStartedAt = Date.now();
    active.stageStarted = performance.now();
  }

  list(origin: Origin, signal?: AbortSignal) {
    return this.perform(
      origin,
      "list",
      signal,
      async (preparation) => boundedCatalog(await discoverAgents(preparation)),
      (error) => ({
        rejection: "denied" as const,
        error: boundedText(safeErrorText(error, "Catalog operation failed."), 4096),
      }),
    );
  }

  preflight(origin: Origin, agent: string, source: ResearchSource, signal?: AbortSignal) {
    let stage: PreflightStage = "host";
    return this.perform(
      origin,
      "preflight",
      signal,
      async (preparation, combined) => {
        const captureBound = (includeParentPrompt: boolean) => {
          preparation.check();
          const host = source.capture(includeParentPrompt);
          preparation.check();
          return Object.freeze({
            ...host,
            signal: AbortSignal.any([combined, ...(host.signal ? [host.signal] : [])]),
          });
        };
        preparation.check();
        const host = source.scope();
        preparation.check();
        const config = await prepareResearch(
          host,
          "",
          agent,
          preparation,
          captureBound,
          (value) => {
            stage = value;
          },
        );
        preparation.check();
        stage = "report";
        const report = preflightReport(config);
        preparation.check();
        return report;
      },
      (error, combined) =>
        preflightFailure(
          signal?.aborted
            ? "cancelled"
            : error instanceof PreparationLimitError ||
                (combined.aborted && combined.reason instanceof PreparationLimitError)
              ? "limit_exceeded"
              : combined.aborted
                ? "cancelled"
                : stage === "host"
                  ? "host_unavailable"
                  : stage === "report"
                    ? "report_unavailable"
                    : "preparation_failed",
          stage,
        ),
    );
  }

  private async perform<T, F>(
    origin: Origin,
    kind: "list" | "preflight",
    signal: AbortSignal | undefined,
    operation: (preparation: Preparation, signal: AbortSignal) => Promise<T>,
    failure: (error: unknown, signal: AbortSignal) => F,
  ) {
    if (this.draining) return { rejection: "unavailable" as const };
    if (this.active) return { rejection: "busy" as const };
    const abort = new AbortController();
    const combined = AbortSignal.any([abort.signal, ...(signal ? [signal] : [])]);
    const deadline = performance.now() + LIMITS.startupMs;
    const timer = setTimeout(
      () => abort.abort(new PreparationLimitError("Catalog preparation deadline exceeded.")),
      LIMITS.startupMs,
    );
    let safe = true;
    const done = Promise.resolve()
      .then(async () => {
        const preparation = new Preparation(combined, deadline);
        return operation(preparation, combined);
      })
      .catch((error: unknown) => {
        if (error instanceof PreparationSafetyError) {
          safe = false;
          clearTimeout(timer);
          this.draining = true;
          this.stage("unsafe");
          // As with an unsafe invocation, no timeout can prove the handle is closed.
          return new Promise<never>(() => {});
        }
        return failure(error, combined);
      });
    const started = performance.now();
    const startedAt = Date.now();
    this.active = {
      abort,
      done,
      origin: { ...origin },
      kind,
      started,
      startedAt,
      stage: "discovering",
      stageStarted: started,
      stageStartedAt: startedAt,
    };
    const onAbort = () => this.stage("cancelling");
    combined.addEventListener("abort", onAbort, { once: true });
    if (combined.aborted) onAbort();
    try {
      return await done;
    } finally {
      clearTimeout(timer);
      combined.removeEventListener("abort", onAbort);
      if (safe) this.active = undefined;
    }
  }

  async drain(): Promise<void> {
    this.draining = true;
    const active = this.active;
    if (!active) return;
    active.abort.abort("shutdown");
    await Promise.allSettled([active.done]);
  }
}

function preflightReport(config: ResearchConfig) {
  const { model, modelSource, thinkingLevel, thinkingSource } = config.selection;
  const selection = { model, modelSource, thinkingLevel, thinkingSource };
  const report: {
    status: "configuration_valid";
    checkedAt: number;
    selection?: ResolvedSelection;
    maxModelTokens?: number;
    promptMode: ResearchConfig["promptMode"];
    skillCount: number;
    ordinaryToolCount: number;
    mcpServerCount: number;
    mcp: {
      name: string;
      transport: "stdio" | "http";
      exposure: ResearchConfig["mcp"][number]["exposure"];
    }[];
    omittedMcpServers: number;
    unchecked: string[];
  } = {
    status: "configuration_valid",
    checkedAt: Date.now(),
    ...(Buffer.byteLength(JSON.stringify(selection)) <= LIMITS.selectionBytes ? { selection } : {}),
    ...(config.maxModelTokens === undefined ? {} : { maxModelTokens: config.maxModelTokens }),
    promptMode: config.promptMode,
    skillCount: config.skills.length,
    ordinaryToolCount: config.tools.length,
    mcpServerCount: config.mcp.length,
    mcp: [],
    omittedMcpServers: config.mcp.length,
    unchecked: [
      "model_authentication",
      "mcp_connectivity",
      "mcp_catalog",
      "rendered_prompt",
      ...(config.skills.length ? ["skill_body_validation"] : []),
      "task",
      "tool_permissions_at_call",
    ],
  };
  for (const server of config.mcp) {
    report.mcp.push({
      name: server.name,
      transport: server.transport.type,
      exposure: server.exposure,
    });
    if (Buffer.byteLength(JSON.stringify(report)) > LIMITS.catalogBytes) report.mcp.pop();
    else report.omittedMcpServers--;
  }
  if (Buffer.byteLength(JSON.stringify(report)) > LIMITS.catalogBytes)
    throw new Error("Preflight report exceeds its output budget.");
  return report;
}

function boundedCatalog(catalog: Catalog) {
  const value: {
    agents: Entry[];
    diagnostics: Catalog["diagnostics"];
    omittedAgents: number;
    omittedDiagnostics: number;
  } = {
    agents: [],
    diagnostics: [],
    omittedAgents: 0,
    omittedDiagnostics: 0,
  };
  // Reserve space for counters and JSON structure; measure escaped UTF-8, not raw strings.
  let bytes = 256;
  for (const { systemPrompt: _prompt, ...agent } of catalog.agents) {
    const size = Buffer.byteLength(JSON.stringify(agent)) + 1;
    if (bytes + size > LIMITS.catalogBytes) value.omittedAgents++;
    else {
      value.agents.push(agent);
      bytes += size;
    }
  }
  for (const diagnostic of catalog.diagnostics) {
    const size = Buffer.byteLength(JSON.stringify(diagnostic)) + 1;
    if (bytes + size > LIMITS.catalogBytes) value.omittedDiagnostics++;
    else {
      value.diagnostics.push(diagnostic);
      bytes += size;
    }
  }
  return value;
}
