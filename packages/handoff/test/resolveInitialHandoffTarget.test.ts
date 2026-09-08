import test from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection } from "@polyth/contracts";
import { resolveInitialHandoffTarget } from "../widgets/lib/resolveInitialHandoffTarget.ts";

const idleSession: SessionProjection = {
  id: "s1",
  projectId: "p1",
  title: "Session",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
};

const workingSession: SessionProjection = {
  ...idleSession,
  status: "working",
};

const allTargets = ["current-session", "queue", "new-session", "draft"] as const;

test("resolveInitialHandoffTarget honors preferred target when available", () => {
  assert.equal(
    resolveInitialHandoffTarget({
      preferredTarget: "draft",
      session: idleSession,
      availableTargets: allTargets,
      fallbackTarget: "current-session",
    }),
    "draft",
  );
});

test("resolveInitialHandoffTarget maps current-session to queue when working", () => {
  assert.equal(
    resolveInitialHandoffTarget({
      preferredTarget: "current-session",
      session: workingSession,
      availableTargets: allTargets,
      fallbackTarget: "queue",
    }),
    "queue",
  );
});

test("resolveInitialHandoffTarget keeps queue when working", () => {
  assert.equal(
    resolveInitialHandoffTarget({
      preferredTarget: "queue",
      session: workingSession,
      availableTargets: allTargets,
      fallbackTarget: "queue",
    }),
    "queue",
  );
});

test("resolveInitialHandoffTarget falls back when preferred target unavailable", () => {
  assert.equal(
    resolveInitialHandoffTarget({
      preferredTarget: "draft",
      session: idleSession,
      availableTargets: ["current-session", "queue"],
      fallbackTarget: "current-session",
    }),
    "current-session",
  );
});
