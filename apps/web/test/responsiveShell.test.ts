// UX-A390 permanent regression tests: boundary classification and
// source-independent shell state rules for the Ember command shelf.
// The live geometry/interaction gate is apps/web/test/responsiveShell.live.ts
// (kept outside the default *.test.ts glob and run explicitly).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  COMPACT_MAX_WIDTH,
  PHONE_LANDSCAPE_MAX_HEIGHT,
  PHONE_MAX_WIDTH,
  shellModeForViewport,
  shellModeForWidth,
} from "../src/responsiveShell.ts";
import { readWebStyles } from "./webStyles.ts";

const read = (rel: string) =>
  rel === "../src/styles.css"
    ? readWebStyles()
    : readFile(new URL(rel, import.meta.url), "utf8");

// ---- pure width classifier -------------------------------------------------

test("boundaries are the literal compact and phone contracts", () => {
  // 960, not 820: the persistent navigator only holds when a comfortable
  // workspace survives beside it — SIDEBAR_DEFAULT_WIDTH 332 + ~620–628px ≈ 960
  // (rendered: ~621px workspace / ~517px conversation lane at 961px). Portrait
  // tablets (≤834) and half-width windows sit in the drawer shell; landscape
  // tablets (≥1080) keep the persistent nav.
  assert.equal(COMPACT_MAX_WIDTH, 960);
  assert.equal(PHONE_MAX_WIDTH, 480);
  assert.equal(PHONE_LANDSCAPE_MAX_HEIGHT, 480);
});

test("width classification is exact at and around every boundary", () => {
  assert.equal(shellModeForWidth(0), "phone");
  assert.equal(shellModeForWidth(320), "phone");
  assert.equal(shellModeForWidth(375), "phone");
  assert.equal(shellModeForWidth(390), "phone");
  assert.equal(shellModeForWidth(480), "phone");
  assert.equal(shellModeForWidth(481), "compact");
  assert.equal(shellModeForWidth(600), "compact");
  assert.equal(shellModeForWidth(768), "compact");
  assert.equal(shellModeForWidth(820), "compact");
  assert.equal(shellModeForWidth(834), "compact", "11\" iPad portrait is single-stage, not persistent-nav");
  assert.equal(shellModeForWidth(900), "compact", "half of a 1920 desktop stays a drawer shell");
  assert.equal(shellModeForWidth(959), "compact");
  assert.equal(shellModeForWidth(960), "compact");
  assert.equal(shellModeForWidth(961), "wide", "first persistent-nav width: ~621px workspace survives the 332px navigator");
  assert.equal(shellModeForWidth(1024), "wide");
  assert.equal(shellModeForWidth(1080), "wide", "smallest landscape tablet keeps the persistent navigator");
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

test("short coarse-pointer viewports use the phone shell in landscape", () => {
  assert.equal(shellModeForViewport(932, 430, true), "phone", "large landscape phone");
  assert.equal(shellModeForViewport(844, 390, true), "phone", "standard landscape phone");
  assert.equal(shellModeForViewport(821, 480, true), "phone", "height boundary is inclusive");
  assert.equal(shellModeForViewport(932, 481, true), "compact",
    "one row taller than the landscape-phone height: not phone; 932 < 960 so compact, not wide");
  assert.equal(shellModeForViewport(1000, 481, true), "wide", "tall coarse viewport past the seam stays wide");
  assert.equal(shellModeForViewport(932, 430, false), "compact",
    "short fine-pointer window: the coarse landscape-phone rule does not fire; 932 < 960 so compact");
  assert.equal(shellModeForViewport(1400, 430, false), "wide", "short fine-pointer window past the seam stays wide");
  assert.equal(shellModeForViewport(768, 430, false), "compact", "short fine-pointer compact window stays compact");
});

// ---- source-independent shell state rules ----------------------------------

test("shell mode uses bounded coarse-pointer detection without UA/touch sniffing or persistence", async () => {
  const raw = await read("../src/responsiveShell.ts");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  for (const banned of ["hover", "userAgent", "maxTouchPoints", "ontouch", "localStorage", "sessionStorage"]) {
    assert.ok(!src.toLowerCase().includes(banned.toLowerCase()), `responsiveShell.ts must not use ${banned}`);
  }
  assert.ok(src.includes("(pointer: coarse)"), "landscape phone query requires a coarse primary pointer");
  assert.ok(src.includes("(max-height:"), "landscape phone query is height bounded");
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
  assert.ok(css.includes("(max-width: 960px)"), "compact boundary (COMPACT_MAX_WIDTH) present in CSS");
  assert.ok(css.includes("(min-width: 961px)"), "wide-side twin (COMPACT_MAX_WIDTH + 1) present in CSS");
  assert.ok(css.includes("(max-width: 480px)"), "phone boundary present in CSS");
  assert.ok(css.includes("(max-height: 600px)"), "short-height contract present in CSS");
  assert.match(
    css,
    /body\[data-band="short"\] \.composer-mobile > \.session-context-bar\s*\{\s*display:\s*none/,
    "short landscape/keyboard bands remove the duplicate context row before clipping primary composer controls",
  );
});

test("long-press reorder handles keep native scrolling disabled", async () => {
  const css = await read("../src/styles.css");
  assert.match(css, /\.widget-drag-handle\s*\{\s*touch-action:\s*none/);
  assert.doesNotMatch(
    css,
    /:is\(\.settings-shell,[^)]+\) button\s*\{[^}]*touch-action:\s*manipulation/,
    "coarse-pointer button defaults must not override the reorder handle",
  );
  assert.match(
    css,
    /:is\(\.module-view-content,[^)]+\)\s*button[^\{]*:not\(\.widget-drag-handle\)[^\{]*\{[^}]*touch-action:\s*manipulation/,
    "container button defaults explicitly preserve the reorder handle",
  );
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

test("header keeps compact navigation and gives active phone chat a separate floating shell", async () => {
  const header = await read("../src/components/Header.tsx");
  const mobileHeader = await read("../src/components/mobile/MobileSessionHeader.tsx");
  const navigation = await read("../src/components/mobile/MobileNavigationRail.tsx");
  const actions = await read("../../../packages/permissions/widgets/index.tsx");
  assert.ok(header.includes('aria-controls="polyth-session-drawer"'), "drawer trigger targets the drawer");
  assert.ok(header.includes('tr("header.openProjectsAndSessions")'), "drawer trigger accessible name");
  assert.ok(header.includes("<MobileNavigationRail />"), "compact headers expose the shared top rail");
  assert.ok(header.includes("<MobileSessionHeader />"), "active phone chat uses floating navigation");
  assert.ok(!header.includes("WorkspaceBottomNav"), "the obsolete bottom session bar is gone");
  assert.ok(mobileHeader.includes("mobile-session-floats"), "the floating shell is explicit");
  assert.ok(navigation.includes("const resolved = useResolvedCapabilities()"), "mobile rail consumes the shared capability model");
  assert.ok(navigation.includes("VIEW_OF_CAPABILITY[id]"), "mobile rail maps capability descriptors to views");
  assert.ok(navigation.includes("PANE_OF_CAPABILITY[id]"), "mobile rail keeps pane tools such as Browser reachable");
  assert.ok(navigation.includes("useRailSurfaceModel()"), "slot-backed surfaces such as Notifications join the same rail");
  assert.ok(navigation.includes('className="mobile-shortcut-track"'), "compact navigation is a swipeable icon rail instead of a select menu");
  assert.ok(!header.includes("const VIEW_GROUPS"), "no duplicate hard-coded view list");
  assert.ok(
    actions.includes('"Turn off auto-approve"')
      && actions.includes('"Turn on auto-approve"'),
    "placeable auto-approve control exposes the resulting action in its accessible name",
  );
});

test("modal surfaces share the Dialog focus contract (no copied traps)", async () => {
  const dialog = await read("../src/components/a11y/Dialog.tsx");
  assert.ok(dialog.includes("export function useModalSurface"), "Dialog.tsx exports the reusable hook");
  const sidebar = await read("../src/components/Sidebar.tsx");
  const rail = await read("../src/components/ContextRail.tsx");
  const css = await read("../src/styles.css");
  const palette = await read("../src/components/CommandPalette.tsx");
  for (const [name, src] of [
    ["Sidebar", sidebar],
    ["ContextRail", rail],
  ] as const) {
    assert.ok(src.includes("useModalSurface"), `${name} consumes useModalSurface`);
    assert.ok(!src.includes("FOCUSABLE"), `${name} must not copy a focus-trap implementation`);
  }
  assert.ok(palette.includes("ResponsiveOverlay"), "CommandPalette consumes the adaptive modal primitive");
  assert.ok(!palette.includes("FOCUSABLE"), "CommandPalette must not copy a focus-trap implementation");
  assert.ok(sidebar.includes('id="polyth-session-drawer"'), "drawer id matches the trigger");
  assert.ok(
    rail.includes('id={compact ? "polyth-panel-sheet" : undefined}'),
    "compact sheet id matches the trigger without duplicating it on the desktop rail",
  );
  assert.ok(
    rail.includes('className="menu-backdrop panel-sheet-backdrop"'),
    "the panel backdrop does not inherit the shared mobile-sheet stacking layer",
  );
  assert.ok(
    rail.includes('document.querySelector<HTMLElement>(".header-view-picker .picker-chip")'),
    "a panel opened from the phone picker restores focus to that surviving trigger",
  );
  assert.match(
    css,
    /\.panel-sheet-backdrop\s*\{[^}]*z-index:\s*119[^}]*\}[\s\S]*?\.sheet-backdrop\s*\{[^}]*z-index:\s*var\(--z-overlay\)/s,
    "the panel remains above its own backdrop while shared sheets stay topmost",
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
  const surfaces = await read("../src/components/workspace/builtinSurfaces.tsx");
  for (const cls of ["composer-rail", "composer-config", "composer-extensions", "composer-actions", "composer-primary"]) {
    assert.ok(composer.includes(cls), `composer bar renders .${cls}`);
  }
  assert.equal(composer.match(/const send = useCallback/g)?.length, 1, "exactly one send() path");
  assert.equal(
    surfaces.match(/<Composer \/>/g)?.length,
    2,
    "fresh and existing sessions instantiate the same default composer",
  );
  assert.ok(composer.includes("<SessionContextBar {...contextBar} />"), "the shared composer owns both location selectors");
  assert.ok(!surfaces.includes("SessionContextBar"), "no chat surface assembles a partial composer");
  assert.ok(!composer.includes("composer-hero"), "the composer has no fresh-session visual fork");
  assert.ok(!surfaces.includes('variant="hero"'), "the session surface does not request a fresh-session variant");
  const css = await read("../src/styles.css");
  // P2-W3A rail contract: config chips shrink and truncate; Send never leaves.
  assert.match(css, /\.composer-config \{[^}]*flex: 0 1 auto/s, "config chips yield space first");
  assert.match(css, /\.composer-actions \{[^}]*flex: none/s, "the action group never collapses");
  assert.ok(!css.includes(".composer-hero"), "fresh and existing sessions share one composer selector");
});

test("composer active-run controls and mobile actions stay direct", async () => {
  const composer = await read("../src/components/Composer.tsx");
  const timeline = await read("../src/components/Timeline.tsx");
  const goal = await read("../../../packages/goals/widgets/GoalStrip.tsx");
  const css = await read("../src/styles.css");
  assert.ok(composer.includes("<QueueIcon />"), "queue mode uses the canonical queue icon");
  assert.ok(composer.includes("<MoreIcon />"), "alternate active-run actions use the standard more icon");
  assert.ok(
    composer.includes("if (emptySteerItem) void steerQueuedItem(emptySteerItem)"),
    "submitting the emptied composer promotes the newest queued follow-up",
  );
  assert.ok(
    composer.includes("const current = await api.queueEditStart(target, item.id)"),
    "queue promotion reserves the row before steering to prevent duplicate dispatch",
  );
  assert.ok(composer.includes('tr("composer.sendNow")'), "queue options expose immediate delivery");
  assert.ok(composer.includes('tr("composer.stopWithoutSendingThisDraft")'), "queue options expose stop");
  assert.ok(composer.includes("composer-stop-primary"), "active sends become a primary stop control");
  assert.ok(timeline.includes('className="msg-actions"'), "message actions remain inline");
  assert.match(css, /Phone quick actions are immediately available[\s\S]*?\.focus-conversation \.msg \.msg-actions\s*\{[^}]*display:\s*flex/);
  assert.match(goal, /<Dialog\s+title=\{tr\("goalstrip\.sessionGoal"\)\}/, "goal parameters open in a focused modal");
});

test("Focus uses compact mobile composer controls without editor chrome", async () => {
  const composer = await read("../src/components/Composer.tsx");
  const permissions = await read("../../../packages/permissions/widgets/index.tsx");
  const goals = await read("../../../packages/goals/widgets/index.tsx");
  assert.ok(
    composer.includes('composer-simple${widgetMode ? "" : " composer-focus-light"}'),
    "light controls are shared by fresh and existing chats",
  );
  assert.ok(composer.includes('className="composer-extensions composer-mobile-extensions"'), "Focus exposes slotted mobile actions");
  assert.ok(permissions.includes('"permissions.auto-approve-composer-action"'), "auto-approve is a placeable composer action");
  assert.ok(goals.includes('"session.goal-composer-action"'), "goals are a placeable composer action");
  // P2-W3A: one `+` on every layout — the Add menu owns Upload; there is no
  // second standalone upload chip anywhere.
  assert.ok(composer.includes("<ComposerAddMenu"), "the Add menu is the single plus control");
  assert.ok(
    composer.includes("onUpload={openAttachmentPicker}")
      && composer.includes("pickNativeFiles().then")
      && composer.includes("fileInputRef.current?.click()"),
    "the Add menu drives native or browser file picking through one callback",
  );
  assert.ok(!composer.includes('label={tr("composer.addFiles")}'), "no separate upload chip remains");
  assert.ok(!composer.includes("<Icon.focus />"), "Focus removes the focused-editor header action");
  assert.ok(permissions.includes("icon: ShieldIcon"), "Focus exposes the auto-approve shield");
  assert.ok(goals.includes("icon={TargetIcon}"), "Focus exposes the goals target");
  assert.ok(composer.includes("<Icon.send />"), "Focus uses a paper-plane send icon");
  const css = await read("../src/styles.css");
  assert.ok(css.includes(".composer-agent-chip .chip-k { display: none; }"), "technical picker keys are hidden");
  const dictationCss = await read("../../../packages/dictation/widgets/styles.css");
  assert.ok(dictationCss.includes('body[data-dictate="false"] .mic-control .mic-btn'),
    "the package-owned microphone can be hidden without suppressing other slot items");
});

test("desktop header keeps brand, workspace modes, and a named utility cluster", async () => {
  const header = await read("../src/components/Header.tsx");
  const actions = await read("../src/widgets/builtinMiniWidgets.tsx");
  const sidebar = await read("../src/components/Sidebar.tsx");
  assert.ok(header.includes('<span className="polyth-mark">{tr("header.p")}</span>'), "localized Polyth mark is visible");
  assert.ok(header.includes('<strong>{tr("header.polyth")}</strong>'), "localized wordmark text is visible");
  assert.ok(header.includes('className="workspace-mode-switch"'), "Focus and Canvas remain next to the brand");
  assert.ok(!header.includes("header-breadcrumbs"), "project and branch crumbs are removed");
  assert.ok(sidebar.includes('setOverlay("project-picker")'), "project switching remains available in the project sidebar");
  assert.ok(header.includes('<div className="header-actions customize-zone"'), "utilities share one right-side cluster");
  assert.ok(actions.includes('label={tr("widgets.builtinminiwidgets.searchCommandsAndActions")}'), "search utility remains named");
  assert.ok(actions.includes('label={tr("widgets.builtinminiwidgets.searchSessionHistory2")}'), "history utility remains named");
  assert.ok(actions.includes('label={tr("common.settings")}'), "settings utility remains named");
  assert.ok(!header.includes('className="header-global-search"'), "Search is not duplicated in the header");
});

test("Settings uses the current desktop workbench and workspace customizer", async () => {
  const settings = await read("../src/components/SettingsView.tsx");
  const css = await read("../src/styles.css");
  const widgets = await read("../src/components/settings/WidgetsPage.tsx");
  const widgetLibrary = await read("../src/components/settings/WidgetLibraryOverlay.tsx");
  const tours = await read("../src/packages/onboarding/tours/builtin.ts");
  assert.ok(settings.includes('className="scrim settings-scrim"'), "Settings owns viewport-specific scrim geometry");
  assert.ok(css.includes("width: min(96vw, 1180px); max-width: 1180px; height: 94vh"),
    "Settings uses the desktop workbench footprint");
  assert.doesNotMatch(css, /\.settings-shell\s*\{[^}]*min-width:\s*1100px/, "Settings no longer forces an 1100px minimum width");
  assert.ok(widgets.includes('className="workspace-inspector"'), "widget settings expose the live preview inspector");
  assert.doesNotMatch(
    [settings, widgets, widgetLibrary, tours].join("\n"),
    /changes (?:are )?save(?:d)? automatically|changes are saved as you edit/i,
    "Settings does not show automatic-save assurances",
  );
  assert.ok(!settings.includes('className="modal-foot"'), "Settings does not render the save-and-Done footer");
});

test("pending OpenCode changes render in the OpenCode Runtime detail", async () => {
  const runtime = await read("../../../packages/opencode/widgets/index.tsx");
  const bootstrap = await read("../src/bootstrap.tsx");
  assert.ok(runtime.includes('sectionId: "runtime", label: "Runtime"'), "OpenCode contributes its Runtime section");
  assert.ok(runtime.includes("api.opencodeApplyRestart()"), "the Runtime section applies staged OpenCode changes");
  assert.ok(!bootstrap.includes("installOpenCodeRestartControl"), "OpenCode restart is no longer installed into a global footer");
});

test("open rails remain visible in every workspace mode", async () => {
  const rail = await read("../src/components/ContextRail.tsx");
  const css = await read("../src/styles.css");
  assert.ok(rail.includes('`railbar${open ? " railbar-open" : ""}${pinnedNarrow ? " railbar-pinned-narrow" : ""}${bottomDock ? " railbar-dock-bottom" : ""}`'), "the host marks an active surface");
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
  assert.match(css, /\.railbar:has\(\.rail-fullscreen\)\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*overflow:\s*visible/s,
    "fullscreen package panes escape the floating rail clipping context");
  assert.match(css, /\.railbar:has\(\.rail-fullscreen\)\s*>\s*\.rail-fullscreen\s*\{[^}]*position:\s*relative[^}]*flex:\s*1/s,
    "every fullscreen package pane fills the shared viewport host");
});

test("mobile Settings swaps a vertical page list for content with a back action", async () => {
  const settings = await read("../src/components/SettingsView.tsx");
  const css = await read("../src/styles.css");
  const mobile = css;
  const mobileHeaderStart = settings.indexOf("{mobile ? (");
  const mobileHeader = settings.slice(mobileHeaderStart, settings.indexOf(") : (", mobileHeaderStart));
  assert.ok(settings.includes('type MobileStage = "nav" | "page"'), "Settings models the two mobile stages");
  assert.ok(settings.includes('window.matchMedia("(max-width: 700px)")'), "Settings tracks the mobile breakpoint");
  assert.ok(settings.includes('className="settings-mobile-back"'), "the page header renders a mobile back button");
  assert.ok(settings.includes('className="settings-pane-head-bar"'), "mobile back and close actions share a header bar");
  assert.match(mobileHeader, /current\.label/, "the mobile detail header identifies the selected settings page");
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

test("package tiles and plugin marketplace rows stay responsive", async () => {
  const css = [
    await read("../src/styles.css"),
    await read("../../../packages/plugins/widgets/styles.css"),
  ].join("\n");
  assert.match(
    css,
    /\.settings-pane-body \.package-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)\s*!important[^}]*gap:\s*10px/,
    "package grids use two pane-relative columns by default",
  );
  assert.match(
    css,
    /@media \(max-width: 480px\), \(max-height: 480px\) and \(pointer: coarse\)[\s\S]*?\.settings-pane-body \.package-grid\s*\{[^}]*grid-template-columns:\s*1fr/,
    "package grids collapse to one column on phones",
  );
  assert.match(css, /\.pkg-plugins \.plugin-card-grid\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column/s,
    "plugins use a vertical list instead of a tile grid");
  assert.match(css, /\.pkg-plugins \.plugin-card\s*\{[^}]*border-bottom:\s*1px solid var\(--border-soft\)/s,
    "plugin rows retain visible separation");
  assert.match(css, /\.package-tile\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*align-items:\s*center/);
  assert.match(css, /\.pkg-plugins \.plugin-card-main\s*\{[^}]*display:\s*grid[^}]*align-items:\s*center/s);
  assert.match(css, /\.package-icon\s*\{[^}]*width:\s*58px[^}]*height:\s*58px/);
});

test("shared menu, destructive, failed-turn, and header-action contracts stay wired", async () => {
  const sidebar = await read("../src/components/Sidebar.tsx");
  const header = await read("../src/components/Header.tsx");
  const actions = await read("../src/widgets/builtinMiniWidgets.tsx");
  const sessions = await read("../src/components/sidebar/SessionList.tsx");
  const plugins = await read("../../../packages/plugins/widgets/PluginsPage.tsx");
  const timeline = await read("../src/components/Timeline.tsx");
  const css = await read("../src/styles.css");
  // Project and session menus render through the ui/Menu primitive, which
  // itself owns the shared dismissible-menu semantics — one contract,
  // consumed once.
  assert.ok(sidebar.includes("<Menu"), "project actions consume the shared menu primitive");
  assert.ok(!sidebar.includes("useDismissibleMenu"), "the sidebar no longer hand-rolls menu semantics");
  assert.ok(header.includes("<Menu"), "the user menu consumes the shared menu primitive");
  const menuPrimitive = await read("../src/components/ui/Menu.tsx");
  assert.ok(menuPrimitive.includes("useDismissibleMenu"), "the menu primitive consumes the shared menu contract");
  assert.ok(actions.includes('setOverlay("palette")'), "Search opens the command/action palette");
  assert.ok(actions.includes('setOverlay("search")'), "History opens session history search");
  assert.ok(
    sessions.includes("confirmAlert("),
    "every permanent session deletion is guarded by the themed alert contract",
  );
  assert.ok(plugins.includes('disabled={!sourceValid}'), "plugin install stays disabled until minimally valid");
  assert.match(timeline, /<Notice[\s\S]*?className="turn-error"[\s\S]*?role="alert"/,
    "failed turns use the shared accessible notice primitive");
  assert.match(css, /\.turn-error\s*\{[^}]*width:\s*min\(var\(--chat-measure\), 100%\)[^}]*border-inline-start-width:\s*3px/s);
});

test("fresh and existing chats expose the shared composer and stable focus target", async () => {
  const composer = await read("../src/components/Composer.tsx");
  const input = await read("../src/components/input/AdaptiveTextInput.tsx");
  const store = await read("../src/store.ts");
  assert.ok(
    composer.includes('className={`composer ${widgetMode ? "composer-widget" : "composer-chat"}'),
    "one component owns both chat states",
  );
  assert.ok(composer.includes('data-composer-input=""'), "both chat states mark the shared input");
  assert.ok(input.includes("data-composer-input={dataComposerInput}"), "the marker reaches the textarea");
  assert.ok(store.includes('COMPOSER_INPUT_SELECTOR = "[data-composer-input]"'), "focus uses the stable marker");
  assert.ok(store.includes("export function focusComposer()"), "one focus command is exported");
});

test("timeline empty states defer starters to the hero", async () => {
  const timeline = await read("../src/components/Timeline.tsx");
  assert.ok(!timeline.includes("const STARTERS"), "the timeline no longer duplicates hero starters");
  assert.ok(timeline.includes('tr("timeline.answerPendingQuestion")'), "pending questions get actionable copy");
  assert.ok(timeline.includes('tr("timeline.archivedSessionNoMessages")'), "archived sessions get read-only copy");
});

test("header and customizer render configured capabilities and permanent Terminal launchers", async () => {
  const header = await read("../src/components/Header.tsx");
  const rail = await read("../src/components/ContextRail.tsx");
  const widgets = await read("../src/components/settings/WidgetsPage.tsx");
  const store = await read("../src/store.ts");
  assert.ok(header.includes("function CapabilityNav"), "header owns the primary capability navigation");
  assert.ok(header.includes("useResolvedCapabilities"), "header resolves configured top-rail capabilities");
  assert.ok(header.includes("<CapabilityNav />"), "wide chat renders the primary capability navigation");
  assert.ok(header.includes('capability.tier === "primary"'), "header limits its capability rail to primary tools");
  assert.ok(header.includes("topRail.map"), "header renders the resolved top capability rail");
  assert.ok(
    header.includes('id === "workflow" || id === "terminal"'),
    "Terminal remains a permanent top-rail launcher",
  );
  assert.ok(!header.includes("CapabilityMenu"), "header creates no implicit overflow disclosure");
  assert.ok(!rail.includes("CapabilityMenu"), "rail creates no duplicate More-tools picker");
  assert.ok(rail.includes("configuredRailButtons"), "rail renders only configured tool buttons");
  assert.ok(rail.includes('capability.descriptor.id === "terminal"'), "Terminal remains a guaranteed rail launcher");
  assert.ok(rail.includes("draggable={customizeActive && capabilityIds.has(s.id)}"), "runtime capability buttons reorder only while customization is active");
  assert.ok(widgets.includes('aria-label="Top toolbar"'), "the customizer previews top-rail capabilities");
  assert.ok(widgets.includes('aria-label="Right rail"'), "the customizer previews right-rail capabilities");
  assert.ok(widgets.includes('label="Placement"'), "the inspector exposes explicit placement controls");
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
