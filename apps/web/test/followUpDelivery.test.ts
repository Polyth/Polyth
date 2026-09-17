import test from "node:test";
import assert from "node:assert/strict";
import { executionSelectionChanged, immediateFollowUpDelivery } from "../src/followUpDelivery.ts";

test("immediate follow-up steers only when the same execution can continue", () => {
  assert.equal(immediateFollowUpDelivery({
    requested: "steer",
    steering: true,
    executionChanged: false,
    hasAttachments: false,
    hasCommand: false,
  }), "steer");
  assert.equal(immediateFollowUpDelivery({
    requested: "interrupt",
    steering: true,
    executionChanged: false,
    hasAttachments: false,
    hasCommand: false,
  }), "interrupt");
});

test("immediate follow-up stops and sends when steering cannot carry the prompt", () => {
  const base = {
    requested: "steer" as const,
    steering: true,
    executionChanged: false,
    hasAttachments: false,
    hasCommand: false,
  };
  assert.equal(immediateFollowUpDelivery({ ...base, steering: false }), "interrupt");
  assert.equal(immediateFollowUpDelivery({ ...base, executionChanged: true }), "interrupt");
  assert.equal(immediateFollowUpDelivery({ ...base, hasAttachments: true }), "interrupt");
  assert.equal(immediateFollowUpDelivery({ ...base, hasCommand: true }), "interrupt");
});

test("execution selection changes when the next model, agent, or harness differs", () => {
  const current = { model: { providerID: "openai", modelID: "gpt-5", variant: "high" }, agent: "build" };
  assert.equal(executionSelectionChanged(current, { model: current.model, agent: "build" }), false);
  assert.equal(executionSelectionChanged(current, {
    model: { providerID: "openai", modelID: "gpt-5", variant: "low" },
  }), true);
  assert.equal(executionSelectionChanged(current, {
    model: { providerID: "anthropic", modelID: "opus" },
  }), true);
  assert.equal(executionSelectionChanged(current, { agent: "plan" }), true);
  assert.equal(executionSelectionChanged(current, { harness: { mode: "pinned", harnessId: "codex" } }), true);
});
