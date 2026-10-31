import test from "node:test";
import assert from "node:assert/strict";
import type { ExecutionReleaseProof, HarnessTransition, SessionProjection } from "@polyth/contracts";
import { SESSION_SUMMARY_FIELDS } from "@polyth/contracts";
import { resolveSessionStatus } from "../src/sessionStatus.ts";
import { setLocale } from "../src/i18n/index.ts";

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

test("working status uses the active locale label", async () => {
  await setLocale("uk");
  try {
    assert.equal(resolveSessionStatus(session({ status: "working" }), NOW).label, "Виконується");
  } finally {
    await setLocale("en");
  }
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

test("an active workflow run resolves as working outside its view", () => {
  assert.deepEqual(resolveSessionStatus(session({
    status: "idle",
    backgroundWork: { workflow: 1, startedAt: NOW - 30_000 },
  }), NOW), {
    kind: "working",
    elapsedMs: 30_000,
    glyph: "◌",
    label: "Working",
  });
});

test("pending permissions and questions resolve as waiting-for-user chrome", () => {
  assert.deepEqual(resolveSessionStatus(session({
    status: "waiting",
    attention: { questions: 0, permissions: 1, unread: 0 },
  }), NOW), {
    kind: "needs-approval",
    glyph: "✓",
    label: "Approval required",
  });
  assert.deepEqual(resolveSessionStatus(session({
    status: "waiting",
    attention: { questions: 2, permissions: 1, unread: 0 },
  }), NOW), {
    kind: "needs-approval",
    glyph: "✓",
    label: "Approval required",
  });
  assert.deepEqual(resolveSessionStatus(session({
    status: "idle",
    attention: { questions: 2, permissions: 0, unread: 0 },
  }), NOW), {
    kind: "needs-reply",
    glyph: "?",
    label: "Reply needed",
  });
  assert.deepEqual(resolveSessionStatus(session({ status: "waiting" }), NOW), {
    kind: "needs-reply",
    glyph: "?",
    label: "Waiting for you",
  });
  assert.equal(resolveSessionStatus(session({
    status: "idle",
    attention: { questions: 0, permissions: 0, unread: 0 },
  }), NOW).kind, "regular");
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

test("a dormant owned runtime epoch is ready to reconnect without an attention warning", () => {
  assert.deepEqual(resolveSessionStatus(session({
    status: "epoch-pending",
    runtimeControl: "owned",
  }), NOW), {
    kind: "resume-ready",
    glyph: "↻",
    label: "Reconnect on use",
  });
  assert.equal(resolveSessionStatus(session({
    status: "epoch-pending",
    runtimeControl: "borrowed",
  }), NOW).kind, "epoch-pending");
  assert.equal(resolveSessionStatus(session({
    status: "epoch-pending",
  }), NOW).kind, "epoch-pending", "unclassified runtime ownership is not assumed safe");
});

test("a provider-limit stop awaiting its automatic resend is a calm pause, not a failure", () => {
  const resume = { resumeAt: NOW + 60_000, scope: "quota" as const, attempt: 1, userMessageSeq: 4 };
  assert.deepEqual(resolveSessionStatus(session({ status: "failed", resume }), NOW), {
    kind: "rate-limited",
    glyph: "⏱",
    label: "Resumes after limit",
  });
  assert.equal(resolveSessionStatus(session({ status: "idle", resume }), NOW).kind, "rate-limited");
  // A person's attention and live work still win; an archived row stays idle.
  assert.equal(resolveSessionStatus(session({
    status: "failed",
    resume,
    attention: { questions: 1, permissions: 0, unread: 0 },
  }), NOW).kind, "needs-reply");
  assert.equal(resolveSessionStatus(session({ status: "working", resume }), NOW).kind, "working");
  assert.equal(resolveSessionStatus(session({ status: "archived", resume }), NOW).kind, "regular");
  // Without a pending resume the same stop is still an honest failure.
  assert.equal(resolveSessionStatus(session({ status: "failed" }), NOW).kind, "failed");
});

test("a refused request awaiting its bounded auto-retry reads as an automatic retry", () => {
  const resume = {
    resumeAt: NOW + 10_000,
    scope: "request" as const,
    attempt: 2,
    maxAttempts: 3,
    userMessageSeq: 4,
  };
  assert.deepEqual(resolveSessionStatus(session({ status: "failed", resume }), NOW), {
    kind: "rate-limited",
    glyph: "↻",
    label: "Auto-retrying",
  });
  // The retry is still the session's own work, so live work and archive win.
  assert.equal(resolveSessionStatus(session({ status: "working", resume }), NOW).kind, "working");
  assert.equal(resolveSessionStatus(session({ status: "archived", resume }), NOW).kind, "regular");
});

test("resolver covers the shared continuity taxonomy", () => {
  const fixtures: Array<[Partial<SessionProjection>, string, string]> = [
    [{ status: "waiting" }, "needs-reply", "Waiting for you"],
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

/** Cuts a full projection down to the fields a navigator summary actually
 * carries, mirroring the server's projection. A status that changes when the
 * session is opened means the summary is missing a resolver input. */
const navigatorRow = (full: SessionProjection): SessionProjection => ({
  ...Object.fromEntries(SESSION_SUMMARY_FIELDS.map((key) => [key, (full as unknown as Record<string, unknown>)[key]])),
  summary: true,
} as SessionProjection);

test("navigator summaries carry every field the status resolver reads", () => {
  const resume = { resumeAt: NOW + 60_000, scope: "quota" as const, attempt: 1, userMessageSeq: 4 };
  assert.equal(
    resolveSessionStatus(navigatorRow(session({ status: "failed", resume })), NOW).kind,
    "rate-limited",
    "a limit pause with a pending resume must not show as a failure before the session is opened",
  );
  assert.equal(
    resolveSessionStatus(navigatorRow(session({ status: "epoch-pending", runtimeControl: "owned" })), NOW).kind,
    "resume-ready",
    "a dormant owned epoch reconnects on use instead of warning",
  );
  const planned: HarnessTransition = {
    id: "switch-1",
    selection: { mode: "pinned", harnessId: "cursor" },
    targetHarnessId: "cursor",
    timing: "after-turn",
    phase: "requested",
  };
  assert.equal(
    resolveSessionStatus(navigatorRow(session({ status: "epoch-pending", harnessTransition: planned })), NOW).kind,
    "regular",
    "a planned handoff is not an incident in the navigator either",
  );
});

test("a planned harness handoff explains its own epoch without flashing Runtime changed", () => {
  const released: ExecutionReleaseProof = { authorityId: "a", generation: 1, backendSessionId: "b" };
  const planned: HarnessTransition = {
    id: "switch-1",
    selection: { mode: "pinned", harnessId: "cursor" },
    targetHarnessId: "cursor",
    timing: "after-turn",
    phase: "requested",
  };
  const dispatched: HarnessTransition = { ...planned, phase: "released", released };
  const failed: HarnessTransition = {
    ...planned,
    phase: "failed",
    released,
    attempt: 1,
    lastAttemptAt: NOW,
    error: { stage: "starting-target", message: "could not start" },
  };

  assert.equal(
    resolveSessionStatus(session({ status: "epoch-pending", harnessTransition: planned }), NOW).kind,
    "regular",
    "a switch that is still running is not an incident",
  );
  assert.equal(
    resolveSessionStatus(session({ status: "epoch-pending", harnessTransition: dispatched }), NOW).kind,
    "regular",
  );
  // A failed switch, a borrowed identity change and unread attention all keep
  // their honest state.
  assert.equal(
    resolveSessionStatus(session({ status: "epoch-pending", harnessTransition: failed }), NOW).kind,
    "epoch-pending",
  );
  assert.equal(
    resolveSessionStatus(session({
      status: "epoch-pending",
      runtimeControl: "owned",
      harnessTransition: failed,
    }), NOW).kind,
    "epoch-pending",
    "a failed planned switch still needs attention even with an owned runtime",
  );
  assert.equal(
    resolveSessionStatus(session({
      status: "epoch-pending",
      harnessTransition: planned,
      runtimeControl: "borrowed",
    }), NOW).kind,
    "epoch-pending",
  );
  assert.equal(
    resolveSessionStatus(session({
      status: "epoch-pending",
      harnessTransition: planned,
      attention: { questions: 0, permissions: 0, unread: 1 },
    }), NOW).kind,
    "unread",
  );
});
