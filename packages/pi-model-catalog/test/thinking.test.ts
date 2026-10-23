import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  initTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Component } from "@earendil-works/pi-tui";
import { registerModelPicker } from "../thinking.ts";
import { parseCatalog } from "../catalog.ts";

function harness(
  provider = "catalog",
  initialLevel = "medium",
  map: Record<string, string | null> = {
    low: null,
    medium: "medium",
    high: "high",
    max: "max",
  },
) {
  initTheme("dark", false);
  const model = parseCatalog(
    [
      {
        id: "original",
        name: "Original",
        reasoning: true,
        thinkingLevelMap: map,
      },
    ],
    provider,
    "openai-responses",
    "https://example.test",
  )[0]!;
  let currentModel = model;
  let currentLevel = initialLevel;
  let text = "";
  let input: (data: string) => unknown = () => {};
  let dialog: Component | undefined;
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const ctx = {
    mode: "tui",
    hasUI: true,
    scopedModels: [],
    get model() {
      return currentModel;
    },
    isIdle: () => true,
    modelRegistry: {
      refresh: async () => {},
      getAvailable: () => [model, { ...model, id: "other", name: "Alternative" }],
    },
    ui: {
      addAutocompleteProvider() {},
      notify() {},
      getEditorText: () => text,
      setEditorText: (value: string) => {
        text = value;
      },
      onTerminalInput: (callback: typeof input) => {
        input = callback;
        return () => {};
      },
      custom: async (factory: Function) =>
        new Promise((resolve) => {
          dialog = factory(
            { terminal: { rows: 24 }, requestRender() {} },
            { fg: (_color: string, value: string) => value },
            getKeybindings(),
            (value: unknown) => {
              dialog = undefined;
              resolve(value);
            },
          );
        }),
    },
  } as unknown as ExtensionContext;
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) =>
      handlers.set(event, handler),
    getThinkingLevel: () => currentLevel,
    setThinkingLevel: (level: string) => {
      currentLevel = level;
    },
    setModel: async (next: Model<Api>) => {
      currentModel = next;
      return true;
    },
  } as unknown as ExtensionAPI;
  registerModelPicker(pi, new Map([["catalog", "openai-responses"]]), async () => {});
  handlers.get("session_start")!({}, ctx);
  return {
    model,
    current: () => ({ model: currentModel.id, level: currentLevel }),
    submit(command: string) {
      text = command;
      input("\r");
    },
    async key(data: string) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (!dialog) throw new Error("No active selection dialog");
      dialog.handleInput?.(data);
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    async settled() {
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

test("back from thinking preserves current settings and lets the user complete model selection", async () => {
  const h = harness();
  const previous = h.current();
  h.submit("/model");
  await h.key("\x1b[B");
  await h.key("\r");
  await h.key("\x1b");
  assert.deepEqual(h.current(), previous);
  await h.key("\r");
  await h.key("\x1b[B");
  await h.key("\r");
  assert.deepEqual(h.current(), { model: "other", level: "high" });
});

test("model search accepts a display name without a provider prefix", async () => {
  const h = harness();
  h.submit("/model Alternative");
  await h.key("\r");
  await h.key("\r");
  assert.equal(h.current().model, "other");
});

test("native providers retain implicit supported thinking levels with partial maps", async () => {
  const h = harness("native", "high", { off: null, max: "max" });
  h.submit("/thinking medium");
  await h.settled();
  assert.equal(h.current().level, "medium");
});

test("a manual model with a different API can still select native thinking levels", async () => {
  const h = harness("catalog", "high", { max: "max" });
  h.model.api = "openai-completions";
  h.submit("/thinking medium");
  await h.settled();
  assert.equal(h.current().level, "medium");
});
