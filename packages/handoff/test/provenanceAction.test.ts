import test from "node:test";
import assert from "node:assert/strict";
import { provenanceActionForTarget } from "../widgets/lib/provenanceAction.ts";

test("draft does not record import provenance", () => {
  assert.equal(provenanceActionForTarget("draft"), "none");
});

test("current session and queue record against the destination session", () => {
  assert.equal(provenanceActionForTarget("current-session"), "record-session");
  assert.equal(provenanceActionForTarget("queue"), "record-session");
});

test("new-session stages pending provenance for the created session", () => {
  assert.equal(provenanceActionForTarget("new-session"), "pending-new-session");
});
