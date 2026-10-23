export const LIMITS = Object.freeze({
  runs: 3,
  taskBytes: 64 * 1024,
  handoffBytes: 16 * 1024,
  messageBytes: 8 * 1024,
  pendingMessages: 8,
  pendingMessageBytes: 32 * 1024,
  pendingFollowupBytes: 256 * 1024,
  retainedAgents: 32,
  followupReceipts: 128,
  agentHistoryBytes: 64 * 1024 * 1024,
  generationHistoryBytes: 256 * 1024 * 1024,
  messageReceipts: 32,
  instructionBytes: 64 * 1024,
  preparationRoots: 32,
  preparationEntries: 4096,
  preparationDepth: 16,
  preparationBytes: 8 * 1024 * 1024,
  promptBytes: 4 * 1024 * 1024,
  catalogBytes: 64 * 1024,
  selectionBytes: 4 * 1024,
  mcpServers: 4,
  // The SDK owns stdio/SSE framing; bound its otherwise buffered JSON/error bodies separately.
  mcpHttpBodyBytes: 16 * 1024 * 1024,
  mcpStreamTrafficBytes: 256 * 1024 * 1024,
  mcpCatalogBytes: 8 * 1024 * 1024,
  invocationMs: 30 * 60 * 1000,
  startupMs: 60 * 1000,
  turns: 48,
  safeguardFinishMs: 30 * 1000,
  safeguardSummaryMs: 60 * 1000,
  safeguardTokens: 2048,
  wrapUpTurns: 2,
  wrapUpModelTokenFraction: 0.1,
  tokens: 8192,
  // Per-request inbound wire/event work, independent of model context size.
  providerResponseBytes: 8 * 1024 * 1024,
  // Actual child tool starts; the codemode wrapper does not consume this allowance.
  toolCalls: 256,
  wrapUpToolCalls: 8,
  toolConcurrency: 4,
  toolMs: 3 * 60 * 1000,
  // A native MCP result can retain its wire payload and a model-facing image copy.
  toolBytes: 64 * 1024 * 1024,
  toolUpdates: 4096,
  toolUpdateTrafficBytes: 128 * 1024 * 1024,
  graceMs: 5000,
  resultBytes: 256 * 1024,
  retained: 32,
  retentionMs: 60 * 60 * 1000,
});

const textEncoder = new TextEncoder();

export function boundedText(text: string, bytes: number): string {
  // UTF-8 never uses fewer bytes than the source's UTF-16 code units. Do not
  // scan or allocate the entire oversized input just to retain a short prefix.
  if (text.length <= bytes && Buffer.byteLength(text) <= bytes) return text;
  const buffer = Buffer.allocUnsafe(bytes);
  const { written } = textEncoder.encodeInto(text, buffer);
  return buffer.toString("utf8", 0, written);
}
