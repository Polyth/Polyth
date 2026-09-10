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
});

test("compact package windows are fullscreen-only", async () => {
  const source = await readFile(new URL("../src/components/ContextRail.tsx", import.meta.url), "utf8");
  assert.match(source, /effectivePaneMode = compact && isWorkspacePane \? "fullscreen" : paneMode/);
  assert.match(source, /onTogglePin=\{isWorkspacePane && !compact \? togglePanePin : undefined\}/);
  assert.match(source, /onToggleFullscreen=\{isWorkspacePane && !compact \? togglePaneFullscreen : undefined\}/);
  assert.match(source, /if \(compact\) closeWorkspacePane\(\);\s*else handlePaneEscape\(\);/);
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
