import { randomUUID } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export type Mode = "fast" | "ultrafast";

export type Settings = {
  fast: {
    enabled: boolean;
    serviceTier: "priority";
    supportedModels: string[];
    [key: string]: unknown;
  };
  ultrafast: {
    enabled: boolean;
    serviceTier: "ultrafast";
    supportedModels: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

function validateSettings(value: unknown): asserts value is Settings {
  if (!isObject(value)) throw new Error("Service-tier settings must be a JSON object");
  for (const [mode, tier] of [
    ["fast", "priority"],
    ["ultrafast", "ultrafast"],
  ] as const) {
    const section = value[mode];
    if (
      !isObject(section) ||
      typeof section.enabled !== "boolean" ||
      section.serviceTier !== tier
    ) {
      throw new Error(
        `Invalid ${mode} settings: enabled must be a boolean and serviceTier must be ${tier}`,
      );
    }
    if (
      !Array.isArray(section.supportedModels) ||
      !section.supportedModels.every(
        (model: unknown) =>
          typeof model === "string" && model.slice(model.lastIndexOf("/") + 1).trim().length > 0,
      )
    ) {
      throw new Error(
        `Invalid ${mode} supportedModels: expected model IDs with a nonempty final segment`,
      );
    }
  }
}

function readSettings(path: string): Settings {
  const settings: unknown = JSON.parse(readFileSync(path, "utf8"));
  validateSettings(settings);
  return settings;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function saveSettings(path: string, settings: Settings, replace: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  try {
    try {
      writeFileSync(descriptor, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    } finally {
      closeSync(descriptor);
    }
    if (replace) renameSync(temporaryPath, path);
    else linkSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function loadSettings(path: string): Settings {
  try {
    return readSettings(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }

  const settings: Settings = {
    fast: {
      enabled: false,
      serviceTier: "priority",
      supportedModels: [
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-6-astra",
        "gpt-6-sol",
        "gpt-6-luna",
        "gpt-6.1-sol",
      ],
    },
    ultrafast: {
      enabled: false,
      serviceTier: "ultrafast",
      supportedModels: ["gpt-6-astra", "gpt-6.1-sol"],
    },
  };
  try {
    saveSettings(path, settings, false);
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  return readSettings(path);
}

export function setModeEnabled(path: string, mode: Mode, enabled: boolean): Settings {
  const settings = loadSettings(path);
  settings[mode].enabled = enabled;
  // shortcut: concurrent updates use last completed save; add locking if serialized updates are required.
  saveSettings(path, settings, true);
  return settings;
}

export function disableAllModes(path: string): Settings {
  const settings = loadSettings(path);
  settings.fast.enabled = false;
  settings.ultrafast.enabled = false;
  saveSettings(path, settings, true);
  return settings;
}
