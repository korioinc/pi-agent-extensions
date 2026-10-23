import assert from "node:assert/strict";
import test from "node:test";
import type { Settings } from "../settings.ts";
import { selectServiceTier } from "../service-tier.ts";

const settings: Settings = {
  fast: { enabled: true, serviceTier: "priority", supportedModels: ["vendor/shared", "fast-only"] },
  ultrafast: { enabled: true, serviceTier: "ultrafast", supportedModels: ["shared"] },
};
const model = (id: string) => ({ id, api: "openai-responses" });

test("independent toggles select the fastest enabled tier supported by the model", () => {
  assert.equal(selectServiceTier(settings, model("shared")), "ultrafast");
  assert.equal(selectServiceTier(settings, model("fast-only")), "priority");
  const ultraOff = { ...settings, ultrafast: { ...settings.ultrafast, enabled: false } };
  assert.equal(selectServiceTier(ultraOff, model("shared")), "priority");
  const fastOff = { ...settings, fast: { ...settings.fast, enabled: false } };
  assert.equal(selectServiceTier(fastOff, model("fast-only")), undefined);
  assert.equal(selectServiceTier(fastOff, model("shared")), "ultrafast");
  const bothOff = { ...fastOff, ultrafast: { ...settings.ultrafast, enabled: false } };
  assert.equal(selectServiceTier(bothOff, model("shared")), undefined);
});

test("provider prefixes do not change eligibility, but the final model name must match exactly", () => {
  for (const id of ["shared", "codex-pooler/shared", "org/codex-magpie/shared"]) {
    assert.equal(selectServiceTier(settings, model(id)), "ultrafast");
  }
  const fastOnly = { ...settings, ultrafast: { ...settings.ultrafast, enabled: false } };
  assert.equal(selectServiceTier(fastOnly, model("another/shared")), "priority");
  for (const id of ["not-shared", "shared-preview", "SHARED", "shared/", ""]) {
    assert.equal(selectServiceTier(settings, model(id)), undefined);
  }
});

test("disabled or unsupported tiers never become an implicit request", () => {
  assert.equal(selectServiceTier(settings, undefined), undefined);
  assert.equal(selectServiceTier(settings, model("unsupported")), undefined);
  assert.equal(selectServiceTier(settings, { id: "shared", api: "anthropic-messages" }), undefined);
  assert.equal(
    selectServiceTier(settings, { id: "shared", api: "openai-codex-responses" }),
    "ultrafast",
  );
  const noUltraModels = { ...settings, ultrafast: { ...settings.ultrafast, supportedModels: [] } };
  assert.equal(selectServiceTier(noUltraModels, model("shared")), "priority");
});
