import test from "node:test";
import assert from "node:assert/strict";
import { creationModelAndAgent } from "../src/creationDefaults.ts";

const relay = { mode: "pinned" as const, harnessId: "antigravity-relay" };
const flash = { providerID: "antigravity", modelID: "gemini-3.8-flash" };

test("a model chosen for a Relay chat is sent although the aggregate catalogue lacks the Relay", () => {
  // The aggregate /api/models has no per-person Relay rows.
  const models = [{ harnessId: "claude", providerID: "anthropic", modelID: "sonnet", name: "Sonnet" }];
  assert.deepEqual(creationModelAndAgent({ harness: relay, model: flash, agent: "build", models, agents: [] }), { model: flash, agent: "build" });
});

test("an inherited default reaches a pinned chat only when that harness offers it", () => {
  const defaultModel = { providerID: "anthropic", modelID: "sonnet" };
  const models = [{ harnessId: "claude", ...defaultModel, name: "Sonnet" }];
  assert.deepEqual(creationModelAndAgent({ harness: relay, defaultModel, defaultAgent: "plan", models, agents: [] }), {});
  assert.deepEqual(
    creationModelAndAgent({ harness: { mode: "pinned", harnessId: "claude" }, defaultModel, models, agents: [] }),
    { model: defaultModel },
  );
  assert.deepEqual(creationModelAndAgent({ defaultModel, defaultAgent: "plan", models: [], agents: [] }), { model: defaultModel, agent: "plan" });
});
