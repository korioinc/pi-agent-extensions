import { classifyFailure, type RunFailure } from "../runner/failure.ts";
import { projectInbox } from "./inbox.ts";
import type { Run, RunDiagnostics, RunView } from "./types.ts";

export function projectDiagnostics(run: Run): RunDiagnostics {
  const diagnostics = { ...run.view.diagnostics };
  const now = run.clock.completed ?? performance.now();
  diagnostics.elapsedMs = Math.max(0, now - run.clock.admitted);
  diagnostics.phaseElapsedMs = Math.max(0, now - run.clock.phase);
  diagnostics.stageElapsedMs = Math.max(0, now - run.clock.stage);
  if (run.clock.stopped !== undefined)
    diagnostics.stopElapsedMs = Math.max(0, now - run.clock.stopped);
  if (run.view.phase === "running" && run.activeTools.size > 0)
    diagnostics.activeToolNames = [...new Set(run.activeTools.values())];
  if (run.view.phase === "blocked")
    diagnostics.recovery =
      diagnostics.executor === "rejected" || run.cleanupUnsafe
        ? "containment_required"
        : "await_owned_work";
  return diagnostics;
}

export function projectFailure(run: Run): RunFailure | undefined {
  if (run.view.phase !== "blocked") return run.view.failure && structuredClone(run.view.failure);
  return classifyFailure({
    outcome: "failed",
    stage: run.failureStage ?? run.view.diagnostics.stage,
    stopReason: run.view.stopReason,
    model: run.modelFailure,
    toolEffects: run.effects,
    cleanupRecovery: projectDiagnostics(run).recovery,
  });
}

export function copyRunView(run: Run): RunView {
  const failure = projectFailure(run);
  return {
    ...structuredClone(run.view),
    ...(run.view.identity?.agentId ? { agentId: run.view.identity.agentId } : {}),
    diagnostics: projectDiagnostics(run),
    ...(failure ? { failure } : {}),
  };
}

export function projectRunDetail(run: Run) {
  return {
    ...copyRunView(run),
    observation: structuredClone(run.observation),
    inbox: projectInbox(run.inbox),
    activity: {
      providerRequests: run.activity.providerRequests,
      toolStarts: run.activity.toolStarts,
      codemodeStarts: run.activity.codemodeStarts,
      recentTools: run.activity.recentTools.map(({ name, state }) => ({ name, state })),
    },
  };
}

export function projectRunSummary(run: Run) {
  return {
    runId: run.view.runId,
    ...(run.view.identity?.agentId ? { agentId: run.view.identity.agentId } : {}),
    ...(run.view.identity ? { identity: { ...run.view.identity } } : {}),
    phase: run.view.phase,
    outcome: run.view.outcome,
    stopReason: run.view.stopReason,
    diagnostics: projectDiagnostics(run),
    failure: projectFailure(run),
    executionLimits: run.view.executionLimits,
  };
}

export function projectActivityRun(run: Run) {
  return {
    ...projectRunSummary(run),
    safeguard: run.view.safeguard ? { ...run.view.safeguard } : undefined,
    error: run.view.error,
    preview: run.preview,
  };
}
