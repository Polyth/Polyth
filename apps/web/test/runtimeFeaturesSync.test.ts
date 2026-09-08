import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionProjection } from "@polyth/contracts";
import { shouldRefreshRuntimeFeatures } from "../src/runtimeFeaturesSync.ts";

const base = (patch: Partial<SessionProjection> = {}): SessionProjection => ({
  id: "s",
  projectId: "p",
  title: "t",
  status: "idle",
  createdAt: 0,
  updatedAt: 0,
  ...patch,
});

test("shouldRefreshRuntimeFeatures is false without a loaded payload", () => {
  assert.equal(shouldRefreshRuntimeFeatures(undefined, base({ nativeCommandsRevision: 1 }), false), false);
});

test("shouldRefreshRuntimeFeatures tracks nativeCommandsRevision", () => {
  const prev = base({ nativeCommandsRevision: 0 });
  const next = base({ nativeCommandsRevision: 1 });
  assert.equal(shouldRefreshRuntimeFeatures(prev, next, true), true);
  assert.equal(shouldRefreshRuntimeFeatures(next, next, true), false);
});

test("shouldRefreshRuntimeFeatures tracks harness and generation changes", () => {
  const prev = base({
    resolvedHarnessId: "a",
    runtimeBinding: {
      backendSessionId: "b",
      authorityId: "auth",
      generation: 1,
      continuity: "generation-only",
      protocol: "legacy",
      location: { directory: "/tmp" },
    },
  });
  assert.equal(shouldRefreshRuntimeFeatures(prev, base({ resolvedHarnessId: "b" }), true), true);
  assert.equal(shouldRefreshRuntimeFeatures(prev, base({
    runtimeBinding: { ...prev.runtimeBinding!, generation: 2 },
  }), true), true);
});

test("shouldRefreshRuntimeFeatures treats a dropped revision as a change", () => {
  assert.equal(
    shouldRefreshRuntimeFeatures(base({ nativeCommandsRevision: 4 }), base(), true),
    true,
  );
});
