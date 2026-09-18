import test from "node:test";
import assert from "node:assert/strict";
import type { WorkbenchProfileDefinition } from "@polyth/web-sdk";
import {
  initialCapabilityPlacementOverrides,
  projectSetupRecovery,
  selectInitialWorkbenchProfile,
} from "../src/projectCompositionPlan.ts";

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

test("profile can inherit owning package affinity, while explicit profile affinity wins", () => {
  const inherited: WorkbenchProfileDefinition = {
    id: "markets",
    label: "Markets",
    description: "Markets",
    order: 30,
    ownerPackageId: "markets",
    defaultLayout: { surfaces: [] },
  };
  const packageAffinity = (owner: string) => owner === "markets"
    ? { directions: ["finance"] as const, recommended: true }
    : undefined;
  assert.equal(selectInitialWorkbenchProfile(
    { version: 1, directions: ["finance"], packageOverrides: {} },
    [inherited],
    packageAffinity,
  ), "markets");

  const explicit: WorkbenchProfileDefinition = {
    ...inherited,
    id: "markets-research-only",
    projectAffinity: { directions: ["research"], recommended: true },
  };
  assert.equal(selectInitialWorkbenchProfile(
    { version: 1, directions: ["finance"], packageOverrides: {} },
    [explicit],
    packageAffinity,
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

test("typed projects keep recommended tools in place and demote secondary package capabilities", () => {
  const composition = { version: 1, directions: ["engineering"], packageOverrides: {} } as const;
  const affinities = (owner: string) => ({
    git: { directions: ["engineering"] as const, recommended: true },
    usage: {},
    files: { recommended: true },
    github: { directions: ["engineering", "operations"] as const },
  } as const)[owner as "git" | "usage" | "files" | "github"];

  assert.deepEqual(initialCapabilityPlacementOverrides(composition as never, [
    { id: "session", standardTier: "primary", standardRank: 0 },
    { id: "files", ownerPackageId: "files", standardTier: "primary", standardRank: 1 },
    { id: "git", ownerPackageId: "git", standardTier: "more", standardRank: 4 },
    { id: "github", ownerPackageId: "github", standardTier: "more", standardRank: 16 },
    { id: "usage", ownerPackageId: "usage", standardTier: "more", standardRank: 15 },
    { id: "events", standardTier: "technical", standardRank: 33 },
  ], affinities), {
    usage: { tier: "technical", rank: 15 },
  });
});

test("explicit include keeps a secondary package in its normal rail", () => {
  const composition = {
    version: 1,
    directions: ["engineering"],
    packageOverrides: { usage: "include" },
  } as const;
  assert.deepEqual(initialCapabilityPlacementOverrides(composition as never, [
    { id: "usage", ownerPackageId: "usage", standardTier: "more", standardRank: 15 },
  ], () => ({})), {});
});

test("general projects preserve the global capability arrangement", () => {
  assert.deepEqual(initialCapabilityPlacementOverrides(
    { version: 1, directions: [], packageOverrides: {} },
    [{ id: "usage", ownerPackageId: "usage", standardTier: "more", standardRank: 15 }],
    () => ({}),
  ), {});
});

test("typed projects demote package capabilities with no project affinity metadata", () => {
  assert.deepEqual(initialCapabilityPlacementOverrides(
    { version: 1, directions: ["finance"], packageOverrides: {} },
    [{ id: "legacy-extra", ownerPackageId: "legacy-extra", standardTier: "more", standardRank: 19 }],
    () => undefined,
  ), {
    "legacy-extra": { tier: "technical", rank: 19 },
  });
});
