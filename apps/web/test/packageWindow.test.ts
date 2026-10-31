import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transitionPaneWindow, type PaneWindowState } from "../src/workspace/panePrefs.ts";
import { clampPaneDimension } from "../src/workspace/panePrefs.ts";
import { pathBelongsToPackageWindow } from "../src/components/ui/PackageWindowContext.ts";

const dynamic: PaneWindowState = { mode: "dynamic", previousMode: "dynamic" };
const pinned: PaneWindowState = { mode: "pinned", previousMode: "pinned" };

test("package window pins and unpins predictably", () => {
  const pin = transitionPaneWindow(dynamic, { type: "toggle-pin" });
  assert.deepEqual(pin, pinned);
  assert.deepEqual(transitionPaneWindow(pin!, { type: "toggle-pin" }), dynamic);
});

test("fullscreen restores the exact pinned mode", () => {
  const fullscreen = transitionPaneWindow(pinned, { type: "toggle-fullscreen" });
  assert.deepEqual(fullscreen, { mode: "fullscreen", previousMode: "pinned" });
  assert.deepEqual(transitionPaneWindow(fullscreen!, { type: "toggle-fullscreen" }), pinned);
});

test("fullscreen restores the exact dynamic mode", () => {
  const fullscreen = transitionPaneWindow(dynamic, { type: "toggle-fullscreen" });
  assert.deepEqual(fullscreen, { mode: "fullscreen", previousMode: "dynamic" });
  assert.deepEqual(transitionPaneWindow(fullscreen!, { type: "toggle-fullscreen" }), dynamic);
});

test("Escape closes dynamic, restores fullscreen, and ignores pinned", () => {
  assert.equal(transitionPaneWindow(dynamic, { type: "escape" }), null);
  assert.equal(transitionPaneWindow(pinned, { type: "escape" }), pinned);
  assert.deepEqual(
    transitionPaneWindow({ mode: "fullscreen", previousMode: "pinned" }, { type: "escape" }),
    pinned,
  );
});

test("dynamic resize clamps to both content minimum and available viewport", () => {
  assert.equal(clampPaneDimension(100, 380, 1200), 380);
  assert.equal(clampPaneDimension(2000, 380, 1200), 1168);
  assert.equal(clampPaneDimension(380, 380, 320), 288);
});

test("portal and launcher interaction belong to their package window", () => {
  const node = (name: string, value: string): EventTarget => ({
    getAttribute: (attribute: string) => attribute === name ? value : null,
  }) as unknown as EventTarget;
  assert.equal(pathBelongsToPackageWindow([node("data-package-window-owner", "files")], "files"), true);
  assert.equal(pathBelongsToPackageWindow([node("data-pane-launcher", "files")], "files"), true);
  assert.equal(pathBelongsToPackageWindow([node("role", "dialog")], "files"), true);
  assert.equal(pathBelongsToPackageWindow([node("data-package-window-owner", "git")], "files"), false);
  assert.equal(pathBelongsToPackageWindow([node("data-pane-launcher", "git")], "files"), false);
});

test("browser-extension overlays (Grammarly) are not an outside click", () => {
  const el = (nodeName: string): EventTarget => ({ nodeName, getAttribute: () => null }) as unknown as EventTarget;
  const tail = [el("BODY"), el("HTML"), el("#document")];
  // Grammarly's suggestion card: shadow content, its shadow root, then the host under <body>.
  assert.equal(pathBelongsToPackageWindow([el("DIV"), el("#document-fragment"), el("GRAMMARLY-DESKTOP-INTEGRATION"), ...tail], "tasks"), true);
  assert.equal(pathBelongsToPackageWindow([el("grammarly-popups"), el("HTML"), el("#document")], "tasks"), true);
  // Polyth's own chrome is still outside.
  assert.equal(pathBelongsToPackageWindow([el("BUTTON"), el("DIV"), ...tail], "tasks"), false);
  assert.equal(pathBelongsToPackageWindow([el("BODY"), el("HTML")], "tasks"), false);
});

test("pressing the active launcher is never an outside click, whatever its id", () => {
  const launcher = (id: string): EventTarget => ({
    getAttribute: (attribute: string) => attribute === "data-pane-launcher" ? id : null,
  }) as unknown as EventTarget;
  // A package home launcher stays active while one of its pages is open.
  const active = (id: string) => id === "markets";
  assert.equal(pathBelongsToPackageWindow([launcher("markets")], "markets.crypto", active), true);
  assert.equal(pathBelongsToPackageWindow([launcher("git")], "markets.crypto", active), false);
});

test("every desktop launcher marks itself so its second click closes the window", async () => {
  // pointerdown outside a dynamic window dismisses it; an unmarked launcher's
  // click then saw it inactive and reopened it (Home Assistant, Browser).
  const [widgets, rail] = await Promise.all([
    readFile(new URL("../src/widgets/capabilityWidgets.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/ContextRail.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(widgets, /data-pane-launcher=\{id\}\s*onClick=\{\(\) => toggleCapability\(id, capability\.open\)\}/);
  assert.match(rail, /"data-pane-launcher": s\.id/);
  assert.match(rail, /pathBelongsToPackageWindow\(event\.composedPath\(\), id, \(launcherId\) => isCapabilityActive\(launcherId\)\)/);
});

test("top workspace launchers close their package window on a second click", async () => {
  const source = await readFile(new URL("../src/components/Header.tsx", import.meta.url), "utf8");
  assert.match(source, /data-pane-launcher=\{c\.descriptor\.id\}/);
  const placement = await readFile(new URL("../src/railPlacement.ts", import.meta.url), "utf8");
  assert.match(source, /topRailCapabilities\(resolved, placements/);
  assert.match(placement, /const NOT_A_LAUNCHER = new Set\(\["session"\]\)/);
  assert.match(placement, /top = top\.filter\(\(capability\) => !NOT_A_LAUNCHER\.has\(capability\.descriptor\.id\)\)/);
});

test("entering edit mode stays local to the selected surface", async () => {
  // Edit mode no longer closes the open package window or switches the view;
  // it only toggles editing on whatever surface is showing.
  const source = await readFile(new URL("../src/components/Header.tsx", import.meta.url), "utf8");
  assert.match(source, /onSelect: \(\) => setWorkspaceEditing\(!editing\)/);
  assert.doesNotMatch(source, /closeWorkspacePane\(\);\s*setActiveView\("session"\);\s*setWorkspaceMode\(/);
});

test("compact package windows are fullscreen-only", async () => {
  const [source, surfaces] = await Promise.all([
    readFile(new URL("../src/components/ContextRail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/surfaces.ts", import.meta.url), "utf8"),
  ]);
  // Compact forcing lives in the pure paneWindowLayout precedence.
  assert.match(surfaces, /input\.compact && input\.isWorkspacePane \? "fullscreen" : input\.paneMode/);
  assert.match(source, /paneWindowLayout\(\{ isWorkspacePane, compact, paneMode, dockEdge, measured, admits, guardPromoted \}\)/);
  // A profile's home surface (the Tasks tab) is the whole view: no toggles.
  assert.match(source, /onTogglePin=\{paneWorkspace && !compact && !homePane \? togglePanePin : undefined\}/);
  assert.match(source, /onToggleFullscreen=\{paneWorkspace && !compact && !homePane \? togglePaneFullscreen : undefined\}/);
  assert.match(source, /if \(homePane\) return;/, "Escape does not shrink a home surface into a window");
  assert.match(source, /if \(compact\) closeWorkspacePane\(\);\s*else handlePaneEscape\(\);/);
});

test("package windows share directional enter/exit motion and a reduced-motion escape hatch", async () => {
  const [source, css, stack] = await Promise.all([
    readFile(new URL("../src/components/ContextRail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/stackNavigation.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /data-rail-motion=\{exiting \? "exiting" : open \? "open" : "idle"\}/);
  // A closed keep-alive frame stays mounted: it must not present itself again.
  assert.match(source, /presented=\{open !== null\}/);
  assert.match(source, /window\.getComputedStyle\([^\n]+animationName === "none"/);
  for (const name of [
    "rail-window-open-inline",
    "rail-window-open-dynamic",
    "rail-window-open-layer",
    "rail-window-open-bottom",
    "rail-window-exit-inline",
    "rail-window-exit-dynamic",
    "rail-window-exit-layer",
    "rail-window-exit-bottom",
  ]) {
    assert.match(css, new RegExp(`@keyframes ${name}\\b`), `${name} is defined`);
  }
  // Compact full-screen layers (phone and tablet) travel through the shared
  // stack grammar; one keyframe set is direction-aware, so RTL needs no copy.
  for (const name of ["stack-in", "stack-out", "stack-cover", "stack-uncover", "stack-dim-in", "stack-dim-out"]) {
    assert.match(stack, new RegExp(`@keyframes ${name}\\b`), `${name} is defined`);
  }
  assert.doesNotMatch(css, /@keyframes (?:module-slide-|panel-slide-)/, "the superseded per-surface slide keyframes are gone");
  assert.match(css, /\.rail-exiting:not\(\.rail-dynamic\)[\s\S]*?animation: rail-window-exit-inline/);
  // One keyframe set per window motion: --stack-dir mirrors the travel, so
  // RTL needs no copy (geometry pinned in packageWindowMotion.test.ts).
  assert.doesNotMatch(css, /@keyframes (?:rail-window-|focused-split-)[\w-]*-rtl\b/, "no RTL copies of the window keyframes");
  assert.match(css, /@keyframes rail-window-exit-dynamic \{[\s\S]*?var\(--stack-dir, 1\) \* var\(--motion-window-travel, 96px\)/);
  assert.match(css, /border-start-start-radius: var\(--radius-surface\)/);
});

test("screen edges and package-to-launcher seams keep the wrong-side corners square", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(
    css,
    /\.sidebar\s*\{\s*border: 1px solid var\(--contour\);\s*border-radius: 0;\s*border-start-end-radius: var\(--radius-surface\);\s*box-shadow:/s,
    "the desktop sidebar rounds only its top workspace-facing corner: it runs into the window's start and bottom edges",
  );
  assert.match(
    css,
    /\.rail-dynamic\s*\{[^}]*border-radius: 0;[^}]*border-start-start-radius: var\(--radius-surface\);[^}]*border-end-start-radius: var\(--radius-surface\);[^}]*clip-path: inset\(0\);/s,
    "a dynamic package rounds only the outer inline-start corners",
  );
  assert.match(
    css,
    /\.rail:not\(\.rail-workspace\):not\(\.rail-fullscreen\),\s*\.rail-workspace\s*\{[^}]*border-inline-end: 0;/s,
    "package windows leave the launcher seam to the strip",
  );
  assert.match(
    css,
    /\.railbar:is\(\[data-rail-motion="open"\], \[data-rail-motion="exiting"\]\):has\(> \.rail:not\(\.rail-dynamic\):not\(\.rail-fullscreen\)\)\s*\{[^}]*border: 0;/s,
    "a docked package does not double the outer rail border",
  );
  assert.match(
    css,
    /\.railbar:is\(\[data-rail-motion="open"\], \[data-rail-motion="exiting"\]\):has\(> \.rail:not\(\.rail-dynamic\):not\(\.rail-fullscreen\)\) > \.rail-icon-col\.plugin-strip\s*\{[^}]*border-block: 1px solid var\(--hair\);[^}]*border-inline-start: 1px solid var\(--surface-divider\);/s,
    "the launcher strip completes the package block border and seam",
  );
  assert.match(css, /\.rail-pinned\s*\{[^}]*border-radius: 0;[^}]*border-start-start-radius: var\(--radius-surface\)/s);
  assert.match(css, /\.rail-workspace\.rail-fullscreen\s*\{[^}]*border-radius: 0;/s);
  assert.match(css, /\.railbar:has\(\.rail-fullscreen\) > \.rail-icon-col\s*\{[^}]*border-block: 1px solid var\(--hair\);[^}]*border-inline-end: 0;/s);
  assert.match(css, /\.railbar:has\(> \.rail-dynamic\) > \.rail-icon-col\.plugin-strip\s*\{[^}]*border-inline-start: 1px solid var\(--surface-divider\);[^}]*border-inline-end: 0;/s);
  assert.match(css, /\.rail-dock-bottom\s*\{[^}]*border-radius: 0;[^}]*border-start-start-radius: var\(--radius-surface\)/s);
  assert.doesNotMatch(css, /clip-path: inset\([^;]*round var\(--radius-surface\)/, "package motion never re-rounds the launcher seam");
});

test("a docked package window and its launcher strip share one frame and one edge", async () => {
  const [css, tokens, theme] = await Promise.all([
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/tokens.css", import.meta.url), "utf8"),
    readFile(new URL("../src/theme.ts", import.meta.url), "utf8"),
  ]);
  const docked = String.raw`:has\(> \.rail:not\(\.rail-dynamic\):not\(\.rail-fullscreen\):not\(\.rail-dock-bottom\):not\(\.rail-pinned-narrow\)\)`;
  const host = css.match(new RegExp(String.raw`\.railbar:is\(\[data-rail-motion="open"\], \[data-rail-motion="exiting"\]\)${docked} \{([^}]*)\}`))?.[1] ?? "";
  assert.match(host, /border-block: 1px solid var\(--hair-solid\);/, "the host keeps the one top/bottom edge");
  assert.match(host, /border-inline-start: 1px solid var\(--hair-solid\);/);
  assert.match(host, /border-start-start-radius: var\(--radius-surface\);/);
  assert.doesNotMatch(host, /border-end-start-radius/, "the frame runs into the window's bottom edge, square");
  assert.match(host, /box-shadow: inset 0 0 0 transparent, var\(--shadow-sm\);/, "the highlight fades with the same list shape");
  const strip = css.match(new RegExp(String.raw`\.railbar:is\(\[data-rail-motion="open"\], \[data-rail-motion="exiting"\]\)${docked} > \.rail-icon-col\.plugin-strip \{([^}]*)\}`))?.[1] ?? "";
  assert.match(strip, /border: 0;/, "the strip draws no second top/bottom edge");
  assert.match(strip, /border-inline-start: 1px solid var\(--surface-divider\);/, "the strip only adds the seam");
  assert.match(
    css,
    /\.railbar:is\(\[data-rail-motion="open"\], \[data-rail-motion="exiting"\]\) > \.rail:not\(\.rail-dynamic\):not\(\.rail-fullscreen\):not\(\.rail-dock-bottom\):not\(\.rail-pinned-narrow\) \{[^}]*border: 0;[^}]*border-start-start-radius: calc\(var\(--radius-surface\) - 1px\);/s,
    "the pane fills the frame's inner curve instead of drawing its own border",
  );
  assert.match(css, /\.railbar\[data-rail-motion="exiting"\]:has\(> \.rail:not\(\.rail-dynamic\)[^{]*\{\s*overflow: clip;/, "an exiting frame clips the strip's square glass to its curve");
  // Idle and open use the same solid edge, so opening never swaps its colour.
  assert.match(css, /\.railbar \{\s*position: absolute;[^}]*border-block: 1px solid var\(--hair-solid\);[^}]*transition:[^}]*border-radius/s);
  assert.match(tokens, /--hair-solid:/);
  assert.match(theme, /"--hair-solid": blend\(t\.text, blend\(t\.elevated, t\.panel, 0\.88\), dark \? 0\.055 : 0\.07\)/, "the solid edge is --hair composited over the glass base");
  assert.match(css, /body\[data-hide-borders="true"\] \{[^}]*--hair-solid: transparent;/s);
  // Borderless appearance strips every border colour and restores only some
  // edges. The floating window is pulled 1px into the host's top hairline so
  // pane and strip share ONE line: the host keeps its block edge, but the
  // pane's stayed transparent, and the theme's `--contour` may be translucent
  // so it composited over the pane's own bright glass instead of the page.
  // Both the missing edge and the wrong backdrop are asserted here.
  assert.match(
    css,
    /body\[data-hide-borders="true"\] \.railbar:has\(> \.rail-dynamic\) > \.rail-dynamic \{[^}]*border-block-color: var\(--contour\) !important;[^}]*background-clip: padding-box !important;\s*\}/,
    "the floating window keeps the same block edge its rail host keeps, composited over the same backdrop",
  );
});

test("window motion keeps the frame opaque and the corners continuous", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const inline = css.match(/@keyframes rail-window-open-inline \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.doesNotMatch(inline, /opacity|radius/, "a docked frame neither fades into a hollow box nor re-rounds on its own");
  assert.match(css, /> \.module-view \{\s*animation: rail-window-content-in/, "only the content fades in");
  assert.match(css, /\.rail-exiting:not\(\.rail-dynamic\):not\(\.rail-fullscreen\):not\(\.rail-dock-bottom\) > \.module-view \{\s*animation: rail-window-content-out/);
  // The floating window glides out of its rail as one piece, on properties
  // the compositor animates while the package mounts.
  const dynamic = css.match(/@keyframes rail-window-open-dynamic \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(
    dynamic,
    /translate\(calc\(var\(--package-window-x, 0px\) \+ var\(--stack-dir, 1\) \* var\(--motion-window-travel, 96px\)\), var\(--package-window-y, 0px\)\)/,
    "the floating window starts back inside its rail, wherever it was moved",
  );
  assert.doesNotMatch(dynamic, /clip-path|scale\(|width|height/, "transform and opacity only; its top edge stays level with the strip's");
  assert.match(css, /@keyframes rail-seam-in \{\s*from \{ border-inline-start-color: transparent; \}/, "the seam divider fades instead of popping");
  // Tablet band: the floating cluster morphs into the docked column and back.
  assert.match(css, /@container app-shell \(min-width: 961px\) and \(max-width: 1400px\) \{[\s\S]*?\.railbar\.railbar-open\[data-rail-motion="open"\]:not\(\.railbar-dock-bottom\):not\(\.railbar-pinned-narrow\):not\(:has\(> \.rail-fullscreen\)\) \{\s*animation: rail-host-dock /);
  assert.match(css, /\.railbar\[data-rail-motion="exiting"\]:not\(\.railbar-dock-bottom\):not\(\.railbar-pinned-narrow\):not\(:has\(> \.rail-fullscreen\)\) \{\s*animation: rail-host-undock [^;]* both;/);
  for (const name of ["rail-host-dock", "rail-host-undock"]) {
    const body = css.match(new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
    // Less the band a layout keeps the cluster clear of (the desktop caption
    // band; none elsewhere).
    assert.match(body, /max-height: min\(var\(--rail-cluster-block-size, 100%\), calc\(100% - var\(--rail-cluster-clear, 0px\) - 2 \* var\(--space-3\)\)\);/, `${name} uses the idle cluster's clamped height`);
    assert.match(body, /inset-inline-end: var\(--space-3\);/);
    assert.match(body, /border-radius: var\(--radius-card\);/);
  }
  const source = await readFile(new URL("../src/components/ContextRail.tsx", import.meta.url), "utf8");
  assert.match(source, /railbar\.style\.setProperty\("--rail-cluster-block-size", `\$\{railClusterBlockSize\(strip\)\}px`\);/);
});

test("bottom package docks expose edges and keep the launcher strip on the right", async () => {
  const [terminal, css] = await Promise.all([
    readFile(new URL("../../../packages/terminal/widgets/index.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(terminal, /dockOptions:\s*\["bottom",\s*"side"\]/);
  assert.match(css, /\.app-shell:has\(\.rail-dock-bottom\) > \.railbar \{[\s\S]*grid-row: 1 \/ 3;/);
  assert.match(css, /\.app-shell:has\(\.rail-dock-bottom\) > \.railbar > \.rail-dock-bottom \{[\s\S]*inset-inline-end: var\(--rail-strip-width-right/);
  assert.match(css, /\.app-shell:has\(\.rail-dock-bottom\) > \.railbar > \.rail-icon-col\.plugin-strip \{[\s\S]*position: absolute;[\s\S]*inset-inline-end: 0;/);
});

test("workspace package hosts never blur Chat", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(
    css,
    /\.railbar:is\(\[data-rail-motion="open"\], \[data-rail-motion="exiting"\]\):has\(> \.rail:not\(\.rail-dynamic\):not\(\.rail-fullscreen\)\) > \.rail-icon-col\.plugin-strip/,
    "a hidden keep-alive pane cannot leave the launcher seam styled as open",
  );
  const host = css.match(/\.railbar:is\(\[data-rail-motion="open"\], \[data-rail-motion="exiting"\]\):has\(> \.rail-workspace\) \{([^}]*)\}/)?.[1] ?? "";
  assert.match(host, /background: transparent !important;/);
  assert.match(host, /-webkit-backdrop-filter: none !important;/);
  assert.match(host, /\n  backdrop-filter: none !important;/);
  assert.match(css, /\.railbar:is\(\[data-rail-motion="open"\], \[data-rail-motion="exiting"\]\):has\(> \.rail-workspace\) > \.rail-icon-col\.plugin-strip \{[\s\S]*background: var\(--material-glass\);/);
  assert.match(css, /\.railbar:not\(:has\(\.rail-fullscreen\)\):not\(:has\(> \.rail:is\(\[data-rail-motion="open"\], \[data-rail-motion="exiting"\]\)\.rail-workspace\)\):not\(:has\(> \.panel-sheet\)\)/);
});

test("dynamic peek shares the launcher seam and owns the selected glass material", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.rail-dynamic\s*\{[^}]*width:\s*calc\(var\(--rail-w\) \+ var\(--package-window-seam-padding\)\);/s);
  assert.match(css, /\.rail-dynamic\s*\{[^}]*max-width:[^;]*--package-window-seam-padding[^;]*;/s);
  assert.match(css, /\.rail-dynamic\s*\{[^}]*background:\s*var\(--material-glass\);/s);
  assert.match(
    css,
    /\.rail:not\(\.rail-fullscreen\):not\(\.rail-dynamic\):not\(\.rail-pinned-narrow\):not\(\.rail-dock-bottom\):not\(\.closed\)\s*\{[^}]*width:\s*calc\(var\(--rail-w, 300px\) \+ var\(--package-window-seam-padding\)\);/s,
    "inline and pinned package frames also grow around their preserved content width",
  );
  assert.match(css, /@keyframes rail-window-open-inline[\s\S]*?width:\s*calc\(var\(--rail-w\) \+ var\(--package-window-seam-padding\)\);/s);
  assert.match(
    css,
    /\.rail-dynamic > \.package-window-resize--e,[\s\S]*?\.rail-dynamic > \.package-window-resize--se\s*\{[^}]*inset-inline-end:\s*var\(--package-window-seam-padding\);/s,
    "the resize affordance follows the content edge instead of the frame padding",
  );
  assert.match(
    css,
    /\.app-shell:has\(\.rail-pinned-narrow\) > \.railbar > \.rail-pinned-narrow[\s\S]*?inset-inline-end:\s*var\(--rail-strip-width-right, calc\(var\(--control-h-sm\) \+ var\(--space-3\) \+ 1px\)\);/s,
    "narrow package frames meet the launcher seam without reducing content width",
  );
  assert.match(
    css,
    /\.app-shell:has\(\.rail-dock-bottom\) > \.railbar > \.rail-dock-bottom[\s\S]*?inset-inline-end:\s*var\(--rail-strip-width-right, calc\(var\(--control-h-sm\) \+ var\(--space-3\) \+ 1px\)\);/s,
    "bottom package frames keep the same right seam",
  );
  assert.match(
    css,
    /@media \(max-width: 960px\)[\s\S]*?\.rail:not\(\.rail-fullscreen\)\s*\{[^}]*--package-window-seam-padding:\s*0px;[^}]*padding-inline-end:\s*0;/s,
    "compact package layers do not reserve a desktop-only rail gap",
  );
  assert.match(
    css,
    /\.rail:not\(\.rail-fullscreen\)\s*\{[^}]*--package-window-seam-padding:\s*var\(--space-3\);[^}]*padding-inline-end:\s*var\(--package-window-seam-padding\);/s,
    "package windows reserve a right-side frame padding without shrinking their content",
  );
  assert.match(css, /\.railbar:has\(\.rail-dynamic\) > \.rail-dynamic\s*\{[^}]*inset-block-start:\s*-1px;/s);
  assert.match(css, /inset-inline-end:\s*var\(--rail-strip-width-right, calc\(var\(--control-h-sm\) \+ var\(--space-3\) \+ 1px\)\);/s);
  assert.match(
    css,
    /@media \(min-width: 961px\)[\s\S]*?\.railbar:has\(\.rail-dynamic\)\s*\{[^}]*border-block:\s*1px solid var\(--hair-solid\);[^}]*border-inline:\s*0 solid var\(--hair-solid\);/s,
    "the open rail and package window share the same top/bottom border treatment",
  );
  assert.match(
    css,
    /\.railbar:has\(> \.rail-dynamic\) > \.rail-icon-col\.plugin-strip\s*\{[^}]*background: var\(--material-glass\);[^}]*box-shadow: var\(--material-glass-highlight\);/s,
    "the strip repeats the floating window's fill and top highlight, so both run on through the seam",
  );
  assert.match(
    css,
    /\.railbar:has\(\.rail-dynamic\) > \.rail-dynamic\s*\{[^}]*border-color: var\(--hair-solid\);[^}]*box-shadow: var\(--material-glass-highlight\), var\(--shadow-md\);/s,
    "the floating window's edge is the same solid hairline as the host's",
  );
  assert.match(
    css,
    /body:not\(\[data-glass="off"\]\):not\(\[data-desktop-low-resource="true"\]\)\s*:is\(\.rail-dynamic, \.rail-workspace:not\(\.rail-fullscreen\), \.railbar:has\(> :is\(\.rail-workspace, \.rail-dynamic\)\) > \.rail-icon-col\.plugin-strip\)\s*\{[^}]*background:\s*radial-gradient\([\s\S]*?--material-glass-readable-fill[\s\S]*?backdrop-filter:\s*blur\(var\(--material-glass-blur\)\)/s,
    "the dynamic and docked panes and the launcher strip follow the selected glass material",
  );
  assert.doesNotMatch(css, /--rail-strip-width-right, calc\(var\(--control-h-sm\) \+ var\(--space-4\)\)/);
  assert.doesNotMatch(
    css,
    /--rail-strip-width-right, calc\(var\(--control-h-sm\) \+ var\(--space-3\)\)/,
    "every fallback follows the published strip width: tile + gutters + the seam hairline",
  );
});

test("a pinned pane promoted to the full-screen layer is not kept in the launcher strip", async () => {
  // A side dock that cannot keep Chat's floor — or that the dock guard
  // rejects — presents as `.rail-pinned.rail-fullscreen`. The pinned in-flow
  // host rule has higher specificity than `.railbar:has(.rail-fullscreen)`, so
  // without the `:not(:has(.rail-fullscreen))` guard the layer was laid out
  // inside the ~44px launcher strip and collapsed to its border width.
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(
    css,
    /\.railbar:has\(\.rail-pinned:not\(\.rail-pinned-narrow\)\):not\(:has\(\.rail-fullscreen\)\) \{/,
  );
  assert.match(css, /\.railbar:has\(\.rail-fullscreen\) > \.rail-fullscreen \{[\s\S]*flex: 1;/);
});

test("a bottom dock cannot overflow a short shell", async () => {
  // Chat's 240px minimum plus the 160px strip floor is taller than a short
  // window. Grid minimums win over the container: the strip rendered below
  // the clipped shell and disappeared. Chat yields and scrolls instead.
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const grid = css.match(/\.app-shell:has\(\.rail-dock-bottom\) \{([^}]*)\}/)?.[1] ?? "";
  assert.match(grid, /grid-template-rows: minmax\(0, 1fr\) var\(--workspace-dock-row-size\);/);
});

test("pinned windows can share one persisted layout entry", async () => {
  const { paneLayoutKey, parseWorkspacePanePrefs, SHARED_PINNED_PANE_KEY } = await import("../src/workspace/panePrefs.ts");
  assert.equal(paneLayoutKey("files", false), "files");
  assert.equal(paneLayoutKey("files", true), SHARED_PINNED_PANE_KEY);
  const prefs = parseWorkspacePanePrefs(JSON.stringify({
    version: 2, mode: "pinned", openSurface: "files",
    widths: { [SHARED_PINNED_PANE_KEY]: 640, files: 500 },
    heights: { [`${SHARED_PINNED_PANE_KEY}::dock`]: 320 },
    dockEdges: { [SHARED_PINNED_PANE_KEY]: "bottom" },
    lastResource: {},
  }));
  assert.equal(prefs.widths[SHARED_PINNED_PANE_KEY], 640);
  assert.equal(prefs.heights[`${SHARED_PINNED_PANE_KEY}::dock`], 320);
  assert.equal(prefs.dockEdges?.[SHARED_PINNED_PANE_KEY], "bottom");
});

test("a docked package window paints its launcher strip's material", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.rail\.rail-workspace:not\(\.rail-fullscreen\) \{ background: var\(--material-glass\); \}/);
  assert.doesNotMatch(css, /\.rail\.rail-workspace:not\(\.rail-fullscreen\) \{\s*background: color-mix\(in srgb, var\(--panel\)/, "no separate panel fill under a wallpaper");
  assert.match(
    css,
    /body:not\(\[data-glass="off"\]\):not\(\[data-desktop-low-resource="true"\]\)\s*:is\(\.rail-dynamic, \.rail-workspace:not\(\.rail-fullscreen\), \.railbar:has\(> :is\(\.rail-workspace, \.rail-dynamic\)\) > \.rail-icon-col\.plugin-strip\) \{/,
    "docked and floating windows share the strip's glass",
  );
  // Dock admission reads Chat's margin box, so a look's sheet inset cannot
  // promote a pin to the full-screen layer.
  const rail = await readFile(new URL("../src/components/ContextRail.tsx", import.meta.url), "utf8");
  assert.match(rail, /const chatW = chatRect \? chatRect\.width \+ chatInset : 0;/);
});
