import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { LIMITS } from "./limits.ts";

export const handoffParameters = Type.Union([
  Type.Object(
    { text: Type.String({ minLength: 1, maxLength: LIMITS.handoffBytes }) },
    { additionalProperties: false },
  ),
  Type.Object({ runId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);

export type HandoffInput = Static<typeof handoffParameters>;
export type HandoffMetadata =
  | { source: "text" }
  | {
      runId: string;
      sourceOutcome: "succeeded" | "failed" | "cancelled";
      sourceTruncated: boolean;
      excerptTruncated: boolean;
    };
export type HandoffReference = HandoffMetadata & { text: string };

export function validateHandoff(value: unknown): asserts value is HandoffInput | undefined {
  if (value === undefined) return;
  if (!Check(handoffParameters, value)) throw new Error("Handoff must contain only text or runId.");
  if ("runId" in value) {
    if (!value.runId.trim()) throw new Error("Handoff runId must not be blank.");
  } else if (
    !value.text.trim() ||
    Buffer.byteLength(value.text) > LIMITS.handoffBytes ||
    Buffer.from(value.text).toString("utf8") !== value.text
  )
    throw new Error("Handoff text must be nonblank valid UTF-8 within the handoff byte limit.");
}
