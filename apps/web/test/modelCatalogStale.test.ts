import { test } from "node:test";
import assert from "node:assert/strict";
import { createStaleCatalogTrigger, isStaleModelRefusal, signalsStaleModelCatalog } from "../src/modelCatalogStale.ts";

test("only a model-unavailable terminal event or a model/variant refusal signals a stale catalog", () => {
  assert.equal(signalsStaleModelCatalog({ type: "turn/stopped", data: { reason: "error", code: "model-unavailable" } }), true);
  assert.equal(signalsStaleModelCatalog({ type: "turn/stopped", data: { reason: "error", error: "rate limited" } }), false);
  assert.equal(signalsStaleModelCatalog({ type: "turn/failed", data: { code: "model-unavailable" } }), false);
  assert.equal(isStaleModelRefusal("invalid-model"), true);
  // The picker offered a thinking level the runtime's own list lacks: the two
  // catalogs disagree (a CLI update moved the `haiku` alias), so re-read.
  assert.equal(isStaleModelRefusal("invalid-variant"), true);
  assert.equal(isStaleModelRefusal("discovery-unavailable"), false);
  assert.equal(isStaleModelRefusal(undefined), false);
});

test("a burst of stale signals invalidates the client catalog once per window", () => {
  let clock = 0;
  let invalidations = 0;
  const trigger = createStaleCatalogTrigger(() => { invalidations += 1; }, { cooldownMs: 10_000, now: () => clock });
  assert.equal(trigger(), true);
  assert.equal(trigger(), false);
  clock = 9_999;
  assert.equal(trigger(), false);
  clock = 10_000;
  assert.equal(trigger(), true);
  assert.equal(invalidations, 2);
});
