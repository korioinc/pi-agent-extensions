import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { isRecord, parseCatalog } from "./catalog.ts";

type ModelMetadata = Pick<
  Model<Api>,
  | "id"
  | "name"
  | "input"
  | "reasoning"
  | "thinkingLevelMap"
  | "contextWindow"
  | "maxTokens"
  | "cost"
>;

export type CachedCatalog = { cacheKey: string; models: ModelMetadata[] };

export function catalogCacheKey(
  provider: string,
  url: URL,
  config: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        provider,
        url.href,
        config.api,
        config.baseUrl,
        config.apiKey,
        isRecord(config.headers) ? Object.entries(config.headers).sort() : config.headers,
        config.oauth,
        config.authHeader,
      ]),
    )
    .digest("hex");
}

export function cacheModelMetadata(models: readonly Model<Api>[]): ModelMetadata[] {
  return models.map(
    ({ id, name, input, reasoning, thinkingLevelMap, contextWindow, maxTokens, cost }) => ({
      id,
      name,
      input,
      reasoning,
      thinkingLevelMap,
      contextWindow,
      maxTokens,
      cost,
    }),
  );
}

export async function readModelCache(path: string): Promise<Map<string, CachedCatalog>> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError || (isRecord(error) && error.code === "ENOENT"))
      return new Map();
    throw error;
  }
  const cache = new Map<string, CachedCatalog>();
  if (!isRecord(data) || data.version !== 1 || !isRecord(data.providers)) return cache;
  for (const [id, entry] of Object.entries(data.providers)) {
    if (
      !isRecord(entry) ||
      typeof entry.cacheKey !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.cacheKey)
    )
      continue;
    try {
      cache.set(id, {
        cacheKey: entry.cacheKey,
        models: cacheModelMetadata(parseCatalog(entry.models, id, "", "")),
      });
    } catch {
      // One invalid provider must not discard other usable catalogs.
    }
  }
  return cache;
}

export async function writeModelCache(
  path: string,
  updates: ReadonlyMap<string, CachedCatalog>,
  signal: AbortSignal,
): Promise<void> {
  const cache = await readModelCache(path);
  for (const [id, entry] of updates) cache.set(id, entry);
  signal.throwIfAborted();
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ version: 1, providers: Object.fromEntries(cache) }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600, signal },
    );
    signal.throwIfAborted();
    // shortcut: concurrent Pi processes use last-writer-wins; add locking if shared refreshes need ordering.
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
