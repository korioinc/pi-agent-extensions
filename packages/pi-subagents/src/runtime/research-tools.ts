import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export class ToolCleanupError extends Error {
  constructor(path: string, cause: unknown) {
    super(`Cannot establish local tool handle closure: ${path}`, { cause });
    this.name = "ToolCleanupError";
  }
}

async function closeHandle(handle: { close(): Promise<void> }, path: string): Promise<void> {
  try {
    await handle.close();
  } catch (error) {
    throw new ToolCleanupError(path, error);
  }
}

const MAX_READ_BYTES = 64 * 1024;
const MAX_DIRECTORY_ENTRIES = 200;

function requireInside(root: string, path: string): void {
  const part = relative(root, path);
  if (isAbsolute(part) || part === ".." || part.startsWith(`..${sep}`)) {
    throw new Error("Path is outside the research root.");
  }
}

function requireInteger(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
}

function requireSameFile(expected: BigIntStats, actual: BigIntStats): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino)
    throw new Error("Research path changed during access.");
}

/**
 * Read-only filesystem tools, not an OS sandbox. Reads reject observed identity
 * and canonical-path changes before exposing bytes. Pathname checks are not an
 * atomic boundary against hostile ancestor races; listings are not snapshots.
 */
export async function createResearchTools(
  root: string,
  signal?: AbortSignal,
): Promise<ToolDefinition[]> {
  signal?.throwIfAborted();
  const canonicalRoot = await fs.realpath(root);
  signal?.throwIfAborted();
  const rootStat = await fs.stat(canonicalRoot, { bigint: true });
  signal?.throwIfAborted();
  if (!rootStat.isDirectory()) throw new Error("Research root must be a directory.");

  async function resolveInside(path: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (
      typeof path !== "string" ||
      !path ||
      path.includes("\0") ||
      path.split(sep).includes("..")
    ) {
      throw new Error("Provide a nonempty path without NUL or '..' components.");
    }
    const requested = resolve(canonicalRoot, path);
    requireInside(canonicalRoot, requested);
    const canonical = await fs.realpath(requested);
    signal?.throwIfAborted();
    requireInside(canonicalRoot, canonical);
    return canonical;
  }

  async function verifyOpenedPath(
    canonical: string,
    opened: BigIntStats,
    signal?: AbortSignal,
  ): Promise<void> {
    const current = await fs.realpath(canonical);
    signal?.throwIfAborted();
    requireInside(canonicalRoot, current);
    if (current !== canonical) throw new Error("Research path changed during access.");
    const currentFile = await fs.stat(current, { bigint: true });
    signal?.throwIfAborted();
    requireSameFile(opened, currentFile);
    const currentRoot = await fs.stat(canonicalRoot, { bigint: true });
    signal?.throwIfAborted();
    requireSameFile(rootStat, currentRoot);
  }

  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  return [
    defineTool({
      name: "read_text",
      label: "Read text",
      description:
        "Read a UTF-8 regular file within the research root, at a byte offset. " +
        "Reads at most 64 KiB, rejects invalid UTF-8 and binary control bytes in the selected window. " +
        "Use nextOffset when truncated; offsets must start at a UTF-8 boundary. " +
        "A limit too small for the first character must be increased.",
      annotations,
      parameters: Type.Object({
        path: Type.String({ minLength: 1, description: "Path within the research root." }),
        offset: Type.Optional(
          Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - MAX_READ_BYTES }),
        ),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_BYTES })),
      }),
      async execute(_id, { path, offset = 0, limit = MAX_READ_BYTES }, signal) {
        signal?.throwIfAborted();
        requireInteger(offset, "offset", 0, Number.MAX_SAFE_INTEGER - MAX_READ_BYTES);
        requireInteger(limit, "limit", 1, MAX_READ_BYTES);
        const canonical = await resolveInside(path, signal);
        signal?.throwIfAborted();
        const before = await fs.stat(canonical, { bigint: true });
        signal?.throwIfAborted();
        if (!before.isFile()) throw new Error("read_text requires a regular file.");

        // Nonblocking open also prevents a replacement FIFO from blocking before fstat.
        const file = await fs.open(
          canonical,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          signal?.throwIfAborted();
          const info = await file.stat({ bigint: true });
          signal?.throwIfAborted();
          if (!info.isFile()) throw new Error("read_text requires a regular file.");
          requireSameFile(before, info);
          await verifyOpenedPath(canonical, info, signal);
          const buffer = Buffer.alloc(limit);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
          signal?.throwIfAborted();
          const more = bytesRead > 0 && offset + bytesRead < info.size;
          let text: string;
          try {
            // Streaming leaves an incomplete final character for the next byte window.
            text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
              buffer.subarray(0, bytesRead),
              { stream: more },
            );
          } catch {
            throw new Error(
              "Selected bytes are not valid UTF-8; offset must start at a character boundary.",
            );
          }
          for (const character of text) {
            const code = character.codePointAt(0)!;
            if (
              (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
              (code >= 127 && code <= 159)
            ) {
              throw new Error("Binary control bytes are not supported by read_text.");
            }
          }
          const consumed = Buffer.byteLength(text, "utf8");
          if (more && consumed === 0)
            throw new Error("Increase limit to fit the first UTF-8 character.");
          const truncated = more;
          const details = {
            path: relative(canonicalRoot, canonical),
            offset,
            bytesRead: consumed,
            nextOffset: truncated ? offset + consumed : null,
            truncated,
          };
          return {
            content: [{ type: "text", text: `${JSON.stringify(details)}\n${text}` }],
            details,
          };
        } finally {
          await closeHandle(file, canonical);
          signal?.throwIfAborted();
        }
      },
    }),
    defineTool({
      name: "list_files",
      label: "List files",
      description:
        "List only regular files and directories directly within a directory under the research root. " +
        "No recursion, sorting or symlink following. Scans at most 200 entries, including skipped entries. " +
        "truncated means the scan limit was reached; more entries may exist. No pagination cursor.",
      annotations,
      parameters: Type.Object({
        path: Type.Optional(
          Type.String({
            minLength: 1,
            description: "Directory within the research root; defaults to '.'.",
          }),
        ),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_DIRECTORY_ENTRIES })),
      }),
      async execute(_id, { path = ".", limit = MAX_DIRECTORY_ENTRIES }, signal) {
        signal?.throwIfAborted();
        requireInteger(limit, "limit", 1, MAX_DIRECTORY_ENTRIES);
        const canonical = await resolveInside(path, signal);
        signal?.throwIfAborted();
        const info = await fs.stat(canonical);
        signal?.throwIfAborted();
        if (!info.isDirectory()) throw new Error("list_files requires a directory.");

        // One buffered entry keeps the underlying directory scan bounded too.
        const directory = await fs.opendir(canonical, { bufferSize: 1 });
        try {
          signal?.throwIfAborted();
          const entries: { name: string; type: "file" | "directory" }[] = [];
          let scanned = 0;
          while (scanned < limit) {
            const entry = await directory.read();
            signal?.throwIfAborted();
            if (entry === null) break;
            scanned++;
            if (entry.isFile()) entries.push({ name: entry.name, type: "file" });
            else if (entry.isDirectory()) entries.push({ name: entry.name, type: "directory" });
          }
          const details = {
            path: relative(canonicalRoot, canonical) || ".",
            entries,
            scanned,
            truncated: scanned === limit,
          };
          return { content: [{ type: "text", text: JSON.stringify(details) }], details };
        } finally {
          await closeHandle(directory, canonical);
          signal?.throwIfAborted();
        }
      },
    }),
  ];
}
