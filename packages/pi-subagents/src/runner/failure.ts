import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { RunStage } from "../runner-pool/index.ts";

export type ToolEffects = "none_started" | "possible" | "unknown";

export type FailureCode =
  | "cleanup_unconfirmed"
  | "shutdown"
  | "cancelled"
  | "authority_revoked"
  | "configuration_invalid"
  | "invocation_limit"
  | "tool_timeout"
  | "model_output_limit"
  | "model_token_limit"
  | "tool_call_limit"
  | "model_turn_limit"
  | "provider_auth_error"
  | "provider_http_error"
  | "model_error_unknown"
  | "tool_error"
  | "unknown";

export type RecoveryAction =
  | "await_owned_work"
  | "containment_required"
  | "inspect_current_agents"
  | "none"
  | "repair_configuration"
  | "adjust_user_limits"
  | "inspect_then_followup";

export interface ModelFailureEvidence {
  requestIndex: number;
  stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
  httpStatus?: number;
  responseId?: string;
  transportCode?: "ECONNRESET" | "ETIMEDOUT" | "UND_ERR_SOCKET" | "ABORT_ERR";
}

export interface RunFailure {
  code: FailureCode;
  stage: RunStage;
  nextAction: RecoveryAction;
  automaticReplay: false;
  toolEffects: ToolEffects;
  model?: ModelFailureEvidence;
}

function modelStopReason(value: unknown): ModelFailureEvidence["stopReason"] {
  switch (value) {
    case "stop":
    case "length":
    case "toolUse":
    case "error":
    case "aborted":
      return value;
    default:
      return undefined;
  }
}

function transportCode(value: unknown): ModelFailureEvidence["transportCode"] {
  switch (value) {
    case "ECONNRESET":
    case "ETIMEDOUT":
    case "UND_ERR_SOCKET":
    case "ABORT_ERR":
      return value;
    default:
      return undefined;
  }
}

function diagnosticTransportCode(diagnostics: unknown): ModelFailureEvidence["transportCode"] {
  if (!Array.isArray(diagnostics)) return undefined;
  for (let index = 0; index < Math.min(diagnostics.length, 8); index++) {
    try {
      const diagnostic: unknown = diagnostics[index];
      if (!diagnostic || typeof diagnostic !== "object" || !("error" in diagnostic)) continue;
      const error = diagnostic.error;
      if (!error || typeof error !== "object" || !("code" in error)) continue;
      const code = transportCode(error.code);
      if (code) return code;
    } catch {
      // Optional provider diagnostics must not turn reporting into an execution failure.
    }
  }
  return undefined;
}

function projectModel(evidence: ModelFailureEvidence): ModelFailureEvidence {
  const projected: ModelFailureEvidence = { requestIndex: evidence.requestIndex };
  const stopReason = modelStopReason(evidence.stopReason);
  if (stopReason) projected.stopReason = stopReason;
  const status = evidence.httpStatus;
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
    projected.httpStatus = status;
  }
  if (
    typeof evidence.responseId === "string" &&
    /^[A-Za-z0-9_.:-]{1,128}$/.test(evidence.responseId)
  ) {
    projected.responseId = evidence.responseId;
  }
  const code = transportCode(evidence.transportCode);
  if (code) projected.transportCode = code;
  return projected;
}

/** Copy only bounded native evidence. Request indices come from successful Budget admission. */
export function modelFailureEvidence(
  requestIndex: number,
  message: AssistantMessage,
  httpStatus?: number,
): ModelFailureEvidence {
  const evidence: ModelFailureEvidence = {
    requestIndex,
    stopReason: modelStopReason(message.stopReason),
    httpStatus,
  };
  try {
    evidence.responseId = message.responseId;
    evidence.transportCode = diagnosticTransportCode(message.diagnostics);
  } catch {
    // Native adapters need not expose usable optional metadata.
  }
  return projectModel(evidence);
}

function limitCode(reason: unknown): FailureCode | undefined {
  switch (reason) {
    case "invocation":
    case "limit_exceeded: invocation":
      return "invocation_limit";
    case "tool deadline":
    case "limit_exceeded: tool deadline":
      return "tool_timeout";
    case "model output":
    case "limit_exceeded: model output":
      return "model_output_limit";
    case "limit_exceeded: model tokens":
      return "model_token_limit";
    case "limit_exceeded: tool calls":
      return "tool_call_limit";
    case "model turns":
    case "limit_exceeded: model turns":
      return "model_turn_limit";
    default:
      // An explicit owner limit outranks a later transport error even without a named code.
      return typeof reason === "string" && reason.startsWith("limit_exceeded:")
        ? "unknown"
        : undefined;
  }
}

function nextAction(code: FailureCode): RecoveryAction {
  switch (code) {
    case "shutdown":
    case "cancelled":
      return "inspect_current_agents";
    case "authority_revoked":
      return "none";
    case "configuration_invalid":
    case "provider_auth_error":
      return "repair_configuration";
    case "invocation_limit":
    case "tool_timeout":
    case "model_output_limit":
      return "adjust_user_limits";
    default:
      return "inspect_then_followup";
  }
}

export function classifyFailure(input: {
  outcome: "succeeded" | "failed" | "cancelled";
  stage: RunStage;
  stopReason?: unknown;
  safeguardReason?: unknown;
  model?: ModelFailureEvidence;
  toolEffects: ToolEffects;
  cleanupRecovery?: "await_owned_work" | "containment_required";
  configurationFailure?: boolean;
  toolFailure?: boolean;
}): RunFailure | undefined {
  if (input.outcome === "succeeded" && !input.cleanupRecovery) return undefined;
  const model =
    input.model && Number.isSafeInteger(input.model.requestIndex) && input.model.requestIndex > 0
      ? projectModel(input.model)
      : undefined;
  let code: FailureCode;
  if (input.cleanupRecovery) {
    code = "cleanup_unconfirmed";
  } else if (input.outcome === "cancelled") {
    code = input.stopReason === "shutdown" ? "shutdown" : "cancelled";
  } else if (input.stopReason === "authority_revoked") {
    code = "authority_revoked";
  } else if (input.configurationFailure) {
    code = "configuration_invalid";
  } else {
    const limit =
      limitCode(input.safeguardReason) ??
      limitCode(input.stopReason) ??
      (model?.stopReason === "length" ? "model_output_limit" : undefined);
    if (limit) code = limit;
    else if (model?.httpStatus === 401 || model?.httpStatus === 403) code = "provider_auth_error";
    else if (model?.httpStatus !== undefined && model.httpStatus >= 400)
      code = "provider_http_error";
    else if (model?.stopReason === "error" || model?.stopReason === "aborted") {
      code = "model_error_unknown";
    } else if (input.toolFailure) code = "tool_error";
    else code = "unknown";
  }
  const failure: RunFailure = {
    code,
    stage: input.stage,
    nextAction: input.cleanupRecovery ?? nextAction(code),
    automaticReplay: false,
    toolEffects: input.toolEffects,
  };
  if (model) failure.model = model;
  if (Buffer.byteLength(JSON.stringify(failure), "utf8") > 2 * 1024) delete failure.model;
  return failure;
}
