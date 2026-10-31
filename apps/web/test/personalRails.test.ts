// A Personal project (`Project.personal`) is the first screen of someone who
// has not set up a project. Its rails start with the few launchers that ask
// for the `personal` kind — no Source control, Terminal or other project-work
// tools — and every other surface that follows the rails (phone Workspace,
// tablet shortcuts) shows the same short set.
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { projectKinds } from "@polyth/contracts/project-composition";
import {
  defaultCapabilityPlacements,
  defaultRailFor,
  type ProjectCapabilitySeedInput,
} from "../src/projectCompositionPlan.ts";
import {
  projectRailPlanContext,
  replaceProjectPackageCatalog,
  resetProjectRelevanceForTest,
  setProjectCompositionContext,
} from "../src/packages/projectRelevance.ts";
import { setProjectInterfaceMode } from "../src/projectInterfaceScope.ts";
import { DEFAULT_PANEL_WIDGETS, defaultPanelWidgetIds } from "../src/workspacePanel.ts";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

// The shapes first-party packages register today (ids, tiers, ranks).
const capabilities: ProjectCapabilitySeedInput[] = [
  { id: "files", ownerPackageId: "files", standardTier: "primary", standardRank: 1, defaultRails: { general: "top", personal: "right" } },
  { id: "browser", ownerPackageId: "browser", standardTier: "primary", standardRank: 2, defaultRails: { general: "top" } },
  { id: "git", ownerPackageId: "git", standardTier: "technical", standardRank: 3, defaultRails: { general: "right" } },
  { id: "terminal", ownerPackageId: "terminal", standardTier: "more", standardRank: 4, defaultRails: { general: "top" } },
  { id: "schedule", ownerPackageId: "agents", standardTier: "more", standardRank: 14, defaultRails: { general: "right", personal: "right" } },
  { id: "planner", ownerPackageId: "planner", standardTier: "more", standardRank: 15, defaultRails: { general: "right", personal: "right" } },
  { id: "usage", ownerPackageId: "usage", standardTier: "more", standardRank: 15, defaultRails: { general: "right" } },
  { id: "custom-action", ownerPackageId: "custom-action", standardTier: "more", standardRank: 24, defaultRails: { general: "right" } },
  // No `defaultRails`: a universal extension that would take its standard
  // tier in a General project.
  { id: "vendor.tool", ownerPackageId: "vendor", standardTier: "more", standardRank: 40 },
  { id: "vendor.primary", ownerPackageId: "vendor-two", standardTier: "primary", standardRank: 41 },
];

const onRails = (placements: ReturnType<typeof defaultCapabilityPlacements>) =>
  Object.entries(placements).filter(([, placement]) => placement.tier !== "technical").map(([id, placement]) => `${id}:${placement.tier}`);

test("a Personal project is its own project kind, whatever its composition says", () => {
  assert.deepEqual(projectKinds(undefined), ["general"]);
  assert.deepEqual(projectKinds(undefined, { personal: true }), ["personal"]);
  assert.deepEqual(projectKinds({ version: 1, directions: ["engineering"], packageOverrides: {} }, { personal: true }), ["personal"]);
});

test("a Personal project's rails hold only the launchers that ask for it", () => {
  const personal = defaultCapabilityPlacements(undefined, capabilities, () => undefined, { personal: true });
  assert.deepEqual(onRails(personal), ["files:more", "schedule:more", "planner:more"],
    "Files, Agents and Planner on the right rail; the top rail starts empty");
  for (const id of ["git", "terminal", "browser", "usage", "custom-action", "vendor.tool", "vendor.primary"]) {
    assert.equal(personal[id]?.tier, "technical", `${id} waits under More, one search away`);
  }
  // The same capabilities in a General project keep their usual arrangement.
  const general = defaultCapabilityPlacements(undefined, capabilities);
  assert.equal(general.git?.tier, "more");
  assert.equal(general.terminal?.tier, "primary");
  assert.equal(general["vendor.tool"]?.tier, "more");
});

test("nothing places itself on a Personal project's rails without asking", () => {
  const included = { version: 1 as const, directions: [], packageOverrides: { vendor: "include" as const } };
  const vendor = capabilities.find((capability) => capability.id === "vendor.tool")!;
  assert.equal(defaultRailFor(included, vendor), "right", "an included package gets a rail elsewhere");
  assert.equal(defaultRailFor(included, vendor, () => undefined, { personal: true }), null);
  assert.equal(defaultRailFor(undefined, { ...vendor, rail: false, defaultRails: { personal: "top" } }, () => undefined, { personal: true }), null,
    "a capability without a rail launcher never gets one");
  assert.equal(defaultRailFor(undefined, { ...vendor, defaultRails: { personal: "top" } }, () => undefined, { personal: true }), "top");
});

test("a capability arriving later follows the same Personal rule", async () => {
  const { capabilityArrivalsFor } = await import("../src/capabilityArrivals.ts");
  const descriptors = capabilities.map((capability) => ({
    ...capability, label: capability.id, plainDescription: "", keywords: [], open: () => {}, available: () => true,
  }));
  const arrivals = Object.fromEntries(capabilityArrivalsFor(undefined, descriptors, () => undefined, { personal: true })
    .map((arrival) => [arrival.id, arrival.placement?.tier ?? null]));
  assert.equal(arrivals.planner, "more");
  assert.equal(arrivals.git, "technical");
  assert.equal(arrivals.terminal, "technical");
  assert.equal(arrivals["vendor.tool"], "technical", "an extension without defaultRails is placed under More, not on a rail");
  const general = Object.fromEntries(capabilityArrivalsFor(undefined, descriptors, () => undefined)
    .map((arrival) => [arrival.id, arrival.placement?.tier ?? null]));
  assert.equal(general.terminal, "primary");
  assert.equal(general["vendor.tool"], null, "elsewhere it keeps its standard tier");
});

test("the rail plan knows the Personal project, except while every project shares one interface", () => {
  try {
    replaceProjectPackageCatalog([]);
    setProjectCompositionContext("mine", undefined, { personal: true });
    assert.deepEqual(projectRailPlanContext("mine"), { composition: undefined, personal: true });
    setProjectInterfaceMode("shared");
    assert.equal(projectRailPlanContext("mine")?.personal, false, "a shared arrangement serves every project alike");
    setProjectInterfaceMode("per-project");
    setProjectCompositionContext("work", undefined);
    assert.deepEqual(projectRailPlanContext("work"), { composition: undefined, personal: false });
  } finally {
    setProjectInterfaceMode("per-project");
    resetProjectRelevanceForTest();
  }
});

test("the phone Workspace of a Personal project is its launchers and nothing else", () => {
  assert.deepEqual(DEFAULT_PANEL_WIDGETS.personal, []);
  assert.deepEqual(defaultPanelWidgetIds(["personal"]), []);
});

// The `defaultRails` of the capability registration carrying `idText`.
function railsOf(source: string, idText: string): string | null {
  const registration = source.split("capabilities.register(").slice(1)
    .find((chunk) => chunk.slice(0, 200).includes(idText));
  return registration === undefined ? null : /defaultRails: (\{[^}]*\})/.exec(registration)?.[1] ?? "";
}

test("of the framework tools, only Files asks for the Personal rails", async () => {
  assert.match(railsOf(await read("../../../packages/files/widgets/index.tsx"), 'id: "files"') ?? "", /personal: "right"/);
  for (const [path, id] of [
    ["../../../packages/git/widgets/index.tsx", "git"],
    ["../../../packages/terminal/widgets/index.tsx", "terminal"],
  ] as const) {
    const rails = railsOf(await read(path), `id: "${id}"`);
    assert.ok(rails !== null, `${id} registers its capability`);
    assert.doesNotMatch(rails, /personal/, `${id} stays off a Personal project's rails`);
  }
});

test("the Personal rails stay short: a few right-rail launchers, an empty top rail", async () => {
  // Every package's own choice, read generically (packages own their
  // `defaultRails`; joining the Personal rail is a reviewed decision).
  const packagesDir = new URL("../../../packages/", import.meta.url);
  const choices: string[] = [];
  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const widgets = new URL(`${entry.name}/widgets/`, packagesDir);
    const files = await readdir(widgets, { recursive: true }).catch(() => [] as string[]);
    for (const file of files.filter((name) => /\.tsx?$/.test(name))) {
      const source = await readFile(new URL(file, widgets), "utf8");
      for (const match of source.matchAll(/defaultRails: \{[^}]*\bpersonal: "(top|right)"/g)) choices.push(match[1]!);
    }
  }
  assert.ok(choices.length >= 1 && choices.length <= 4, `${choices.length} launchers ask for the Personal rails`);
  assert.ok(!choices.includes("top"), "nothing starts on a Personal project's top rail");
});

test("the tablet shortcut rail of a Personal project follows its rails, not the account's pinned set", async () => {
  const { personalShortcutIds } = await import("../src/personalProject.ts");
  const resolved = [
    { id: "session", tier: "primary" },
    { id: "notification-centre", tier: "more" },
    { id: "files", tier: "more" },
    { id: "git", tier: "technical" },
    { id: "terminal", tier: "technical" },
    { id: "schedule", tier: "more" },
    { id: "planner", tier: "more" },
    { id: "settings", tier: "more" },
  ];
  assert.deepEqual(personalShortcutIds(resolved, (id) => id !== "session"),
    ["files", "schedule", "planner", "notification-centre", "settings"],
    "its rail tools in order, then Notifications and Settings exactly once; nothing kept under More");
  const rail = await read("../src/components/mobile/MobileNavigationRail.tsx");
  assert.match(rail, /const pinnedIds = personal\s*\?\s*personalShortcutIds\(/);
  assert.match(rail, /isRailLauncherId,\s*\)\s*:\s*ui\.mobileShortcuts/);
  // Nor does its tablet header name the lone Personal project.
  const header = await read("../src/components/Header.tsx");
  assert.match(header, /const projectName = soloPersonal \? undefined : project\?\.name;/);
  assert.match(header, /compact \? projectName : undefined/);
  assert.match(header, /\{soloPersonal \? tr\("sidebar\.newChat"\) : projectName \|\| tr\("header\.polyth"\)\}/,
    "a new chat is titled as one, not with the project's name");
});
