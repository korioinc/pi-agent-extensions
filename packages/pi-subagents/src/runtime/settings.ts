import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { LIMITS } from "./limits.ts";

/** One generation uses one user-owned capacity snapshot; project settings cannot override it. */
export function loadSettings(): { maxConcurrentRuns: number } {
  const path = join(getAgentDir(), "sub-agents.json");
  let source: string;
  try {
    const file = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = fstatSync(file);
      if (!info.isFile()) throw new Error("Subagent settings must be a regular file.");
      if (info.size > LIMITS.instructionBytes)
        throw new Error(`Subagent settings exceed ${LIMITS.instructionBytes} bytes.`);
      const buffer = Buffer.alloc(LIMITS.instructionBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const bytesRead = readSync(file, buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > LIMITS.instructionBytes)
        throw new Error(`Subagent settings exceed ${LIMITS.instructionBytes} bytes.`);
      source = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
    } finally {
      closeSync(file);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { maxConcurrentRuns: LIMITS.runs };
    throw new Error(`Cannot read subagent settings: ${path}`, { cause: error });
  }
  let settings: unknown;
  try {
    settings = JSON.parse(source.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Invalid JSON in subagent settings: ${path}`, { cause: error });
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new Error(`${path}: settings must be a JSON object.`);
  if (Object.keys(settings).some((key) => key !== "maxConcurrentRuns"))
    throw new Error(`${path}: only "maxConcurrentRuns" is supported.`);
  const value = "maxConcurrentRuns" in settings ? settings.maxConcurrentRuns : LIMITS.runs;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > LIMITS.retainedAgents
  )
    throw new Error(
      `${path}: "maxConcurrentRuns" must be an integer between 1 and ${LIMITS.retainedAgents}.`,
    );
  return { maxConcurrentRuns: value };
}
