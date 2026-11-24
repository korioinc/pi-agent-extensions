import { stripTerminalSequences } from "@earendil-works/pi-tui";

/** Remove terminal escape sequences, control characters and Unicode BiDi overrides. */
export function clean(text: string): string {
  return stripTerminalSequences(text).replace(
    /[\p{Cc}\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu,
    " ",
  );
}
