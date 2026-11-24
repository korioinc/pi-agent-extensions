import {
  getCurrentSystemMessage,
  getSystemMessageText,
  lazyStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Provider,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ResearchConfig } from "../runtime/index.ts";
import { LIMITS, modelOutputTokens } from "../runtime/limits.ts";
import type { SessionHooks } from "./index.ts";
import { HttpResponseResources } from "./http-resources.ts";
import { modelFailureEvidence, type ModelFailureEvidence } from "../runner/failure.ts";
import type { ModelRequestAdmission } from "../runner/budget.ts";

type ProviderHooks = Pick<
  SessionHooks,
  "signal" | "check" | "checkFast" | "exceeded" | "trackTransport" | "cleanupUnsafe"
> & {
  request(): ModelRequestAdmission;
  result?(message: AssistantMessage): void;
  summary?(): boolean;
};

const FETCH_WRAPPED_APIS = new Set([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
  "mistral-conversations",
  "pi-messages",
  "google-generative-ai",
  "google-vertex",
]);

/** Own parent requests through producer settlement and transport cleanup, not model accounting. */
export class ParentProvider {
  readonly provider: Provider;
  private tail: Promise<void> = Promise.resolve();
  private readonly abort = new AbortController();
  private closing?: Promise<void>;
  private stopped = false;
  private requestEvidence?: { requestIndex: number; httpStatus?: number };
  private readonly config: Pick<
    ResearchConfig,
    "model" | "thinkingLevel" | "stream" | "executionLimits"
  >;
  private readonly hooks: ProviderHooks;
  private readonly sessionId: string;

  constructor(
    config: Pick<ResearchConfig, "model" | "thinkingLevel" | "stream" | "executionLimits">,
    hooks: ProviderHooks,
    sessionId: string,
  ) {
    this.config = config;
    this.hooks = hooks;
    this.sessionId = sessionId;
    this.provider = {
      id: config.model.provider,
      name: "Parent Pi provider",
      auth: {
        apiKey: {
          name: "Parent-managed authentication",
          check: async () => ({ type: "api_key" }),
          resolve: async () => ({ auth: {} }),
        },
      },
      getModels: () => [config.model],
      stream: () => {
        throw new Error("Use the parent-managed streamSimple path.");
      },
      streamSimple: (_model, context, options) => this.stream(context, options),
    };
  }

  evidence(message: AssistantMessage): ModelFailureEvidence | undefined {
    const evidence = this.requestEvidence;
    return evidence && modelFailureEvidence(evidence.requestIndex, message, evidence.httpStatus);
  }

  private stream(context: TranscriptContext, options?: SimpleStreamOptions) {
    if (this.stopped)
      return lazyStream(this.config.model, async () => {
        throw new Error("Child provider is closed.");
      });
    const previous = this.tail;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    const owned: {
      promise: Promise<void>;
      resolve(): void;
      reject(error: unknown): void;
      result?: AssistantMessage;
    } = { promise, resolve, reject };
    // Reserve before lazyStream starts setup. Overlapping entries cannot share the same gate.
    this.tail = owned.promise;
    void owned.promise.catch(() => {});
    this.hooks.trackTransport(owned.promise);
    return lazyStream(this.config.model, async () =>
      Object.assign(this.request(context, options, previous, owned), {
        // Some providers use end(message) without a terminal event. Preserve SDK result fallback.
        result: async () => {
          await owned.promise;
          if (!owned.result) throw new Error("Parent provider ended without a result.");
          return owned.result;
        },
      }),
    );
  }

  private async *request(
    context: TranscriptContext,
    options: SimpleStreamOptions | undefined,
    previous: Promise<void>,
    owned: { resolve(): void; reject(error: unknown): void; result?: AssistantMessage },
  ): AsyncGenerator<AssistantMessageEvent> {
    const { config, hooks } = this;
    const requestAbort = new AbortController();
    const signal = AbortSignal.any([
      hooks.signal,
      this.abort.signal,
      requestAbort.signal,
      ...(options?.signal ? [options.signal] : []),
    ]);
    const resources = new HttpResponseResources(undefined, () => hooks.cleanupUnsafe());
    let receivedBytes = 0;
    let wireBytes = 0;
    let sourceCleanup: Promise<void> | undefined;
    let unsafe: Error | undefined;
    const closeReaders = () => {
      requestAbort.abort();
      return resources.close();
    };
    try {
      try {
        await previous;
      } catch (error) {
        unsafe = new Error("Previous provider cleanup is unconfirmed.", { cause: error });
        throw unsafe;
      }
      this.requestEvidence = undefined;
      signal.throwIfAborted();
      hooks.check();
      const system = getCurrentSystemMessage(context.messages);
      if (
        system &&
        Buffer.byteLength(getSystemMessageText(system)) +
          Buffer.byteLength(JSON.stringify(system.toolsAdded ?? [])) >
          LIMITS.promptBytes
      )
        hooks.exceeded("prompt and tools");
      const summary = hooks.summary?.() ?? false;
      const admission = hooks.request();
      const requestEvidence: { requestIndex: number; httpStatus?: number } = {
        requestIndex: admission.requestIndex,
      };
      const remainingMs = Math.floor(admission.remainingMs);
      if (remainingMs <= 0) throw new Error("Model request deadline has expired.");
      this.requestEvidence = requestEvidence;
      const maxTokens = summary ? LIMITS.safeguardTokens : config.executionLimits.maxOutputTokens;
      const requestOptions: SimpleStreamOptions = {
        maxTokens: modelOutputTokens(maxTokens, config.model),
        reasoning: summary || config.thinkingLevel === "off" ? undefined : config.thinkingLevel,
        sessionId: this.sessionId,
        transport: "sse",
        maxRetries: 0,
        timeoutMs: Math.min(
          remainingMs,
          summary ? LIMITS.safeguardSummaryMs : config.executionLimits.invocationMs,
        ),
        signal,
        onResponse: (response) => {
          requestEvidence.httpStatus = response.status;
        },
        fetch: FETCH_WRAPPED_APIS.has(config.model.api)
          ? (input, init) =>
              resources.acquire(async () => {
                signal.throwIfAborted();
                const fetchSignal = AbortSignal.any([
                  signal,
                  ...(init?.signal ? [init.signal] : []),
                ]);
                const response = await globalThis.fetch(input, {
                  ...init,
                  signal: fetchSignal,
                });
                requestEvidence.httpStatus = response.status;
                if (!response.body) return response;
                const body = resources.wrapBody(response.body, fetchSignal, (bytes) => {
                  wireBytes += bytes;
                  if (wireBytes > LIMITS.providerResponseBytes)
                    hooks.exceeded("provider wire output");
                });
                return new Response(body, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                });
              })
          : undefined,
        // An unset preference leaves retention to the parent's provider default/environment.
        // Prompt caching is independent of our SSE transport and owned reader cleanup.
        cacheRetention: options?.cacheRetention,
        onProviderStreamEvent: (event) => {
          if (hooks.checkFast) hooks.checkFast();
          else hooks.check();
          receivedBytes += Buffer.byteLength(JSON.stringify(event));
          // Bound inbound response processing, not outgoing context or image data.
          if (receivedBytes > LIMITS.providerResponseBytes) hooks.exceeded("provider output");
        },
      };
      const source = config.stream(config.model, context, requestOptions);
      // Start reader cleanup at result settlement, even if the producer has not ended iteration.
      sourceCleanup = source
        .result()
        .then((message) => {
          owned.result = message;
          hooks.result?.(message);
        })
        .finally(closeReaders);
      void sourceCleanup.catch(() => {});
      yield* source;
    } finally {
      try {
        if (sourceCleanup) await sourceCleanup;
        else await closeReaders();
      } catch (error) {
        unsafe ??= new Error("Parent provider cleanup is unconfirmed.", { cause: error });
      }
      if (unsafe !== undefined) {
        hooks.cleanupUnsafe();
        owned.reject(unsafe);
      } else owned.resolve();
    }
  }

  async idle(): Promise<void> {
    await this.tail;
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.stopped = true;
      this.abort.abort();
      this.closing = this.tail;
    }
    return this.closing;
  }
}
