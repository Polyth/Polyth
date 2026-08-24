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
  const actions = await read("../src/widgets/builtinMiniWidgets.tsx");
  assert.ok(header.includes('aria-controls="polyth-session-drawer"'), "drawer trigger targets the drawer");
  assert.ok(header.includes("Open projects and sessions"), "drawer trigger accessible name");
  assert.ok(header.includes("NarrowPanelTrigger"), "registry-backed panel trigger rendered from the header");
  assert.ok(header.includes("Change workspace view, current:"), "compact view trigger keeps the current label in its name");
  assert.ok(header.includes("const resolved = useResolvedCapabilities()"), "compact picker consumes the shared capability model");
  assert.ok(header.includes("VIEW_OF_CAPABILITY[c.descriptor.id]"), "compact picker maps capability descriptors to views");
  assert.ok(!header.includes("const VIEW_GROUPS"), "no duplicate hard-coded view list");
  assert.ok(
    actions.includes('"Turn off auto-approve" : "Turn on auto-approve"'),
    "placeable auto-approve control exposes the resulting action in its accessible name",
  );
});

test("modal surfaces share the Dialog focus contract (no copied traps)", async () => {
  const dialog = await read("../src/components/a11y/Dialog.tsx");
  assert.ok(dialog.includes("export function useModalSurface"), "Dialog.tsx exports the reusable hook");
  const sidebar = await read("../src/components/Sidebar.tsx");
  const rail = await read("../src/components/ContextRail.tsx");
  const projectSetup = await read("../src/components/ProjectSetup.tsx");
  const palette = await read("../src/components/CommandPalette.tsx");
  for (const [name, src] of [
    ["Sidebar", sidebar],
    ["ContextRail", rail],
    ["ProjectSetup", projectSetup],
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

test("drawer opens existing sessions but new chat defers session creation", async () => {
  const list = await read("../src/components/sidebar/SessionList.tsx");
  assert.match(list, /openSession\(id\)\.then\(/, "close happens after openSession resolves");
  const sidebar = await read("../src/components/Sidebar.tsx");
  assert.ok(sidebar.includes("startNewSession(p.id)"), "project plus enters the unsaved composer surface");
  assert.ok(
    list.includes('startNewSession(projectId, key === "__main__" ? {} : { worktreePath: key })'),
    "worktree plus enters the unsaved composer with its contextual target",
  );
  assert.ok(!sidebar.includes("createSession("), "new chat never posts a session before first send");
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

test("composer active-run controls and mobile actions stay direct", async () => {
  const composer = await read("../src/components/Composer.tsx");
  const timeline = await read("../src/components/Timeline.tsx");
  const goal = await read("../src/components/GoalStrip.tsx");
  const css = await read("../src/styles.css");
  assert.ok(composer.includes("<Icon.sendClock />"), "queue mode uses the clock-send icon");
  assert.ok(composer.includes("Send now"), "queue options expose immediate delivery");
  assert.ok(composer.includes("Stop without sending this draft"), "queue options expose stop");
  assert.ok(composer.includes("composer-stop-primary"), "active sends become a primary stop control");
  assert.ok(timeline.includes('className="msg-actions"'), "message actions remain inline");
  assert.match(css, /Phone quick actions are immediately available[\s\S]*?\.focus-conversation \.msg \.msg-actions\s*\{[^}]*display:\s*flex/);
  assert.ok(goal.includes("<Dialog title=\"Session goal\""), "goal parameters open in a focused modal");
});

test("Focus uses compact mobile composer controls without editor chrome", async () => {
  const composer = await read("../src/components/Composer.tsx");
  const actions = await read("../src/widgets/builtinMiniWidgets.tsx");
  assert.ok(composer.includes('simpleMode && variant === "docked"'), "light controls are scoped to docked Focus");
  assert.ok(composer.includes('className="composer-extensions composer-mobile-extensions"'), "Focus exposes slotted mobile actions");
  assert.ok(actions.includes('"permissions.auto-approve-composer-action"'), "auto-approve is a placeable composer action");
  assert.ok(actions.includes('"session.goal-composer-action"'), "goals are a placeable composer action");
  // UX-MOBILE-01 §17/§19: phones expose ONE `+` (the Add menu owns Upload);
  // wider layouts keep the direct upload chip beside it.
  assert.ok(composer.includes('aria-label="Add files"'), "wider layouts keep a direct upload control");
  assert.ok(
    composer.includes('trigger={phoneLayout ? "add" : "tools"}'),
    "the phone add menu is the single plus control",
  );
  assert.ok(!composer.includes("<Icon.focus />"), "Focus removes the focused-editor header action");
  assert.ok(actions.includes("<Icon.shield />"), "Focus exposes the auto-approve shield");
  assert.ok(actions.includes("<Icon.target />"), "Focus exposes the goals target");
  assert.ok(composer.includes("<Icon.send />"), "Focus uses a paper-plane send icon");
  const css = await read("../src/styles.css");
  assert.ok(css.includes(".composer-focus-light .chip-k { display: none; }"), "technical picker keys are hidden");
  assert.ok(css.includes('body[data-dictate="false"] .mic-btn'), "the microphone can be hidden without suppressing other slot items");
});

test("desktop header keeps brand, workspace modes, and a named utility cluster", async () => {
  const header = await read("../src/components/Header.tsx");
  const actions = await read("../src/widgets/builtinMiniWidgets.tsx");
  const sidebar = await read("../src/components/Sidebar.tsx");
  assert.ok(header.includes('<span className="polyth-mark">p</span>'), "stylized Polyth mark is visible");
  assert.ok(header.includes("<strong>polyth</strong>"), "wordmark text is visible");
  assert.ok(header.includes('className="workspace-mode-switch"'), "Focus and Canvas remain next to the brand");
  assert.ok(!header.includes("header-breadcrumbs"), "project and branch crumbs are removed");
  assert.ok(sidebar.includes('setOverlay("project-picker")'), "project switching remains available in the project sidebar");
  assert.ok(header.includes('<div className="header-actions"'), "utilities share one right-side cluster");
  for (const label of ["Search", "History", "Settings"]) {
    assert.ok(actions.includes(`<span>${label}</span>`), `${label} utility remains named`);
  }
  assert.ok(!header.includes('className="header-global-search"'), "Search is not duplicated in the header");
});

test("Settings uses a focused desktop dialog without a widget preview inspector", async () => {
  const settings = await read("../src/components/SettingsView.tsx");
  const css = await read("../src/styles.css");
  const widgets = await read("../src/components/settings/WidgetsPage.tsx");
  assert.ok(settings.includes('className="scrim settings-scrim"'), "Settings owns viewport-specific scrim geometry");
  assert.ok(css.includes("width: min(92vw, 780px); max-width: 780px; height: 92vh"), "Settings has a 780px desktop width cap");
  assert.doesNotMatch(css, /\.settings-shell\s*\{[^}]*min-width:\s*1100px/, "Settings no longer forces an 1100px minimum width");
  assert.ok(!widgets.includes("widget-inspector"), "widget settings no longer render a preview inspector");
});

test("pending OpenCode changes render in the pinned Settings footer with an opaque restart overlay", async () => {
  const settings = await read("../src/components/SettingsView.tsx");
  const restart = await read("../src/components/OpenCodeRestartControl.tsx");
  const css = await read("../src/styles.css");
  assert.match(
    settings,
    /<div className="nav-foot">\s*<SlotHost slot="settings\.footer" \/>/,
    "Settings owns the restart-control host at the start of its pinned navigation footer",
  );
  assert.ok(
    restart.includes('registerSlot("settings.footer", "opencode.apply-restart"'),
    "the restart control no longer contributes to the main app sidebar",
  );
  assert.match(
    css,
    /\.opencode-restart-overlay\s*\{[^}]*background:\s*rgba\(0,\s*0,\s*0,\s*\.78\)/,
    "the restart overlay strongly obscures the UI underneath",
  );
});

test("open rails remain visible in every workspace mode", async () => {
  const rail = await read("../src/components/ContextRail.tsx");
  const css = await read("../src/styles.css");
  assert.ok(rail.includes('`railbar${open ? " railbar-open" : ""}`'), "the host marks an active surface");
  assert.ok(
    !css.includes(".app.view-session.mode-chat .railbar:not(.railbar-open)"),
    "Chat keeps the inactive desktop rail available as a stable launcher",
  );
  for (const mode of ["widgets", "edit"]) {
    assert.ok(
      css.includes(`.app.view-session.mode-${mode} .railbar:not(.railbar-open)`),
      `${mode} hides only an inactive rail host`,
    );
  }
  assert.ok(!/mode-chat \.railbar\s*[,{][^}]*display:\s*none/.test(css), "Chat never hides an active rail");
});

test("mobile Settings swaps a vertical page list for content with a back action", async () => {
  const settings = await read("../src/components/SettingsView.tsx");
  const css = await read("../src/styles.css");
  const mobileSettingsMarker = css.indexOf("/* Mobile Settings");
  const finalBreakpoint = css.indexOf("@media (max-width: 700px)", mobileSettingsMarker);
  assert.ok(finalBreakpoint > css.indexOf("focused, centered"), "mobile rules follow desktop workbench overrides");
  const mobile = css.slice(finalBreakpoint);
  const mobileHeaderStart = settings.indexOf("{mobile ? (");
  const mobileHeader = settings.slice(mobileHeaderStart, settings.indexOf(") : (", mobileHeaderStart));
  assert.ok(settings.includes('type MobileStage = "nav" | "page"'), "Settings models the two mobile stages");
  assert.ok(settings.includes('window.matchMedia("(max-width: 700px)")'), "Settings tracks the mobile breakpoint");
  assert.ok(settings.includes('className="settings-mobile-back"'), "the page header renders a mobile back button");
  assert.ok(settings.includes('className="settings-pane-head-bar"'), "mobile back and close actions share a header bar");
  assert.doesNotMatch(mobileHeader, /current\.label/, "the mobile shell header leaves the page title to PageHead");
  assert.match(mobile, /\.settings-nav-list\s*\{[^}]*flex-direction:\s*column/);
  assert.match(mobile, /\.settings-nav-list\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(mobile, /\.settings-mobile-nav \.settings-pane\s*\{[^}]*display:\s*none/);
  assert.match(mobile, /\.settings-mobile-page \.settings-nav\s*\{[^}]*display:\s*none/);
  assert.match(mobile, /\.settings-mobile-page \.settings-pane\s*\{[^}]*display:\s*flex/);
  assert.match(mobile, /\.settings-mobile-page \.settings-pane-head\s*\{[^}]*display:\s*block[^}]*min-height:\s*0/);
  assert.doesNotMatch(mobile, /\.settings-mobile-page \.set-page-head\s*>\s*h3\s*\{[^}]*display:\s*none/);
  assert.match(
    mobile,
    /\.settings-mobile-page \.widget-settings-toolbar,\s*\.settings-mobile-page \.widget-placement-toolbar\s*\{[^}]*position:\s*static[^}]*margin-inline:\s*-20px/,
  );
  assert.match(mobile, /\.settings-pane-body \.set-row\s*\{[^}]*flex-direction:\s*column/);
  assert.match(mobile, /\.settings-pane-body \.set-row-control\s*\{[^}]*width:\s*100%/);
  assert.doesNotMatch(mobile, /\.settings-nav-list\s*\{[^}]*overflow-x:\s*auto/);
});

test("package and plugin marketplaces use responsive vertical tiles", async () => {
  const css = await read("../src/styles.css");
  assert.match(
    css,
    /\.settings-pane-body \.package-grid,\s*\.settings-pane-body \.plugin-card-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)\s*!important[^}]*gap:\s*10px/,
    "marketplace grids use two pane-relative columns by default",
  );
  assert.match(
    css,
    /@media \(max-width: 480px\)[\s\S]*?\.settings-pane-body \.package-grid,\s*\.settings-pane-body \.plugin-card-grid\s*\{[^}]*grid-template-columns:\s*1fr/,
    "marketplace grids collapse to one column on phones",
  );
  assert.doesNotMatch(css, /\.plugin-card-grid, \.package-grid\s*\{[^}]*repeat\([34], minmax\(150px, 1fr\)\)/);
  assert.match(css, /\.package-tile\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*align-items:\s*center/);
  assert.match(css, /\.plugin-card-main\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*align-items:\s*center/);
  assert.match(css, /\.package-icon\s*\{[^}]*width:\s*58px[^}]*height:\s*58px/);
});

test("shared menu, destructive, failed-turn, and header-action contracts stay wired", async () => {
  const sidebar = await read("../src/components/Sidebar.tsx");
  const header = await read("../src/components/Header.tsx");
  const actions = await read("../src/widgets/builtinMiniWidgets.tsx");
  const sessions = await read("../src/components/sidebar/SessionList.tsx");
  const plugins = await read("../src/components/settings/pages.tsx");
  const css = await read("../src/styles.css");
  assert.ok(sidebar.includes("useDismissibleMenu"), "project actions consume the shared menu contract");
  assert.ok(header.includes("useDismissibleMenu"), "the user menu consumes the shared menu contract");
  assert.ok(actions.includes('setOverlay("palette")'), "Search opens the command/action palette");
  assert.ok(actions.includes('setOverlay("search")'), "History opens session history search");
  assert.ok(sessions.includes("window.confirm"), "every permanent session deletion is guarded");
  assert.ok(plugins.includes('disabled={!sourceValid}'), "plugin install stays disabled until minimally valid");
  assert.match(css, /\.turn-error\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap[^}]*gap:\s*8px/);
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

test("header owns the capability disclosure while the rail renders configured tools", async () => {
  const header = await read("../src/components/Header.tsx");
  const rail = await read("../src/components/ContextRail.tsx");
  const menu = await read("../src/components/CapabilityMenu.tsx");
  const store = await read("../src/store.ts");
  assert.ok(header.includes("<CapabilityMenu"), "header consumes the shared disclosure");
  assert.ok(!rail.includes("CapabilityMenu"), "rail dropped its duplicate More-tools picker");
  assert.ok(rail.includes("configuredRailSurfaces"), "rail renders only configured tool buttons");
  assert.ok(rail.includes("reorderRail"), "rail arranges surfaces by drag-reorder instead");
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
