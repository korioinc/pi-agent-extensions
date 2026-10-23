import { constants, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { LIMITS } from "./limits.ts";

const DIRECTORY_BATCH_SIZE = 32;
const FRONTMATTER_READ_BYTES = 512;

export class PreparationLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreparationLimitError";
  }
}

export class PreparationSafetyError extends Error {
  constructor(path: string, closeError: unknown, operationError?: unknown) {
    super(`Cannot establish preparation handle closure: ${path}`, {
      cause:
        operationError === undefined
          ? closeError
          : new AggregateError([operationError, closeError]),
    });
    this.name = "PreparationSafetyError";
  }
}

export function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function frontmatterEnd(buffer: Buffer, length: number): number | undefined {
  const bom = buffer[0] === 0xef;
  const prefix = bom ? [0xef, 0xbb, 0xbf, 45, 45, 45] : [45, 45, 45];
  for (let index = 0; index < Math.min(length, prefix.length); index++) {
    if (buffer[index] !== prefix[index]) return undefined;
  }
  // Match the SDK's normalized newline + "---", including CRLF and bare CR.
  for (let index = bom ? 6 : 3; index + 3 < length; index++) {
    if (
      (buffer[index] === 10 || buffer[index] === 13) &&
      buffer[index + 1] === 45 &&
      buffer[index + 2] === 45 &&
      buffer[index + 3] === 45
    )
      return index + 4;
  }
  return 0;
}

/** One invocation owns filesystem work until every opened handle closes. */
export class Preparation {
  private roots = new Set<string>();
  private directories = new Set<string>();
  private files = new Set<string>();
  private entries = 0;
  private bytes = 0;
  private unsafe?: PreparationSafetyError;

  private signal: AbortSignal;
  private deadline: number;

  constructor(signal: AbortSignal, deadline: number) {
    this.signal = signal;
    this.deadline = deadline;
  }

  check(): void {
    if (this.unsafe) throw this.unsafe;
    this.signal.throwIfAborted();
    if (performance.now() >= this.deadline)
      throw new PreparationLimitError("Preparation deadline exceeded.");
  }

  async io<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    try {
      return await operation();
    } finally {
      this.check();
    }
  }

  async yield(): Promise<void> {
    await this.io(() => setImmediate());
  }

  /** Missing defaults consume configured-root budget; canonical aliases do not. */
  async root(path: string): Promise<string | undefined> {
    let canonical: string | undefined;
    try {
      canonical = await this.io(() => fs.realpath(path));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    this.roots.add(canonical ?? resolve(path));
    if (this.roots.size > LIMITS.preparationRoots)
      throw new PreparationLimitError(
        `Preparation roots exceed ${LIMITS.preparationRoots}: ${path}`,
      );
    return canonical;
  }

  async visitDirectory(path: string, depth: number): Promise<boolean> {
    const canonical = await this.io(() => fs.realpath(path));
    if (this.directories.has(canonical)) return false;
    if (depth > LIMITS.preparationDepth)
      throw new PreparationLimitError(
        `Preparation depth exceeds ${LIMITS.preparationDepth}: ${path}`,
      );
    this.directories.add(canonical);
    await this.yield();
    return true;
  }

  async visitFile(path: string): Promise<boolean> {
    const canonical = await this.io(() => fs.realpath(path));
    if (this.files.has(canonical)) return false;
    this.files.add(canonical);
    return true;
  }

  private async close(
    handle: { close(): Promise<void> },
    path: string,
    failure: unknown,
  ): Promise<void> {
    try {
      await handle.close();
    } catch (error) {
      this.unsafe = new PreparationSafetyError(path, error, failure ?? this.unsafe);
      throw this.unsafe;
    }
    this.check();
  }

  async *directory(path: string): AsyncGenerator<Dirent> {
    this.check();
    const handle = await fs.opendir(path, { bufferSize: DIRECTORY_BATCH_SIZE });
    let failure: unknown;
    try {
      this.check();
      for (;;) {
        const entry = await this.io(() => handle.read());
        if (entry === null) return;
        if (++this.entries > LIMITS.preparationEntries)
          throw new PreparationLimitError(
            `Preparation entries exceed ${LIMITS.preparationEntries}: ${path}`,
          );
        if (this.entries % DIRECTORY_BATCH_SIZE === 0) await this.yield();
        yield entry;
      }
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await this.close(handle, path, failure);
    }
  }

  async read(path: string, noFollow = false): Promise<string> {
    return this.acquire(path, noFollow, false);
  }

  /** Candidate size is bounded before reading; only the YAML header is returned. */
  async readFrontmatter(path: string): Promise<string> {
    return this.acquire(path, false, true);
  }

  private async acquire(
    path: string,
    noFollow: boolean,
    frontmatterOnly: boolean,
  ): Promise<string> {
    this.check();
    const flags = constants.O_RDONLY | constants.O_NONBLOCK | (noFollow ? constants.O_NOFOLLOW : 0);
    // Acquiring handles cannot use io(): its post-await check could lose the handle.
    const handle = await fs.open(path, flags);
    let failure: unknown;
    try {
      this.check();
      const stat = await this.io(() => handle.stat());
      if (!stat.isFile()) throw new Error(`Instruction path must be a regular file: ${path}`);
      const oversized = () =>
        new PreparationLimitError(
          `Instruction file exceeds ${LIMITS.instructionBytes} bytes: ${path}`,
        );
      if (stat.size > LIMITS.instructionBytes) throw oversized();
      if (!frontmatterOnly && stat.size > LIMITS.preparationBytes - this.bytes)
        throw new PreparationLimitError(`Preparation byte budget exceeded: ${path}`);
      const maximum = LIMITS.instructionBytes + 1;
      // Header discovery need not reserve space for an unselected skill's body.
      let buffer = Buffer.alloc(
        Math.min(maximum, stat.size + 1, frontmatterOnly ? FRONTMATTER_READ_BYTES : maximum),
      );
      let length = 0;
      while (length < maximum) {
        this.check();
        // Stat is only an initial size estimate. Keep reading growing files up to
        // the same overflow sentinel instead of treating a full buffer as EOF.
        if (length === buffer.length) {
          const grown = Buffer.alloc(Math.min(maximum, buffer.length * 2));
          buffer.copy(grown, 0, 0, length);
          buffer = grown;
        }
        const available = Math.min(
          buffer.length - length,
          LIMITS.preparationBytes - this.bytes + 1,
          frontmatterOnly ? (length < 6 ? 6 - length : FRONTMATTER_READ_BYTES) : buffer.length,
        );
        const { bytesRead } = await handle.read(buffer, length, available, null);
        this.bytes += bytesRead;
        this.check();
        if (this.bytes > LIMITS.preparationBytes)
          throw new PreparationLimitError(`Preparation byte budget exceeded: ${path}`);
        if (bytesRead === 0) break;
        length += bytesRead;
        if (length > LIMITS.instructionBytes) throw oversized();
        if (frontmatterOnly) {
          const end = frontmatterEnd(buffer, length);
          if (end === undefined) return "";
          if (end > 0)
            return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, end));
        }
      }
      if (frontmatterOnly) return "";
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      // No Promise.race: cancellation never abandons pending work or handle cleanup.
      await this.close(handle, path, failure);
    }
  }
}
