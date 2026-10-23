/** Own HTTP acquisitions and bodies without deciding the enclosing request or transport lifetime. */
export class HttpResponseResources {
  private readonly acquiring = new Set<Promise<Response>>();
  private readonly readers = new Set<() => Promise<void>>();
  private readonly cleanupErrors: unknown[] = [];
  private readonly mapError: (error: unknown) => unknown;
  private closing?: Promise<void>;

  constructor(mapError: (error: unknown) => unknown = (error) => error) {
    this.mapError = mapError;
  }

  /** Wrap an acquired body before this operation settles, including a response arriving during close. */
  acquire(operation: () => Promise<Response>): Promise<Response> {
    const acquisition = Promise.resolve().then(() => {
      if (this.closing) throw this.mapError(new Error("HTTP response owner is closed."));
      return operation();
    });
    this.acquiring.add(acquisition);
    const settled = () => this.acquiring.delete(acquisition);
    void acquisition.then(settled, settled);
    return acquisition;
  }

  wrapBody(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    onChunk: (bytes: number) => void,
  ): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    const closed = reader.closed;
    void closed.catch(() => {});
    let reading: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
    let closing: Promise<void> | undefined;
    let released = false;
    let output: ReadableStreamDefaultController<Uint8Array>;
    const release = () => {
      if (released) return;
      try {
        reader.releaseLock();
      } catch (error) {
        const failure = this.mapError(error);
        this.cleanupErrors.push(failure);
        throw failure;
      } finally {
        released = true;
        this.readers.delete(stop);
        signal.removeEventListener("abort", onAbort);
      }
    };
    const cancel = (reason?: unknown): Promise<void> => {
      if (released) return closing ?? Promise.resolve();
      closing ??= (async () => {
        try {
          const [cancellation, closure] = await Promise.allSettled([
            Promise.resolve().then(() => reader.cancel(reason)),
            closed,
            ...(reading ? [reading] : []),
          ]);
          // Compare original errors before redaction. An errored stream rethrows its
          // stored error; a failed source cancellation instead leaves closed fulfilled.
          if (
            cancellation.status === "rejected" &&
            (closure.status !== "rejected" || !Object.is(cancellation.reason, closure.reason))
          )
            throw cancellation.reason;
        } catch (error) {
          const failure = this.mapError(error);
          this.cleanupErrors.push(failure);
          throw failure;
        } finally {
          release();
        }
      })();
      return closing;
    };
    const stopped = () => signal.reason ?? new Error("HTTP response owner is closed.");
    const stop = () => {
      const cleanup = cancel();
      // Closing the owner must also settle a consumer's pending read without an extra abort step.
      output.error(this.mapError(stopped()));
      return cleanup;
    };
    const onAbort = () => {
      // The consumer may catch body errors; owner close must still retain failed cleanup.
      void stop().catch(() => {});
    };
    this.readers.add(stop);
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          output = controller;
        },
        pull: async (controller) => {
          try {
            if (closing || this.closing || signal.aborted) throw stopped();
            reading = reader.read();
            const { done, value } = await reading;
            reading = undefined;
            if (closing) return;
            if (done) {
              release();
              controller.close();
              return;
            }
            onChunk(value.byteLength);
            if (closing || this.closing || signal.aborted) throw stopped();
            controller.enqueue(value);
          } catch (error) {
            try {
              await cancel();
            } finally {
              controller.error(this.mapError(error));
            }
          }
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    signal.addEventListener("abort", onAbort, { once: true });
    // An already-owned acquisition may return a body after close sealed new work.
    if (signal.aborted || this.closing) onAbort();
    return stream;
  }

  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      while (this.acquiring.size || this.readers.size) {
        await Promise.allSettled([...this.acquiring, ...[...this.readers].map((stop) => stop())]);
      }
      if (this.cleanupErrors.length)
        throw new AggregateError(this.cleanupErrors, "HTTP response cleanup failed.");
    });
    return this.closing;
  }
}
