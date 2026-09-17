import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readWebStyles } from "./webStyles.ts";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("every phone view uses the same three-segment shell bar", async () => {
  const [header, mobileHeader, workspacePanel, prefs, shell, css] = await Promise.all([
    read("../src/components/Header.tsx"),
    read("../src/components/mobile/MobileSessionHeader.tsx"),
    read("../src/components/mobile/WorkspacePanel.tsx"),
    read("../src/uiPrefs.ts"),
    read("../src/shell.ts"),
    readWebStyles(),
  ]);

  assert.match(header, /if \(mode === "phone"\) \{\s*return chatSurface \? <MobileSessionHeader \/> : <MobileViewHeader \/>;\s*\}/s);
  assert.doesNotMatch(header, /WorkspaceBottomNav/);
  assert.match(mobileHeader, /label="Open navigation"/);
  assert.match(mobileHeader, /label="New session"/);
  assert.match(mobileHeader, /label="Open tools"/);
  assert.match(mobileHeader, /origin="top"/);
  assert.match(workspacePanel, /title="Workspace"/);
  assert.match(workspacePanel, /Available items/);
  assert.equal((workspacePanel.match(/<Sheet/g) ?? []).length, 1);
  assert.doesNotMatch(mobileHeader, /Icon\.plus/);
  // The reserved band clears the floating island: safe area, the island's own
  // height (never below the tap floor), and the chrome inset around it.
  assert.match(css, /\.app-shell\s*\{[^}]*padding-top:\s*calc\(var\(--safe-top\) \+ var\(--conversation-chrome-inset\) \+ max\(var\(--tap\), var\(--mobile-island-height\)\) \+ var\(--space-4\)\)/s);
  assert.match(prefs, /mobileShortcuts:\s*\[[\s\S]*"notification-centre"/);
  assert.match(shell, /hint:\s*hintOf\("notificationCentre"\)/);
  assert.match(shell, /notificationCentre:\s*\(\) => toggleRailPlugin\("slot:notification-centre"\)/);
  assert.equal(shell.match(/window\.addEventListener\("keydown", onKey\)/g)?.length, 1);
});

test("compact project drawer is above its scrim", async () => {
  const css = await readWebStyles();
  const drawerStart = css.indexOf("/* Project/session drawer:");
  assert.ok(drawerStart >= 0, "compact drawer style block is present");
  const drawerStyles = css.slice(drawerStart, css.indexOf("\n}", drawerStart));
  assert.match(
    drawerStyles,
    /\.sidebar\s*\{[\s\S]*?z-index:\s*var\(--z-overlay\)/,
    "the open project/session drawer must share the overlay layer",
  );
  assert.match(
    css,
    /\.sidebar-backdrop\s*\{[^}]*z-index:\s*calc\(var\(--z-overlay\)\s*-\s*1\)/,
    "the drawer scrim must stay below the drawer",
  );
});

test("compact project drawer shares the mobile Workspace surface", async () => {
  const [css, navigation] = await Promise.all([
    readWebStyles(),
    read("../src/components/Navigation.tsx"),
  ]);

  assert.match(navigation, /mode === "phone" \? <MobileNavigator \/> : <Sidebar \/>/,
    "the compact width uses the Sidebar drawer path");

  const drawerStart = css.indexOf("/* Project/session drawer:");
  assert.ok(drawerStart >= 0, "compact drawer style block is present");
  const drawerSidebarStart = css.indexOf("  .sidebar {", drawerStart);
  const drawerSidebarEnd = css.indexOf("\n  }", drawerSidebarStart);
  assert.ok(drawerSidebarStart >= 0 && drawerSidebarEnd > drawerSidebarStart,
    "compact drawer surface override is present");
  assert.match(
    css.slice(drawerSidebarStart, drawerSidebarEnd),
    /--sidebar-glass-surface:\s*var\(--material-glass-strong\)/,
    "the compact drawer selects the sheet-grade surface",
  );

  const toolbarStart = css.indexOf("/* The compact drawer trades", drawerStart);
  const toolbarEnd = css.indexOf("\n  }", toolbarStart);
  assert.ok(toolbarStart >= 0 && toolbarEnd > toolbarStart,
    "compact drawer toolbar style block is present");
  assert.match(
    css.slice(toolbarStart, toolbarEnd),
    /\.sidebar-drawer-header\s*\{[\s\S]*?background:\s*transparent;/,
    "the drawer toolbar remains part of the same surface",
  );

  assert.match(
    css,
    /color-mix\(in srgb, var\(--sidebar-glass-surface, var\(--material-glass\)\) var\(--material-glass-fill\)/,
    "the final glass recipe resolves the compact drawer's surface token",
  );
});

test("horizontal tabs and chips retain a visible scroll affordance", async () => {
  const css = await readWebStyles();

  assert.match(css, /--scroll-affordance:\s*18px/);
  assert.match(
    css,
    /\.ui-scroll-tabs\s*\{[\s\S]*?mask-image:\s*linear-gradient/,
  );
});

test("mobile widget library preview is viewport-bounded without a 420px floor", async () => {
  const css = await readWebStyles();

  assert.doesNotMatch(css, /\.widget-library-preview\s*\{\s*min-height:\s*420px/);
  assert.match(
    css,
    /\.widget-library-preview\s*\{[^}]*min-height:\s*0[^}]*max-height:\s*min\(360px, 42dvh\)/s,
  );
});
