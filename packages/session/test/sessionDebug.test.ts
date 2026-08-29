import assert from "node:assert/strict";
import { test } from "node:test";

import type { DurableOperation, PersistedRuntimeBinding, SessionEvent } from "@polyth/contracts";
import {
  planRuntimeEpochRecovery,
  sessionDebugObservability,
} from "../src/index.ts";

const PROMPT = "SECRET_USER_PROMPT_DO_NOT_LEAK";
const TOKEN = "sk-secret-provider-token";

function ev(seq: number, type: string, data: Record<string, unknown>, ignorable?: boolean): SessionEvent {
  return {
    id: `id-${seq}`,
    sessionId: "s1",
    seq,
    time: seq,
    type,
    data: data as SessionEvent["data"],
    v: 1,
    ...(ignorable ? { ignorable: true } : {}),
  };
}

function op(ownerEventSeq: number, state: DurableOperation["state"]): DurableOperation {
  return {
    operationId: `op-${ownerEventSeq}`,
    sessionId: "s1",
    ordinal: ownerEventSeq,
    mutationKind: "turn-submit",
    state,
    replay: { kind: "never" },
    createdAt: 1,
    updatedAt: 1,
    ownerEventSeq,
  };
}

const binding: PersistedRuntimeBinding = {
  backendSessionId: "backend-1",
  authorityId: "owned:authority-hash",
  generation: 2,
  epoch: 3,
  continuity: "verified",
  protocol: "legacy",
  location: { directory: "/project" },
  historyBaseline: "empty",
};

test("debug observability includes binding, counts, epoch marker, and recovery stats", () => {
  const events = [
    ev(1, "user/message", { text: PROMPT }),
    ev(2, "assistant/message", { text: "ok" }),
    ev(3, "runtime/epoch-replaced", {
      old: { authorityId: "owned:old", generation: 1, epoch: 2 },
      new: { authorityId: "owned:authority-hash", generation: 2, epoch: 3 },
      reason: "isolated runtime DB was quarantined after an engine digest change",
    }, true),
  ];
  const plan = planRuntimeEpochRecovery({
    events,
    operations: [op(1, "confirmed"), op(4, "fenced"), op(5, "unknown")],
  });
  assert.ok(plan);
  const debug = sessionDebugObservability({
    binding,
    events,
    operations: [op(1, "confirmed"), op(4, "fenced"), op(5, "unknown")],
    heldForReview: 1,
    endpoint: {
      authorityId: "owned:live",
      generation: 9,
      control: { kind: "owned", instanceToken: TOKEN },
    },
    recoveryPlan: plan,
    recoveryRestored: false,
  });

  assert.deepEqual(debug.runtimeBinding, {
    authorityId: "owned:authority-hash",
    generation: 2,
    epoch: 3,
    continuity: "verified",
    protocol: "legacy",
    location: { directory: "/project" },
    historyBaseline: "empty",
  });
  assert.deepEqual(debug.endpoint, {
    authorityId: "owned:live",
    generation: 9,
    control: { kind: "owned" },
  });
  assert.deepEqual(debug.counts, {
    fencedOperations: 1,
    unknownOperations: 1,
    heldForReview: 1,
  });
  assert.deepEqual(debug.lastEpochReplaced, {
    reason: "isolated runtime DB was quarantined after an engine digest change",
    old: { authorityId: "owned:old", generation: 1, epoch: 2 },
    new: { authorityId: "owned:authority-hash", generation: 2, epoch: 3 },
    seq: 3,
  });
  assert.ok(debug.recoveryPlan);
  assert.equal(debug.recoveryPlan.omittedMessages, plan.omittedMessages);
  assert.deepEqual(debug.recoveryPlan.sectionChars, plan.sectionChars);
  assert.equal(debug.recoveryPlan.restored, false);
  assert.equal("recoveryContext" in debug.recoveryPlan, false);

  const json = JSON.stringify(debug);
  assert.equal(json.includes(PROMPT), false);
  assert.equal(json.includes(TOKEN), false);
  assert.equal(json.includes("recoveryContext"), false);
  assert.equal(json.includes("http://"), false);
});

test("debug observability never copies conversation text from a recovery plan", () => {
  const events = [
    ev(1, "user/message", { text: PROMPT }),
    ev(2, "runtime/epoch-replaced", {
      old: { authorityId: "a", generation: 1, epoch: 0 },
      new: { authorityId: "b", generation: 1, epoch: 1 },
      reason: "user confirmed replacement of an external runtime",
    }, true),
  ];
  const plan = planRuntimeEpochRecovery({
    events,
    operations: [op(1, "confirmed")],
  });
  assert.ok(plan);
  assert.match(plan.recoveryContext, new RegExp(PROMPT));
  const debug = sessionDebugObservability({
    events,
    recoveryPlan: plan,
  });
  assert.ok(debug.recoveryPlan);
  const json = JSON.stringify(debug);
  assert.equal(json.includes(PROMPT), false);
  assert.equal(json.includes(plan.recoveryContext.slice(0, 40)), false);
});
