import test from "node:test";
import assert from "node:assert/strict";
import type { WorkbenchProfileDefinition } from "@polyth/web-sdk";
import { projectSetupRecovery, selectInitialWorkbenchProfile } from "../src/projectCompositionPlan.ts";

const profile = (id: string, order: number, directions: string[], recommended = true): WorkbenchProfileDefinition => ({
  id, label: id, description: id, order, ownerPackageId: id,
  defaultLayout: { surfaces: [] },
  projectAffinity: { directions: directions as never, recommended },
});

test("initial profile is metadata-driven and prefers the strongest direction overlap", () => {
  const profiles = [
    profile("engineering", 20, ["engineering"]),
    profile("finance-research", 30, ["finance", "research"]),
    profile("research", 10, ["research"]),
  ];
  assert.equal(selectInitialWorkbenchProfile(
    { version: 1, directions: ["finance", "research"], packageOverrides: {} }, profiles,
  ), "finance-research");
});

test("ties are deterministic by profile order then id", () => {
  const profiles = [
    profile("z-last", 8, ["engineering"]),
    profile("b-first", 4, ["engineering"]),
    profile("a-first", 4, ["engineering"]),
  ];
  assert.equal(selectInitialWorkbenchProfile(
    { version: 1, directions: ["engineering"], packageOverrides: {} }, profiles,
  ), "a-first");
});

test("general projects and non-recommended profiles do not force a workbench", () => {
  assert.equal(selectInitialWorkbenchProfile(
    { version: 1, directions: [], packageOverrides: {} }, [profile("eng", 1, ["engineering"])],
  ), null);
  assert.equal(selectInitialWorkbenchProfile(
    { version: 1, directions: ["engineering"], packageOverrides: {} }, [profile("eng", 1, ["engineering"], false)],
  ), null);
});

test("setup recovery never traps an unresolved project and never abandons an unsafe known one", () => {
  assert.deepEqual(projectSetupRecovery(false, false), {
    canExit: true, canRetry: false, exitKind: "close",
  });
  assert.deepEqual(projectSetupRecovery(false, true), {
    canExit: false, canRetry: true, exitKind: null,
  });
  assert.deepEqual(projectSetupRecovery(true, true), {
    canExit: true, canRetry: true, exitKind: "open-anyway",
  });
});
