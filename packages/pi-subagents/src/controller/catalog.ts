import type { Caller, Origin } from "../runner-pool/index.ts";
import { discoverAgents, type AgentDefinition } from "../runtime/agents.ts";
import {
  Preparation,
  PreparationLimitError,
  PreparationSafetyError,
} from "../runtime/discovery.ts";
import { boundedText, LIMITS } from "../runtime/limits.ts";
import { safeErrorText } from "../runtime/errors.ts";

type Catalog = Awaited<ReturnType<typeof discoverAgents>>;
type Entry = Omit<AgentDefinition, "systemPrompt">;

/** One bounded catalog listing owns its lifetime without an execution slot or child effects. */
export class AgentCatalog {
  private active?: {
    abort: AbortController;
    done: Promise<unknown>;
    origin: Origin;
    kind: "list";
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

  async list(origin: Origin, signal?: AbortSignal) {
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
        return boundedCatalog(await discoverAgents(preparation));
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
        return {
          rejection: "denied" as const,
          error: boundedText(safeErrorText(error, "Catalog operation failed."), 4096),
        };
      });
    const started = performance.now();
    const startedAt = Date.now();
    this.active = {
      abort,
      done,
      origin: { ...origin },
      kind: "list",
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
