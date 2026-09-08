import test from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent } from "@polyth/contracts";
import { hashText } from "../src/hash.ts";
import {
  getPairedProvenance,
  noteImportPending,
  pairUserMessage,
  resetProvenancePairing,
} from "../src/provenancePairing.ts";

const provenance = {
  sourceKind: "chat-workspace" as const,
  provider: "Kimi",
  profileName: "Personal",
  bundleLabel: "Review changes",
};

test("pairs the next user/message with matching text hash", () => {
  resetProvenancePairing();
  const text = "Paste this result into Polyth";
  noteImportPending("s1", provenance, hashText(text), 1_700_000_000_000);
  pairUserMessage({
    id: "e1",
    sessionId: "s1",
    seq: 42,
    time: 1_700_000_000_100,
    type: "user/message",
    data: { text },
    v: 1,
  } satisfies SessionEvent);
  const paired = getPairedProvenance("s1", 42);
  assert.ok(paired);
  assert.equal(paired!.provenance.provider, "Kimi");
  assert.equal(paired!.provenance.bundleLabel, "Review changes");
});

test("does not pair when text hash differs", () => {
  resetProvenancePairing();
  noteImportPending("s1", provenance, hashText("expected"), 1);
  pairUserMessage({
    id: "e2",
    sessionId: "s1",
    seq: 7,
    time: 2,
    type: "user/message",
    data: { text: "different" },
    v: 1,
  } satisfies SessionEvent);
  assert.equal(getPairedProvenance("s1", 7), null);
});
