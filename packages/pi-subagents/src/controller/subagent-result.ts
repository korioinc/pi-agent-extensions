import type { RunProgress, RunView } from "../runner-pool/index.ts";
import { boundedText } from "../runtime/limits.ts";
import { runStatusText } from "./render.ts";
import { clean } from "./sanitize.ts";

/** Display-only projection for Pi's official subagent consumer; never execution state. */
export function subagentResult<T extends { details: unknown }>(
  result: T,
  task: string,
  run?: RunProgress | RunView,
) {
  const finished = run?.phase === "terminal" && "cleanup" in run && run.cleanup === "safe";
  const stopReason = finished
    ? run.outcome === "succeeded"
      ? "stop"
      : run.outcome === "cancelled"
        ? "aborted"
        : "error"
    : undefined;
  const status = run ? `Status: ${runStatusText(run)}` : "";
  const text =
    finished && run.text
      ? run.outcome === "succeeded"
        ? run.text
        : `${status}\n\n${run.text}`
      : status;
  const model = run?.model
    ? boundedText(clean(run.model).replace(/\s+/gu, " ").trim(), 256)
    : undefined;
  return {
    ...result,
    details: {
      ...(typeof result.details === "object" && result.details !== null ? result.details : {}),
      // No row before admission or after authorization is lost; never reuse cached identity.
      results: run?.identity
        ? [
            {
              agent: run.identity.agent,
              task,
              ...(model ? { model } : {}),
              step: 0,
              finished,
              ...(stopReason ? { stopReason } : {}),
              messages: [
                {
                  role: "assistant",
                  content: [{ type: "text", text: boundedText(text, finished ? 10_000 : 200) }],
                },
              ],
            },
          ]
        : [],
    },
  };
}

/** Per-call display state contains no child identity or transcript. */
export class SubagentDisplay {
  private published = false;
  private closed = false;
  private revokedSettlement = false;

  readonly revoke = () => {
    this.revokedSettlement = true;
  };

  update<T extends { details: unknown }>(
    result: T,
    task: string,
    run: RunProgress,
    publish: (value: ReturnType<typeof subagentResult<T>>) => void | Promise<void>,
  ) {
    if (this.closed || this.revokedSettlement) return;
    const projected = subagentResult(result, task, run);
    const hasRow = projected.details.results.length > 0;
    const pending = publish(projected);
    const delivered = () => {
      this.published ||= hasRow;
    };
    if (pending) return pending.then(delivered);
    delivered();
  }

  finish<T extends { details: unknown }>(result: T, task: string, run?: RunView) {
    this.closed = true;
    if (!this.revokedSettlement || !this.published) return subagentResult(result, task, run);
    return {
      ...result,
      details: {
        ...(typeof result.details === "object" && result.details !== null ? result.details : {}),
        results: [
          {
            agent: "Unavailable agent",
            task: "Access to this task is no longer available.",
            step: 0,
            finished: true,
            stopReason: "error",
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: "Access was lost. Owned work has settled; details are unavailable. Do not automatically retry.",
                  },
                ],
              },
            ],
          },
        ],
      },
    };
  }
}
