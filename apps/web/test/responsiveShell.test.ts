// UX-A390 permanent regression tests: boundary classification and
// source-independent shell state rules for the Ember command shelf.
// The live geometry/interaction gate is apps/web/test/responsiveShell.live.ts
// (kept outside the default *.test.ts glob and run explicitly).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  COMPACT_MAX_WIDTH,
  PHONE_MAX_WIDTH,
  shellModeForWidth,
} from "../src/responsiveShell.ts";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

// ---- pure width classifier -------------------------------------------------

test("boundaries are the literal 820/480 contract", () => {
  assert.equal(COMPACT_MAX_WIDTH, 820);
  assert.equal(PHONE_MAX_WIDTH, 480);
});

test("width classification is exact at and around every boundary", () => {
  assert.equal(shellModeForWidth(0), "phone");
  assert.equal(shellModeForWidth(320), "phone");
  assert.equal(shellModeForWidth(390), "phone");
  assert.equal(shellModeForWidth(480), "phone");
  assert.equal(shellModeForWidth(481), "compact");
  assert.equal(shellModeForWidth(600), "compact");
  assert.equal(shellModeForWidth(768), "compact");
  assert.equal(shellModeForWidth(820), "compact");
  assert.equal(shellModeForWidth(821), "wide");
  assert.equal(shellModeForWidth(1000), "wide");
  assert.equal(shellModeForWidth(1280), "wide");
});

test("classifier is monotonic: growing width never returns to a narrower mode", () => {
  const rank = { phone: 0, compact: 1, wide: 2 } as const;
  let prev = -1;
  for (let w = 0; w <= 2000; w += 1) {
    const r = rank[shellModeForWidth(w)];
    assert.ok(r >= prev, `mode rank regressed at ${w}px`);
    prev = r;
  }
});

// ---- source-independent shell state rules ----------------------------------

test("width alone selects shell mode: no pointer/hover/UA/touch signals, no persistence", async () => {
  const raw = await read("../src/responsiveShell.ts");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  for (const banned of ["pointer", "hover", "userAgent", "maxTouchPoints", "ontouch", "localStorage", "sessionStorage"]) {
    assert.ok(!src.toLowerCase().includes(banned.toLowerCase()), `responsiveShell.ts must not use ${banned}`);
  }
  assert.ok(src.includes("matchMedia"), "useShellMode subscribes through matchMedia");
  assert.ok(src.includes("useSyncExternalStore"), "useShellMode is a useSyncExternalStore subscription");
});

test("responsiveShell.ts is the sole JavaScript breakpoint seam", async () => {
  const files = [
    "../src/components/Header.tsx",
    "../src/components/Sidebar.tsx",
    "../src/components/ContextRail.tsx",
    "../src/components/Composer.tsx",
    "../src/components/StatusBar.tsx",
  ];
  for (const f of files) {
    const src = await read(f);
    assert.ok(!src.includes("matchMedia"), `${f} must use useShellMode, not its own media query`);
    assert.ok(!/\b(820|480)\b/.test(src.replace(/UX-A390[^\n]*/g, "")), `${f} must not hardcode breakpoint numbers`);
  }
});

test("CSS carries the same literal width/height contracts", async () => {
  const css = await read("../src/styles.css");
  assert.ok(css.includes("(max-width: 820px)"), "compact boundary present in CSS");
  assert.ok(css.includes("(max-width: 480px)"), "phone boundary present in CSS");
  assert.ok(css.includes("(max-height: 600px)"), "short-height contract present in CSS");
});

test("compact sidebar is a drawer, never display:none with no way back", async () => {
  const css = await read("../src/styles.css");
  assert.ok(!/\.sidebar\s*\{\s*display:\s*none/.test(css), "the old unrecoverable .sidebar{display:none} must stay dead");
  assert.ok(!/\.rail\s*\{\s*display:\s*none/.test(css), "the old .rail{display:none} strip lie must stay dead");
  assert.ok(css.includes(".sidebar.open"), "drawer open state styled");
  assert.ok(css.includes("min(320px, calc(100vw - 24px))"), "drawer width contract");
  assert.ok(css.includes(".panel-sheet"), "registered panel sheet styled");
  assert.ok(css.includes("min(380px, 100vw)"), "sheet width contract");
});

test("header owns the drawer trigger, compact view picker, and panel trigger", async () => {
  const header = await read("../src/components/Header.tsx");
  assert.ok(header.includes('aria-controls="polyth-session-drawer"'), "drawer trigger targets the drawer");
  assert.ok(header.includes("Open projects and sessions"), "drawer trigger accessible name");
  assert.ok(header.includes("NarrowPanelTrigger"), "registry-backed panel trigger rendered from the header");
  assert.ok(header.includes("Change workspace view, current:"), "compact view trigger keeps the current label in its name");
  assert.ok(header.includes("const resolved = useResolvedCapabilities()"), "compact picker consumes the shared capability model");
  assert.ok(header.includes("VIEW_OF_CAPABILITY[c.descriptor.id]"), "compact picker maps capability descriptors to views");
  assert.ok(!header.includes("const VIEW_GROUPS"), "no duplicate hard-coded view list");
  assert.ok(header.includes('"Auto-accept on" : "Auto-accept off"'), "auto-accept state exposed as text, not color alone");
});

test("modal surfaces share the Dialog focus contract (no copied traps)", async () => {
  const dialog = await read("../src/components/a11y/Dialog.tsx");
  assert.ok(dialog.includes("export function useModalSurface"), "Dialog.tsx exports the reusable hook");
  const sidebar = await read("../src/components/Sidebar.tsx");
  const rail = await read("../src/components/ContextRail.tsx");
  const preset = await read("../src/components/PresetSetup.tsx");
  const palette = await read("../src/components/CommandPalette.tsx");
  for (const [name, src] of [
    ["Sidebar", sidebar],
    ["ContextRail", rail],
    ["PresetSetup", preset],
    ["CommandPalette", palette],
  ] as const) {
    assert.ok(src.includes("useModalSurface"), `${name} consumes useModalSurface`);
    assert.ok(!src.includes("FOCUSABLE"), `${name} must not copy a focus-trap implementation`);
  }
  assert.ok(sidebar.includes('id="polyth-session-drawer"'), "drawer id matches the trigger");
  assert.ok(
    rail.includes('id={compact ? "polyth-panel-sheet" : undefined}'),
    "compact sheet id matches the trigger without duplicating it on the desktop rail",
  );
  assert.ok(rail.includes("export function NarrowPanelTrigger"), "panel trigger exported for the header");
  assert.ok(rail.includes("useRailSurfaceModel"), "trigger and host share one visibleSurfaces model");
});

test("drawer closes only after successful session activation", async () => {
  const list = await read("../src/components/sidebar/SessionList.tsx");
  assert.match(list, /openSession\(id\)\.then\(/, "close happens after openSession resolves");
  const sidebar = await read("../src/components/Sidebar.tsx");
  assert.match(sidebar, /createSession\(activeProjectId\)\s*\n?\s*\.then\(closeDrawer\)/, "new-session closes the drawer only on success");
});

test("composer bar exposes the two-tier semantic groups without forking send", async () => {
  const composer = await read("../src/components/Composer.tsx");
  for (const cls of ["composer-selectors", "composer-extensions", "composer-actions", "composer-primary"]) {
    assert.ok(composer.includes(cls), `composer bar renders .${cls}`);
  }
  assert.equal(composer.match(/const send = useCallback/g)?.length, 1, "exactly one send() path");
  const css = await read("../src/styles.css");
  assert.ok(css.includes("repeat(2, minmax(0, 1fr))"), "phone selector grid contract");
});

test("hero and docked composers expose the shared stable focus target", async () => {
  const composer = await read("../src/components/Composer.tsx");
  const input = await read("../src/components/input/AdaptiveTextInput.tsx");
  const store = await read("../src/store.ts");
  assert.ok(composer.includes('variant === "hero" ? "composer-hero" : "composer"'), "one component owns both variants");
  assert.ok(composer.includes('data-composer-input=""'), "both variants mark the shared input");
  assert.ok(input.includes("data-composer-input={dataComposerInput}"), "the marker reaches the textarea");
  assert.ok(store.includes('COMPOSER_INPUT_SELECTOR = "[data-composer-input]"'), "focus uses the stable marker");
  assert.ok(store.includes("export function focusComposer()"), "one focus command is exported");
});

test("timeline empty states defer starters to the hero", async () => {
  const timeline = await read("../src/components/Timeline.tsx");
  assert.ok(!timeline.includes("const STARTERS"), "the timeline no longer duplicates hero starters");
  assert.ok(timeline.includes("Answer the pending question below to continue."), "pending questions get actionable copy");
  assert.ok(timeline.includes("This archived session has no messages."), "archived sessions get read-only copy");
});

test("header and rail share one capability disclosure", async () => {
  const header = await read("../src/components/Header.tsx");
  const rail = await read("../src/components/ContextRail.tsx");
  const menu = await read("../src/components/CapabilityMenu.tsx");
  const store = await read("../src/store.ts");
  assert.ok(header.includes("<CapabilityMenu"), "header consumes the shared disclosure");
  assert.ok(rail.includes("<CapabilityMenu"), "rail consumes the shared disclosure");
  assert.ok(menu.includes('role="group"'), "disclosure uses grouped native buttons");
  assert.ok(!menu.includes('role="menuitem"'), "disclosure does not claim unsupported menu arrow behavior");
  assert.ok(!store.includes("moreOpen:"), "dead global More-tools state stays removed");
  assert.ok(!store.includes("setMoreOpen"), "dead global More-tools action stays removed");
});

test("status bar segments carry stable keys and phone priority", async () => {
  const bar = await read("../src/components/StatusBar.tsx");
  for (const cls of ["sb-project", "sb-branch", "sb-model", "sb-agent", "sb-view"]) {
    assert.ok(bar.includes(cls), `status bar renders .${cls}`);
  }
  const css = await read("../src/styles.css");
  assert.ok(/\.sb-branch,\s*\.sb-model,\s*\.sb-agent/.test(css), "phone suppresses secondary segments instead of clipping them");
});
