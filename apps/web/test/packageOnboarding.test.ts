// Package onboarding tours: registry register/replace/unregister, versioned
// localStorage skip prefs (skip-this vs skip-all vs preview), the controller's
// auto-show-once semantics, the settings pageId → packageId mapping, and the
// installer wiring (tours appear/disappear with package enable/disable).
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import type { PackageDescriptorDto, PackageOnboardingTour } from "@polyth/contracts";

register("./tsxHooks.mjs", import.meta.url);

// Tour prefs persist through localStorage; give node a stub before import.
const stored = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); },
    removeItem: (key: string) => { stored.delete(key); },
  },
});

// packagesList fake so bootPackages can run the real installers.
const descriptors = new Map<string, PackageDescriptorDto>([
  ["models", {
    id: "models",
    name: "Providers & Models",
    description: "Model configuration.",
    core: true,
    enabled: true,
    hasSettings: true,
  }],
  ["git", {
    id: "git",
    name: "Git",
    description: "Source control.",
    core: true,
    enabled: true,
    hasSettings: true,
  }],
  ["dictation", {
    id: "dictation",
    name: "Voice & Dictation",
    description: "Voice controls.",
    core: false,
    enabled: true,
    hasSettings: true,
  }],
  ["usage", {
    id: "usage",
    name: "Usage",
    description: "Usage reporting.",
    core: false,
    enabled: true,
    hasSettings: true,
  }],
  ["github", {
    id: "github",
    name: "GitHub",
    description: "GitHub integration.",
    core: false,
    enabled: true,
    hasSettings: false,
  }],
  ["knowledge", {
    id: "knowledge",
    name: "Knowledge",
    description: "Project knowledge.",
    core: false,
    enabled: true,
    hasSettings: false,
  }],
  ["home-assistant", {
    id: "home-assistant",
    name: "Home Assistant",
    description: "Home controls.",
    core: false,
    enabled: true,
    hasSettings: true,
  }],
  ["secure-safe", {
    id: "secure-safe",
    name: "Secure Safe",
    description: "Credential handles.",
    core: false,
    enabled: true,
    hasSettings: true,
  }],
  ["mcp", {
    id: "mcp",
    name: "MCP",
    description: "MCP servers.",
    core: false,
    enabled: true,
    hasSettings: true,
  }],
  ["commands", {
    id: "commands",
    name: "Commands",
    description: "Reusable commands.",
    core: false,
    enabled: true,
    hasSettings: true,
  }],
  ["plugins", {
    id: "plugins",
    name: "Plugins",
    description: "Managed plugins.",
    core: false,
    enabled: true,
    hasSettings: true,
  }],
  ["integrations", {
    id: "integrations",
    name: "Integrations",
    description: "External integrations.",
    core: false,
    enabled: true,
    hasSettings: true,
  }],
  ["ssh", {
    id: "ssh",
    name: "SSH Remotes",
    description: "Remote servers over SSH.",
    core: false,
    enabled: true,
    hasSettings: true,
  }],
]);

Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async (input: string | URL | Request) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => String(input).endsWith("/packages-manifest.json")
      ? { packages: [] }
      : { packages: [...descriptors.values()] },
    text: async () => "",
  }),
});

const {
  getPackageOnboarding, listPackageOnboardings,
  registerPackageOnboarding, subscribePackageOnboardings,
} = await import("../src/packages/onboarding/registry.ts");
const {
  PACKAGE_TOUR_PREFS_KEY, getPackageTourPrefs, isPackageTourAutoShow,
  markPackageTourSeen, parsePackageTourPrefs, resetPackageTour,
} = await import("../src/packages/onboarding/prefs.ts");
const {
  closePackageTour, getPackageTourState, maybeAutoShowPackageTour,
  nextPackageTourStep, openPackageTour, previousPackageTourStep, setPackageTourStep,
} = await import("../src/packages/onboarding/controller.ts");
const { canonicalTourPackageId, settingsPageToPackageId } =
  await import("../src/packages/onboarding/pageMap.ts");
// Importing the package registry also registers the built-in tours.
const { bootPackages } = await import("../src/packages/registry.ts");
const { registerBuiltinPackageTours } = await import("../src/packages/onboarding/builtinTours.ts");

const makeTour = (packageId: string, steps = 2): PackageOnboardingTour => ({
  packageId,
  title: packageId,
  steps: Array.from({ length: steps }, (_, index) => ({
    id: `step-${index}`,
    title: `Step ${index + 1}`,
    body: "Body copy.",
    media: { kind: "pattern", pattern: "orbit" },
  })),
});

test("registry: register/get/list, same-id replacement, stale unregister no-op", () => {
  let notifications = 0;
  const unsubscribe = subscribePackageOnboardings(() => { notifications++; });

  const first = makeTour("reg-a");
  const offFirst = registerPackageOnboarding(first);
  assert.equal(getPackageOnboarding("reg-a"), first);
  assert.ok(listPackageOnboardings().some((item) => item.packageId === "reg-a"));
  assert.equal(notifications, 1);

  const second = makeTour("reg-a", 3);
  const offSecond = registerPackageOnboarding(second);
  assert.equal(getPackageOnboarding("reg-a"), second, "same-id registration replaces");

  offFirst();
  assert.equal(getPackageOnboarding("reg-a"), second, "superseded unregister is a no-op");

  offSecond();
  assert.equal(getPackageOnboarding("reg-a"), undefined);
  assert.equal(listPackageOnboardings().some((item) => item.packageId === "reg-a"), false);

  const offEmpty = registerPackageOnboarding({ packageId: "reg-empty", title: "Empty", steps: [] });
  assert.equal(getPackageOnboarding("reg-empty"), undefined, "step-less tours are not registered");
  offEmpty();
  unsubscribe();
});

test("prefs parser survives garbage and drops malformed entries", () => {
  assert.equal(PACKAGE_TOUR_PREFS_KEY, "polyth.packageTours.v1", "key is versioned");
  assert.deepEqual(parsePackageTourPrefs(null), { skippedAll: false, completed: {} });
  assert.deepEqual(parsePackageTourPrefs("not json"), { skippedAll: false, completed: {} });
  assert.deepEqual(parsePackageTourPrefs("[1,2]"), { skippedAll: false, completed: {} });
  assert.deepEqual(
    parsePackageTourPrefs(JSON.stringify({ skippedAll: true, completed: { git: true } })),
    { skippedAll: true, completed: { git: true } },
  );
  // Non-true values, empty keys, and wrong shapes are dropped.
  assert.deepEqual(
    parsePackageTourPrefs(JSON.stringify({ skippedAll: "yes", completed: { a: true, b: 1, "": true } })),
    { skippedAll: false, completed: { a: true } },
  );
});

test("pageId → packageId: builtin pages, slot meta, aliases, unknown pages", () => {
  assert.equal(settingsPageToPackageId("packages", []), "packages");
  assert.equal(settingsPageToPackageId("widgets", []), null, "Widgets & Layout is not a settings page");
  assert.equal(settingsPageToPackageId("voice", []), null, "slot pages need their slot item");
  assert.equal(settingsPageToPackageId("not-a-page", []), null);

  const slotItems = [
    { id: "voice", meta: { pageId: "voice", packageId: "dictation", label: "Voice" } },
    { id: "acme.tools", meta: { packageId: "acme" } },
    { id: "orphan", meta: {} },
  ];
  assert.equal(settingsPageToPackageId("voice", slotItems), "voice", "meta.packageId wins, alias canonicalized");
  assert.equal(settingsPageToPackageId("slot:acme.tools", slotItems), "acme", "fallback page id is slot:<id>");
  assert.equal(settingsPageToPackageId("slot:orphan", slotItems), null, "slot page without packageId has no tour owner");

  assert.equal(canonicalTourPackageId("dictation"), "voice");
  assert.equal(canonicalTourPackageId("git"), "git");
});

test("skip this package blocks only that tour; reset restores it", () => {
  assert.equal(isPackageTourAutoShow("pref-a"), true);
  assert.equal(isPackageTourAutoShow("pref-b"), true);

  markPackageTourSeen("pref-a");
  assert.equal(isPackageTourAutoShow("pref-a"), false);
  assert.equal(isPackageTourAutoShow("pref-b"), true, "other packages stay eligible");
  assert.match(stored.get(PACKAGE_TOUR_PREFS_KEY) ?? "", /"pref-a":true/, "flag persisted under versioned key");

  resetPackageTour("pref-a");
  assert.equal(isPackageTourAutoShow("pref-a"), true);
});

test("auto-show opens once per session; Esc-dismiss persists nothing", () => {
  const off = registerPackageOnboarding(makeTour("alpha"));
  assert.equal(maybeAutoShowPackageTour("alpha"), true);
  const state = getPackageTourState();
  assert.equal(state?.tour.packageId, "alpha");
  assert.equal(state?.mode, "first-run");
  assert.equal(state?.step, 0);

  closePackageTour("dismiss");
  assert.equal(getPackageTourState(), null);
  assert.equal(getPackageTourPrefs().completed["alpha"], undefined, "dismiss writes nothing");
  assert.equal(isPackageTourAutoShow("alpha"), true, "still eligible on the next app session");
  assert.equal(maybeAutoShowPackageTour("alpha"), false, "but not again within this session");
  off();
});

test("finishing (Done) or skipping persists and blocks future auto-show", () => {
  const offBeta = registerPackageOnboarding(makeTour("beta", 2));
  assert.equal(maybeAutoShowPackageTour("beta"), true);
  nextPackageTourStep();
  assert.equal(getPackageTourState()?.step, 1);
  nextPackageTourStep(); // Next on the last step = Done
  assert.equal(getPackageTourState(), null);
  assert.equal(getPackageTourPrefs().completed["beta"], true);
  assert.equal(isPackageTourAutoShow("beta"), false);

  const offGamma = registerPackageOnboarding(makeTour("gamma"));
  assert.equal(maybeAutoShowPackageTour("gamma"), true);
  closePackageTour("skip");
  assert.equal(getPackageTourPrefs().completed["gamma"], true);
  assert.equal(isPackageTourAutoShow("gamma"), false);
  offBeta();
  offGamma();
});

test("step navigation clamps at both ends", () => {
  const off = registerPackageOnboarding(makeTour("stepper", 3));
  assert.equal(openPackageTour("stepper", "preview"), true);
  previousPackageTourStep();
  assert.equal(getPackageTourState()?.step, 0, "no step before the first");
  setPackageTourStep(99);
  assert.equal(getPackageTourState()?.step, 2, "clamped to the last step");
  setPackageTourStep(-5);
  assert.equal(getPackageTourState()?.step, 0);
  closePackageTour("dismiss");
  off();
  assert.equal(openPackageTour("stepper", "preview"), false, "unregistered tours never open");
});

test("skip all onboardings stops every auto-show; preview still opens", () => {
  const offDelta = registerPackageOnboarding(makeTour("delta"));
  assert.equal(maybeAutoShowPackageTour("delta"), true);
  closePackageTour("skip-all");
  assert.equal(getPackageTourPrefs().skippedAll, true);

  const offEpsilon = registerPackageOnboarding(makeTour("epsilon"));
  assert.equal(maybeAutoShowPackageTour("epsilon"), false, "never-seen tours stay closed after skip-all");

  assert.equal(openPackageTour("epsilon", "preview"), true, "preview ignores skip-all");
  assert.equal(getPackageTourState()?.mode, "preview");
  closePackageTour("dismiss");

  assert.equal(openPackageTour("gamma", "preview"), false, "gamma tour was disposed above");
  const offGamma = registerPackageOnboarding(makeTour("gamma"));
  assert.equal(openPackageTour("gamma", "preview"), true, "preview ignores per-package skip flags too");
  closePackageTour("dismiss");
  offDelta();
  offEpsilon();
  offGamma();
});

test("every built-in package surface has a substantial onboarding tour", async () => {
  registerBuiltinPackageTours();
  await bootPackages();

  const expectedPackageIds = [
    "session", "files", "projects", "behavior", "models", "permissions",
    "notifications", "appearance", "general", "chat", "sessions", "shortcuts",
    "access", "about", "git", "terminal", "browser", "goals",
    "multirun", "workflow", "fusion", "walkthrough", "schedule", "usage",
    "github", "knowledge", "voice", "home-assistant", "secure-safe", "mcp",
    "commands", "plugins", "integrations", "ssh", "packages",
    // Catalog-only: production BUILTIN_PACKAGES does not advertise `agents`.
    // The tour stays registered for a future Roles surface and must not be
    // confused with a live package descriptor from /api/packages.
    "agents",
  ];

  assert.equal(descriptors.has("agents"), false, "onboarding fixture must not fake a live Roles package");
  assert.ok(getPackageOnboarding("agents"), "Roles tour remains catalog-only");

  for (const packageId of expectedPackageIds) {
    const tour = getPackageOnboarding(packageId);
    assert.ok(tour, `${packageId} has an onboarding tour`);
    assert.ok(tour.steps.length >= 2, `${packageId} tour has at least two steps`);
  }
  assert.equal(getPackageOnboarding("dictation"), undefined, "voice is the only canonical dictation tour id");
});

test("package tour catalog remains available while package state changes", async () => {
  assert.ok(getPackageOnboarding("packages"), "builtin Packages tour registered at registry import");

  await bootPackages();
  assert.ok(getPackageOnboarding("git"), "Git tour is registered");
  assert.ok(getPackageOnboarding("voice"), "dictation aliases to the voice tour");

  descriptors.get("git")!.enabled = false;
  descriptors.get("dictation")!.enabled = false;
  await bootPackages();
  assert.ok(getPackageOnboarding("git"), "tour metadata stays available for package previews");
  assert.ok(getPackageOnboarding("voice"));
  assert.ok(getPackageOnboarding("packages"), "builtin tours are independent of package sync");
});
