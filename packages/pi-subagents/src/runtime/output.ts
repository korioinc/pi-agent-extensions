import { boundedText, LIMITS } from "./limits.ts";

export interface OutputUpdate {
  type: "append" | "replace";
  text: string;
}

export function copyOutputText(text: string): string {
  // Detach sliced strings without changing unpaired UTF-16 code units.
  return Buffer.from(text, "utf16le").toString("utf16le");
}

/** Pool-owned bounded result and preview; updates never retain the full transcript. */
export class OutputBuffer {
  private text = "";
  private tail = "";
  private bytes = 0;

  apply(update: OutputUpdate): void {
    const text = update.text;
    if (update.type === "replace") {
      this.bytes = Buffer.byteLength(text);
      this.text =
        this.bytes > LIMITS.resultBytes
          ? boundedText(text, LIMITS.resultBytes)
          : copyOutputText(text);
      this.tail = copyOutputText(text.slice(-512));
      return;
    }
    if (!text) return;
    const last = this.tail.charCodeAt(this.tail.length - 1);
    const first = text.charCodeAt(0);
    // Two separately encoded surrogate replacements use six bytes; a completed
    // pair uses four. Count only the new suffix plus this boundary correction.
    const paired = last >= 0xd800 && last <= 0xdbff && first >= 0xdc00 && first <= 0xdfff;
    const bytes = this.bytes + Buffer.byteLength(text) - (paired ? 2 : 0);
    if (this.bytes <= LIMITS.resultBytes) {
      this.text =
        bytes <= LIMITS.resultBytes
          ? this.text + copyOutputText(text)
          : copyOutputText(
              boundedText(this.text + text.slice(0, LIMITS.resultBytes), LIMITS.resultBytes),
            );
    }
    this.bytes = bytes;
    this.tail = copyOutputText((this.tail + text.slice(-512)).slice(-512));
  }

  snapshot() {
    return {
      text: this.text,
      preview: this.tail.replace(/^[\uDC00-\uDFFF]/u, ""),
      outputBytes: this.bytes,
      truncated: this.bytes > LIMITS.resultBytes,
    };
  }
}
