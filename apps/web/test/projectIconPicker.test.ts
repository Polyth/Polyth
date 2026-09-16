import assert from "node:assert/strict";
import test from "node:test";

import {
  filterProjectIcons,
  embeddedIconifyName,
  filterSupportedIconifyNames,
  iconifyProjectIconName,
  iconifyProjectIconValue,
  iconifySearchUrl,
  iconifySvgUrl,
  inlineIconifySvgDataUrl,
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

test("Iconify URLs encode the source and use all agreed collections", () => {
  assert.equal(iconifySvgUrl("mynaui:menu"), "https://api.iconify.design/mynaui/menu.svg");
  const search = new URL(iconifySearchUrl("folder search"));
  assert.equal(search.hostname, "api.iconify.design");
  assert.equal(search.searchParams.get("query"), "folder search");
  assert.equal(search.searchParams.get("prefixes"), "hugeicons,mingcute,ph,mynaui,tabler");
  assert.equal(projectIconProviderLabel("ph:folder"), "Phosphor");
  assert.equal(projectIconMaskUrl("iconify:ph:folder"), "https://api.iconify.design/ph/folder.svg");
  assert.equal(projectIconMaskUrl("/assets/project-icons/folder.svg"), "/assets/project-icons/folder.svg");
});

test("recent and favorites are deterministic, deduplicated convenience state", () => {
  assert.deepEqual(updateRecentProjectIcons(["a", "b", "c"], "b", 3), ["b", "a", "c"]);
  assert.deepEqual(updateRecentProjectIcons(["a", "b"], "c", 2), ["c", "a"]);
  assert.deepEqual(toggleFavoriteProjectIcon(["a", "b"], "b"), ["a"]);
  assert.deepEqual(toggleFavoriteProjectIcon(["a", "b"], "c"), ["c", "a", "b"]);
});


test("remote icons persist as self-contained SVG data while retaining their Iconify identity", () => {
  const stored = inlineIconifySvgDataUrl(
    "ph:magnifying-glass",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M0 0h1v1H0z"/></svg>',
    "#B4532A",
  );
  assert.match(stored, /^data:image\/svg\+xml;charset=utf-8,/);
  assert.equal(embeddedIconifyName(stored), "ph:magnifying-glass");
  assert.equal(storedProjectIconSelection(stored), "iconify:ph:magnifying-glass");
  assert.equal(projectIconMaskUrl(stored), "https://api.iconify.design/ph/magnifying-glass.svg");
  const decoded = decodeURIComponent(stored.split(",", 2)[1] ?? "");
  assert.match(decoded, /#b4532a/);
  assert.doesNotMatch(decoded, /currentColor/);
});

test("embedded Iconify metadata rejects unsupported providers", () => {
  const fake = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg><metadata id="polyth-iconify">mdi:folder</metadata></svg>')}`;
  assert.equal(embeddedIconifyName(fake), null);
  assert.equal(storedProjectIconSelection(fake), fake);
});
