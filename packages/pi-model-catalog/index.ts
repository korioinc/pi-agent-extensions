import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { envApiKeyAuth, type Provider } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { builtinProviders, radiusProvider } from "@earendil-works/pi-ai/providers/all";
import {
  buildSessionContext,
  getAgentDir,
  ModelRuntime,
  parseArgs,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { fetchCatalog, isRecord, parseCatalog } from "./catalog.ts";
import {
  cacheModelMetadata,
  catalogCacheKey,
  readModelCache,
  writeModelCache,
  type CachedCatalog,
} from "./cache.ts";
import { registerModelPicker } from "./thinking.ts";

export default async function modelCatalogExtension(pi: ExtensionAPI): Promise<void> {
  const modelsPath = join(getAgentDir(), "models.json");
  const cachePath = join(getAgentDir(), "models-cache.json");
  const offline = ["1", "true", "yes"].includes(process.env.PI_OFFLINE?.toLowerCase() ?? "");
  let document: unknown;
  try {
    const content = await readFile(modelsPath, "utf8");
    // Match Pi's models.json support for BOM, line comments, and trailing commas.
    document = JSON.parse(
      content
        .replace(/^\uFEFF/, "")
        .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
        .replace(
          /"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,
          (match, tail: string | undefined) => tail ?? match,
        ),
    );
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    console.error("[pi-model-catalog] Cannot read models.json; remote catalogs were not loaded.");
    return;
  }
  if (!isRecord(document) || !isRecord(document.providers)) return;
  const catalogs = Object.entries(document.providers).filter(
    ([, config]) => isRecord(config) && Object.hasOwn(config, "modelCatalogUrl"),
  );
  if (catalogs.length === 0) return;

  // Use Pi's auth resolver so environment, command, and stored credentials keep their semantics.
  const runtime = await ModelRuntime.create({ modelsPath, refreshOnCreate: false });
  if (runtime.getError()) {
    console.error("[pi-model-catalog] Pi rejected models.json; remote catalogs were not loaded.");
    return;
  }
  const builtins = builtinProviders();
  const catalogProviders = new Map<string, string>();
  const lifetime = new AbortController();
  let pending: Promise<void> | undefined;
  registerModelPicker(pi, catalogProviders, (ctx) => {
    pending ??= refreshCatalogs(ctx).finally(() => {
      pending = undefined;
    });
    return pending;
  });
  pi.on("session_shutdown", async () => {
    lifetime.abort();
    await pending?.catch(() => {});
  });

  async function refreshCatalogs(ctx: ExtensionContext): Promise<void> {
    if (offline) {
      ctx.ui.notify("Catalog refresh is unavailable in offline mode.", "warning");
      return;
    }
    ctx.ui.notify("Refreshing model catalogs…", "info");
    const result = await loadCatalogs(true);
    lifetime.signal.throwIfAborted();
    await ctx.modelRegistry.refresh({ allowNetwork: false, signal: lifetime.signal });
    lifetime.signal.throwIfAborted();
    ctx.ui.notify(
      `Refreshed ${result.refreshed} model catalog(s).` +
        (result.failed ? ` ${result.failed} failed; existing models were kept.` : "") +
        (result.cacheSaved ? "" : " Could not save models-cache.json."),
      result.failed || !result.cacheSaved ? "warning" : "info",
    );
  }

  async function loadCatalogs(force: boolean) {
    let cache: Map<string, CachedCatalog>;
    try {
      cache = await readModelCache(cachePath);
    } catch {
      cache = new Map();
      console.error(
        "[pi-model-catalog] Cannot read models-cache.json; cached catalogs are unavailable.",
      );
    }
    const updates = new Map<string, CachedCatalog>();
    let failed = 0;
    await Promise.all(
      catalogs.map(async ([id, config]) => {
        try {
          if (builtins.some((provider) => provider.id === id)) {
            failed++;
            console.error(
              `[pi-model-catalog] ${id}: use a custom provider name; built-in providers are left unchanged.`,
            );
            return;
          }
          if (
            !isRecord(config) ||
            typeof config.modelCatalogUrl !== "string" ||
            typeof config.baseUrl !== "string" ||
            typeof config.api !== "string"
          ) {
            throw new Error("modelCatalogUrl, baseUrl, and api must be strings");
          }
          const url = new URL(config.modelCatalogUrl);
          if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
            throw new Error("Invalid catalog URL");
          }
          const api = getApiProvider(config.api);
          if (!api) throw new Error("Unsupported provider API");
          const cacheKey = catalogCacheKey(id, url, config);
          const cached = cache.get(id);
          let models =
            !force && cached?.cacheKey === cacheKey
              ? parseCatalog(cached.models, id, config.api, config.baseUrl)
              : undefined;
          const fetched = models === undefined;
          if (models === undefined) {
            if (offline) {
              failed++;
              console.error(
                `[pi-model-catalog] ${id}: no matching catalog cache is available offline.`,
              );
              return;
            }
            const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(10000)]);
            const auth = await runtime.getAuth(id, { signal });
            const headers = new Headers();
            for (const [name, value] of Object.entries(auth?.auth.headers ?? {})) {
              if (value !== null) headers.set(name, value);
            }
            if (auth?.auth.apiKey && !headers.has("Authorization"))
              headers.set("Authorization", `Bearer ${auth.auth.apiKey}`);
            headers.set("Accept", "application/json");
            models = parseCatalog(
              await fetchCatalog(url, headers, signal),
              id,
              config.api,
              config.baseUrl,
            );
          }
          const base: Provider | undefined =
            config.oauth === "radius"
              ? radiusProvider({
                  id,
                  name: typeof config.name === "string" ? config.name : id,
                  gateway: config.baseUrl.replace(/\/v1\/?$/u, ""),
                })
              : undefined;
          const getModels = () => {
            const merged = new Map(base?.getModels().map((model) => [model.id, model]));
            for (const model of models) merged.set(model.id, model);
            return [...merged.values()];
          };
          const provider: Provider = {
            ...base,
            id,
            name: base?.name ?? id,
            auth: base?.auth ?? { apiKey: envApiKeyAuth("API key", []) },
            getModels,
            getAllModels: () => [
              ...(base
                ?.getAllModels?.()
                .filter((model) => model.type !== undefined && model.type !== "chat") ?? []),
              ...getModels(),
            ],
            stream: (model, context, options) =>
              base?.getModels().some((entry) => entry.api === model.api)
                ? base.stream(model, context, options)
                : api.stream(model, context, options),
            streamSimple: (model, context, options) =>
              base?.getModels().some((entry) => entry.api === model.api)
                ? base.streamSimple(model, context, options)
                : api.streamSimple(model, context, options),
          };
          lifetime.signal.throwIfAborted();
          pi.registerProvider(provider);
          catalogProviders.set(id, config.api);
          if (fetched) updates.set(id, { cacheKey, models: cacheModelMetadata(models) });
        } catch {
          if (lifetime.signal.aborted) return;
          failed++;
          // Resolver/fetch errors can contain secrets; do not print their message or response body.
          console.error(
            `[pi-model-catalog] ${id}: catalog load failed; existing models remain available. Check the URL, credentials, and catalog format.`,
          );
        }
      }),
    );
    lifetime.signal.throwIfAborted();
    let cacheSaved = true;
    if (updates.size > 0) {
      try {
        await writeModelCache(cachePath, updates, lifetime.signal);
      } catch {
        lifetime.signal.throwIfAborted();
        cacheSaved = false;
        console.error(
          "[pi-model-catalog] Models loaded, but models-cache.json could not be saved.",
        );
      }
    }
    return { refreshed: updates.size, failed, cacheSaved };
  }

  await loadCatalogs(false);

  let defaultChecked = false;
  pi.on("session_start", async (event, ctx) => {
    if (defaultChecked || event.reason !== "startup" || ctx.scopedModels.length > 0) return;
    defaultChecked = true;
    // shortcut: CLI process names identify startup ownership until Pi exposes model selection provenance.
    if (process.title !== "pi" && process.title !== "pi-rpc") return;
    const args = parseArgs(process.argv.slice(2));
    if (
      args.model ||
      args.provider ||
      args.models ||
      args.continue ||
      args.resume ||
      args.session ||
      args.sessionId ||
      args.fork ||
      buildSessionContext(ctx.sessionManager.getBranch()).messages.length > 0
    ) {
      return;
    }
    const { defaultProvider, defaultModel } = pi.getSettings();
    if (!defaultProvider || !defaultModel || !catalogProviders.has(defaultProvider)) return;
    const models = ctx.modelRegistry
      .getAvailable()
      .filter((model) => model.provider === defaultProvider);
    if (models.some((model) => model.id === defaultModel)) return;
    const matches = models.filter((model) => model.id.split("/").at(-1) === defaultModel);
    if (matches.length !== 1) return;
    const model = matches[0]!;
    if (ctx.model?.provider === model.provider && ctx.model.id === model.id) return;
    if ((await pi.setModel(model)) && args.thinking) pi.setThinkingLevel(args.thinking);
  });
}
