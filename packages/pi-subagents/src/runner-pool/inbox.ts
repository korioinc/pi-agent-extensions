import { createHash } from "node:crypto";
import { LIMITS } from "../runtime/limits.ts";
import type { MessageInput, MessageResult, PendingMessage } from "../runtime/messages.ts";
import type { RunInbox } from "./types.ts";

export function createInbox(): RunInbox {
  return { pending: [], bytes: 0, receipts: new Map() };
}

export function closeInbox(inbox: RunInbox): void {
  for (const { messageId } of inbox.pending) inbox.receipts.get(messageId)!.state = "discarded";
  inbox.pending = [];
  inbox.bytes = 0;
}

export function takeInboxMessages(inbox: RunInbox): PendingMessage[] {
  const messages = inbox.pending;
  for (const { messageId } of messages)
    inbox.receipts.get(messageId)!.state = "injected_not_confirmed";
  inbox.pending = [];
  inbox.bytes = 0;
  return messages;
}

export function enqueueInboxMessage(
  inbox: RunInbox,
  { runId, messageId, message }: MessageInput,
  accepting: () => boolean,
  signal?: AbortSignal,
  beforePublish?: (messageId: string) => void | false,
): MessageResult {
  const digest = createHash("sha256").update(message).digest("hex");
  const receipt = inbox.receipts.get(messageId);
  if (receipt)
    return receipt.digest === digest
      ? { runId, messageId, state: receipt.state }
      : { rejection: "message_conflict" as const };
  if (signal?.aborted || !accepting()) return { rejection: "not_accepting" as const };
  const bytes = Buffer.byteLength(message);
  if (
    inbox.receipts.size >= LIMITS.messageReceipts ||
    inbox.pending.length >= LIMITS.pendingMessages ||
    inbox.bytes + bytes > LIMITS.pendingMessageBytes
  )
    return { rejection: "message_capacity" as const };
  try {
    // Existing receipts bypass admission; rejecting new input must not reserve its ID.
    if (beforePublish?.(messageId) === false) return { rejection: "not_accepting" };
  } catch {
    return { rejection: "not_available" };
  }
  if (signal?.aborted || !accepting()) {
    inbox.receipts.set(messageId, { digest, state: "discarded" });
    return { runId, messageId, state: "discarded" };
  }
  inbox.pending.push({ messageId, message });
  inbox.bytes += bytes;
  inbox.receipts.set(messageId, { digest, state: "queued" });
  return { runId, messageId, state: "queued" as const };
}

export function projectInbox(inbox: RunInbox) {
  return {
    pendingCount: inbox.pending.length,
    pendingBytes: inbox.bytes,
    receipts: [...inbox.receipts].map(([messageId, { state }]) => ({
      messageId,
      state,
    })),
  };
}
