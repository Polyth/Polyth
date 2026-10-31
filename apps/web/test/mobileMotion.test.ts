import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseCssDurationMs, scheduleSurfaceExit } from "../src/motionPresence.ts";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("surface motion timing understands canonical CSS duration values", () => {
  assert.equal(parseCssDurationMs("240ms"), 240);
  assert.equal(parseCssDurationMs("0.24s"), 240);
  assert.equal(parseCssDurationMs(" calc(240ms) "), null);
  assert.equal(parseCssDurationMs("var(--motion-surface)"), null);
});

test("reduced-motion preference releases a pending surface exit immediately", () => {
  const previousDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      documentElement: { dataset: { reduceAnimations: "true" } },
      body: { dataset: {} },
    },
  });
  try {
    let released = false;
    scheduleSurfaceExit(() => { released = true; });
    assert.equal(released, true);
  } finally {
    if (previousDocument === undefined) delete (globalThis as { document?: Document }).document;
    else Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
  }
});

test("phone navigation and session overview keep their closing frame mounted", async () => {
  const [navigator, header, sheet] = await Promise.all([
    read("../src/components/mobile/MobileNavigator.tsx"),
    read("../src/components/mobile/MobileSessionHeader.tsx"),
    read("../src/components/mobile/Sheet.tsx"),
  ]);

  assert.match(navigator, /const \[drawerMounted, setDrawerMounted\] = useState\(drawerOpen\)/);
  // Covered by Settings (which takes its place), the drawer stays until Settings has arrived.
  assert.match(navigator, /scheduleSurfaceExit\(\(\) => setDrawerMounted\(false\), drawerExit === "covered" \? "--motion-stack" : "--motion-surface"\)/);
  assert.match(navigator, /open:\s*drawerOpen \|\| drawerMounted/);
  // A swipe from Chat also mounts it, as an inert peek (shellSwipe.ts) that is
  // neither open nor closing.
  assert.match(navigator, /if \(!drawerOpen && !drawerMounted && !peeking\) return null/);
  assert.match(navigator, /mobile-navigator\$\{drawerOpen \? "" : peeking \? " is-peeking" : " is-closing"\}/);
  assert.match(header, /const \[overviewMounted, setOverviewMounted\] = useState\(overviewOpen\)/);
  assert.match(header, /scheduleSurfaceExit\(\(\) => setOverviewMounted\(false\)\)/);
  assert.match(header, /\(overviewOpen \|\| overviewMounted\)\s*&&/);
  assert.match(header, /closing = false/);
  assert.match(header, /closing=\{closing\}/);
  assert.match(header, /closing=\{!overviewOpen\}/);
  assert.match(header, /aria-expanded=\{overviewOpen\}/);
  // One owner for the overview's exit frame: a leftover separate closing state
  // (its setter is called from the Tools button) would throw at runtime.
  assert.doesNotMatch(header, /surfaceClosing|SurfaceClosing|requestSurfaceClose/);
  assert.match(sheet, /closing\?: boolean/);
  assert.match(sheet, /\$\{closing \? " is-closing" : ""\}/);
  // A drag hands its position to the exit (sheetDrag.ts); an owner that
  // unmounts the sheet at once still gets that exit through its ghost.
  assert.match(sheet, /attachSheetDrag\(/);
  assert.match(sheet, /useExitGhost<HTMLDivElement>\(/);
  assert.doesNotMatch(sheet, /is-drag-closing|setDragClosing/, "the fade-in-place drag exit is gone");
});

test("Workspace pushes package windows above itself and only waits for its exit when it leaves", async () => {
  const [panel, layer, sheet] = await Promise.all([
    read("../src/components/mobile/WorkspacePanel.tsx"),
    read("../src/components/mobile/MobileWorkspaceLayer.tsx"),
    read("../src/components/mobile/Sheet.tsx"),
  ]);

  // Presence belongs to the layer host: the panel no longer keeps a private
  // closing state or a deferred-open ref that could disagree with it.
  assert.doesNotMatch(panel, /const \[closing, setClosing\]|afterCloseRef/);
  assert.match(panel, /closing = false/);
  assert.match(panel, /closing=\{closing\}/);
  // A package window opens immediately, above the mounted Workspace; only a
  // destination that is not a window (Chat, Edit workspace) waits for the exit.
  assert.match(panel, /capability\.open\(\);\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*if \(!packageLayerPresented\(getState\(\)\)\) requestPanelClose\(\);/);
  assert.match(panel, /requestPanelClose\(\(\) => toggleCapability\(capabilityId, capability\.open\)\)/);
  assert.match(panel, /scheduleSurfaceExit\(afterClose, "--motion-stack"\)/);
  // The host keeps the frame mounted through its exit and releases it after.
  assert.match(layer, /scheduleSurfaceExit\(\(\) => setMounted\(false\), "--motion-stack"\)/);
  assert.match(layer, /closing=\{mounted && !wanted\}/);
  assert.match(sheet, /data-sheet-state=\{closing \? "closing" : "open"\}/);
  assert.match(sheet, /data-stack=\{stackPhase\}/);
});

test("mobile surface motion uses shared tokens, directional exits, and no private timing", async () => {
  const [navigatorCss, headerCss, workspaceCss, coreCss, stackCss] = await Promise.all([
    read("../src/components/mobile/MobileNavigator.css"),
    read("../src/components/mobile/MobileSessionHeader.css"),
    read("../src/workspacePanelPremium.css"),
    read("../src/styles.css"),
    read("../src/stackNavigation.css"),
  ]);

  for (const name of ["mobile-navigator-in", "mobile-navigator-out", "mobile-nav-toolbar-in", "mobile-nav-scroll-in"]) {
    assert.match(navigatorCss, new RegExp(`@keyframes ${name}`));
  }
  assert.match(navigatorCss, /\.mobile-navigator:not\(\.is-closing\)[\s\S]*?var\(--motion-surface\)/);
  assert.match(navigatorCss, /\.mobile-navigator\.is-closing[\s\S]*?var\(--motion-surface\)/);
  assert.match(headerCss, /@keyframes mobile-session-sheet-lift/);
  assert.match(headerCss, /\.mobile-island-sheet--full-screen\.sheet\.is-closing\s*\{[^}]*mobile-session-overview-out/s);
  assert.match(headerCss, /@keyframes mobile-session-overview-out/);
  assert.match(headerCss, /mobile-session-selector\[aria-expanded="true"\][\s\S]*?rotate\(180deg\)/);
  // Phone sheets rise from the bottom edge and go back down it (from wherever a
  // drag let go); centered sheets on wider screens rise and sink in place.
  assert.match(coreCss, /animation:\s*sheet-slide-in var\(--motion-stack\) var\(--motion-stack-ease\) backwards/);
  assert.match(coreCss, /\.sheet\.is-closing\s*\{[^}]*animation:\s*sheet-slide-out var\(--sheet-settle, var\(--motion-stack\)\) var\(--motion-stack-ease\) both/s);
  assert.match(coreCss, /@keyframes sheet-slide-out\s*\{\s*from\s*\{\s*transform:\s*translate3d\(0, var\(--sheet-from, 0px\), 0\)/);
  assert.match(coreCss, /\.sheet:not\(\.sheet-origin-top\)\s*\{[^}]*animation-name:\s*sheet-rise/s);
  assert.match(coreCss, /\.sheet\.is-closing:not\(\.sheet-origin-top\)\s*\{[^}]*animation-name:\s*sheet-sink/s);
  assert.match(workspaceCss, /\.workspace-panel-sheet\.sheet/);
  // Full-screen phone layers (Workspace and package windows) share one grammar.
  assert.match(stackCss, /\.sheet-backdrop\[data-stack\]\.is-closing > \.workspace-panel-sheet\.sheet\.is-closing\s*\{\s*animation:\s*stack-out var\(--motion-stack\) var\(--motion-stack-ease\) both/);
  assert.match(stackCss, /\.railbar > :is\(\.rail-fullscreen, \.panel-sheet\)\.rail-exiting\s*\{\s*animation:\s*stack-out var\(--motion-stack\) var\(--motion-stack-ease\) both/);
  assert.match(stackCss, /\.railbar > :is\(\.rail-workspace\.rail-fullscreen, \.panel-sheet\):not\(\.rail-exiting\)\s*\{\s*animation:\s*stack-in var\(--motion-stack\) var\(--motion-stack-ease\) backwards/);
  assert.doesNotMatch(coreCss, /mobile-tools-(?:in|out)|module-slide-(?:in|out)|panel-slide-(?:in|out)/,
    "the superseded private keyframes are gone");
  assert.doesNotMatch(stackCss, /\b\d{3,}ms\b/, "stack motion takes its timing from the tokens, never a private duration");
  assert.doesNotMatch(navigatorCss, /@keyframes mobile-navigator-(?:in|out)[^{]*\{[^}]*\b\d{3,}ms/s);
  assert.doesNotMatch(headerCss, /@keyframes mobile-session-sheet-(?:drop|lift)[^{]*\{[^}]*\b\d{3,}ms/s);
});
