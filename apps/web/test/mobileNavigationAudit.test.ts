import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readWebStyles } from "./webStyles.ts";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("every phone view uses the same three-segment shell bar", async () => {
  const [header, mobileHeader, prefs, shell, css] = await Promise.all([
    read("../src/components/Header.tsx"),
    read("../src/components/mobile/MobileSessionHeader.tsx"),
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
  assert.match(mobileHeader, /title="Tools"/);
  assert.doesNotMatch(mobileHeader, /Icon\.plus/);
  // The reserved band clears the floating island: safe area, the island's own
  // height (never below the tap floor), and the chrome inset around it.
  assert.match(css, /\.app-shell\s*\{[^}]*padding-top:\s*calc\(var\(--safe-top\) \+ var\(--conversation-chrome-inset\) \+ max\(var\(--tap\), var\(--mobile-island-height\)\) \+ var\(--space-4\)\)/s);
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
