import test from "node:test";
import assert from "node:assert/strict";
import {
  addModel, buildGuardrails, draftChanged, draftFrom, extraGrantChoices, isRiskyGrant,
  makeDefaultModel, removeModel, toggleExtra,
} from "../src/components/settings/accountGuardrailsModel.ts";

const a = { harnessId: "h", providerID: "p", modelID: "a" };
const b = { harnessId: "h", providerID: "p", modelID: "b" };
const c = { harnessId: "h2", providerID: "p", modelID: "a" };
const base = ["core.sessions.read", "dictation.use"];
const grantable = [...base, "files.read", "files.write", "core.tunnel"];

test("model list: add dedupes by harness, default moves first, remove drops", () => {
  assert.deepEqual(addModel([a], a), [a]);
  assert.deepEqual(addModel([a], c), [a, c]);
  assert.deepEqual(makeDefaultModel([a, b, c], b), [b, a, c]);
  assert.deepEqual(makeDefaultModel([a], b), [a]);
  assert.deepEqual(removeModel([a, b], a), [b]);
});

test("payload: off saves null; on is baseline plus unique extras", () => {
  assert.equal(buildGuardrails({ enabled: false, models: [a], approvals: "once", extra: [] }, base), null);
  assert.deepEqual(
    buildGuardrails({ enabled: true, models: [a], approvals: "none", extra: ["files.read", "dictation.use"] }, base),
    { grants: [...base, "files.read"], models: [a], approvals: "none" },
  );
});

test("draft round-trips and ignores baseline/unknown grants as extras", () => {
  assert.deepEqual(draftFrom(null, grantable, base), { enabled: false, models: [], approvals: "none", extra: [] });
  const d = draftFrom({ grants: [...base, "files.write", "nope"], models: [a], approvals: "once" }, grantable, base);
  assert.deepEqual(d.extra, ["files.write"]);
  assert.equal(draftChanged(d, structuredClone(d)), false);
  assert.equal(draftChanged(d, { ...d, models: [b] }), true);
  assert.equal(draftChanged(d, { ...d, extra: toggleExtra(d.extra, "files.write", false) }), true);
});

test("extra choices exclude baseline; risky set is flagged", () => {
  assert.deepEqual(extraGrantChoices(grantable, base), ["files.read", "files.write", "core.tunnel"]);
  assert.ok(isRiskyGrant("terminal.open") && isRiskyGrant("browser.use") && !isRiskyGrant("files.read"));
});
