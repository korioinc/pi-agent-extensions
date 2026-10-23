import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { AssistantOutput } from "../src/session/output.ts";

function message(text: string): AssistantMessage {
  return {
    role: "assistant",
    api: "offline",
    provider: "offline",
    model: "child",
    content: text ? [{ type: "text", text }] : [],
    stopReason: "stop",
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function partial(text: string): AgentSessionEvent {
  const value = message(text);
  return {
    type: "message_update",
    message: value,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: value },
  };
}

test("an empty replacement final discards its partial without erasing retained evidence", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let visible = "";
  const output = new AssistantOutput((update) => {
    visible = update.type === "append" ? visible + update.text : update.text;
  });
  t.after(() => output.close());
  const evidence = "Confirmed work before interruption.";
  output.observe({ type: "message_start", message: message("") });
  output.observe(partial(evidence));
  output.observe({ type: "message_end", message: message("") });
  assert.equal(output.text, evidence, "ordinary empty finals must retain pending useful work");

  const accepted = await output.replaceWith(
    async () => {
      output.observe({ type: "message_start", message: message("") });
      output.observe(partial("Unfinished summary"));
      output.observe({ type: "message_end", message: message("") });
    },
    () => true,
  );
  t.mock.timers.runAll();
  assert.equal(accepted, false, "an empty authoritative final cannot replace evidence");
  assert.equal(output.text, evidence);
  assert.equal(visible, evidence, "private summary partials must never replace visible evidence");
});

test("failed replacement publication preserves evidence and discards delayed candidate text", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let visible = "";
  let unavailable = false;
  const output = new AssistantOutput((update) => {
    if (unavailable) throw new Error("Publisher unavailable");
    visible = update.type === "append" ? visible + update.text : update.text;
  });
  t.after(() => output.close());
  const evidence = "Verified effect already committed.";
  output.observe({ type: "message_end", message: message(evidence) });
  unavailable = true;
  await assert.rejects(
    output.replaceWith(
      async () => {
        output.observe({ type: "message_start", message: message("") });
        output.observe(partial("Replacement evidence"));
        output.observe({ type: "message_end", message: message("Replacement evidence") });
      },
      () => true,
    ),
  );
  unavailable = false;
  t.mock.timers.runAll();
  assert.equal(output.text, evidence, "publication failure cannot commit replacement text");
  assert.equal(visible, evidence, "a discarded candidate cannot escape through its timer");
});

for (const stopReason of ["error", "aborted", "length"] as const)
  test(`${stopReason} during handoff preserves prior evidence and its failure`, async (t) => {
    let visible = "";
    const output = new AssistantOutput((update) => {
      visible = update.type === "append" ? visible + update.text : update.text;
    });
    t.after(() => output.close());
    const evidence = "Verified work before interruption.";
    const failure = "The original work was interrupted.";
    output.observe({
      type: "message_end",
      message: { ...message(evidence), stopReason: "aborted", errorMessage: failure },
    });
    await output.replaceWith(
      async () => {
        output.observe({ type: "message_start", message: message("") });
        output.observe({
          type: "message_end",
          message: {
            ...message("Unverified replacement."),
            stopReason,
            errorMessage: "The private handoff failed.",
          },
        });
        assert.equal(output.text, evidence, "a private candidate cannot disclose its evidence");
        assert.equal(output.error, failure, "a private candidate cannot replace retained failure");
      },
      () => true,
    );
    assert.equal(output.text, evidence, "an incomplete handoff cannot replace prior work");
    assert.equal(visible, evidence, "an incomplete handoff must remain private");
    assert.equal(output.error, failure, "discarding text must also discard candidate failure");
  });

test("a streamed tool call cannot become a valid handoff through a text-only final", async (t) => {
  let visible = "";
  const output = new AssistantOutput((update) => {
    visible = update.type === "append" ? visible + update.text : update.text;
  });
  t.after(() => output.close());
  const evidence = "Existing work must survive a prohibited handoff attempt.";
  output.observe({ type: "message_end", message: message(evidence) });
  await output.replaceWith(
    async () => {
      const attempted = message("");
      attempted.content = [{ type: "toolCall", id: "attempt", name: "write", arguments: {} }];
      output.observe({ type: "message_start", message: attempted });
      output.observe({
        type: "message_update",
        message: attempted,
        assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: attempted },
      });
      // Authoritative text correction cannot erase a prohibited tool call seen while streaming.
      output.observe({ type: "message_end", message: message("Apparently normal summary.") });
    },
    () => true,
  );
  assert.equal(output.text, evidence);
  assert.equal(visible, evidence, "a tool-calling handoff must never replace visible evidence");
});

test("a successful handoff replaces response evidence only when execution remains safe", async (t) => {
  let visible = "";
  const output = new AssistantOutput((update) => {
    visible = update.type === "append" ? visible + update.text : update.text;
  });
  t.after(() => output.close());
  const evidence = "Partial work.";
  const failure = "Original request stopped.";
  output.observe({
    type: "message_end",
    message: { ...message(evidence), stopReason: "aborted", errorMessage: failure },
  });
  const summary = "Verified work and remaining tasks.";
  const produce = async () => {
    output.observe({ type: "message_start", message: message("") });
    output.observe({ type: "message_end", message: message(summary) });
  };
  await output.replaceWith(produce, () => false);
  assert.equal(
    visible,
    evidence,
    "runtime denial must prevent even a valid candidate's disclosure",
  );
  assert.equal(output.error, failure);
  await output.replaceWith(produce, () => true);
  assert.equal(visible, summary);
  assert.equal(output.text, summary);
  assert.equal(output.error, undefined, "successful replacement commits response status with text");
});

test("ordinary publication failure stays recorded after later model failure", async (t) => {
  const output = new AssistantOutput(() => {
    throw new Error("Publisher unavailable");
  });
  t.after(() => output.close());
  const evidence = "Completed effect with unavailable progress delivery.";
  output.observe({ type: "message_end", message: message(evidence) });
  const publicationFailure = output.error;
  assert.ok(
    publicationFailure,
    "failed publication must prevent reporting ordinary output as safe",
  );
  output.observe({
    type: "message_end",
    message: { ...message(""), stopReason: "error", errorMessage: "Later provider failure." },
  });
  assert.equal(output.text, evidence, "failed publication cannot erase evidence of completed work");
  assert.equal(
    output.error,
    publicationFailure,
    "later failures must not conceal the first failure",
  );
});
