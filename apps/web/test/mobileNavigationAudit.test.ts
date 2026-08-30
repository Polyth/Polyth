import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readWebStyles } from "./webStyles.ts";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("phone chat uses floating session controls while other compact views retain the capability rail", async () => {
  const [header, mobileHeader, shortcuts, prefs, shell] = await Promise.all([
    read("../src/components/Header.tsx"),
    read("../src/components/mobile/MobileSessionHeader.tsx"),
    read("../src/components/mobile/MobileNavigationRail.tsx"),
    read("../src/uiPrefs.ts"),
    read("../src/shell.ts"),
  ]);

  assert.match(header, /chatSurface\s*\? <MobileSessionHeader \/>/);
  assert.doesNotMatch(header, /WorkspaceBottomNav/);
  assert.match(mobileHeader, /label="Open navigation"/);
  assert.match(mobileHeader, /label="New session"/);
  assert.match(mobileHeader, /label="Open tools"/);
  assert.match(mobileHeader, /title="Select a session"/);
  assert.match(mobileHeader, /title="Tools"/);
  assert.match(shortcuts, /ui\.mobileShortcuts\.flatMap/);
  assert.match(shortcuts, /className="mobile-shortcut-track"/);
  assert.match(shortcuts, /capability\.descriptor\.open/);
  assert.doesNotMatch(mobileHeader, /Icon\.plus/);
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
