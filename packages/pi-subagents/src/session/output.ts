import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { copyOutputText, type OutputUpdate } from "../runtime/output.ts";

const PRESENTATION_INTERVAL_MS = 100;

type PendingOutput = { type: "replace" } | { type: "append"; chunks: string[] };

interface ResponseEvidence {
  text: string;
  failure?: string;
  stopReason?: AssistantMessage["stopReason"];
  toolCall: boolean;
}

/** Own response evidence and private replacements from native SDK events, never execution safety. */
export class AssistantOutput {
  private retained: ResponseEvidence = { text: "", toolCall: false };
  private candidate?: ResponseEvidence;
  private blocks?: (string | undefined)[];
  private lastIndex = -1;
  private meaningful = false;
  private published = false;
  private pending?: PendingOutput;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private readonly publish: (update: OutputUpdate) => void;

  constructor(publish: (update: OutputUpdate) => void) {
    this.publish = publish;
  }

  get text(): string {
    return this.retained.text;
  }

  get error(): string | undefined {
    return (
      this.retained.failure ??
      (this.retained.stopReason === "length"
        ? "Model output limit reached (length); the answer is incomplete."
        : undefined)
    );
  }

  observe(event: AgentSessionEvent): void {
    if (this.closed) return;
    if (event.type === "message_start" && event.message.role === "assistant") this.begin();
    if (
      (event.type !== "message_update" && event.type !== "message_end") ||
      event.message.role !== "assistant"
    )
      return;
    const evidence = this.candidate ?? this.retained;
    if (event.type === "message_end") {
      this.finish(event.message);
      evidence.stopReason = event.message.stopReason;
      if (this.candidate)
        evidence.toolCall ||= event.message.content.some((block) => block.type === "toolCall");
      if (event.message.stopReason === "error" || event.message.stopReason === "aborted")
        evidence.failure ??=
          event.message.errorMessage ?? `Model stopped: ${event.message.stopReason}`;
    } else {
      const update = event.assistantMessageEvent;
      if (
        update.type === "text_start" ||
        update.type === "text_delta" ||
        update.type === "text_end"
      )
        this.update(
          event.message,
          update.contentIndex,
          update.type === "text_delta" ? update.delta : undefined,
        );
      if (this.candidate && update.type.startsWith("toolcall_")) evidence.toolCall = true;
    }
  }

  /** Stage text privately; the caller checks execution safety immediately before publication. */
  async replaceWith(
    produce: (retainedText: string) => Promise<void>,
    accept: () => boolean,
  ): Promise<boolean> {
    if (this.closed || this.candidate !== undefined) return false;
    this.flush();
    const candidate: ResponseEvidence = { text: "", toolCall: false };
    this.candidate = candidate;
    try {
      await produce(this.retained.text);
      this.flush();
      if (
        this.closed ||
        !accept() ||
        candidate.failure ||
        candidate.stopReason !== "stop" ||
        candidate.toolCall ||
        !candidate.text.trim()
      )
        return false;
      // Publish before committing so a failed publisher cannot erase retained evidence.
      this.publish({ type: "replace", text: candidate.text });
      this.retained = candidate;
      return true;
    } finally {
      // Flush while still private, then discard reconciliation state and candidate text.
      this.begin();
      this.candidate = undefined;
    }
  }

  private begin(): void {
    if (this.closed) return;
    this.flush();
    this.blocks = undefined;
    this.lastIndex = -1;
    this.meaningful = false;
    this.published = false;
  }

  private update(message: AssistantMessage, contentIndex: number, delta?: string): void {
    if (this.closed) return;
    const block = message.content[contentIndex];
    if (block?.type !== "text") return;
    const previous = this.blocks?.[contentIndex];
    // A valid native delta appends within its block. Inspect lengths only: comparing
    // cumulative prefixes (or flattening ropes) here would restore quadratic work.
    const suffix =
      this.blocks &&
      contentIndex === this.lastIndex &&
      previous !== undefined &&
      delta !== undefined &&
      previous.length + delta.length === block.text.length
        ? delta
        : this.blocks && previous === undefined && contentIndex > this.lastIndex
          ? `\n${block.text}`
          : undefined;
    if (suffix !== undefined) {
      this.blocks![contentIndex] = block.text;
      this.lastIndex = contentIndex;
      this.meaningful ||= suffix.trim().length > 0;
      if (!this.published) this.pending = { type: "replace" };
      else if (this.pending?.type !== "replace") {
        this.pending ??= { type: "append", chunks: [] };
        this.pending.chunks.push(suffix);
      }
    } else {
      if (previous === block.text) return;
      this.replace(message);
    }
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), PRESENTATION_INTERVAL_MS);
    this.timer.unref();
  }

  private finish(message: AssistantMessage): void {
    if (this.closed) return;
    // An empty error/tool-only final must not discard a still-pending useful partial.
    this.flush();
    const changed =
      !this.blocks ||
      message.content.some(
        (block, index) => (block.type === "text" ? block.text : undefined) !== this.blocks![index],
      ) ||
      this.blocks.some(
        (text, index) => text !== undefined && message.content[index]?.type !== "text",
      );
    if (changed) {
      this.replace(message);
      // In particular, a private summary's empty final must invalidate its partial.
      this.flush(true);
    }
    this.blocks = undefined;
  }

  flush(final = false): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const pending = this.pending;
    this.pending = undefined;
    if (!pending || !this.blocks) return;
    if (pending.type === "replace") {
      if (this.meaningful || this.published || final)
        this.emit({
          type: "replace",
          text: this.blocks.filter((text) => text !== undefined).join("\n"),
        });
      this.published = this.meaningful;
    } else if (pending.chunks.length) {
      this.emit({ type: "append", text: pending.chunks.join("") });
    }
  }

  close(): void {
    this.closed = true;
    this.flush();
    this.blocks = undefined;
  }

  private replace(message: AssistantMessage): void {
    // Own string values, not mutable native blocks or their tool/image payloads.
    const blocks = message.content.map((block) => (block.type === "text" ? block.text : undefined));
    const meaningful = blocks.some((text) => text !== undefined && text.trim().length > 0);
    // Native text_end may clear a partial before the presentation timer fires.
    // Preserve useful evidence first; the empty replacement still invalidates summaries.
    if (this.meaningful && !meaningful) this.flush();
    this.blocks = blocks;
    this.lastIndex = this.blocks.findLastIndex((text) => text !== undefined);
    this.meaningful = meaningful;
    this.pending = { type: "replace" };
  }

  private emit(update: OutputUpdate): void {
    try {
      // A provider's suffix can be a slice of its entire cumulative response.
      // Session evidence must not chain those backing strings through appends.
      update = { ...update, text: copyOutputText(update.text) };
      if (this.candidate !== undefined) {
        // Empty final replacements invalidate private partials, not retained evidence.
        this.candidate.text =
          update.type === "append" ? this.candidate.text + update.text : update.text;
      } else if (update.type === "append" || update.text.trim()) {
        this.retained.text =
          update.type === "append" ? this.retained.text + update.text : update.text;
        this.publish(update);
      }
    } catch {
      // Presentation runs from a timer as well as SDK callbacks; never throw out of the timer.
      (this.candidate ?? this.retained).failure ??= "Child output publication failed.";
    }
  }
}
