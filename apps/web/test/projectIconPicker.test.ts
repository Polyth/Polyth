import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  filterProjectIcons,
  embeddedIconifyName,
  filterSupportedIconifyNames,
  iconifyProjectIconName,
  iconifyProjectIconValue,
  iconifySearchUrl,
  iconifySvgUrl,
  inlineIconifySvgDataUrl,
  isSafePersistedProjectIcon,
  persistProjectIcon,
  projectIconCategoryQuery,
  projectIconLabel,
  projectIconMaskUrl,
  projectIconProviderLabel,
  rankSuggestedProjectIcons,
  storedProjectIconSelection,
  toggleFavoriteProjectIcon,
  updateRecentProjectIcons,
} from "../src/projectIconPicker.ts";

test("projectIconLabel makes bundled and Iconify names searchable", () => {
  assert.equal(projectIconLabel("folder-search-02.svg"), "folder search 02");
  assert.equal(projectIconLabel("ph:magnifying-glass"), "magnifying glass");
});

test("filterProjectIcons matches every query token case-insensitively", () => {
  const icons = ["folder-search.svg", "folder-open.svg", "search-web.svg"];
  assert.deepEqual(filterProjectIcons(icons, "SEARCH folder"), ["folder-search.svg"]);
});

test("rankSuggestedProjectIcons uses the project title before generic fallbacks", () => {
  const icons = ["cat.svg", "database.svg", "folder.svg", "search.svg", "star.svg"];
  const ranked = rankSuggestedProjectIcons(icons, "case-seek");
  assert.ok(ranked.indexOf("search.svg") < ranked.indexOf("cat.svg"));
  assert.ok(ranked.indexOf("folder.svg") < ranked.indexOf("cat.svg"));
});

test("suggested remote query resolves useful aliases from the title", () => {
  assert.equal(projectIconCategoryQuery("suggested", "case-seek"), "search");
  assert.equal(projectIconCategoryQuery("security", "anything"), "shield");
});

test("Iconify values stay restricted to the five agreed libraries", () => {
  assert.equal(iconifyProjectIconValue("ph:magnifying-glass"), "iconify:ph:magnifying-glass");
  assert.equal(iconifyProjectIconName("iconify:mingcute:folder-line"), "mingcute:folder-line");
  assert.equal(iconifyProjectIconValue("mdi:folder"), "");
  assert.equal(iconifyProjectIconName("iconify:mdi:folder"), null);
  assert.deepEqual(filterSupportedIconifyNames([
    "ph:folder", "mdi:folder", "tabler:folder", "ph:folder", 42,
  ]), ["ph:folder", "tabler:folder"]);
});

test("Iconify URLs stay same-origin through the Polyth proxy", () => {
  assert.equal(iconifySvgUrl("mynaui:menu"), "/api/iconify/mynaui/menu.svg");
  const search = new URL(iconifySearchUrl("folder search"), "http://polyth.local");
  assert.equal(search.pathname, "/api/iconify/search");
  assert.equal(search.hostname, "polyth.local");
  assert.equal(search.searchParams.get("query"), "folder search");
  assert.equal(search.searchParams.get("prefixes"), "hugeicons,mingcute,ph,mynaui,tabler");
  assert.equal(projectIconProviderLabel("ph:folder"), "Phosphor");
  assert.equal(projectIconMaskUrl("iconify:ph:folder"), "");
  assert.equal(projectIconMaskUrl("/assets/project-icons/folder.svg"), "/assets/project-icons/folder.svg");
});

test("recent and favorites are deterministic, deduplicated convenience state", () => {
  assert.deepEqual(updateRecentProjectIcons(["a", "b", "c"], "b", 3), ["b", "a", "c"]);
  assert.deepEqual(updateRecentProjectIcons(["a", "b"], "c", 2), ["c", "a"]);
  assert.deepEqual(toggleFavoriteProjectIcon(["a", "b"], "b"), ["a"]);
  assert.deepEqual(toggleFavoriteProjectIcon(["a", "b"], "c"), ["c", "a", "b"]);
});


test("suggested Iconify icons persist as validator-safe SVG data, never picker handles", async () => {
  const dirty = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24"><path fill="currentColor" d="M0 0h1v1H0z" xlink:href="https://evil.example"/></svg>';
  const stored = await persistProjectIcon("iconify:ph:folder", "#B4532A", async () => dirty);
  assert.equal(isSafePersistedProjectIcon("iconify:ph:folder"), false);
  assert.equal(isSafePersistedProjectIcon(stored), true);
  assert.match(stored, /^data:image\/svg\+xml;base64,/);
  assert.equal(embeddedIconifyName(stored), "ph:folder");
  const decoded = new TextDecoder().decode(Uint8Array.from(atob(stored.split(",", 2)[1] ?? ""), (char) => char.charCodeAt(0)));
  const withoutW3 = decoded.replace(/\sxmlns(?::[\w-]+)?\s*=\s*["']https?:\/\/www\.w3\.org\/[^"']*["']/gi, "");
  assert.doesNotMatch(withoutW3, /https?:|xlink:href/i);
  assert.match(decoded, /xmlns=["']http:\/\/www\.w3\.org\/2000\/svg["']/);
  assert.match(decoded, /currentColor/i);
  assert.equal(await persistProjectIcon("/assets/project-icons/folder.svg", "#b4532a", async () => { throw new Error("should not load"); }), "/assets/project-icons/folder.svg");
});

test("legacy charset SVG data URLs are rewritten to safe base64 before save", async () => {
  const legacy = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3" fill="currentColor"/></svg>')}`;
  assert.equal(isSafePersistedProjectIcon(legacy), false);
  const stored = await persistProjectIcon(legacy, "#123abc", async () => { throw new Error("should not load"); });
  assert.equal(isSafePersistedProjectIcon(stored), true);
  const decoded = new TextDecoder().decode(Uint8Array.from(atob(stored.split(",", 2)[1] ?? ""), (char) => char.charCodeAt(0)));
  assert.match(decoded, /xmlns=["']http:\/\/www\.w3\.org\/2000\/svg["']/);
  assert.match(decoded, /currentColor/i);
});

test("remote icons persist as self-contained SVG data while retaining their Iconify identity", () => {
  const stored = inlineIconifySvgDataUrl(
    "ph:magnifying-glass",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M0 0h1v1H0z"/></svg>',
    "#B4532A",
  );
  assert.match(stored, /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(embeddedIconifyName(stored), "ph:magnifying-glass");
  assert.equal(storedProjectIconSelection(stored), "iconify:ph:magnifying-glass");
  assert.equal(projectIconMaskUrl(stored), "/api/iconify/ph/magnifying-glass.svg");
  const decoded = new TextDecoder().decode(Uint8Array.from(atob(stored.split(",", 2)[1] ?? ""), (char) => char.charCodeAt(0)));
  assert.match(decoded, /xmlns=["']http:\/\/www\.w3\.org\/2000\/svg["']/);
  assert.match(decoded, /currentColor/i);
});

test("embedded Iconify metadata rejects unsupported providers", () => {
  const fake = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg><metadata id="polyth-iconify">mdi:folder</metadata></svg>')}`;
  assert.equal(embeddedIconifyName(fake), null);
  assert.equal(storedProjectIconSelection(fake), fake);
});

test("project appearance dialog stays compact, single-preview, and same-origin", async () => {
  const css = await readFile(new URL("../src/components/ProjectAppearanceDialog.css", import.meta.url), "utf8");
  const tsx = await readFile(new URL("../src/components/ProjectAppearanceDialogCore.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /920px|480px|(?<![\d.])6px|api\.iconify\.design|backdrop-filter|hideHeader|project-appearance-dialog\.dialog-panel|project-icon-upload-row \.muted/);
  assert.match(tsx, /size="sm"/);
  assert.match(tsx, /className="project-glyph"/);
  assert.match(tsx, /className="chip"/);
  assert.doesNotMatch(tsx, /hideHeader|project-sidebar-preview|project-appearance-head|api\.iconify\.design|project-hero|hero-preview|mobileSheet/);
  assert.match(tsx, /searchProjectIcons/);
  assert.match(tsx, /persistProjectIcon/);
  assert.match(tsx, /loadProjectIconSvg/);
  assert.doesNotMatch(styles, /project-appearance-body|\.project-icon-options\s*\{/);
});

test("project settings menu and child pages use canonical dialog chrome", async () => {
  const [tsx, css, styles] = await Promise.all([
    readFile(new URL("../src/components/ProjectAppearanceDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/ProjectSettingsDialog.css", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(tsx, /Dialog,/);
  assert.doesNotMatch(tsx, /\.\/a11y\/Dialog\.tsx/);
  assert.match(tsx, /className="project-settings-dialog"/);
  assert.doesNotMatch(tsx, /project-settings-workspace-dialog/);
  assert.match(tsx, /footer=\{/);
  assert.match(tsx, /<ProjectGlyph/);
  assert.match(tsx, /<ProjectAppearanceDialogCore[\s\S]*onBack=/);
  assert.match(css, /\.project-settings-dialog \.ui-dialog-body/);
  assert.match(css, /var\(--density-scale\)/);
  assert.doesNotMatch(css, /data-glass|backdrop-filter|material-glass-control/);
  assert.doesNotMatch(css, /var\(--surface\)|var\(--danger\)|border-radius:\s*11px|font-size:\s*1[123]px/);
  assert.match(styles, /\.dialog-panel\s*\{[\s\S]*?border-radius:\s*var\(--radius-sheet\)/);
  assert.match(
    styles,
    /:is\(\.dialog-panel, \.sheet, \.response-footer-metadata-grid\)\s*\{[\s\S]*?var\(--material-glass-fill\)[\s\S]*?var\(--material-glass-edge\)[\s\S]*?var\(--material-glass-saturation\)/,
  );
  const backdropStart = styles.indexOf("/* The floating surface owns Quiet Glass.");
  assert.ok(backdropStart >= 0);
  const backdropRule = styles.slice(backdropStart, styles.indexOf("}", backdropStart) + 1);
  assert.match(backdropRule, /background:\s*color-mix\(in srgb, var\(--scrim\) 42%, transparent\)/);
  assert.doesNotMatch(backdropRule, /backdrop-filter/);
});
