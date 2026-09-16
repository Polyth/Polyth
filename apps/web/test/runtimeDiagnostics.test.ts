import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { SessionEvent, SessionProjection } from "@polyth/contracts";
import { runtimeDiagnosticFacts, uncertainRecoveryWarning } from "../src/runtimeDiagnostics.ts";

const session = (overrides: Partial<SessionProjection> = {}): SessionProjection => ({
  id: "s1",
  projectId: "p1",
  title: "Session",
  status: "epoch-pending",
  createdAt: 1,
  updatedAt: 1,
  runtimeControl: "borrowed",
  runtimeBinding: {
    backendSessionId: "be",
    authorityId: "owned:raw-authority-should-not-appear",
    generation: 2,
    epoch: 3,
    continuity: "verified",
    protocol: "legacy",
    location: { directory: "/project" },
  },
  ...overrides,
});

test("diagnostic facts use the conceptual runtime inspector fields", () => {
  const events: SessionEvent[] = [{
    id: "e1",
    sessionId: "s1",
    seq: 4,
    time: 4,
    type: "runtime/epoch-replaced",
    data: {
      reason: "user confirmed replacement of an external runtime",
      old: { authorityId: "old", generation: 1, epoch: 2 },
      new: { authorityId: "new", generation: 2, epoch: 3 },
    },
    v: 1,
    ignorable: true,
  }];
  const facts = runtimeDiagnosticFacts({
    status: "epoch-pending",
    runtimeControl: "borrowed",
    binding: session().runtimeBinding,
    events,
    debug: {
      status: "epoch-pending",
      eventCount: 1,
      latestSeq: 4,
      runtime: { attached: false, activeTurn: false, admissionPending: false },
      queue: [{
        id: "q1",
        sessionId: "s1",
        position: 0,
        text: "SECRET_PROMPT",
        delivery: "queue",
        createdAt: 1,
      }],
      pending: { permissions: [], questions: [], secrets: [] },
      recentErrors: [],
      counts: { fencedOperations: 0, unknownOperations: 1, heldForReview: 0 },
      lastEpochReplaced: {
        reason: "user confirmed replacement of an external runtime",
        old: { authorityId: "old", generation: 1, epoch: 2 },
        new: { authorityId: "new", generation: 2, epoch: 3 },
        seq: 4,
      },
      recoveryPlan: {
        epoch: 3,
        markerSeq: 4,
        omittedMessages: 2,
        omittedPins: 0,
        omittedKnowledge: 0,
        omittedSummaries: 0,
        sectionsCapped: ["dialogue"],
        sectionChars: { intent: 0, durable: 0, summaries: 0, dialogue: 120 },
        goalRestored: false,
        restored: false,
      },
    },
    promptPrefix: {
      version: 1,
      coverage: "polyth-capability-prefix",
      identity: "prefix-abc",
      bundleRevision: "bundle-def",
      contributorCount: 1,
      contributors: [{
        id: "example.policy",
        kind: "instruction",
        owner: "example",
        scope: "project",
        revision: "semantic-123",
      }],
    },
  });
  const byLabel = Object.fromEntries(facts.map((fact) => [fact.label, fact.value]));
  assert.equal(byLabel.Engine, "OpenCode");
  assert.equal(byLabel.Mode, "borrowed");
  assert.equal(byLabel.Epoch, "3");
  assert.equal(byLabel.Status, "recovery-needed");
  assert.equal(byLabel.Control, "borrowed");
  assert.equal(byLabel["Unknown operations"], "1");
  assert.equal(byLabel["Omitted messages"], "2");
  assert.equal(byLabel["Capped sections"], "dialogue");
  assert.equal(byLabel["Prompt prefix"], "prefix-abc");
  assert.equal(byLabel["Capability bundle"], "bundle-def");
  assert.equal(byLabel["Prefix contributors"], "1");
  assert.equal(byLabel["Prefix · example.policy"], "instruction · semantic-123");
  const blob = JSON.stringify(facts);
  assert.equal(blob.includes("owned:raw-authority-should-not-appear"), false);
  assert.equal(blob.includes("SECRET_PROMPT"), false);
});

test("runtime recovery banner discloses technical details without App.tsx", async () => {
  const banner = await readFile(new URL("../src/components/RuntimeEpochBanner.tsx", import.meta.url), "utf8");
  assert.match(banner, /registerSlot\(\s*"session\.composer\.before"/);
  assert.match(banner, /runtimeRecovery\.technicalDetails/);
  assert.match(banner, /runtime-recovery-details/);
  assert.match(banner, /api\.sessionDebug/);
  assert.match(banner, /fetchPromptPrefixDiagnostics/);
  assert.match(banner, /uncertainRecoveryWarning/);
  assert.doesNotMatch(banner, /runtimeRecovery\.keepBlocked/);
  assert.match(banner, /runtimeRecovery\.leaveBlocked/);
  assert.doesNotMatch(banner, /instanceToken|passwordEnv|recoveryContext/);
  assert.match(banner, /session\.runtimeControl === "owned"\) return null/);
  assert.doesNotMatch(banner, /runtimeRecovery\.ownedBody/);
});

test("uncertain recovery warning uses server debug counts when events omit the turn", () => {
  const events: SessionEvent[] = [];
  assert.equal(uncertainRecoveryWarning({ events }), false);
  assert.equal(uncertainRecoveryWarning({
    events,
    debug: { counts: { unknownOperations: 1, fencedOperations: 0, heldForReview: 0 } },
  }), true);
  assert.equal(uncertainRecoveryWarning({
    events,
    debug: { counts: { unknownOperations: 0, fencedOperations: 2, heldForReview: 0 } },
  }), true);
  assert.equal(uncertainRecoveryWarning({
    events,
    debug: { counts: { unknownOperations: 0, fencedOperations: 0, heldForReview: 1 } },
  }), true);
  assert.equal(uncertainRecoveryWarning({
    events: [{
      id: "e1",
      sessionId: "s1",
      seq: 1,
      time: 1,
      type: "mutation/uncertainty-recorded",
      data: { mutationKind: "turn-submit" },
      v: 1,
    }],
    debug: { counts: { unknownOperations: 0, fencedOperations: 0, heldForReview: 0 } },
  }), true);
});
