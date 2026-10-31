import test from "node:test";
import assert from "node:assert/strict";
import type { WorkbenchProfileDefinition } from "@polyth/web-sdk";
import type { ProjectComposition } from "@polyth/contracts/project-composition";
import {
  DEFAULT_RIGHT_RAIL_LIMIT,
  DEFAULT_TOP_RAIL_LIMIT,
  defaultCapabilityPlacements,
  projectSetupRecovery,
  selectInitialWorkbenchProfile,
  type ProjectCapabilitySeedInput,
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

const kind = (...directions: ProjectComposition["directions"]): ProjectComposition =>
  ({ version: 1, directions, packageOverrides: {} });
const pkg = (
  id: string,
  standardTier: ProjectCapabilitySeedInput["standardTier"],
  standardRank: number,
  defaultRails?: ProjectCapabilitySeedInput["defaultRails"],
): ProjectCapabilitySeedInput => ({ id, ownerPackageId: id, standardTier, standardRank, ...(defaultRails ? { defaultRails } : {}) });
const rails = (placements: Record<string, { tier: string; rank: number }>) => ({
  top: Object.entries(placements).filter(([, p]) => p.tier === "primary").map(([id]) => id).sort(),
  right: Object.entries(placements).filter(([, p]) => p.tier === "more").map(([id]) => id).sort(),
});

test("each package chooses its rail per project kind and everything else starts under More", () => {
  const capabilities = [
    pkg("files", "primary", 1, { general: "top", engineering: "top", finance: "right" }),
    pkg("terminal", "more", 20, { general: "top", engineering: "top" }),
    pkg("git", "technical", 30, { general: "right", engineering: "top" }),
    pkg("usage", "more", 15, { general: "right", engineering: "right" }),
    pkg("markets", "more", 21, { finance: "top" }),
    pkg("gitlab", "more", 17, {}),
  ];
  const engineering = defaultCapabilityPlacements(kind("engineering"), capabilities);
  assert.deepEqual(rails(engineering), { top: ["files", "git", "terminal"], right: ["usage"] });
  assert.deepEqual(engineering.gitlab, { tier: "technical", rank: 17 });
  assert.equal(Object.keys(engineering).length, capabilities.length, "every capability gets an explicit placement");

  assert.deepEqual(rails(defaultCapabilityPlacements(kind("finance"), capabilities)), { top: ["markets"], right: ["files"] });
  // General and legacy projects (no directions) use the `general` rails.
  for (const composition of [kind(), undefined]) {
    assert.deepEqual(rails(defaultCapabilityPlacements(composition, capabilities)), { top: ["files", "terminal"], right: ["git", "usage"] });
  }
  // Several directions take the most prominent rail any of them asks for.
  assert.deepEqual(rails(defaultCapabilityPlacements(kind("engineering", "finance"), capabilities)), {
    top: ["files", "git", "markets", "terminal"], right: ["usage"],
  });
});

test("a project may start with an empty rail", () => {
  const placements = defaultCapabilityPlacements(kind("home"), [
    pkg("schedule", "more", 14, { home: "top" }),
    pkg("files", "primary", 1, { general: "top" }),
    pkg("usage", "more", 15, { general: "right" }),
  ]);
  assert.deepEqual(rails(placements), { top: ["schedule"], right: [] });
});

test("rails never overflow: the top rail spills to the right, the right rail to More, by rank", () => {
  const top = Array.from({ length: DEFAULT_TOP_RAIL_LIMIT + 2 }, (_, index) => pkg(`top${index}`, "more", index, { general: "top" }));
  const right = Array.from({ length: DEFAULT_RIGHT_RAIL_LIMIT }, (_, index) => pkg(`right${index}`, "more", 10 + index, { general: "right" }));
  const placements = defaultCapabilityPlacements(kind(), [...top, ...right]);
  const { top: shownTop, right: shownRight } = rails(placements);
  assert.equal(shownTop.length, DEFAULT_TOP_RAIL_LIMIT);
  assert.equal(shownRight.length, DEFAULT_RIGHT_RAIL_LIMIT);
  assert.deepEqual(placements.top5, { tier: "more", rank: 5 }, "the first overflow of the top rail moves right");
  assert.deepEqual(placements.right5, { tier: "technical", rank: 15 }, "the worst-ranked right entry waits under More");
});

test("the right rail only holds launchers it can draw", () => {
  const placements = defaultCapabilityPlacements(kind(), [
    { ...pkg("web-search", "more", 18, { general: "right" }), rightRailDestination: false },
    { ...pkg("usage", "more", 15, { general: "right" }), rightRailDestination: true },
  ]);
  assert.deepEqual(rails(placements), { top: [], right: ["usage"] });
  assert.deepEqual(placements["web-search"], { tier: "technical", rank: 18 });
});

test("packages without default rails keep their standard tier where their directions match", () => {
  const affinities = (owner: string) => ({
    git: { directions: ["engineering"] as const, recommended: true },
    usage: {},
    files: { recommended: true },
    github: { directions: ["engineering", "operations"] as const },
  } as const)[owner as "git" | "usage" | "files" | "github"];
  const placements = defaultCapabilityPlacements(kind("engineering"), [
    { id: "files", ownerPackageId: "files", standardTier: "primary", standardRank: 1 },
    { id: "git", ownerPackageId: "git", standardTier: "more", standardRank: 4 },
    { id: "github", ownerPackageId: "github", standardTier: "more", standardRank: 16 },
    { id: "usage", ownerPackageId: "usage", standardTier: "more", standardRank: 15 },
    { id: "events", standardTier: "technical", standardRank: 33 },
  ], affinities);
  assert.deepEqual(rails(placements), { top: ["files"], right: ["git", "github"] });
  assert.deepEqual(placements.usage, { tier: "technical", rank: 15 }, "a universal package needs a recommendation");
});

test("explicit include keeps a package visible even where it has no default rail", () => {
  const composition = { version: 1, directions: ["engineering"], packageOverrides: { usage: "include", gitlab: "include" } } as const;
  const placements = defaultCapabilityPlacements(composition as never, [
    pkg("usage", "more", 15),
    pkg("gitlab", "more", 17, {}),
  ], () => ({}));
  assert.deepEqual(rails(placements), { top: [], right: ["gitlab", "usage"] });
});

test("every initial rail has one entry per package for General, typed and explicit-include projects", () => {
  const capabilities = [
    { id: "events", standardTier: "primary" as const, standardRank: 1 },
    { id: "alpha.details", ownerPackageId: "alpha", standardTier: "primary" as const, standardRank: 2 },
    { id: "alpha", ownerPackageId: "alpha", standardTier: "primary" as const, standardRank: 3 },
    { id: "beta.first", ownerPackageId: "beta", standardTier: "more" as const, standardRank: 4 },
    { id: "beta.second", ownerPackageId: "beta", standardTier: "more" as const, standardRank: 5 },
  ];
  const compositions: ProjectComposition[] = [
    { version: 1 as const, directions: [], packageOverrides: {} },
    { version: 1 as const, directions: ["finance" as const], packageOverrides: {} },
    { version: 1 as const, directions: ["finance" as const], packageOverrides: { alpha: "include" as const, beta: "include" as const } },
  ];
  for (const composition of compositions) {
    assert.deepEqual(defaultCapabilityPlacements(composition, capabilities, () => ({ recommended: true })), {
      events: { tier: "primary", rank: 1 },
      alpha: { tier: "primary", rank: 3 },
      "alpha.details": { tier: "technical", rank: 2 },
      "beta.first": { tier: "more", rank: 4 },
      "beta.second": { tier: "technical", rank: 5 },
    });
  }
});
