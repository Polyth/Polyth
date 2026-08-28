import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readWebStyles } from "./webStyles.ts";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("compact navigation uses the drawer while phone keeps session actions", async () => {
  const [header, shortcuts, sessions, prefs, shell] = await Promise.all([
    read("../src/components/Header.tsx"),
    read("../src/components/mobile/MobileNavigationRail.tsx"),
    read("../src/components/workspace/WorkspaceBottomNav.tsx"),
    read("../src/uiPrefs.ts"),
    read("../src/shell.ts"),
  ]);

  assert.equal(header.match(/<WorkspaceBottomNav \/>/g)?.length, 1);
  assert.match(header, /if \(mode === "phone"\)[\s\S]*<WorkspaceBottomNav \/>/);
  assert.doesNotMatch(header.slice(header.indexOf('return (\n    <>', header.indexOf('if (mode === "phone")') + 1)), /<WorkspaceBottomNav \/>/);
  assert.match(shortcuts, /ui\.mobileShortcuts\.flatMap/);
  assert.match(shortcuts, /className="mobile-shortcut-track"/);
  assert.match(shortcuts, /capability\.descriptor\.open/);
  assert.doesNotMatch(shortcuts, /<Sheet/);
  assert.match(sessions, /workspace\.workspacebottomnav\.openSessionsCurrentValue/);
  assert.match(sessions, /workspace\.workspacebottomnav\.newSession/);
  assert.match(prefs, /mobileShortcuts:\s*\[[\s\S]*"notification-centre"/);
  assert.match(shell, /hint:\s*hintOf\("notificationCentre"\)/);
  assert.match(shell, /notificationCentre:\s*\(\) => toggleRailPlugin\("slot:notification-centre"\)/);
  assert.equal(shell.match(/window\.addEventListener\("keydown", onKey\)/g)?.length, 1);
});

test("horizontal tabs and chips retain a visible scroll affordance", async () => {
  const css = await readWebStyles();

  assert.match(css, /--scroll-affordance:\s*18px/);
  assert.match(
    css,
    /\.pane-tabs,[\s\S]*?\.provider-chips,[\s\S]*?\.git-ref-chips,[\s\S]*?\.gh-filter-chips[\s\S]*?mask-image:\s*linear-gradient/,
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
