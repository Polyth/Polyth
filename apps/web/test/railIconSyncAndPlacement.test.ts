import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { ProjectPresentationSettingsDto } from "@polyth/contracts";
import { mergeJson3 } from "../src/presentationMerge.ts";
import { autoPlacesContribution, defaultRailFor } from "../src/projectCompositionPlan.ts";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
const values = new Map<string, string>();
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  CustomEvent: dom.CustomEvent,
  localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  },
});

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test("three-way merge replays only local changes onto the newer server record", () => {
  const base = { widgets: { ha: { visible: true, title: "Home" }, git: { visible: true } }, order: ["a", "b", "c"] };
  // Another client hid HA and reordered; this device only repaired a title
  // and appended a new widget id.
  const server = { widgets: { ha: { visible: false, title: "Home" }, git: { visible: true } }, order: ["c", "a", "b"] };
  const local = { widgets: { ha: { visible: true, title: "Home status" }, git: { visible: true } }, order: ["a", "b", "c", "d"] };
  assert.deepEqual(mergeJson3(base, local, server), {
    widgets: { ha: { visible: false, title: "Home status" }, git: { visible: true } },
    order: ["c", "a", "b", "d"],
  });
  // Untouched local cache: the server wins outright, including deletions.
  assert.deepEqual(mergeJson3(base, base, {}), {});
  // A pure local reorder keeps the local order and the server's membership.
  assert.deepEqual(mergeJson3(["a", "b", "c"], ["c", "b", "a"], ["a", "b", "c", "x"]), ["c", "b", "a", "x"]);
  // Both sides created the same entry: the durable server copy wins.
  assert.deepEqual(mergeJson3({}, { ha: { visible: true } }, { ha: { visible: false } }), { ha: { visible: false } });
  // A genuine concurrent edit of one leaf: the pending local edit wins.
  assert.deepEqual(mergeJson3({ v: 1 }, { v: 2 }, { v: 3 }), { v: 2 });
});

test("automatic placement follows project directions", () => {
  const home = { directions: ["home", "operations"] as const, recommended: true };
  const typed = (directions: string[], packageOverrides: Record<string, "include" | "exclude"> = {}) =>
    ({ version: 1 as const, directions: directions as never, packageOverrides });
  assert.equal(autoPlacesContribution(typed(["home"]), "home-assistant", home, undefined), true);
  assert.equal(autoPlacesContribution(typed(["engineering"]), "home-assistant", home, undefined), false);
  // Untyped (General/legacy) projects never receive a direction-scoped package
  // on their own, but keep universal ones.
  assert.equal(autoPlacesContribution(typed([]), "home-assistant", home, undefined), false);
  assert.equal(autoPlacesContribution(undefined, "home-assistant", home, undefined), false);
  assert.equal(autoPlacesContribution(undefined, "gallery", {}, undefined), true);
  // The user's explicit project inclusion and host contributions always may.
  assert.equal(autoPlacesContribution(typed(["engineering"], { "home-assistant": "include" }), "home-assistant", home, undefined), true);
  assert.equal(autoPlacesContribution(typed(["engineering"]), undefined, undefined, undefined), true);
  // Typed projects keep the seed rule for universal packages.
  assert.equal(autoPlacesContribution(typed(["engineering"]), "gallery", {}, undefined), false);
  assert.equal(autoPlacesContribution(typed(["engineering"]), "gallery", { recommended: true }, undefined), true);
  // Session controls (Goal, Auto-approve, Dictation) are not chrome: a
  // universal package keeps them in every project; direction scope still holds.
  assert.equal(autoPlacesContribution(typed(["engineering"]), "goals", {}, undefined, "session"), true);
  assert.equal(autoPlacesContribution(typed(["engineering"]), "home-assistant", home, undefined, "session"), false);
  assert.equal(autoPlacesContribution(typed(["home"]), "home-assistant", home, undefined, "session"), true);
});

test("a stale device cache cannot bring back an icon hidden on another client", async () => {
  const { api } = await import("@polyth/session/web-api");
  const sync = await import("../src/projectPresentationSync.ts");
  const originalGet = api.projectPresentationSettings;
  const originalSave = api.projectPresentationSettingsSave;
  const visibleLayout = { widgets: { "home-assistant.status-action": { visible: true, title: "Home status" } } };
  const hiddenLayout = { widgets: { "home-assistant.status-action": { visible: false, title: "Home status" } } };
  // This device last synced revision 3 (icon visible) and still caches it.
  values.set("polyth.projectPresentationBase.v1.stale1", JSON.stringify({ widgetLayout: visibleLayout }));
  values.set("polyth.widgetLayout.stale1", JSON.stringify(visibleLayout));
  let release: ((value: ProjectPresentationSettingsDto) => void) | undefined;
  let server: ProjectPresentationSettingsDto = { revision: 4, updatedAt: 4, settings: { widgetLayout: hiddenLayout } };
  api.projectPresentationSettings = () => new Promise((resolve) => { release = resolve; });
  api.projectPresentationSettingsSave = async (_projectId, settings, opts) => {
    if (opts?.expectedRevision !== server.revision) throw Object.assign(new Error("stale"), { code: "conflict" });
    server = { revision: server.revision + 1, updatedAt: 5, settings };
    return structuredClone(server);
  };
  try {
    sync.initProjectPresentationSync(() => () => undefined, () => "stale1");
    await tick();
    // While the GET is in flight a package repairs widget metadata on top of
    // the stale cache — previously this made the whole stale layout win.
    values.set("polyth.widgetLayout.stale1", JSON.stringify({
      widgets: { "home-assistant.status-action": { visible: true, title: "Home status", kind: "mini-widget" } },
    }));
    sync.markProjectPresentationChanged("stale1", "widgetLayout");
    release!(structuredClone(server));
    await tick(600);
    const expected = { widgets: { "home-assistant.status-action": { visible: false, title: "Home status", kind: "mini-widget" } } };
    assert.deepEqual(JSON.parse(values.get("polyth.widgetLayout.stale1")!), expected);
    assert.deepEqual(server.settings.widgetLayout, expected, "the hidden choice survives the push");
    assert.equal(sync.isProjectPresentationSynced("stale1"), true);
    assert.deepEqual(JSON.parse(values.get("polyth.projectPresentationBase.v1.stale1")!).widgetLayout, expected);

    // A live frame from another client merges with a local edit at entry
    // level instead of the whole record.
    values.set("polyth.widgetLayout.stale1", JSON.stringify({
      widgets: { "home-assistant.status-action": { visible: false, title: "Home status", kind: "mini-widget" }, other: { visible: true } },
    }));
    sync.markProjectPresentationChanged("stale1", "widgetLayout");
    sync.applyRemoteProjectPresentation("stale1", {
      revision: server.revision + 1,
      updatedAt: 6,
      settings: { widgetLayout: { widgets: { "home-assistant.status-action": { visible: true, title: "Home status", kind: "mini-widget" } } } },
    });
    assert.deepEqual(JSON.parse(values.get("polyth.widgetLayout.stale1")!), {
      widgets: { "home-assistant.status-action": { visible: true, title: "Home status", kind: "mini-widget" }, other: { visible: true } },
    });

    // Another tab's write reaches this tab's in-memory stores.
    const seen: unknown[] = [];
    const onHydrated = (event: Event) => { seen.push((event as CustomEvent).detail); };
    window.addEventListener(sync.PROJECT_PRESENTATION_HYDRATED_EVENT, onHydrated);
    window.dispatchEvent(new dom.StorageEvent("storage", { key: "polyth.capabilityLayout.v1.stale1" }) as unknown as Event);
    window.removeEventListener(sync.PROJECT_PRESENTATION_HYDRATED_EVENT, onHydrated);
    assert.deepEqual(seen, [{ projectId: "stale1", keys: ["capabilityLayout"] }]);
  } finally {
    api.projectPresentationSettings = originalGet;
    api.projectPresentationSettingsSave = originalSave;
  }
});

test("new package widgets and rail capabilities appear only in projects of a matching direction", async () => {
  const relevance = await import("../src/packages/projectRelevance.ts");
  const { activateProject } = await import("../src/store.ts");
  const { ensureWidgets, getWidgetLayout } = await import("../src/widgets/widgetLayout.ts");
  const layout = await import("../src/capabilityLayout.ts");
  const { capabilityArrivalsFor } = await import("../src/capabilityArrivals.ts");
  relevance.replaceProjectPackageCatalog([
    { id: "home-assistant", name: "Home", description: "", core: false, enabled: true, hasSettings: false, category: "home", projectAffinity: { directions: ["home", "operations"], recommended: true } },
    { id: "goals", name: "Goals", description: "", core: false, enabled: true, hasSettings: false, category: "productivity" },
  ] as never);
  // Direction-aware reveal, shown on a rail it may claim. (The top-right
  // header rail is curated, so a package header icon is never revealed —
  // asserted below.)
  const status = {
    id: "home-assistant.status-action",
    pluginId: "home-assistant",
    ownerPackageId: "home-assistant",
    kind: "mini-widget" as const,
    defaultSlot: "workspace.rail" as const,
    defaultVisible: true,
  };
  const headerStatus = { ...status, id: "home-assistant.header-status", defaultSlot: "app.header.actions" as const };

  activateProject("eng1");
  // Composition not known yet: nothing is decided (or persisted).
  ensureWidgets([status]);
  assert.equal(getWidgetLayout().widgets[status.id], undefined);
  relevance.setProjectCompositionContext("eng1", { version: 1, directions: ["engineering"], packageOverrides: {} });
  ensureWidgets([status]);
  assert.equal(getWidgetLayout().widgets[status.id]?.visible, false, "available, but not shown in Engineering");
  // A universal package's session controls are not budgeted chrome: the
  // composer Goal stays visible in a typed project, while its dashboard
  // widget still waits to be added. The top-right header rail is curated
  // (Search, Notifications, Settings), so the header Goal starts hidden.
  const goal = (id: string, defaultSlot: "composer.leading" | "session.header.actions" | "workspace.right") => ({
    id, pluginId: "goals", ownerPackageId: "goals", kind: defaultSlot === "workspace.right" ? "widget" as const : "mini-widget" as const,
    defaultSlot, defaultVisible: true,
  });
  ensureWidgets([goal("goals.composer", "composer.leading"), goal("goals.header", "session.header.actions"), goal("goals.board", "workspace.right")]);
  assert.equal(getWidgetLayout().widgets["goals.composer"]?.visible, true, "composer Goal stays in Engineering");
  assert.equal(getWidgetLayout().widgets["goals.header"]?.visible, false, "the curated header rail offers the Goal, it does not show it");
  assert.equal(getWidgetLayout().widgets["goals.board"]?.visible, false, "dashboard widgets keep the chrome rule");

  activateProject("home1");
  relevance.setProjectCompositionContext("home1", { version: 1, directions: ["home"], packageOverrides: {} });
  ensureWidgets([status, headerStatus]);
  assert.equal(getWidgetLayout().widgets[status.id]?.visible, true, "shown on its own in a Home project");
  assert.equal(getWidgetLayout().widgets[headerStatus.id]?.visible, false, "the curated header rail only offers it");

  // Rail capabilities: a project that was never arranged receives its whole
  // default arrangement once, later arrivals are placed by direction, and a
  // user's choice is never re-decided.
  activateProject("eng2");
  const engineering = { version: 1 as const, directions: ["engineering" as const], packageOverrides: {} };
  relevance.setProjectCompositionContext("eng2", engineering);
  assert.deepEqual(relevance.projectRailPlanContext("eng2"), { composition: engineering, personal: false });
  const capability = (id: string, ownerPackageId?: string) => ({
    id, ownerPackageId, label: id, plainDescription: "", keywords: [], standardTier: "more" as const, standardRank: 9,
    open: () => undefined, available: () => true,
  });
  let seeds = 0;
  const seed = () => { seeds++; return { git: { tier: "primary" as const, rank: 1 } }; };
  assert.equal(layout.needsDefaultCapabilityLayout("eng2"), true);
  const first = capabilityArrivalsFor(engineering, [capability("git")], relevance.projectPackageAffinity);
  assert.equal(layout.recordCapabilityArrivals("eng2", first, seed), true);
  assert.deepEqual(layout.getCapabilityPlacements(), { git: { tier: "primary", rank: 1 } });
  assert.equal(layout.needsDefaultCapabilityLayout("eng2"), false);
  const arrivals = capabilityArrivalsFor(
    engineering,
    [capability("git"), capability("home-assistant", "home-assistant"), capability("context")],
    relevance.projectPackageAffinity,
  );
  layout.recordCapabilityArrivals("eng2", arrivals, seed);
  assert.equal(seeds, 1, "an arranged project is never re-seeded");
  assert.deepEqual(layout.getCapabilityPlacements(), {
    git: { tier: "primary", rank: 1 },
    "home-assistant": { tier: "technical", rank: 9 },
  });
  layout.setPlacementOverride("home-assistant", { tier: "more", rank: 3 });
  assert.equal(layout.recordCapabilityArrivals("eng2", arrivals, seed), false);
  assert.deepEqual(layout.getCapabilityPlacements()["home-assistant"], { tier: "more", rank: 3 });
  const stored = JSON.parse(values.get(layout.capabilityLayoutStorageKey("eng2"))!);
  assert.deepEqual(stored.seen, { git: true, "home-assistant": true, context: true }, "placement edits keep the arrival record");
  assert.equal(stored.defaults, undefined, "a rearranged project no longer counts as the default arrangement");
  assert.equal(layout.seedCapabilityLayoutForProject("eng2", { git: { tier: "more", rank: 0 } }, { replace: true }), false,
    "even project setup never replaces a person's own arrangement");
  assert.equal(relevance.projectRailPlanContext("unknown-project"), null);

  // A baseline written without the default plan (an older client, or a reset
  // record) and no placements is still arranged once; a customized one is not.
  activateProject("legacy1");
  relevance.setProjectCompositionContext("legacy1", undefined);
  values.set(layout.capabilityLayoutStorageKey("legacy1"), JSON.stringify({ version: 1, placements: {}, seen: { git: true } }));
  activateProject("eng2");
  activateProject("legacy1");
  assert.equal(layout.recordCapabilityArrivals("legacy1", [{ id: "git", placement: null }], seed), true);
  assert.deepEqual(layout.getCapabilityPlacements(), { git: { tier: "primary", rank: 1 } });
  activateProject("custom1");
  values.set(layout.capabilityLayoutStorageKey("custom1"), JSON.stringify({ version: 1, placements: { git: { tier: "more", rank: 4 } } }));
  activateProject("eng2");
  activateProject("custom1");
  layout.recordCapabilityArrivals("custom1", [{ id: "git", placement: null }], seed);
  assert.deepEqual(layout.getCapabilityPlacements(), { git: { tier: "more", rank: 4 } });

  // A seen, never-placed capability keeps its legacy tier; a never-seen one
  // starts on its standard tier.
  const action = { id: "custom-action.run.a", placement: null, legacyTier: "more", standardTier: "technical", standardRank: 24.001 } as const;
  const other = { id: "custom-action.run.b", placement: null, legacyTier: "more", standardTier: "technical", standardRank: 24.002 } as const;
  activateProject("mig1");
  values.set(layout.capabilityLayoutStorageKey("mig1"), JSON.stringify({
    version: 1,
    placements: { git: { tier: "more", rank: 4 } },
    seen: { git: true, [action.id]: true },
  }));
  activateProject("eng2");
  activateProject("mig1");
  layout.recordCapabilityArrivals("mig1", [{ id: "git", placement: null }, action, other], seed);
  const placements = layout.getCapabilityPlacements();
  assert.deepEqual(placements[action.id], { tier: "more", rank: 24.001 }, "seen without an override was showing on its old default");
  assert.equal(placements[other.id], undefined, "never seen: stays on the new standard tier");
  // An explicit placement always wins and a second pass changes nothing.
  layout.setPlacementOverride(action.id, { tier: "technical", rank: 1 });
  layout.recordCapabilityArrivals("mig1", [action], seed);
  assert.equal(layout.getCapabilityPlacements()[action.id]?.tier, "technical");
});

test("a project's include override does not auto-place command capabilities", () => {
  const composition = { version: 1, packageOverrides: { "custom-action": "include" } } as never;
  const base = { ownerPackageId: "custom-action", standardTier: "technical" as const, standardRank: 1, rail: true };
  assert.equal(defaultRailFor(composition, { ...base, id: "x", kind: "command" }), null);
  assert.equal(defaultRailFor(composition, { ...base, id: "y" }), "right", "a destination from an included package still lands on the right");
});
