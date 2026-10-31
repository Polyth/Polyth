// Workbench layout reducer: pure, DOM-free coverage of placement invariants,
// move/swap/make-primary, presentation transitions (docked/floating/fullscreen
// and the exact-return rule), collapse/resize, transient handling at
// restore/session boundaries, template application, and parse hardening.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_SURFACE_ID,
  activateSurface,
  closeSurface,
  closeTransient,
  emptyLayout,
  exitFullscreen,
  focalSurface,
  isCompanionShaped,
  layoutFromTemplate,
  makePrimary,
  moveSurface,
  openSurface,
  parseLayout,
  placedSurfaces,
  placementOf,
  reorderSurface,
  resetSurfacePosition,
  resizeRegion,
  resizeSurface,
  setActive,
  setCollapsed,
  setPresentation,
  swapSurfaces,
  withoutTransient,
  type WorkbenchLayout,
} from "../src/workbench/layout.ts";
import { CONVERSATION_TEMPLATE } from "../src/workbench/profiles.ts";

const authoring = () => layoutFromTemplate({
  surfaces: [
    { surface: "session", region: "start" },
    { surface: "resources", region: "primary" },
    { surface: "files", region: "end", active: true },
    { surface: "outline", region: "end" },
    { surface: "terminal", region: "bottom" },
  ],
  sizes: { start: 340, end: 300, bottom: 220 },
  collapsed: ["bottom"],
});

test("template: docks every entry once, honours active/sizes/collapsed, records homes", () => {
  const layout = authoring();
  assert.deepEqual(layout.regions.start, { surfaces: ["session"], active: "session" });
  assert.deepEqual(layout.regions.primary, { surfaces: ["resources"], active: "resources" });
  assert.deepEqual(layout.regions.end, { surfaces: ["files", "outline"], active: "files" });
  assert.deepEqual(layout.regions.bottom, { surfaces: ["terminal"], active: "terminal" });
  assert.equal(layout.sizes.start, 340);
  assert.equal(layout.sizes.bottom, 220);
  assert.equal(layout.collapsed.bottom, true);
  assert.equal(layout.homes.files, "end");
  // A duplicate entry never places a surface twice.
  const dup = layoutFromTemplate({ surfaces: [{ surface: "a", region: "end" }, { surface: "a", region: "start" }] });
  assert.deepEqual(placedSurfaces(dup), ["a"]);
});

test("open: docks into the preferred/allowed region, activates, and is idempotent", () => {
  let layout = layoutFromTemplate(CONVERSATION_TEMPLATE);
  assert.equal(isCompanionShaped(layout), true);
  layout = openSurface(layout, "files", {}, { allowedRegions: ["end", "start"], preferredRegion: "end" });
  assert.deepEqual(placementOf(layout, "files"), { presentation: "docked", region: "end" });
  // A disallowed explicit region is refused (no-op).
  const refused = openSurface(layout, "git", { region: "bottom" }, { allowedRegions: ["end"], preferredRegion: "end" });
  assert.equal(refused, layout);
  // Re-opening an already-placed surface just activates it.
  layout = openSurface(layout, "git", {});
  assert.deepEqual(layout.regions.end, { surfaces: ["files", "git"], active: "git" });
  const again = openSurface(layout, "files", {});
  assert.equal(again.regions.end.active, "files");
  assert.equal(openSurface(again, "files", {}), again);
});

test("open floating and fullscreen presentations", () => {
  let layout = layoutFromTemplate(CONVERSATION_TEMPLATE);
  layout = openSurface(layout, "files", { presentation: "floating" });
  assert.deepEqual(placementOf(layout, "files"), { presentation: "floating" });
  assert.equal(focalSurface(layout), "files");
  layout = openSurface(layout, "git", { presentation: "fullscreen" });
  assert.deepEqual(placementOf(layout, "git"), {
    presentation: "fullscreen", previous: { presentation: "docked", region: "end" },
  });
  assert.equal(focalSurface(layout), "git");
  // Only one fullscreen layer: another fullscreen returns the first home.
  layout = setPresentation(layout, "files", "fullscreen");
  assert.equal(layout.fullscreen?.surfaceId, "files");
  assert.deepEqual(placementOf(layout, "git"), { presentation: "docked", region: "end" });
});

test("close: removes from any placement and picks the neighbour as active", () => {
  let layout = authoring();
  layout = closeSurface(layout, "files");
  assert.deepEqual(layout.regions.end, { surfaces: ["outline"], active: "outline" });
  layout = closeSurface(layout, "outline");
  assert.deepEqual(layout.regions.end, { surfaces: [], active: null });
  assert.equal(closeSurface(layout, "nope"), layout);
  const floating = openSurface(layout, "git", { presentation: "floating" });
  assert.deepEqual(closeSurface(floating, "git").floating, []);
});

test("move: docks from anywhere, ends floating/fullscreen, refuses disallowed regions", () => {
  let layout = authoring();
  layout = moveSurface(layout, "session", "end");
  assert.deepEqual(layout.regions.start, { surfaces: [], active: null });
  assert.deepEqual(layout.regions.end, { surfaces: ["files", "outline", "session"], active: "session" });
  assert.equal(layout.homes.session, "end");
  const floating = setPresentation(layout, "files", "floating");
  const docked = moveSurface(floating, "files", "start");
  assert.deepEqual(docked.floating, []);
  assert.deepEqual(docked.regions.start, { surfaces: ["files"], active: "files" });
  assert.equal(moveSurface(docked, "files", "bottom", { allowedRegions: ["start", "end"], preferredRegion: "end" }), docked);
  // Moving to the region it already occupies only activates it.
  assert.deepEqual(moveSurface(docked, "outline", "end").regions.end.active, "outline");
});

test("swap: exchanges two docked placements exactly; docked↔floating hands over the slot", () => {
  let layout = authoring();
  layout = swapSurfaces(layout, "session", "resources");
  assert.deepEqual(layout.regions.start, { surfaces: ["resources"], active: "resources" });
  assert.deepEqual(layout.regions.primary, { surfaces: ["session"], active: "session" });
  // Index positions inside a shared region are preserved.
  layout = swapSurfaces(layout, "files", "terminal");
  assert.deepEqual(layout.regions.end.surfaces, ["terminal", "outline"]);
  assert.deepEqual(layout.regions.bottom.surfaces, ["files"]);
  assert.equal(layout.regions.end.active, "terminal");
  const floating = setPresentation(layout, "outline", "floating");
  const swapped = swapSurfaces(floating, "outline", "session");
  assert.deepEqual(placementOf(swapped, "outline"), { presentation: "docked", region: "primary" });
  assert.deepEqual(placementOf(swapped, "session"), { presentation: "floating" });
  // Fullscreen participants are refused.
  const fs = setPresentation(layout, "session", "fullscreen");
  assert.equal(swapSurfaces(fs, "session", "files"), fs);
  assert.equal(swapSurfaces(layout, "files", "files"), layout);
});

test("make primary swaps with the current primary surface, or docks when nothing is there", () => {
  let layout = authoring();
  layout = makePrimary(layout, "session");
  assert.deepEqual(layout.regions.primary.surfaces, ["session"]);
  assert.deepEqual(layout.regions.start.surfaces, ["resources"]);
  const empty = closeSurface(layout, "session");
  const docked = makePrimary(empty, "files");
  assert.deepEqual(docked.regions.primary, { surfaces: ["files"], active: "files" });
  assert.equal(makePrimary(docked, "files"), docked);
});

test("fullscreen returns to the EXACT previous placement, including floating", () => {
  let layout = authoring();
  const before = layout;
  layout = setPresentation(layout, "outline", "fullscreen");
  assert.equal(focalSurface(layout), "outline");
  layout = exitFullscreen(layout);
  assert.deepEqual(layout.regions.end.surfaces, before.regions.end.surfaces);
  assert.equal(layout.regions.end.active, "outline");
  assert.equal(layout.fullscreen, null);

  let floating = setPresentation(before, "files", "floating");
  floating = setPresentation(floating, "files", "fullscreen");
  floating = setPresentation(floating, "files", "docked");
  // Explicit docking while fullscreen leaves fullscreen and docks at home.
  assert.deepEqual(placementOf(floating, "files"), { presentation: "docked", region: "end" });
  let roundTrip = setPresentation(before, "files", "floating");
  roundTrip = setPresentation(roundTrip, "files", "fullscreen");
  roundTrip = exitFullscreen(roundTrip);
  assert.deepEqual(placementOf(roundTrip, "files"), { presentation: "floating" });
  assert.equal(exitFullscreen(roundTrip), roundTrip);
});

test("presentation: docked→floating→docked returns to the remembered home region", () => {
  let layout = authoring();
  layout = setPresentation(layout, "files", "floating");
  assert.deepEqual(layout.floating, ["files"]);
  assert.equal(layout.regions.end.active, "outline");
  layout = setPresentation(layout, "files", "docked");
  assert.deepEqual(placementOf(layout, "files"), { presentation: "docked", region: "end" });
  assert.equal(setPresentation(layout, "files", "docked"), layout);
  assert.equal(setPresentation(layout, "missing", "floating"), layout);
});

test("activate: sets the active tab, brings floating windows to the front, un-collapses", () => {
  let layout = authoring();
  layout = openSurface(layout, "a", { presentation: "floating" });
  layout = openSurface(layout, "b", { presentation: "floating" });
  assert.deepEqual(layout.floating, ["a", "b"]);
  layout = activateSurface(layout, "a");
  assert.deepEqual(layout.floating, ["b", "a"]);
  assert.equal(layout.collapsed.bottom, true);
  layout = activateSurface(layout, "terminal");
  assert.equal(layout.collapsed.bottom, false);
  assert.equal(activateSurface(layout, "terminal"), layout);
  assert.equal(setActive(layout, "end", "outline").regions.end.active, "outline");
  assert.equal(setActive(layout, "end", "nope"), layout);
});

test("collapse/resize/reorder keep everything else and reject garbage sizes", () => {
  let layout = authoring();
  layout = setCollapsed(layout, "end", true);
  assert.equal(layout.collapsed.end, true);
  assert.equal(setCollapsed(layout, "end", true), layout);
  layout = resizeRegion(layout, "end", 420.4);
  assert.equal(layout.sizes.end, 420);
  assert.equal(resizeRegion(layout, "end", Number.NaN), layout);
  assert.equal(resizeRegion(layout, "end", 12), layout);
  assert.equal(resizeRegion(layout, "end", null).sizes.end, null);
  layout = resizeSurface(layout, "files", { inline: 500.6, block: 5, dockBlock: 240 });
  assert.deepEqual(layout.surfaceSizes.files, { inline: 501, dockBlock: 240 });
  assert.equal(resizeSurface(layout, "files", { inline: 501 }), layout);
  layout = reorderSurface(layout, "outline", 0);
  assert.deepEqual(layout.regions.end.surfaces, ["outline", "files"]);
  assert.equal(reorderSurface(layout, "outline", 0), layout);
  assert.equal(reorderSurface(layout, "floating-nope", 0), layout);
});

test("restore rule: floating is transient; fullscreen returns to a docked home or closes", () => {
  let layout = layoutFromTemplate(CONVERSATION_TEMPLATE);
  layout = openSurface(layout, "files", { presentation: "floating" });
  assert.deepEqual(withoutTransient(layout).floating, []);
  let pinnedFs = openSurface(layoutFromTemplate(CONVERSATION_TEMPLATE), "git", { region: "end" });
  pinnedFs = setPresentation(pinnedFs, "git", "fullscreen");
  const restored = withoutTransient(pinnedFs);
  assert.deepEqual(placementOf(restored, "git"), { presentation: "docked", region: "end" });
  let floatingFs = setPresentation(layout, "files", "fullscreen");
  floatingFs = withoutTransient(floatingFs);
  assert.equal(placementOf(floatingFs, "files"), null);
});

test("session boundary: closeTransient keeps docked companions and honours keep()", () => {
  let layout = authoring();
  layout = openSurface(layout, "git", { presentation: "floating" });
  layout = openSurface(layout, "browser", { presentation: "floating" });
  const closed = closeTransient(layout);
  assert.deepEqual(closed.floating, []);
  assert.deepEqual(closed.regions.end.surfaces, ["files", "outline"]);
  const kept = closeTransient(layout, (id) => id === "git");
  assert.deepEqual(kept.floating, ["git"]);
  const fs = setPresentation(layout, "browser", "fullscreen");
  assert.equal(placementOf(closeTransient(fs), "browser"), null);
});

test("companion shape: chat alone in primary with at most one other window", () => {
  const base = layoutFromTemplate(CONVERSATION_TEMPLATE);
  assert.equal(isCompanionShaped(base), true);
  assert.equal(isCompanionShaped(openSurface(base, "files", { presentation: "floating" })), true);
  assert.equal(isCompanionShaped(openSurface(base, "terminal", { region: "bottom" })), true);
  const two = openSurface(openSurface(base, "files", { region: "end" }), "git", { region: "end" });
  assert.equal(isCompanionShaped(two), false);
  assert.equal(isCompanionShaped(moveSurface(base, CHAT_SURFACE_ID, "start")), false);
  assert.equal(isCompanionShaped(authoring()), false);
});

test("reset position returns one surface to the template placement without touching others", () => {
  const template = {
    surfaces: [
      { surface: "session", region: "start" as const },
      { surface: "resources", region: "primary" as const },
      { surface: "files", region: "end" as const },
    ],
  };
  let layout = layoutFromTemplate(template);
  layout = moveSurface(layout, "files", "start");
  layout = resizeSurface(layout, "files", { inline: 400 });
  layout = openSurface(layout, "git", { region: "end" });
  const reset = resetSurfacePosition(layout, "files", template);
  assert.deepEqual(placementOf(reset, "files"), { presentation: "docked", region: "end" });
  assert.deepEqual(reset.regions.end.surfaces, ["git", "files"]);
  assert.equal(reset.surfaceSizes.files, undefined);
  assert.equal(resetSurfacePosition(layout, "unknown", template), layout);
});

test("parse: hardens persisted layouts (duplicates, bad actives, absurd sizes, junk)", () => {
  const junk = parseLayout("nope");
  assert.deepEqual(junk, emptyLayout());
  const parsed = parseLayout({
    regions: {
      start: { surfaces: ["session", "session", 7], active: "ghost" },
      primary: { surfaces: ["resources"], active: "resources" },
      end: { surfaces: ["files"], active: "files" },
      bottom: "garbage",
    },
    floating: ["git", "files"],
    fullscreen: { surfaceId: "git", previous: { presentation: "floating" } },
    sizes: { start: 340, end: 9, bottom: Number.NaN },
    collapsed: { bottom: true, end: "yes" },
    surfaceSizes: { files: { inline: 520.4, block: 12 }, "": { inline: 300 } },
    homes: { files: "end", git: "nowhere" },
  });
  assert.deepEqual(parsed.regions.start, { surfaces: ["session"], active: "session" });
  assert.deepEqual(parsed.regions.bottom, { surfaces: [], active: null });
  assert.deepEqual(parsed.floating, ["git"]); // files already docked
  assert.deepEqual(parsed.fullscreen, { surfaceId: "git", previous: { presentation: "floating" } });
  assert.equal(parsed.sizes.start, 340);
  assert.equal(parsed.sizes.end, null);
  assert.equal(parsed.collapsed.bottom, true);
  assert.equal(parsed.collapsed.end, false);
  assert.deepEqual(parsed.surfaceSizes, { files: { inline: 520 } });
  assert.deepEqual(parsed.homes, { files: "end" });
  // Round trip through JSON is lossless for a valid layout.
  const layout: WorkbenchLayout = authoring();
  assert.deepEqual(parseLayout(JSON.parse(JSON.stringify(layout))), layout);
});
