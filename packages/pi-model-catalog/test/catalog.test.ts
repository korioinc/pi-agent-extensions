import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { fetchCatalog, parseCatalog } from "../catalog.ts";

async function serve(t: TestContext, handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return `http://127.0.0.1:${address.port}`;
}

async function agentDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-model-catalog-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const previousOffline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = directory;
  delete process.env.PI_OFFLINE;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("catalog loading leaves the user's models.json byte-for-byte intact on success and failure", async (t) => {
  const directory = await agentDirectory(t);
  let fail = false;
  const url = await serve(t, (_request, response) => {
    response.end(fail ? "invalid json" : JSON.stringify({ models: [{ id: "remote" }] }));
  });
  const path = join(directory, "models.json");
  const original = `\uFEFF{\n// local configuration\n"providers":${JSON.stringify({
    catalog: {
      api: "openai-responses",
      baseUrl: url,
      apiKey: "test-key",
      modelCatalogUrl: url,
      models: [{ id: "manual" }],
      modelOverrides: { remote: { contextWindow: 672000 } },
      compat: { forceAdaptiveThinking: true },
    },
  })},\n}\n`;
  await writeFile(path, original);
  const runtime = await ModelRuntime.create({ modelsPath: path, refreshOnCreate: false });
  const pi = {
    registerProvider: runtime.registerNativeProvider.bind(runtime),
    on() {},
  } as unknown as ExtensionAPI;
  await extension(pi);
  assert.equal(await readFile(path, "utf8"), original);
  fail = true;
  await rm(join(directory, "models-cache.json"));
  t.mock.method(console, "error", () => {});
  await extension(pi);
  assert.equal(await readFile(path, "utf8"), original);
});

test("remote metadata cannot redirect model credentials or install request headers", async (t) => {
  const directory = await agentDirectory(t);
  const secret = "catalog-test-secret";
  let receivedCredential: string | undefined;
  const url = await serve(t, (request, response) => {
    if (request.method === "GET") {
      response.end(
        JSON.stringify({
          data: [
            {
              id: "remote",
              baseUrl: "https://untrusted.invalid",
              api: "unexpected-api",
              headers: { Authorization: "stolen" },
            },
          ],
        }),
      );
    } else {
      receivedCredential = request.headers.authorization;
      response.setHeader("Content-Type", "text/event-stream");
      response.end(
        'data: {"id":"chat-test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
    }
  });
  const path = join(directory, "models.json");
  await writeFile(
    path,
    JSON.stringify({
      providers: {
        catalog: { api: "openai-completions", baseUrl: url, apiKey: secret, modelCatalogUrl: url },
      },
    }),
  );
  const runtime = await ModelRuntime.create({ modelsPath: path, refreshOnCreate: false });
  await extension({
    registerProvider: runtime.registerNativeProvider.bind(runtime),
    on() {},
  } as unknown as ExtensionAPI);
  const model = runtime.getModel("catalog", "remote");
  if (!model) throw new Error("Catalog model was not loaded");
  await runtime.completeSimple(model, {
    messages: [{ role: "user", content: "Hello", timestamp: 0 }],
  });
  assert.equal(receivedCredential, `Bearer ${secret}`);
  const cache = await readFile(join(directory, "models-cache.json"), "utf8");
  assert.ok(!cache.includes(secret), "Configured credentials must not be persisted in the cache");
  assert.ok(!cache.includes("stolen"), "Remote authentication headers must not be persisted");
  assert.ok(!cache.includes("untrusted.invalid"), "Remote routing must not be persisted");
});

test("a cached model remains usable when the catalog endpoint becomes unavailable", async (t) => {
  const directory = await agentDirectory(t);
  let unavailable = false;
  let requestedModel: string | undefined;
  const url = await serve(t, (request, response) => {
    if (request.method === "GET") {
      response.end(unavailable ? "unavailable" : JSON.stringify({ data: [{ id: "cached" }] }));
    } else {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requestedModel = JSON.parse(body).model;
        response.setHeader("Content-Type", "text/event-stream");
        response.end(
          'data: {"id":"cached-chat","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        );
      });
    }
  });
  const path = join(directory, "models.json");
  await writeFile(
    path,
    JSON.stringify({
      providers: {
        catalog: { api: "openai-completions", baseUrl: url, apiKey: "test", modelCatalogUrl: url },
      },
    }),
  );
  async function load() {
    const runtime = await ModelRuntime.create({ modelsPath: path, refreshOnCreate: false });
    await extension({
      registerProvider: runtime.registerNativeProvider.bind(runtime),
      on() {},
    } as unknown as ExtensionAPI);
    return runtime;
  }
  await load();
  unavailable = true;
  t.mock.method(console, "error", () => {});
  const runtime = await load();
  const model = runtime.getModel("catalog", "cached");
  assert.ok(model, "The saved catalog must remain usable in a new runtime");
  await runtime.completeSimple(model, {
    messages: [{ role: "user", content: "Hello", timestamp: 0 }],
  });
  assert.equal(requestedModel, "cached");
});

test("catalog redirects cannot send configured credentials to another destination", async (t) => {
  let leakedCredential = false;
  const foreign = await serve(t, (request, response) => {
    leakedCredential ||= request.headers["x-catalog-secret"] !== undefined;
    response.end("[]");
  });
  const origin = await serve(t, (_request, response) => {
    response.writeHead(302, { Location: foreign });
    response.end();
  });
  await assert.rejects(
    fetchCatalog(
      new URL(origin),
      new Headers({ "x-catalog-secret": "secret" }),
      AbortSignal.timeout(5000),
    ),
  );
  assert.equal(leakedCredential, false);
});

test("invalid remote metadata cannot enter the model registry", () => {
  for (const entry of [
    null,
    { id: "bad", contextWindow: -1 },
    { id: "bad", context_length: -1 },
    { id: "bad", context_length: "258400" },
    { id: "bad", supports_reasoning: "true" },
    { id: "bad", thinkingLevelMap: { high: {} } },
  ]) {
    assert.throws(() =>
      parseCatalog([entry], "catalog", "openai-responses", "https://example.test"),
    );
  }
});

test("catalog metadata cannot inject terminal commands", () => {
  const controls = [
    "\u001b]52;c;cHJvYmU=\u0007",
    "\u009d52;c;cHJvYmU=\u009c",
    "\u001b[2J",
    "\u009b2J",
    "\rreplacement",
    "\nspoofed line",
    "\bhidden",
    "\t",
    "\u0000",
    "\u007f",
  ];
  for (const control of controls) {
    for (const entry of [
      { id: `remote${control}` },
      { id: "remote", name: `Remote${control}` },
      { slug: `remote${control}` },
      { slug: "remote", display_name: `Remote${control}` },
      { id: "remote", thinkingLevelMap: { high: `high${control}` } },
      { slug: "remote", supported_reasoning_levels: [{ effort: `high${control}` }] },
    ]) {
      assert.throws(() =>
        parseCatalog([entry], "catalog", "openai-responses", "https://example.test"),
      );
    }
  }
});

test("a short default model selects its catalog model without rewriting settings", async (t) => {
  const previousTitle = process.title;
  process.title = "pi";
  t.after(() => {
    process.title = previousTitle;
  });
  const directory = await agentDirectory(t);
  const url = await serve(t, (_request, response) => {
    response.end(
      JSON.stringify({
        data: [
          { id: "upstream/first-model" },
          {
            id: "upstream/preferred-model",
            reasoning: true,
            thinkingLevelMap: { high: "high", xhigh: "xhigh" },
          },
        ],
      }),
    );
  });
  const settingsPath = join(directory, "settings.json");
  const settings = JSON.stringify({
    defaultProvider: "catalog",
    defaultModel: "preferred-model",
    defaultThinkingLevel: "xhigh",
  });
  await writeFile(settingsPath, settings);
  await writeFile(
    join(directory, "models.json"),
    JSON.stringify({
      providers: {
        catalog: { api: "openai-responses", baseUrl: url, apiKey: "test", modelCatalogUrl: url },
      },
    }),
  );
  const services = await createAgentSessionServices({
    cwd: directory,
    agentDir: directory,
    resourceLoaderOptions: {
      additionalExtensionPaths: [join(import.meta.dirname, "../index.ts")],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(directory),
  });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: "print" });
  assert.equal(session.model?.id, "upstream/preferred-model");
  assert.equal(session.thinkingLevel, "xhigh");
  await services.settingsManager.flush();
  assert.equal(await readFile(settingsPath, "utf8"), settings);
});
