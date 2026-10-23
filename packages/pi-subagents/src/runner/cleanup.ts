import { safeErrorText } from "../runtime/errors.ts";

/** Normalize arbitrary promise rejections before they become ownership evidence. */
export function cleanupFailure(error: unknown, message: string): Error {
  return new Error(safeErrorText(error, message), { cause: error });
}
