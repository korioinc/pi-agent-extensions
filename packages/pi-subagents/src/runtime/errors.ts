/** Convert arbitrary thrown values without allowing attacker-controlled coercion to escape. */
export function safeErrorText(value: unknown, fallback = "Operation failed."): string {
  try {
    if (value instanceof Error) {
      const message = value.message;
      if (typeof message === "string" && message) return message;
    }
  } catch {
    return fallback;
  }
  try {
    const text = String(value);
    return text || fallback;
  } catch {
    return fallback;
  }
}
