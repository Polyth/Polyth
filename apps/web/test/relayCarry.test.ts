import test from "node:test";
import assert from "node:assert/strict";
import { carriedRouteModel } from "../src/composer/relayCarry.ts";

const relay = { mode: "pinned" as const, harnessId: "antigravity-relay" };
const flash = { providerID: "antigravity", modelID: "gemini-3.8-flash", variant: "low" };

test("a Relay hand-over between member accounts keeps the chosen model, re-owned by the new member", () => {
  assert.deepEqual(carriedRouteModel({
    model: { ...flash, harnessId: "antigravity" },
    previousSelection: relay,
    selection: relay,
    previousHarnessId: "antigravity",
    harnessId: "antigravity-iryna",
  }), { ...flash, harnessId: "antigravity-iryna" });
  // A pick made while the composer still showed the Relay's own catalogue.
  assert.deepEqual(carriedRouteModel({
    model: { ...flash, harnessId: "antigravity-relay" },
    previousSelection: relay,
    selection: relay,
    previousHarnessId: "antigravity",
    harnessId: "antigravity-iryna",
  }), { ...flash, harnessId: "antigravity-iryna" });
});

test("a person's switch to another harness, or an Auto move, still drops a foreign model", () => {
  const model = { ...flash, harnessId: "antigravity" };
  assert.equal(carriedRouteModel({
    model,
    previousSelection: relay,
    selection: { mode: "pinned", harnessId: "claude" },
    previousHarnessId: "antigravity",
    harnessId: "claude",
  }), undefined);
  assert.equal(carriedRouteModel({
    model,
    previousSelection: { mode: "auto" },
    selection: { mode: "auto" },
    previousHarnessId: "antigravity",
    harnessId: "claude",
  }), undefined);
  // A model of an unrelated harness is not re-owned by a hand-over.
  assert.equal(carriedRouteModel({
    model: { ...flash, harnessId: "claude" },
    previousSelection: relay,
    selection: relay,
    previousHarnessId: "antigravity",
    harnessId: "antigravity-iryna",
  }), undefined);
});

test("a model already owned by the new harness, or no resolved harness, is kept as is", () => {
  const model = { ...flash, harnessId: "claude" };
  const common = { previousSelection: undefined, selection: undefined, previousHarnessId: "antigravity" };
  assert.equal(carriedRouteModel({ ...common, model, harnessId: "claude" }), model);
  assert.equal(carriedRouteModel({ ...common, model, harnessId: undefined }), model);
  assert.equal(carriedRouteModel({ ...common, model: undefined, harnessId: "claude" }), undefined);
});
