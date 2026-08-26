import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("compact bottom navigation caps direct destinations and discloses overflow", async () => {
  const source = await read("../src/components/workspace/WorkspaceBottomNav.tsx");

  assert.match(source, /const MAX_PRIMARY_NAV_ITEMS = 4/);
  assert.match(source, /panes\.slice\(0, MAX_PRIMARY_NAV_ITEMS - 1\)/);
  assert.match(source, /panes\.slice\(MAX_PRIMARY_NAV_ITEMS - 1\)/);
  assert.match(source, /aria-haspopup="dialog"/);
  assert.match(source, /<Sheet[\s\S]*?<SheetRow/);
});

test("horizontal tabs and chips retain a visible scroll affordance", async () => {
  const css = await read("../src/styles.css");

  assert.match(css, /--scroll-affordance:\s*18px/);
  assert.match(
    css,
    /\.pane-tabs,[\s\S]*?\.provider-chips,[\s\S]*?\.git-ref-chips,[\s\S]*?\.gh-filter-chips[\s\S]*?mask-image:\s*linear-gradient/,
  );
});

test("mobile widget library preview is viewport-bounded without a 420px floor", async () => {
  const css = await read("../src/styles.css");

  assert.doesNotMatch(css, /\.widget-library-preview\s*\{\s*min-height:\s*420px/);
  assert.match(
    css,
    /\.widget-library-preview\s*\{[^}]*min-height:\s*0[^}]*max-height:\s*min\(360px, 42dvh\)/s,
  );
});
