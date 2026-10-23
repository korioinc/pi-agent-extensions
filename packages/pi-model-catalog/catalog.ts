import type { Api, Model } from "@earendil-works/pi-ai";

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  // Reject C0, DEL, and C1 controls before metadata reaches terminal widgets.
  if (typeof value !== "string" || !value.trim() || /\p{Cc}/u.test(value))
    throw new Error(`Invalid ${field}`);
  return value;
}

function positiveNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function thinkingMap(value: unknown): Record<string, string | null> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Invalid thinkingLevelMap");
  const entries = Object.entries(value).map(
    ([level, effort]) =>
      [level, effort === null ? null : text(effort, "thinkingLevelMap effort")] as const,
  );
  return Object.fromEntries(entries.filter(([level]) => thinkingLevels.includes(level)));
}

function codexThinkingMap(value: unknown): Record<string, string | null> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Invalid supported_reasoning_levels");
  const efforts = new Set(
    value.map((entry: unknown) => {
      if (!isRecord(entry)) throw new Error("Invalid supported_reasoning_levels entry");
      return text(entry.effort, "reasoning effort");
    }),
  );
  return Object.fromEntries(
    thinkingLevels.map((level) => [level, efforts.has(level) ? level : null]),
  );
}

function modelCost(value: unknown): Model<Api>["cost"] {
  if (value === undefined) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (!isRecord(value)) throw new Error("Invalid cost");
  const rate = (field: string): number => {
    const amount = value[field];
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      throw new Error(`Invalid cost.${field}`);
    }
    return amount;
  };
  return {
    input: rate("input"),
    output: rate("output"),
    cacheRead: rate("cacheRead"),
    cacheWrite: rate("cacheWrite"),
  };
}

export function parseCatalog(
  data: unknown,
  provider: string,
  api: string,
  baseUrl: string,
): Model<Api>[] {
  const entries = Array.isArray(data)
    ? data
    : isRecord(data)
      ? (data.models ?? data.data)
      : undefined;
  if (!Array.isArray(entries))
    throw new Error("Expected a model array, { models: [...] }, or { data: [...] }");
  const models: Model<Api>[] = [];
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry)) throw new Error("Invalid model entry");
    const codex = entry.id === undefined && entry.slug !== undefined;
    if (codex && (entry.visibility === "hide" || entry.supported_in_api === false)) continue;
    const id = text(entry.id ?? entry.slug, "model id");
    if (ids.has(id)) throw new Error("Duplicate model id");
    ids.add(id);
    const input = entry.input ?? entry.input_modalities ?? ["text"];
    if (
      !Array.isArray(input) ||
      input.length === 0 ||
      !input.every((item: unknown) => item === "text" || item === "image")
    ) {
      throw new Error("Invalid model input modalities");
    }
    const map =
      thinkingMap(entry.thinkingLevelMap) ?? codexThinkingMap(entry.supported_reasoning_levels);
    const reasoning =
      entry.reasoning ??
      entry.supports_reasoning ??
      (map !== undefined &&
        Object.values(map).some((effort) => effort !== null && effort !== "off"));
    if (typeof reasoning !== "boolean") throw new Error("Invalid reasoning");
    models.push({
      id,
      name: text(entry.name ?? entry.display_name ?? id, "model name"),
      provider,
      api,
      baseUrl,
      input,
      reasoning,
      ...(map ? { thinkingLevelMap: map } : {}),
      contextWindow: positiveNumber(
        entry.contextWindow ?? entry.context_window ?? entry.context_length ?? 128000,
        "contextWindow",
      ),
      maxTokens: positiveNumber(entry.maxTokens ?? entry.max_output_tokens ?? 16384, "maxTokens"),
      cost: modelCost(entry.cost),
    });
  }
  return models;
}

export async function fetchCatalog(
  url: URL,
  headers: Headers,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(url, { headers, signal, redirect: "error" });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Catalog request failed (HTTP ${response.status})`);
  }
  if (!response.body) throw new Error("Empty catalog response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8 * 1024 * 1024) throw new Error("Catalog exceeds 8 MiB");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Catalog is not valid JSON");
  }
}
