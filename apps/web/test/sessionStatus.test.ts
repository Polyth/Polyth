import test from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection } from "@polyth/contracts";
import { resolveSessionStatus } from "../src/sessionStatus.ts";

const NOW = 1_000_000_000;
const session = (over: Partial<SessionProjection>): SessionProjection => ({
  id: "s",
  projectId: "p",
  title: "Session",
  status: "idle",
  createdAt: NOW - 600_000,
  updatedAt: NOW - 120_000,
  ...over,
});

test("working status derives a non-negative elapsed duration", () => {
  assert.deepEqual(
    resolveSessionStatus(session({
      status: "working",
      lastTurnAt: NOW - 90_000,
    }), NOW),
    { kind: "working", elapsedMs: 90_000, glyph: "◌", label: "Working" },
  );
  assert.equal(
    resolveSessionStatus(session({
      status: "working",
      lastTurnAt: NOW + 5_000,
    }), NOW).kind,
    "working",
  );
  const future = resolveSessionStatus(session({
    status: "working",
    lastTurnAt: NOW + 5_000,
  }), NOW);
  assert.equal(future.kind === "working" ? future.elapsedMs : -1, 0);
});

test("human attention outranks activity, failure, and unread state", () => {
  assert.equal(resolveSessionStatus(session({
    status: "working",
    attention: { questions: 1, permissions: 0, unread: 2 },
  }), NOW).kind, "needs-reply");
  assert.deepEqual(resolveSessionStatus(session({
    status: "failed",
    attention: { questions: 3, permissions: 2, unread: 4 },
  }), NOW), {
    kind: "needs-approval",
    glyph: "✓",
    label: "Approval required",
  });
});

test("active multirun and fusion work resolve as working outside their view", () => {
  const background = resolveSessionStatus(session({
    status: "idle",
    backgroundWork: { multirun: 1, fusion: 1, startedAt: NOW - 45_000 },
  }), NOW);
  assert.deepEqual(background, {
    kind: "working",
    elapsedMs: 45_000,
    glyph: "◌",
    label: "Working",
  });

  assert.equal(resolveSessionStatus(session({
    status: "waiting",
    attention: { questions: 1, permissions: 0, unread: 0 },
    backgroundWork: { fusion: 1, startedAt: NOW - 10_000 },
  }), NOW).kind, "needs-reply");
});

test("epoch-pending is Runtime changed after failed and before reconciling", () => {
  assert.deepEqual(resolveSessionStatus(session({ status: "epoch-pending" }), NOW), {
    kind: "epoch-pending",
    glyph: "⚠",
    label: "Runtime changed",
  });
  assert.equal(resolveSessionStatus(session({
    status: "epoch-pending",
    attention: { questions: 0, permissions: 0, unread: 2 },
  }), NOW).kind, "epoch-pending");
  assert.equal(resolveSessionStatus(session({ status: "failed" }), NOW).kind, "failed");
  assert.equal(resolveSessionStatus(session({ status: "reconciling" }), NOW).kind, "reconciling");
});

test("resolver covers the shared continuity taxonomy", () => {
  const fixtures: Array<[Partial<SessionProjection>, string, string]> = [
    [{ status: "waiting" }, "needs-reply", "Reply needed"],
    [{ status: "failed" }, "failed", "Failed"],
    [{ status: "epoch-pending" }, "epoch-pending", "Runtime changed"],
    [{ attention: { questions: 0, permissions: 0, unread: 2 } }, "unread", "Unread activity"],
    [{ status: "reconciling" }, "reconciling", "Reconnecting"],
    [{ status: "unknown" }, "unknown", "Status unknown"],
    [{ status: "idle" }, "regular", "Idle"],
    [{ status: "finished" }, "regular", "Idle"],
    [{ status: "archived" }, "regular", "Idle"],
  ];
  for (const [input, kind, label] of fixtures) {
    const status = resolveSessionStatus(session(input), NOW);
    assert.equal(status.kind, kind);
    assert.equal(status.label, label);
    assert.ok(status.glyph, `${kind} has a non-color glyph`);
  }
});

test("branch and worktree metadata never alter session status", () => {
  const plain = resolveSessionStatus(session({ status: "idle" }), NOW);
  for (const worktreeState of ["ready", "bootstrapping", "busy", "missing"] as const) {
    assert.deepEqual(resolveSessionStatus(session({
      branch: "feat/mobile",
      worktreePath: "/repo-mobile",
      worktreeState,
    }), NOW), plain);
  }
});
