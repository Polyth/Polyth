// Workbench persistence: versioned record round-trip, hardening, the pure
// migration from the legacy single-window record (polyth.workspacePane.v2),
// idempotence, and project isolation of the browser store — plus the store's
// profile activation/reset/fallback semantics on top of it.
import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKBENCH_PREFS_VERSION,
  emptyWorkbenchPrefs,
  migrateWorkspacePanePrefs,
  parseWorkbenchPrefs,
  restoreWorkbenchPrefs,
  serializeWorkbenchPrefs,
  workbenchPrefsKey,
} from "../src/workbench/prefs.ts";
import { layoutFromTemplate, openSurface, placementOf, setPresentation } from "../src/workbench/layout.ts";
import { CONVERSATION_TEMPLATE } from "../src/workbench/profiles.ts";
import { WORKSPACE_PANE_PREFS_VERSION, workspacePaneKey, type WorkspacePanePrefs } from "../src/workspace/panePrefs.ts";

const legacy = (over: Partial<WorkspacePanePrefs> = {}): WorkspacePanePrefs => ({
  version: WORKSPACE_PANE_PREFS_VERSION,
  openSurface: null,
  mode: "dynamic",
  previousMode: "dynamic",
  widths: {},
  heights: {},
  lastResource: {},
  ...over,
});

test("record round-trips and rejects other versions or junk", () => {
  const prefs = emptyWorkbenchPrefs();
  prefs.activeProfile = "authoring";
  prefs.profiles.authoring = {
    layout: openSurface(layoutFromTemplate(CONVERSATION_TEMPLATE), "files", { region: "end" }),
    customized: true,
  };
  prefs.lastResource = { git: "changes:a.ts" };
  assert.deepEqual(parseWorkbenchPrefs(serializeWorkbenchPrefs(prefs)), prefs);
  assert.equal(parseWorkbenchPrefs(null), null);
  assert.equal(parseWorkbenchPrefs("{not json"), null);
  assert.equal(parseWorkbenchPrefs(JSON.stringify({ version: 99 })), null);
  const hardened = parseWorkbenchPrefs(JSON.stringify({
    version: WORKBENCH_PREFS_VERSION,
    activeProfile: "bad id with spaces",
    profiles: { "": { layout: {} }, ok: { layout: null, customized: "yes" } },
    lastResource: { files: "", git: "changes:x", weird: 7 },
  }));
  assert.equal(hardened!.activeProfile, "conversation");
  assert.deepEqual(Object.keys(hardened!.profiles), ["ok"]);
  assert.equal(hardened!.profiles.ok!.customized, false);
  assert.deepEqual(hardened!.lastResource, { git: "changes:x" });
});

test("migration: pinned → docked end, dynamic → floating, fullscreen remembers its return", () => {
  const pinned = migrateWorkspacePanePrefs(legacy({ openSurface: "files", mode: "pinned", previousMode: "pinned" }));
  const pinnedLayout = pinned.profiles.conversation!.layout;
  assert.deepEqual(placementOf(pinnedLayout, "files"), { presentation: "docked", region: "end" });
  assert.deepEqual(pinnedLayout.regions.primary.surfaces, ["session"]);
  assert.equal(pinned.activeProfile, "conversation");

  const dynamic = migrateWorkspacePanePrefs(legacy({ openSurface: "git", mode: "dynamic" }));
  assert.deepEqual(placementOf(dynamic.profiles.conversation!.layout, "git"), { presentation: "floating" });

  const fullscreen = migrateWorkspacePanePrefs(legacy({ openSurface: "terminal", mode: "fullscreen", previousMode: "pinned" }));
  assert.deepEqual(placementOf(fullscreen.profiles.conversation!.layout, "terminal"), {
    presentation: "fullscreen", previous: { presentation: "docked", region: "end" },
  });
  const fullscreenDynamic = migrateWorkspacePanePrefs(legacy({ openSurface: "terminal", mode: "fullscreen", previousMode: "dynamic" }));
  assert.deepEqual(placementOf(fullscreenDynamic.profiles.conversation!.layout, "terminal"), {
    presentation: "fullscreen", previous: { presentation: "floating" },
  });
});

test("migration: widths/heights/dock heights become per-surface sizes; resources carry over", () => {
  const migrated = migrateWorkspacePanePrefs(legacy({
    openSurface: null,
    widths: { files: 520, git: 400 },
    heights: { files: 360, "terminal::dock": 240 },
    lastResource: { files: "file:src/app.ts", git: "changes:a.ts" },
  }));
  const layout = migrated.profiles.conversation!.layout;
  assert.deepEqual(layout.surfaceSizes, { files: { inline: 520, block: 360 }, git: { inline: 400 }, terminal: { dockBlock: 240 } });
  assert.deepEqual(migrated.lastResource, { files: "file:src/app.ts", git: "changes:a.ts" });
  // Nothing open: only Chat is placed.
  assert.deepEqual(layout.regions.end.surfaces, []);
  assert.deepEqual(layout.floating, []);
});

test("restore drops transient windows per profile but keeps docked layouts", () => {
  const prefs = emptyWorkbenchPrefs();
  let layout = openSurface(layoutFromTemplate(CONVERSATION_TEMPLATE), "files", { region: "end" });
  layout = openSurface(layout, "git", { presentation: "floating" });
  layout = setPresentation(layout, "files", "fullscreen");
  prefs.profiles.conversation = { layout, customized: false };
  const restored = restoreWorkbenchPrefs(prefs);
  const restoredLayout = restored.profiles.conversation!.layout;
  assert.deepEqual(restoredLayout.floating, []);
  assert.equal(restoredLayout.fullscreen, null);
  assert.deepEqual(placementOf(restoredLayout, "files"), { presentation: "docked", region: "end" });
  // The input record is not mutated.
  assert.deepEqual(prefs.profiles.conversation!.layout.floating, ["git"]);
});

test("browser store: migrates the legacy key once, isolates projects, and is idempotent", async () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string) { return values.get(key) ?? null; },
      setItem(key: string, value: string) { values.set(key, value); },
      removeItem(key: string) { values.delete(key); },
    },
  });
  const { readWorkbenchPrefs, resetWorkbenchPrefsCache, writeWorkbenchPrefs } = await import("../src/workbench/prefs.ts");
  resetWorkbenchPrefsCache();
  values.set(workspacePaneKey("p1"), JSON.stringify({
    version: 2, openSurface: "files", mode: "pinned", previousMode: "pinned",
    widths: { files: 480 }, heights: {}, lastResource: { files: "file:a.ts" },
  }));

  const p1 = readWorkbenchPrefs("p1");
  assert.deepEqual(placementOf(p1.profiles.conversation!.layout, "files"), { presentation: "docked", region: "end" });
  assert.equal(p1.profiles.conversation!.layout.surfaceSizes.files?.inline, 480);
  // New record written, legacy removed only after the write succeeded.
  assert.ok(values.has(workbenchPrefsKey("p1")));
  assert.equal(values.has(workspacePaneKey("p1")), false);
  // Project B has its own empty record — nothing copied from A.
  const p2 = readWorkbenchPrefs("p2");
  assert.deepEqual(p2.profiles, {});
  assert.deepEqual(p2.lastResource, {});

  // Idempotent: a second cold read parses the new record, not a migration.
  resetWorkbenchPrefsCache();
  const again = readWorkbenchPrefs("p1");
  assert.deepEqual(again, p1);

  // Writes persist and stay project-scoped (the record keeps the id; the
  // store decides availability when it loads).
  writeWorkbenchPrefs("p2", { ...p2, activeProfile: "authoring" });
  resetWorkbenchPrefsCache();
  assert.equal(readWorkbenchPrefs("p2").activeProfile, "authoring");
  assert.equal(readWorkbenchPrefs("p1").activeProfile, "conversation");
});

test("store: profile activation is gated, layouts are per profile, fallback keeps records", async () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string) { return values.get(key) ?? null; },
      setItem(key: string, value: string) { values.set(key, value); },
      removeItem(key: string) { values.delete(key); },
    },
  });
  const { resetWorkbenchPrefsCache } = await import("../src/workbench/prefs.ts");
  const { registerWorkbenchProfile, resetWorkbenchProfilesForTest } = await import("../src/workbench/profiles.ts");
  const store = await import("../src/workbench/store.ts");
  resetWorkbenchPrefsCache();
  resetWorkbenchProfilesForTest();
  store.resetWorkbenchForTest();
  store.setWorkbenchProject("p1");

  // Unknown or unavailable profiles are refused.
  assert.equal(store.activateWorkbenchProfile("authoring"), false);
  let available = false;
  const off = registerWorkbenchProfile({
    id: "authoring", label: "Writing", description: "", order: 10,
    available: () => available,
    defaultLayout: {
      surfaces: [
        { surface: "session", region: "start" },
        { surface: "resources", region: "primary" },
        { surface: "files", region: "end" },
      ],
      sizes: { start: 340 },
    },
  });
  assert.equal(store.activateWorkbenchProfile("authoring"), false);
  available = true;
  assert.equal(store.activateWorkbenchProfile("authoring"), true);
  assert.equal(store.getActiveProfileId(), "authoring");
  assert.deepEqual(store.getWorkbenchLayout().regions.start.surfaces, ["session"]);
  assert.equal(store.getWorkbenchLayout().sizes.start, 340);

  // Customizing marks the profile; the conversation layout is untouched.
  store.workbenchMoveSurface("session", "end");
  assert.equal(store.isLayoutCustomized(), true);
  assert.deepEqual(store.getWorkbenchLayout().regions.end.surfaces, ["files", "session"]);
  store.activateWorkbenchProfile("conversation");
  assert.deepEqual(store.getWorkbenchLayout().regions.primary.surfaces, ["session"]);
  assert.equal(store.isLayoutCustomized(), false);
  store.activateWorkbenchProfile("authoring");
  assert.deepEqual(store.getWorkbenchLayout().regions.end.surfaces, ["files", "session"]);

  // Reset returns only the active profile to its template.
  store.resetWorkbenchProfile();
  assert.deepEqual(store.getWorkbenchLayout().regions.start.surfaces, ["session"]);
  assert.equal(store.isLayoutCustomized(), false);

  // The owning package unloads: fall back to conversation, keep the record.
  store.workbenchMoveSurface("files", "start");
  off();
  assert.equal(store.getActiveProfileId(), "conversation");
  const persisted = JSON.parse(values.get(workbenchPrefsKey("p1"))!);
  assert.deepEqual(persisted.profiles.authoring.layout.regions.start.surfaces, ["session", "files"]);

  // Re-registering restores the customized layout.
  registerWorkbenchProfile({
    id: "authoring", label: "Writing", description: "", order: 10,
    defaultLayout: { surfaces: [{ surface: "session", region: "start" }] },
  });
  assert.equal(store.activateWorkbenchProfile("authoring"), true);
  assert.deepEqual(store.getWorkbenchLayout().regions.start.surfaces, ["session", "files"]);

  // Another project starts from defaults — nothing leaks across projects.
  store.setWorkbenchProject("p2");
  assert.equal(store.getActiveProfileId(), "conversation");
  assert.deepEqual(store.getWorkbenchLayout().regions.primary.surfaces, ["session"]);
  resetWorkbenchProfilesForTest();
});
