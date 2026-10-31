import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  COMPACT_SHORTCUTS_SETTINGS_ITEM, compactShortcutFit, compactTitleMin,
} from "../src/compactHeaderFit.ts";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("tablet title keeps a guaranteed, bounded share of the header", () => {
  assert.equal(compactTitleMin(300), 200, "narrow headers still keep a readable title");
  assert.equal(compactTitleMin(768), 384);
  assert.equal(compactTitleMin(1200), 420, "wide headers do not starve the tools");
});

test("tablet shortcuts fill whole slots of the remaining budget, never more", () => {
  const base = { reserved: 52, pitch: 42, moreInline: 40, count: 9 };
  const at = (headerInline: number, titled = true) => compactShortcutFit({
    ...base,
    headerInline,
    titleMin: titled ? compactTitleMin(headerInline) : 0,
  });
  let previous = -1;
  for (let width = 481; width <= 960; width += 1) {
    const fit = at(width);
    assert.ok(fit >= previous, `${width}px: the count never drops as the header widens`);
    assert.ok(fit <= base.count);
    const used = base.reserved + compactTitleMin(width) + base.moreInline + fit * base.pitch;
    assert.ok(used <= width, `${width}px: ${fit} shortcuts overflow the header (${used}px)`);
    previous = fit;
  }
  assert.equal(at(960), 9, "a 960px header fits the owner's nine pinned tools");
  assert.ok(at(600) >= 3 && at(600) < 9, "a narrow header folds the tail into More");
  assert.equal(at(600, false), 9, "without a title the tools may use the free row");
  assert.equal(compactShortcutFit({ ...base, headerInline: 0, titleMin: 0 }), 9, "unmeasured layout renders every pinned tool");
  assert.equal(compactShortcutFit({ ...base, headerInline: 200, titleMin: 200 }), 0, "no negative counts");
});

test("tablet header is drawer, project-captioned title, fitted tools and More", async () => {
  const [header, rail, status, styles] = await Promise.all([
    read("../src/components/Header.tsx"),
    read("../src/components/mobile/MobileNavigationRail.tsx"),
    read("../src/components/DesktopSessionStatus.tsx"),
    read("../src/styles.css"),
  ]);
  assert.doesNotMatch(header, /FolderIcon|header-project-btn/, "no second button that only reopens the drawer");
  assert.match(header, /!\(compact && chatSurface\) && <div ref=\{occupancy\.leadingRef\} className="header-left-cluster">/,
    "tablet chat keeps the brand and view switch out of the title's way");
  // The project caption (none for a lone Personal project: personalRails.test.ts).
  assert.match(header, /caption=\{\[\s*compact \? projectName : undefined,/);
  assert.match(header, /className="header-compact-title"/, "a new chat still names where it is");
  assert.match(status, /desktop-session-status-caption/);
  // Every launchable tool is reachable: overflow, then all other tools, then the editor.
  assert.match(rail, /items\.slice\(visible\.length\)/);
  assert.match(rail, /tr\("header\.compactMoreTools"\)/);
  assert.match(rail, /openSettingsPage\("appearance", \{ itemId: COMPACT_SHORTCUTS_SETTINGS_ITEM \}\)/);
  assert.doesNotMatch(styles, /\.mobile-shortcut-rail\s*\{[^}]*(overflow-x: auto|mask-image)/s,
    "no sideways scroller that hides the first tools behind a fade");
  assert.doesNotMatch(styles, /\.header-chat \.header-trailing-cluster\s*\{[^}]*max-width: 42%/s);
});

test("wide top rail shows what was placed, with no implicit More fold", async () => {
  const [header, styles] = await Promise.all([read("../src/components/Header.tsx"), read("../src/styles.css")]);
  assert.doesNotMatch(header, /useTopRailFit|header-rail-overflow|is-folded/);
  assert.doesNotMatch(styles, /\.header-left-cluster \.view-icon:nth-child/, "no width breakpoint hides tools while space is free");
  // Short of room the rail scrolls from the start, and the title keeps 240px.
  assert.match(styles, /\.view-switcher-pill \{[^}]*overflow-x: auto;/);
  assert.match(styles, /\.header:has\(\.desktop-session-status\) \.header-left-cluster \{\s*max-width: max\(0px, calc\(100% - var\(--header-trailing-inline-size, 0px\) - 240px/);
});

test("the pinned tablet tools are editable from Settings and its search", async () => {
  const [pages, registry, view] = await Promise.all([
    read("../src/components/settings/pages.tsx"),
    read("../src/settings/registry.ts"),
    read("../src/components/SettingsView.tsx"),
  ]);
  assert.equal(COMPACT_SHORTCUTS_SETTINGS_ITEM, "appearance.compactShortcuts");
  // Outside tablet width the editor waits behind Show; a routed target (the
  // bar's own Customize link) opens it.
  assert.match(pages, /itemId=\{COMPACT_SHORTCUTS_SETTINGS_ITEM\}[\s\S]{0,1200}?\{tabletShown && <CompactShortcutsEditor \/>\}/);
  assert.match(pages, /const TABLET_ITEMS = new Set\(\[COMPACT_SHORTCUTS_SETTINGS_ITEM\]\)/);
  assert.match(registry, /id: "appearance\.compactShortcuts", pageId: "appearance"/);
  assert.match(view, /candidate\.dataset\.settingsItem === targetItemId/, "a routed item target scrolls into view");
});
