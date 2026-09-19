// UX-PANE-MODEL pure logic: container-geometry dock admission (320px Chat
// floor, remembered-width clamping, full-screen fallback), the workspace/
// contextual surface split, versioned project-scoped pane persistence, tab
// availability reconciliation, and the stable timeline-anchor record.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_FLOOR, clampDockWidth, contextSurfacesOf, decideDock, isWorkspaceSurface,
  paneDockEdge, paneDockOptions, paneWindowLayout, preferredOrDefaultWidth, workspaceSurfacesOf,
  type DockGeometry, type PaneWindowLayoutInput, type RailSurface, type WorkspacePanePresentation,
} from "../src/surfaces.ts";
import {
  WORKSPACE_PANE_PREFS_VERSION, emptyWorkspacePanePrefs, parseWorkspacePanePrefs,
  serializeWorkspacePanePrefs, workspacePaneKey, type WorkspacePanePrefs,
} from "../src/workspace/panePrefs.ts";
import { emptyPane, openTab, reconcileAvailability, tabId, type PaneState } from "../src/workspace/paneStore.ts";
import { parseTimelineAnchor } from "../src/timelineAnchor.ts";

const pres = (over: Partial<WorkspacePanePresentation> = {}): WorkspacePanePresentation => ({
  kind: "workspace", defaultRatio: 0.6, minWidth: 380, preferredMaxWidth: 760,
  keepAlive: true, escape: "close", ...over,
});

const geo = (workspaceWidth: number, chrome = 6): DockGeometry => ({ workspaceWidth, chrome });

// ---- dock admission -------------------------------------------------------

test("dock: wide geometry admits at the default ratio when nothing is remembered", () => {
  // 1440px workspace: maxPane = 1440 - 320 - 6 = 1114; candidate = min(864, 760, 1114).
  const d = decideDock(null, pres(), geo(1440));
  assert.equal(d.dock, true);
  assert.equal(d.width, 760); // preferredMaxWidth caps the 0.6 ratio (864)
  assert.equal(d.maxPane, 1114);
});

test("dock: a remembered width beats the ratio and is geometry-clamped, not dropped", () => {
  // Remembered 640 with 1100px workspace: maxPane = 774 → 640 fits untouched.
  assert.equal(decideDock(640, pres(), geo(1100)).width, 640);
  // Narrower: maxPane = 900 - 320 - 6 = 574 → clamped to 574, still docked.
  const clamped = decideDock(640, pres({ minWidth: 380 }), geo(900));
  assert.equal(clamped.dock, true);
  assert.equal(clamped.width, 574);
});

test("dock: falls back to full-screen when minWidth plus the Chat floor cannot both fit", () => {
  // 700px workspace: maxPane = 374 < minWidth 380 → never squeeze Chat below 320.
  const d = decideDock(640, pres({ minWidth: 380 }), geo(700));
  assert.equal(d.dock, false);
  // The Chat floor is part of the exported contract, not a private constant.
  assert.equal(CHAT_FLOOR, 320);
});

test("dock: boundary — candidate exactly at minWidth docks", () => {
  // workspace = 320 + 6 + 380 → maxPane = 380 = minWidth.
  const d = decideDock(9999, pres({ minWidth: 380 }), geo(706));
  assert.equal(d.dock, true);
  assert.equal(d.width, 380);
});

test("preferredOrDefaultWidth: garbage remembered values fall back to the ratio", () => {
  assert.equal(preferredOrDefaultWidth(null, pres({ defaultRatio: 0.5 }), geo(1000)), 500);
  assert.equal(preferredOrDefaultWidth(Number.NaN, pres({ defaultRatio: 0.5 }), geo(1000)), 500);
  assert.equal(preferredOrDefaultWidth(-5, pres({ defaultRatio: 0.5 }), geo(1000)), 500);
  assert.equal(preferredOrDefaultWidth(421.4, pres(), geo(1000)), 421);
});

test("clampDockWidth: separator range is [minWidth, maxPane]", () => {
  const p = pres({ minWidth: 380 });
  const g = geo(1200); // maxPane = 874
  assert.equal(clampDockWidth(100, p, g), 380);
  assert.equal(clampDockWidth(2000, p, g), 874);
  assert.equal(clampDockWidth(500.6, p, g), 501);
});

// ---- workspace/context split ------------------------------------------------

test("surfaces split into workspace panes and contextual panels by presentation", () => {
  const s = (id: string, presentation?: WorkspacePanePresentation): RailSurface => ({
    id, title: id, order: 0, component: () => null, ...(presentation ? { presentation } : {}),
  });
  const all = [s("files", pres()), s("context"), s("git", pres()), s("usage")];
  assert.deepEqual(workspaceSurfacesOf(all).map((x) => x.id), ["files", "git"]);
  assert.deepEqual(contextSurfacesOf(all).map((x) => x.id), ["context", "usage"]);
  assert.equal(isWorkspaceSurface(s("files", pres())), true);
  assert.equal(isWorkspaceSurface(s("context")), false);
});

test("paneDockEdge: optional dock defaults to side, only explicit bottom flips", () => {
  assert.equal(paneDockEdge(undefined), "side");
  assert.equal(paneDockEdge(pres()), "side");
  assert.equal(paneDockEdge(pres({ dock: "side" })), "side");
  assert.equal(paneDockEdge(pres({ dock: "bottom" })), "bottom");
});

test("paneDockOptions: package-declared edges control the pinned-window actions", () => {
  assert.deepEqual(paneDockOptions(pres()), ["side"]);
  assert.deepEqual(paneDockOptions(pres({ dock: "bottom" })), ["bottom"]);
  assert.deepEqual(
    paneDockOptions(pres({ dock: "bottom", dockOptions: ["bottom", "side", "bottom"] })),
    ["bottom", "side"],
  );
  assert.equal(paneDockEdge(pres({ dock: "bottom", dockOptions: ["bottom", "side"] }), "side"), "side");
  assert.equal(paneDockEdge(pres({ dock: "bottom", dockOptions: ["bottom"] }), "side"), "bottom");
});

// ---- pinned window layout -----------------------------------------------------

test("paneWindowLayout: a side dock that cannot fit promotes to the layer, never the bottom strip", () => {
  const input = (over: Partial<PaneWindowLayoutInput> = {}): PaneWindowLayoutInput => ({
    isWorkspacePane: true, compact: false, paneMode: "pinned", dockEdge: "side",
    measured: true, admits: true, guardPromoted: false, ...over,
  });
  // Wide enough: the classic side dock. No bottom classes anywhere.
  const side = paneWindowLayout(input());
  assert.equal(side.layered, false);
  assert.equal(side.bottomDock, false);
  assert.equal(side.pinnedNarrow, false);
  // Too narrow for the side dock: full-screen fallback, still no bottom strip.
  const fallback = paneWindowLayout(input({ admits: false }));
  assert.equal(fallback.layered, true, "an admitted-nowhere side pane uses the full-screen layer");
  assert.equal(fallback.bottomDock, false);
  assert.equal(fallback.pinnedNarrow, false, "the bottom strip is not a side-dock fallback");
  // The guard's promotion behaves the same way.
  const guarded = paneWindowLayout(input({ guardPromoted: true }));
  assert.equal(guarded.layered, true);
  assert.equal(guarded.pinnedNarrow, false);
});

test("paneWindowLayout: the bottom edge keeps the strip; compact forces full screen", () => {
  const input = (over: Partial<PaneWindowLayoutInput> = {}): PaneWindowLayoutInput => ({
    isWorkspacePane: true, compact: false, paneMode: "pinned", dockEdge: "bottom",
    measured: true, admits: true, guardPromoted: false, ...over,
  });
  const bottom = paneWindowLayout(input());
  assert.equal(bottom.bottomDock, true);
  assert.equal(bottom.pinnedNarrow, true);
  assert.equal(bottom.layered, false);
  // A deliberate bottom dock is never "unfitted" into the layer.
  const narrowBottom = paneWindowLayout(input({ admits: false, guardPromoted: true }));
  assert.equal(narrowBottom.layered, false);
  assert.equal(narrowBottom.pinnedNarrow, true);
  // Compact shells present every workspace package full screen.
  const compact = paneWindowLayout(input({ compact: true, dockEdge: "side" }));
  assert.equal(compact.effectiveMode, "fullscreen");
  assert.equal(compact.layered, true);
  assert.equal(compact.pinned, false);
  assert.equal(compact.pinnedNarrow, false);
});

// ---- project-scoped persistence ----------------------------------------------

test("panePrefs: round-trip keeps surface, mode, dimensions, and resources", () => {
  const prefs: WorkspacePanePrefs = {
    version: WORKSPACE_PANE_PREFS_VERSION,
    openSurface: "files",
    mode: "fullscreen",
    previousMode: "pinned",
    widths: { files: 520, git: 400 },
    heights: { files: 360 },
    lastResource: { files: "file:src/app.ts", git: "changes:a.ts" },
  };
  assert.deepEqual(parseWorkspacePanePrefs(serializeWorkspacePanePrefs(prefs)), prefs);
});

test("panePrefs: garbage, wrong version, and absurd widths fall back safely", () => {
  assert.deepEqual(parseWorkspacePanePrefs(null), emptyWorkspacePanePrefs);
  assert.deepEqual(parseWorkspacePanePrefs("not-json{"), emptyWorkspacePanePrefs);
  assert.deepEqual(parseWorkspacePanePrefs(JSON.stringify({ version: 99, openSurface: "files" })), emptyWorkspacePanePrefs);
  const p = parseWorkspacePanePrefs(JSON.stringify({
    version: 1,
    openSurface: "",
    mode: "bogus",
    widths: { files: 12, git: 99999, term: Number.NaN, ok: 431.7 },
    heights: { tiny: 119, ok: 320.4 },
    lastResource: { files: "", git: "changes:x.ts", weird: 7 },
    dockEdges: { files: "bottom", invalid: "diagonal" },
  }));
  assert.equal(p.openSurface, null); // empty string is not a surface
  assert.equal(p.mode, "dynamic");
  assert.deepEqual(p.widths, { ok: 432 }); // sanity bounds + rounding
  assert.deepEqual(p.heights, { ok: 320 });
  assert.deepEqual(p.lastResource, { git: "changes:x.ts" });
  assert.deepEqual(p.dockEdges, { files: "bottom" });
});

test("panePrefs: v1 expanded migrates directly to fullscreen with dynamic restore", () => {
  const migrated = parseWorkspacePanePrefs(JSON.stringify({
    version: 1,
    openSurface: "files",
    expanded: true,
    widths: { files: 520 },
    lastResource: {},
  }));
  assert.equal(migrated.version, 2);
  assert.equal(migrated.mode, "fullscreen");
  assert.equal(migrated.previousMode, "dynamic");
  assert.deepEqual(migrated.heights, {});
});

test("panePrefs: storage keys are per project — records cannot collide", () => {
  assert.notEqual(workspacePaneKey("p1"), workspacePaneKey("p2"));
  assert.match(workspacePaneKey("p1"), /^polyth\.workspacePane\.v2\./);
});

test("panePrefs: browser store isolates projects and resets mode on close", async () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string) { return values.get(key) ?? null; },
      setItem(key: string, value: string) { values.set(key, value); },
      removeItem(key: string) { values.delete(key); },
    },
  });
  const {
    getWorkspacePanePrefs, resetWorkspacePanePrefsCache, setPersistedPaneMode,
    setPaneDockEdge, setPaneDynamicHeight, setPaneOpenSurface, setPanePreferredWidth,
  } = await import("../src/workspace/panePrefs.ts");
  resetWorkspacePanePrefsCache();

  setPaneOpenSurface("p1", "files");
  setPersistedPaneMode("p1", { mode: "fullscreen", previousMode: "pinned" });
  setPanePreferredWidth("p1", "files", 520);
  setPaneDynamicHeight("p1", "files", 360);
  setPaneDockEdge("p1", "files", "side");
  // Project B stays untouched — one project's layout never replicates.
  assert.deepEqual(getWorkspacePanePrefs("p2"), emptyWorkspacePanePrefs);
  assert.equal(getWorkspacePanePrefs("p1").openSurface, "files");
  assert.equal(getWorkspacePanePrefs("p1").mode, "fullscreen");
  assert.equal(getWorkspacePanePrefs("p1").widths.files, 520);
  assert.equal(getWorkspacePanePrefs("p1").dockEdges?.files, "side");

  // Closing the pane resets mode so the next open starts dynamic.
  setPaneOpenSurface("p1", null);
  assert.equal(getWorkspacePanePrefs("p1").openSurface, null);
  assert.equal(getWorkspacePanePrefs("p1").mode, "dynamic");
  assert.equal(getWorkspacePanePrefs("p1").widths.files, 520); // width survives
  assert.equal(getWorkspacePanePrefs("p1").heights.files, 360); // height survives

  // The record round-trips through storage, not just the in-memory cache.
  resetWorkspacePanePrefsCache();
  assert.equal(getWorkspacePanePrefs("p1").widths.files, 520);
  assert.equal(getWorkspacePanePrefs("p1").dockEdges?.files, "side");
});

// ---- tab availability reconciliation -------------------------------------------

test("reconcileAvailability: late providers heal tabs, unloads flag them, never dropped", () => {
  let s: PaneState = emptyPane;
  s = openTab(s, { id: tabId("file", "a.ts"), kind: "file", resource: "a.ts", title: "a.ts" });
  s = openTab(s, { id: tabId("notebook", "n1"), kind: "notebook", resource: "n1", title: "n1" });

  // The notebook provider is not registered yet → honest unavailable flag.
  const flagged = reconcileAvailability(s, (kind) => kind === "file");
  assert.equal(flagged.tabs.length, 2);
  assert.equal(flagged.tabs[1]!.unavailable, true);
  assert.equal(flagged.tabs[0]!.unavailable, undefined);

  // Provider arrives late → the same tab becomes usable again.
  const healed = reconcileAvailability(flagged, () => true);
  assert.equal(healed.tabs[1]!.unavailable, undefined);

  // No change → the same state object (no render churn).
  assert.equal(reconcileAvailability(healed, () => true), healed);
});

// ---- stable timeline anchor ----------------------------------------------------

test("timelineAnchor: parses stable records and rejects garbage", () => {
  assert.deepEqual(
    parseTimelineAnchor(JSON.stringify({ id: "m7", offset: -12.5, atBottom: false })),
    { id: "m7", offset: -12.5, atBottom: false },
  );
  assert.deepEqual(
    parseTimelineAnchor(JSON.stringify({ id: null, offset: 0, atBottom: true })),
    { id: null, offset: 0, atBottom: true },
  );
  assert.equal(parseTimelineAnchor(null), null);
  assert.equal(parseTimelineAnchor("junk{"), null);
  // Not restorable: no anchored row and not at the bottom.
  assert.equal(parseTimelineAnchor(JSON.stringify({ id: null, atBottom: false })), null);
  // A raw scrollTop-style record (no id) is never accepted as an anchor.
  assert.equal(parseTimelineAnchor(JSON.stringify({ scrollTop: 4200 })), null);
});
