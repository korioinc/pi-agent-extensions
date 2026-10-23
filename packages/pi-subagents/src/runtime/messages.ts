import { Type } from "typebox";
import { Check } from "typebox/value";
import { LIMITS } from "./limits.ts";

export const messageParameters = Type.Object(
  {
    runId: Type.String({
      pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    }),
    messageId: Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }),
    message: Type.String({ minLength: 1, maxLength: LIMITS.messageBytes }),
  },
  { additionalProperties: false },
);

export interface MessageInput {
  runId: string;
  messageId: string;
  message: string;
}

export type PendingMessage = Pick<MessageInput, "messageId" | "message">;
export type MessageState = "queued" | "injected_not_confirmed" | "discarded";
export type MessageResult =
  | { runId: string; messageId: string; state: MessageState }
  | {
      rejection:
        | "invalid_input"
        | "not_available"
        | "not_accepting"
        | "message_conflict"
        | "message_capacity";
      generation?: string;
    };

export function validMessage(input: unknown): input is MessageInput {
  return (
    Check(messageParameters, input) &&
    input.message.trim().length > 0 &&
    Buffer.byteLength(input.message) <= LIMITS.messageBytes &&
    Buffer.from(input.message).toString("utf8") === input.message
  );
}
