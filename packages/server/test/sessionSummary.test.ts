import test from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection } from "@polyth/contracts";
import { sessionSummary } from "../src/sessionSummary.ts";

const full = {
  id: "s1",
  projectId: "p",
  title: "Session",
  status: "failed",
  createdAt: 1,
  updatedAt: 2,
  backendSessionId: "native-1",
  runtimeBinding: { backendSessionId: "native-1", authorityId: "a", generation: 1 },
  workspace: { repositories: [] },
  draft: "private draft",
  resume: { resumeAt: 5, scope: "quota", attempt: 1, userMessageSeq: 3 },
  runtimeControl: "owned",
  harnessTransition: {
    id: "switch-1",
    selection: { mode: "auto" },
    targetHarnessId: "cursor",
    timing: "after-turn",
    phase: "requested",
  },
} as unknown as SessionProjection;

test("a navigator summary keeps every field the row status resolver reads", () => {
  const summary = sessionSummary(full);
  assert.equal(summary.summary, true);
  assert.equal(summary.status, "failed");
  assert.deepEqual(summary.resume, full.resume);
  assert.equal(summary.runtimeControl, "owned");
  assert.deepEqual(summary.harnessTransition, full.harnessTransition);
});

test("a navigator summary still omits runtime binding, workspace and draft detail", () => {
  const summary = sessionSummary(full) as Record<string, unknown>;
  assert.equal(summary.backendSessionId, undefined);
  assert.equal(summary.runtimeBinding, undefined);
  assert.equal(summary.workspace, undefined);
  assert.equal(summary.draft, undefined);
});

test("a navigator summary marks a draft with its bounded first line only", () => {
  assert.equal(sessionSummary(full).draftPreview, "private draft");
  const long = sessionSummary({ ...full, draft: `\n\n  ${"x".repeat(400)}\nsecond` } as SessionProjection);
  assert.equal(long.draftPreview, "x".repeat(120));
  assert.equal(sessionSummary({ ...full, draft: " \n " } as SessionProjection).draftPreview, undefined);
  assert.equal(sessionSummary({ ...full, draft: undefined } as SessionProjection).draftPreview, undefined);
});
