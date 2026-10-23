import type { Settings } from "./settings.ts";

type RequestModel = { id: string; api: string };
type ServiceTier = Settings["fast" | "ultrafast"]["serviceTier"];

function modelName(id: string): string {
  return id.trim().split("/").at(-1) ?? "";
}

export function selectServiceTier(
  settings: Settings,
  model: RequestModel | undefined,
): ServiceTier | undefined {
  if (!model || (model.api !== "openai-responses" && model.api !== "openai-codex-responses"))
    return;
  const name = modelName(model.id);
  if (!name) return;

  for (const mode of [settings.ultrafast, settings.fast]) {
    if (mode.enabled && mode.supportedModels.some((id) => modelName(id) === name)) {
      return mode.serviceTier;
    }
  }
}

export function applyServiceTier(
  settings: Settings,
  model: RequestModel | undefined,
  payload: unknown,
): unknown {
  const tier = selectServiceTier(settings, model);
  if (!tier || !model || !payload || typeof payload !== "object" || Array.isArray(payload)) return;
  if (!("model" in payload) || typeof payload.model !== "string") return;
  if (modelName(payload.model) !== modelName(model.id)) return;

  return { ...payload, service_tier: tier };
}
