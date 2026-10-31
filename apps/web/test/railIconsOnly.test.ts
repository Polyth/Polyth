// Regression guard for the right rail UX decision: icons only, no visible
// labels (the old strip-label spans truncated to "Chan…", "Comp…", …).
// Accessibility is carried by title + aria-label on every strip button.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const railSource = () =>
  readFile(new URL("../src/components/ContextRail.tsx", import.meta.url), "utf8");
const stylesSource = () =>
  readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("ContextRail renders no visible strip labels", async () => {
  const src = await railSource();
  assert.ok(!src.includes("strip-label"), "rail must stay icons-only (no strip-label spans)");
});

test("ContextRail never exposes aria labels as visible desktop rail text", async () => {
  const css = await stylesSource();
  assert.doesNotMatch(
    css,
    /\.strip-btn::after\s*\{[^}]*content:\s*attr\(aria-label\)/s,
    "accessible labels must remain tooltip and screen-reader text, not rail chrome",
  );
});

test("ContextRail strip buttons keep title + aria-label for hover/accessibility", async () => {
  const src = await railSource();
  assert.ok(src.includes("title={s.title}"), "surface buttons need title");
  assert.ok(src.includes("aria-label={s.title}"), "surface buttons need aria-label");
});

test("ContextRail omits the bottom add and More button group", async () => {
  const src = await railSource();
  assert.ok(!src.includes("rail-add-button"), "the add control is gone");
  assert.ok(!src.includes("strip-more"), "the More control is gone");
  assert.ok(!src.includes("moreToolsPicker"), "the old bottom button group is gone");
});

test("desktop rail width and header geometry use the configured icon strip", async () => {
  const css = await stylesSource();
  assert.match(
    css,
    /\.rail\s*\{[^}]*width:\s*var\(--rail-w,\s*300px\)[^}]*flex:\s*0 1 var\(--rail-w,\s*300px\)/s,
    "the panel leaves room for the icon strip inside the 344px rail host",
  );
  assert.match(
    css,
    /\.rail-icon-col\.plugin-strip\s*\{[^}]*width:\s*var\(--rail-strip-width-right[^}]*min-width:\s*var\(--rail-strip-width-right[^}]*padding-inline:\s*var\(--rail-strip-gutter-start, var\(--space-2\)\) var\(--rail-strip-gutter-end, var\(--space-1\)\)/s,
    "the icon strip is the configured button width plus token gutters, the wider one toward the workspace",
  );
  assert.doesNotMatch(
    css,
    /\.plugin-strip\s*\{[^}]*width:\s*var\(--tap\)/s,
    "the desktop strip must not reserve a fixed tap-width column",
  );
  assert.match(
    css,
    /\.strip-btn\s*\{[^}]*width:\s*var\(--rail-icon-size-right[^}]*height:\s*var\(--rail-icon-size-right/s,
    "right-rail buttons use the configured visual size",
  );
  assert.match(
    css,
    /\.rail-fullscreen\s*\{[^}]*inset-inline-end:\s*var\(--rail-strip-width-right/s,
    "the full-screen pane leaves exactly the configured strip width",
  );
  assert.match(
    css,
    /\.rail-icon-col\s*\{[^}]*margin-top:\s*0/s,
    "the desktop strip reaches the header boundary without a top gap",
  );
  assert.match(
    css,
    /\.rail-head\s*\{[^}]*min-height:\s*60px/s,
    "the panel head aligns with the desktop application header",
  );
  assert.doesNotMatch(
    css,
    /body\[data-density="compact"\] \.rail-head/,
    "desktop density preferences must not break shell header alignment",
  );
});

test("top-rail buttons and glyphs use their configured sizes", async () => {
  const css = await stylesSource();
  assert.match(
    css,
    /\.view-icon\s*\{[^}]*width:\s*var\(--rail-icon-size-top[^}]*height:\s*var\(--rail-icon-size-top/s,
  );
  assert.match(
    css,
    /\.view-icon > svg\s*\{[^}]*width:\s*var\(--rail-icon-glyph-top[^}]*height:\s*var\(--rail-icon-glyph-top/s,
  );
});

test("coarse pointers expand rail hit areas without widening visual buttons", async () => {
  const css = await stylesSource();
  assert.match(
    css,
    /\.strip-btn::after\s*\{[^}]*width:\s*max\(100%,\s*var\(--hit-min\)\)[^}]*height:\s*max\(100%,\s*var\(--hit-min\)\)/s,
  );
  assert.doesNotMatch(
    css,
    /@media\s*\(pointer:\s*coarse\)\s*\{[^}]*\.strip-btn\s*\{[^}]*width:\s*var\(--tap\)/s,
  );
});

// Registered panes and capabilities without a panel body use
// the same strip launcher contract.
test("ContextRail has no JUMPS rows — every placed capability gets a launcher", async () => {
  const src = await railSource();
  assert.ok(!src.includes("JUMPS"), "jump rows were replaced by workspace pane launchers");
  assert.ok(src.includes("onClick={s.activate}"), "strip buttons use their shared launcher");
  const placement = await readFile(new URL("../src/railPlacement.ts", import.meta.url), "utf8");
  assert.ok(src.includes("rightRailCapabilities("), "the shared one-home rules drive the button list");
  assert.ok(placement.includes('capability.tier === "more"'), "right-rail placement drives the button list");
  assert.ok(src.includes("toggleCapability"), "capabilities without panel surfaces use the shared toggle");
});

test("right-rail host utilities use distinct semantic icons", async () => {
  const shell = await readFile(new URL("../src/components/railSurfaces.tsx", import.meta.url), "utf8");
  assert.match(shell, /id: "context"[\s\S]*?icon: RAIL_ICONS\.context/);
  assert.match(shell, /id: "events"[\s\S]*?icon: RAIL_ICONS\.events/);
});

test("rail icon module initializes every configured glyph", async () => {
  const { RAIL_ICONS } = await import("../src/railIcons.ts");
  for (const [id, renderIcon] of Object.entries(RAIL_ICONS)) {
    const element = renderIcon();
    assert.ok(element.type, `${id} must resolve to an exported icon component`);
  }
});

test("every primary built-in rail item has a unique Lucide icon", async () => {
  const mappingSource = await readFile(new URL("../src/railIcons.ts", import.meta.url), "utf8");
  const items = [
    "session", "files", "git", "terminal", "browser", "goals", "multirun",
    "workflow", "fusion", "walkthrough", "schedule", "usage", "github",
    "knowledge", "context", "voice", "models-agents", "events", "diagnostics",
    "tracks", "notification-centre", "personal-coach",
    // Package launchers that used to fall back to the generic package glyph.
    "monitoring", "docker", "terraform", "google", "web-search", "playground",
    "tunnel", "permissions", "recap", "conversation-find",
  ];
  const icons = items.map((item) => {
    const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = mappingSource.match(new RegExp(`(?:"${escaped}"|${escaped}): glyph\\((\\w+)\\)`));
    assert.ok(match, `missing rail icon for ${item}`);
    return match[1]!;
  });
  assert.equal(new Set(icons).size, icons.length, "primary rail items must use distinct Lucide glyphs");
  assert.ok(mappingSource.includes("strokeWidth: 1.8"), "rail icons share the same monochrome stroke treatment");
});

test("rail eligibility excludes settings-only and agent-only capabilities", async () => {
  const src = await railSource();
  assert.match(src, /hasRailDestination/);
  assert.match(src, /surfaceByCapability\.has\(capability\.descriptor\.id\)/);
  // The one list of destinations the rail can draw, shared with placement.
  assert.match(src, /const destinations = railDestinationIds\(\)/);
  assert.match(src, /destinations\.has\(capability\.descriptor\.id\)/);
  assert.match(src, /&& hasRailDestination\(capability\)/);
  const placement = await readFile(new URL("../src/railPlacement.ts", import.meta.url), "utf8");
  const destinations = placement.slice(placement.indexOf("export function railDestinationIds"));
  assert.match(destinations, /new Set<string>\(\["workspace-edit"\]\)/, "Edit mode is a destination");
  assert.match(destinations, /isCommandCapability\(capability\)\) ids\.add/, "a command launcher needs none");
  assert.match(destinations, /pageOwners\.has\(capability\.ownerPackageId\)/, "a package page in place of Chat is one");
  assert.ok(!src.includes("openSettingsPage(\"web-search\")"), "Web Search settings remain package-owned, not rail-owned");
});

test("every in-repo package rail launcher has its own mark, not the generic package glyph", async () => {
  const { RAIL_ICONS, railIconFor } = await import("../src/railIcons.ts");
  const generic = railIconFor("no-such-package-id")().type;
  const launchers = [
    "browser", "conversation-find", "voice", "docker", "files",
    "workspace-search", "fusion", "git", "github", "gitlab", "goals", "google",
    "tracks", "markets", "models-agents", "monitoring", "multirun", "personal-coach",
    "playground", "diagnostics", "schedule", "task-trackers", "terminal", "terraform",
    "tunnel", "usage", "voice-mode", "walkthrough", "web-search", "workflow",
    // Widget plugin ids resolved by the widget pickers.
    "conversation", "gallery", "permissions", "recap", "system",
  ];
  for (const id of launchers) {
    assert.ok(RAIL_ICONS[id], `${id} has a rail mark`);
    assert.notEqual(railIconFor(id)().type, generic, `${id} must not fall back to the package glyph`);
  }
});

test("workspace search has a semantic rail icon", async () => {
  const mappingSource = await readFile(new URL("../src/railIcons.ts", import.meta.url), "utf8");
  assert.match(mappingSource, /"workspace-search": glyph\(SearchIcon\)/);
});
