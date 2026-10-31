// Permanent regression tests: boundary classification and
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
  // The level labels live beside the shared level options (levels.tsx).
  const actions = await read("../../../packages/permissions/widgets/index.tsx")
    + await read("../../../packages/permissions/widgets/levels.tsx");
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
  assert.ok(navigation.includes('className="mobile-shortcut-track"'), "compact navigation is an icon rail instead of a select menu");
  assert.ok(navigation.includes("compactShortcutFit("), "compact shortcuts are counted from the header budget, never clipped");
  assert.ok(navigation.includes("mobile-shortcut-more"), "every tool that does not fit stays reachable from More");
  assert.ok(!header.includes("const VIEW_GROUPS"), "no duplicate hard-coded view list");
  assert.ok(
    actions.includes('tr("permissionbanner.approvalLevel")')
      && actions.includes('"permissionbanner.levelAsk"')
      && actions.includes('"permissionbanner.levelRoutine"')
      && actions.includes('"permissionbanner.fullAccess"'),
    "placeable auto-approve control names the current level in its localized accessible name",
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
  // startFreshSession enters the unsaved composer (restoring a shelved draft).
  assert.ok(sidebar.includes("startFreshSession(p.id)"), "project plus enters the unsaved composer surface");
  assert.ok(
    list.includes('startFreshSession(projectId, key === "__main__" ? {} : { worktreePath: key })'),
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
  assert.ok(composer.includes("<SessionContextBar {...contextBar} showIsolation={heroChrome.isolation} />"), "the shared composer owns both location selectors");
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
  const css = await read("../src/styles.css");
  assert.ok(composer.includes('<SendIcon aria-hidden="true" />'), "running delivery keeps the canonical send icon");
  assert.ok(composer.includes("<ChevronDownIcon />"), "alternate active-run actions use a chevron");
  assert.ok(!composer.includes("<MoreIcon />"), "the split no longer uses a detached ellipsis button");
  assert.ok(
    composer.includes("if (emptySteerItem) void steerQueuedItem(emptySteerItem)"),
    "submitting the emptied composer promotes the newest queued follow-up",
  );
  assert.ok(
    composer.includes("const current = await api.queueEditStart(target, item.id)"),
    "queue promotion reserves the row before steering to prevent duplicate dispatch",
  );
  assert.ok(composer.includes('tr("composer.sendNow")'), "active options expose immediate delivery");
  // The primary segment follows the configured follow-up mode (its glyph
  // shows queue vs send); immediate delivery is the explicit menu entry.
  assert.ok(composer.includes("onClick={onPrimaryClick}"), "the primary segment uses the configured delivery");
  assert.match(composer, /id: "send-now",[\s\S]*?onSelect: \(\) => send\(undefined, "interrupt"\)/, "Send now interrupts explicitly");
  assert.ok(composer.includes('id: "stop"'), "active options expose stop");
  assert.ok(composer.includes("composer-stop-primary"), "active sends become a primary stop control");
  assert.ok(timeline.includes("<MessageQuickActions") || timeline.includes('className="msg-actions"'), "message actions remain inline");
  assert.match(css, /Phone quick actions are immediately available[\s\S]*?\.focus-conversation \.msg \.msg-actions\s*\{[^}]*display:\s*flex/);
});

test("Focus uses compact mobile composer controls without editor chrome", async () => {
  const composer = await read("../src/components/Composer.tsx");
  const permissions = await read("../../../packages/permissions/widgets/index.tsx")
    + await read("../../../packages/permissions/widgets/levels.tsx");
  assert.ok(
    composer.includes('composer-simple${widgetMode ? "" : " composer-focus-light"}'),
    "light controls are shared by fresh and existing chats",
  );
  assert.ok(composer.includes('className="composer-extensions composer-mobile-extensions"'), "Focus exposes slotted mobile actions");
  assert.ok(permissions.includes('"permissions.auto-approve-composer-action"'), "auto-approve is a placeable composer action");
  // P2-W3A: one `+` on every layout — the Add menu owns Upload; there is no
  // second standalone upload chip anywhere.
  assert.ok(composer.includes("<ComposerAddMenu"), "the Add menu is the single plus control");
  assert.ok(
    composer.includes(`onUpload={() => openAttachmentPicker("files")}`)
      && composer.includes(`onChoosePhotos={() => openAttachmentPicker("photos")}`)
      && composer.includes(`onTakePhoto={() => openAttachmentPicker("camera")}`)
      && composer.includes("pickNativeFiles(source).then")
      && composer.includes("photoInputRef : fileInputRef).current?.click()"),
    "the Add menu drives native or browser file picking through one callback",
  );
  assert.ok(!composer.includes('label={tr("composer.addFiles")}'), "no separate upload chip remains");
  assert.ok(!composer.includes("<Icon.focus />"), "Focus removes the focused-editor header action");
  assert.match(permissions, /icon: [^,\n]*\bShieldIcon\b/, "Focus exposes the auto-approve shield");
  assert.ok(composer.includes("<Icon.send />"), "Focus uses a paper-plane send icon");
});

test("desktop header keeps brand, workspace modes, and a named utility cluster", async () => {
  const header = await read("../src/components/Header.tsx");
  const actions = await read("../src/widgets/builtinMiniWidgets.tsx");
  const sidebar = await read("../src/components/Sidebar.tsx");
  assert.ok(header.includes('className="polyth-mark" src={POLYTH_MARK_SRC}'), "the Polyth ribbon mark is visible");
  assert.doesNotMatch(header, /\{!compact \|\| !chatSurface\) && <button className="header-brand"/, "compact chat does not hide the brand");
  assert.ok(header.includes('<strong>{tr("header.polyth")}</strong>'), "localized wordmark text is visible");
  assert.ok(header.includes("<HeaderViewTabs editing="), "Focus and Canvas remain next to the brand");
  assert.ok((await read("../src/components/HeaderViewTabs.tsx")).includes('className="workspace-mode-switch"'));
  assert.ok(!header.includes("header-breadcrumbs"), "project and branch crumbs are removed");
  assert.ok(sidebar.includes('setOverlay("project-picker")'), "project switching remains available in the project sidebar");
  assert.ok(header.includes('<div className="header-actions customize-zone"'), "utilities share one right-side cluster");
  assert.ok(actions.includes('label={tr("widgets.builtinminiwidgets.searchCommandsAndActions")}'), "search utility remains named");
  assert.ok(actions.includes('label={tr("widgets.builtinminiwidgets.searchSessionHistory2")}'), "history utility remains named");
  assert.ok(actions.includes('label={tr("common.settings")}'), "settings utility remains named");
  assert.ok(!header.includes('className="header-global-search"'), "Search is not duplicated in the header");
});

test("Settings uses the current desktop workbench without a widget customizer", async () => {
  const settings = await read("../src/components/SettingsView.tsx");
  const css = await read("../src/styles.css");
  const tours = await read("../src/packages/onboarding/tours/builtin.ts");
  assert.ok(settings.includes('className="scrim settings-scrim"'), "Settings owns viewport-specific scrim geometry");
  assert.ok(css.includes("width: min(96vw, 1180px); max-width: 1180px; height: 94vh"),
    "Settings uses the desktop workbench footprint");
  assert.doesNotMatch(css, /\.settings-shell\s*\{[^}]*min-width:\s*1100px/, "Settings no longer forces an 1100px minimum width");
  assert.doesNotMatch(settings, /WidgetsPage|settingsview\.widgetsLayout|id: "widgets"/);
  assert.doesNotMatch(
    [settings, tours].join("\n"),
    /changes (?:are )?save(?:d)? automatically|changes are saved as you edit/i,
    "Settings does not show automatic-save assurances",
  );
  assert.ok(!settings.includes('className="modal-foot"'), "Settings does not render the save-and-Done footer");
});

test("pending OpenCode changes render in the OpenCode Runtime detail", async () => {
  const runtime = await read("../../../packages/opencode/widgets/index.tsx");
  const bootstrap = await read("../src/bootstrap.tsx");
  assert.ok(runtime.includes('sectionId: "runtime", label: tr("opencode.slots.runtime")'), "OpenCode contributes its Runtime section");
  assert.ok(runtime.includes("api.opencodeApplyRestart()"), "the Runtime section applies staged OpenCode changes");
  assert.ok(!bootstrap.includes("installOpenCodeRestartControl"), "OpenCode restart is no longer installed into a global footer");
});

test("rails remain visible in every workspace mode", async () => {
  const rail = await read("../src/components/ContextRail.tsx");
  const header = await read("../src/components/Header.tsx");
  const css = await read("../src/styles.css");
  assert.ok(rail.includes('`railbar${open ? " railbar-open" : ""}${panePinnedNarrow ? " railbar-pinned-narrow" : ""}${paneBottomDock ? " railbar-dock-bottom" : ""}${railDynamic ? " railbar-dynamic" : ""}`'), "the host marks an active surface and preserves its exit geometry");
  // The rail is a shell launcher: Chat, Canvas, and Canvas edit mode all keep
  // the same host, open or idle.
  for (const mode of ["chat", "widgets", "edit"]) {
    assert.ok(
      !css.includes(`.app.view-session.mode-${mode} .railbar`),
      `${mode} does not own a mode-specific rail host rule`,
    );
    assert.ok(
      !css.includes(`.app.mode-${mode} .railbar`),
      `${mode} does not hide the shell rail host`,
    );
  }
  assert.ok(!/mode-\w+ \.railbar\s*[,{][^}]*display:\s*none/.test(css), "no workspace mode hides a rail");
  // The top rail (built-in launchers plus the "app.header.center" widget area)
  // is workspace chrome, not a chat decoration.
  assert.ok(
    !header.includes('workspaceMode === "chat" && !compact && <><span className="header-divider"'),
    "the top rail is no longer gated on chat mode",
  );
  // The window layout may dock it in a column instead (shellLayout.ts);
  // the bar renders it wherever the layout keeps it in the bar.
  assert.match(
    header,
    /\{!compact && shell\.tools === "bar" && <CapabilityNav \/>\}/,
    "every wide workspace mode renders the top rail",
  );
  // An icon rail with no icons renders nothing: no pill, divider or overflow —
  // except while a drag from the other rail offers it an icon to land.
  assert.match(header, /if \(topRail\.length === 0 && !centerWidgets && widgetItems\.length === 0 && !editing && !drag\.receiving\) return null;/,
    "an empty top rail renders nothing outside edit mode or an incoming drag");
  assert.match(rail, /: !compact && \(railButtons\.length > 0 \|\| railWidgets \|\| workspaceEditing \|\| drag\.receiving \|\| dockHosts\.any\);/,
    "an empty right rail strip renders nothing outside edit mode, an incoming drag or docked top-bar groups");
  assert.match(css, /\.app:has\(> \.app-shell > \.railbar\[data-rail-strip="none"\]\) \{ --rail-strip-width-right: 0px; \}/,
    "an absent strip reserves no lane");
  assert.match(css, /\.railbar:empty \{ display: none; \}/, "an empty railbar shows no chrome");
  assert.match(css, /\.railbar:has\(\.rail-fullscreen\)\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*inset-inline-start:\s*var\(--package-window-inline-start[^}]*overflow:\s*visible/s,
    "fullscreen package panes escape the floating rail clipping context and start after the persistent navigator");
  assert.match(rail, /style\.setProperty\("--package-window-inline-start"/,
    "ContextRail publishes the measured workspace edge for fullscreen panes");
  assert.match(rail, /shellRect\.right - workspaceRect\.right/,
    "the measured edge is direction-aware for RTL layouts");
  assert.match(css, /\.railbar:has\(\.rail-fullscreen\)\s*>\s*\.rail-fullscreen\s*\{[^}]*position:\s*relative[^}]*flex:\s*1/s,
    "every fullscreen package pane fills the shared workspace host");
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
  // The list stays laid out under a page (unpainted), so Back reveals it
  // already rendered and a swipe can show it peeking in.
  assert.match(mobile, /\.settings-mobile-page \.settings-nav\s*\{[^}]*visibility:\s*hidden/);
  assert.match(mobile, /\.settings-shell > :is\(\.settings-nav, \.settings-pane\)\s*\{[^}]*grid-area:\s*1 \/ 1/);
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

test("shared menu, destructive, transient-error, and header-action contracts stay wired", async () => {
  const sidebar = await read("../src/components/Sidebar.tsx");
  const header = await read("../src/components/Header.tsx");
  const actions = await read("../src/widgets/builtinMiniWidgets.tsx");
  const sessions = await read("../src/components/sidebar/SessionList.tsx");
  const plugins = await read("../../../packages/plugins/widgets/PluginsPage.tsx");
  // The install control lives in its own component; the invariant belongs to
  // wherever that control is rendered, so read both owners of the page.
  const pluginsInstall = await read("../../../packages/plugins/widgets/PluginInstallDialog.tsx");
  const timeline = await read("../src/components/Timeline.tsx");
  const app = await read("../src/components/ConnectionFeedback.tsx");
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
  assert.match(pluginsInstall, /const ready = mode === "file" \? file !== null : sourceValid;/, "Install needs a chosen archive or a supported link");
  assert.ok(pluginsInstall.includes("disabled={!ready}"), "plugin install stays disabled until minimally valid");
  assert.ok(plugins.includes("<PluginInstallDialog"), "the settings page renders the shared install surface");
  assert.match(timeline, /tr\("timeline\.lastTurnFailed"\)[\s\S]*?setUiError\(\s*message,/,
    "ordinary failed turns route through the host-owned transient error surface");
  assert.doesNotMatch(timeline, /className="turn-error"/,
    "ordinary turn failures do not render inside the conversation");
  const stack = await read("../src/notify/NotificationStack.tsx");
  const store = await read("../src/store.ts");
  assert.match(store, /export function setUiError\([\s\S]*?kind: UiErrorKind = "error",/,
    "the transient error is an error notification unless a caller names a calmer kind");
  assert.match(app, /notify\(\{\s*id: UI_ERROR_NOTIFICATION_ID,\s*kind,/, "the store's kind reaches the notification");
  assert.match(stack, /aria-live="assertive"/, "an assertive region stays mounted for errors");
  assert.match(stack, /record\.kind === "error" \? urgent : calm/,
    "an error notification is announced assertively");
  assert.doesNotMatch(css, /\.error-banner/, "no second bespoke error surface");
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

test("header renders configured capabilities; Terminal starts on the top rail but is not pinned", async () => {
  const header = await read("../src/components/Header.tsx");
  const rail = await read("../src/components/ContextRail.tsx");
  const store = await read("../src/store.ts");
  const placement = await read("../src/railPlacement.ts");
  assert.ok(header.includes("function CapabilityNav"), "header owns the primary capability navigation");
  assert.ok(header.includes("useResolvedCapabilities"), "header resolves configured top-rail capabilities");
  assert.ok(header.includes("<CapabilityNav />"), "wide chat renders the primary capability navigation");
  assert.ok(header.includes("topRailCapabilities("), "header reads the shared one-home rail rules");
  assert.ok(placement.includes('capability.tier === "primary"'), "the top rail is limited to primary tools");
  assert.ok(header.includes("topRail.map"), "header renders the resolved top capability rail");
  assert.ok(
    placement.includes('(id === "workflow" || id === "terminal") && placements[id] === undefined'),
    "Terminal keeps its discoverable top-rail default",
  );
  assert.ok(!header.includes("CapabilityMenu"), "header creates no implicit overflow disclosure");
  assert.ok(!rail.includes("CapabilityMenu"), "rail creates no duplicate More-tools picker");
  assert.ok(rail.includes("configuredRailButtons"), "rail renders only configured tool buttons");
  assert.ok(!placement.includes("GUARANTEED_CAPABILITY"), "no launcher falls back into a rail the person removed it from");
  assert.ok(rail.includes("isDraggable: (id) => railButtonById.has(id)"), "every right-rail button reorders, panels included");
  assert.ok(rail.includes("canLeave: (id) => capabilityIds.has(id) || instanceOfRailItem(id) !== null"),
    "launchers and widgets move between rails; panel buttons stay in the right rail");
  assert.ok(header.includes('useRailDragZone({\n    id: "top"'), "top rail is a drag zone shared with the right rail");
  assert.ok(!store.includes("moreOpen:"), "dead global More-tools state stays removed");
  assert.ok(!store.includes("setMoreOpen"), "dead global More-tools action stays removed");
});

test("status bar segments carry stable keys and narrow bars drop whole segments by priority", async () => {
  const widgets = await read("../src/widgets/statusbarWidgets.tsx");
  for (const cls of ["sb-project", "sb-branch", "sb-changes", "sb-model", "sb-agent", "sb-view"]) {
    assert.ok(widgets.includes(cls), `status bar renders .${cls}`);
  }
  const fit = await read("../src/statusbar/fitSegments.ts");
  assert.ok(fit.includes("hideOrder") && fit.includes("data-fit-keep"));
  const css = await read("../src/components/StatusBar.css");
  assert.match(css, /\.statusbar-cluster > \[data-fit="hidden"\]\s*\{\s*display:\s*none/);
});

test("the status bar keeps the same column gap to the strip as to the navigator", async () => {
  const css = await read("../src/components/StatusBar.css");
  const wide = css.slice(css.indexOf("@container app-shell (min-width: 1401px)"));
  // The wide shell's idle strip is a full-height column: the bar ends one
  // column gap (plus a floating column's inset) before it, not underneath.
  assert.match(wide, /\.statusbar \{\s*margin-inline-end: calc\(var\(--rail-strip-width-right[^;]*\) \+ var\(--shell-edge, 0px\) \+ var\(--space-2\)\);/);
  // Mirrored, the strip sits at the workspace's inline start.
  assert.match(wide, /\.app\[data-shell-mirror="true"\][^{]*\.statusbar \{\s*margin-inline: calc\(/);
  // No lane is reserved for an open pane or a hidden strip.
  assert.ok(wide.includes(':not(:has(.railbar-open)):not(:has(> .railbar[data-rail-strip="none"]))'));
  // A sheet that already clears the strip spans its sheet.
  const looks = await read("../src/shellLooks.css");
  for (const look of ["monolith", "monolith-reverse"]) {
    assert.match(looks, new RegExp(`body\\[data-shell-look="${look}"\\]:not\\(#\\\\#\\) \\.statusbar \\{\\s*margin-inline: 0 !important;`), look);
  }
});

// ---- automatic project rail (focused profile `sidebarRailBelow`) -------------

test("automatic sidebar rail: driven only by the profile hint, wide shells, below the bound", async () => {
  const { automaticSidebarRail } = await import("../src/sidebarLayout.ts");
  assert.equal(automaticSidebarRail({ wide: true, sidebarRailBelow: 1600, viewportBelow: true }), true);
  assert.equal(automaticSidebarRail({ wide: true, sidebarRailBelow: 1600, viewportBelow: false }), false);
  assert.equal(automaticSidebarRail({ wide: false, sidebarRailBelow: 1600, viewportBelow: true }), false, "compact keeps its drawer");
  assert.equal(automaticSidebarRail({ wide: true, sidebarRailBelow: null, viewportBelow: true }), false, "no hint, no collapse");
});

test("automatic sidebar rail is never persisted and never changes the person's sidebar preference", async () => {
  const writes: string[] = [];
  const values = new Map<string, string>([["polyth.sidebar.layout", JSON.stringify({ width: 360, collapsed: false })]]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string) { return values.get(key) ?? null; },
      setItem(key: string, value: string) { writes.push(key); values.set(key, value); },
      removeItem(key: string) { writes.push(key); values.delete(key); },
    },
  });
  const layoutModule = await import(`../src/sidebarLayout.ts?automatic-rail=${Date.now()}`) as typeof import("../src/sidebarLayout.ts");
  const before = layoutModule.getSidebarLayout();
  assert.deepEqual(before, { width: 360, collapsed: false, restoreViewMode: null });

  layoutModule.setAutomaticSidebarRail(true);
  assert.equal(layoutModule.isAutomaticSidebarRailApplied(), true);
  // Expanding by hand while automatic releases it in memory only.
  layoutModule.releaseAutomaticSidebarRail();
  assert.equal(layoutModule.isAutomaticSidebarRailApplied(), false);
  layoutModule.setAutomaticSidebarRail(true);
  assert.equal(layoutModule.isAutomaticSidebarRailApplied(), false, "a release holds while the condition holds");
  layoutModule.setAutomaticSidebarRail(false);
  layoutModule.setAutomaticSidebarRail(true);
  assert.equal(layoutModule.isAutomaticSidebarRailApplied(), true, "the next activation collapses again");

  assert.deepEqual(writes, [], "no storage write");
  assert.equal(layoutModule.getSidebarLayout(), before, "the preference object is untouched");
  assert.equal(values.get("polyth.sidebar.layout"), JSON.stringify({ width: 360, collapsed: false }));
});

test("automatic sidebar rail: shell sources only publish/release it, never write the layout for it", async () => {
  const [app, sidebar, header] = await Promise.all([
    read("../src/App.tsx"), read("../src/components/Sidebar.tsx"), read("../src/components/Header.tsx"),
  ]);
  assert.doesNotMatch(app, /setSidebarLayout/);
  assert.match(app, /setAutomaticSidebarRail\(automaticRail\)/);
  assert.match(app, /sidebarRailBelow: shellPresentation\.sidebarRailBelow/);
  // Every "expand" path releases the automatic rail instead of writing.
  assert.match(sidebar, /if \(layout\.collapsed\) setSidebarLayout\(\{ collapsed: false \}\);\s*else releaseAutomaticSidebarRail\(\);/);
  assert.match(sidebar, /if \(collapsed && !layout\.collapsed\) \{\s*releaseAutomaticSidebarRail\(\);/);
  assert.match(sidebar, /collapsed = !compact && !projectsOnly && \(layout\.collapsed \|\| automaticRail\)/);
  assert.match(header, /sidebarLayout\.collapsed \|\| sidebarAutoRail \? 46/);
});
