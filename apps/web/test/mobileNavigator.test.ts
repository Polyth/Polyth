import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("phone navigator opens silently instead of autofocusing search and raising the keyboard", async () => {
  const source = await read("../src/components/mobile/MobileNavigator.tsx");
  // useModalSurface with no initialFocus claims the first focusable element in
  // DOM order, which is the search <input> — that flips onFocus's searchMode
  // and pops the keyboard the instant the drawer opens. The drawer element
  // itself must be the declared focus target (Sheet/SettingsView contract).
  assert.match(source, /initialFocus:\s*"\[data-drawer-focus\]"/);
  assert.match(source, /<nav[\s\S]*?tabIndex=\{-1\}[\s\S]*?data-drawer-focus=""[\s\S]*?>/);
});

test("the native app's server menu opens from the navigator's title, not a separate tool", async () => {
  const source = await read("../src/components/mobile/MobileNavigator.tsx");
  const connections = await read("../src/nativeConnections.ts");
  const place = source.slice(source.indexOf("function NavigatorPlace()"), source.indexOf("export default function MobileNavigator()"));
  // Native only: a browser has no connection hub to return to.
  assert.match(place, /const servers = canSwitchMobileServer\(\);/);
  assert.match(place, /aria-haspopup="menu"[\s\S]*?switchMobileServer\(event\.currentTarget\)[\s\S]*?tr\("sidebar\.switchServer"\)/,
    "with one Space the title itself opens the native menu and still names the action");
  assert.match(place, /\.\.\.\(servers \? \["separator" as const, \{[\s\S]*?label: tr\("sidebar\.switchServer"\)[\s\S]*?switchMobileServer\(buttonRef\.current\)/,
    "with several Spaces the server menu is the last entry of the Space menu, opened at the title");
  const toolbar = source.slice(source.indexOf('className="mobile-nav-tools"'), source.indexOf('id="mobile-nav-search"'));
  assert.doesNotMatch(toolbar, /ServerIcon|switchServer|sidebar\.addProject/, "the toolbar keeps four tools: search, select, settings, close");
  assert.match(connections, /canSwitchMobileServer = \(\): boolean => isNativeMobile\(\)/);
  // The page hands over only where its button is; the list stays native.
  assert.match(connections, /chooseMobileServer\(rect && rect\.width > 0[\s\S]*?x: rect\.left, y: rect\.top, width: rect\.width, height: rect\.height/);
});

test("a dragged open Navigator is not pinned by its forwards-filling entrance animation", async () => {
  const css = await read("../src/components/mobile/MobileNavigator.css");
  // The entrance fills forwards with `transform: none`; an animation outranks
  // the inline drag transform, so the drawer would ignore the finger.
  assert.match(css, /\.mobile-navigator:not\(\.is-closing\)\s*\{\s*animation:\s*mobile-navigator-in[^;]*\bboth;/);
  const rule = css.match(/:is\(html, html\[dir="rtl"\]\) \.mobile-navigator:is\(\[data-swiping\][^{]*\{([^}]*)\}/);
  assert.ok(rule, "a data-swiping rule that removes the animation exists");
  assert.match(rule[1]!, /animation:\s*none/);
  assert.match(rule[0], /data-swipe-handoff="rest"/);
  // It must come after the swipe-open hand-off rule of equal specificity.
  assert.ok(css.indexOf(rule[0]) > css.indexOf('[data-swipe-handoff="open"]:not'));
});

test("the session swipe action (Pin to top) stays hidden until actually swiped", async () => {
  const css = await read("../src/components/mobile/MobileNavigator.css");
  // The row only marks the underlay aria-hidden at rest; without a matching
  // visual rule the "Pin to top" label paints through the row's
  // transparent background on every session row, all the time.
  assert.match(
    css,
    /\.mobile-nav-session-underlay\[aria-hidden="true"\]\s*\{\s*visibility:\s*hidden;\s*\}/,
  );
});

test("phone navigator uses the canonical viewport, safe-area, and semantic color seams", async () => {
  const css = await read("../src/components/mobile/MobileNavigator.css");

  assert.match(css, /\.mobile-navigator\s*\{[^}]*height:\s*var\(--visual-vh, 100dvh\);/s);
  assert.match(css, /var\(--safe-top\)/);
  assert.match(css, /var\(--safe-bottom\)/);
  assert.doesNotMatch(css, /env\(safe-area-inset-/);
  for (const deprecated of ["--surface", "--text-muted", "--danger", "--warning"]) {
    assert.doesNotMatch(css, new RegExp(`var\\(${deprecated}(?:[,\\)])`), `${deprecated} is deprecated in Navigator CSS`);
  }
});

test("phone project rows omit session totals and group backgrounds", async () => {
  const [source, css] = await Promise.all([
    read("../src/components/mobile/MobileNavigator.tsx"),
    read("../src/components/mobile/MobileNavigator.css"),
  ]);

  assert.doesNotMatch(source, /sidebar\.sessionlist\.valueSessions/,
    "project rows do not show a total session count beneath the project name");
  assert.doesNotMatch(source, /mobile-nav-project-meta-copy/,
    "the removed session-count metadata node is not rendered");
  assert.match(css, /\.mobile-nav-project\s*\{[^}]*background:\s*transparent;/s);
  assert.match(css, /\.mobile-nav-project\.is-current\s*\{[^}]*background:\s*transparent;/s);
});

test("phone project status pills use the shared derived status counts", async () => {
  const source = await read("../src/components/mobile/MobileNavigator.tsx");

  assert.match(source, /projectSessionStatusCounts\(matching, now\)/);
  assert.doesNotMatch(source, /const activeCount = matching\.filter/);
  assert.doesNotMatch(source, /const waitingCount = matching\.filter/);
  assert.doesNotMatch(source, /const completedCount = matching\.filter/);
  assert.doesNotMatch(source, /const failedCount = matching\.filter/);
});

test("phone navigator keeps the tap floor while compacting its rhythm", async () => {
  const [source, statusIcons, css] = await Promise.all([
    read("../src/components/mobile/MobileNavigator.tsx"),
    read("../src/components/mobile/MobileStatusIcon.tsx"),
    read("../src/components/mobile/MobileNavigator.css"),
  ]);

  assert.match(source, /function statusIcon\(kind: MobileStatusKind\)/);
  for (const icon of ["HelpIcon", "ShieldIcon", "SuccessIcon", "ErrorIcon", "WarningIcon", "RefreshIcon"]) {
    assert.match(statusIcons, new RegExp(`icon=\\{${icon}\\}`), `${icon} is used for a mobile state`);
  }
  assert.match(
    statusIcons,
    /case "working":\s*return <Spinner size="sm" className="mobile-nav-state-icon" \/>/,
    "working uses the canonical animated activity indicator",
  );
  assert.doesNotMatch(
    statusIcons,
    /case "working":\s*return <UiIcon icon=\{LoaderIcon\}/,
    "a static loader glyph cannot stand in for activity feedback",
  );
  assert.doesNotMatch(source, />(?:↩|◇|✓|!|⚠|↻)</,
    "mobile navigator state marks should not be platform-font glyphs");
  assert.match(css, /\.mobile-nav-state-icon\s*\{[^}]*color:\s*currentColor;/);
  assert.match(css, /\.mobile-nav-project\s*\{[^}]*margin:\s*0 0 var\(--space-1\);/s);
  // Denser type and gutters must never shrink a touch target below the floor.
  for (const control of [
    "\\.mobile-nav-project-head",
    "\\.mobile-nav-project-main",
  ]) {
    assert.match(css, new RegExp(`${control}[^{]*\\{[^}]*min-height:\\s*var\\(--tap\\);`, "s"), `${control} keeps the tap floor`);
  }
  // Session rows are only denser when the user asks for it: the default value
  // of the row variable is the tap floor, and the smaller values live behind
  // the shared interface-density preference.
  assert.match(css, /\.mobile-navigator\s*\{[^}]*--nav-row-session:\s*var\(--tap\);/s);
  for (const control of ["\\.mobile-nav-session-swipe", "\\.mobile-nav-session-row", "\\.mobile-nav-session-main"]) {
    assert.match(css, new RegExp(`${control}[^{]*\\{[^}]*min-height:\\s*var\\(--nav-row-session\\);`, "s"), `${control} follows the density row height`);
  }
  for (const match of css.match(/--nav-row-session:\s*[^;]+;/g) ?? []) {
    assert.ok(
      /var\(--tap\)/.test(match) || /\[data-density=/.test(css.slice(Math.max(0, css.indexOf(match) - 200), css.indexOf(match))),
      `${match} must be the tap floor or a density opt-in`,
    );
  }
  // New chat and ⋮ split the room between their glyphs (mobileNavigatorLayout
  // pins the widths at or above 24px); the row height stays the tap floor.
  assert.match(css, /\.mobile-nav-project-action\s*\{[^}]*height:\s*var\(--tap\);/s);
  // Type comes from the shared role scale, so the interface-size setting works.
  assert.doesNotMatch(css, /font-size:\s*\d\d(?:\.\d+)?px/,
    "navigator type must use role tokens, not fixed pixel sizes");
});

test("phone navigator renders delegated sessions as an expandable tree", async () => {
  const [source, css] = await Promise.all([
    read("../src/components/mobile/MobileNavigator.tsx"),
    read("../src/components/mobile/MobileNavigator.css"),
  ]);

  assert.match(source, /includeSessionTreeContext/);
  assert.match(source, /buildSessionTree/);
  assert.match(source, /mobile-nav-subagent-toggle/);
  assert.match(source, /treeDepth=\{depth\}/);
  assert.match(css, /--nav-tree-indent:\s*var\(--space-3\)/);
  assert.match(css, /mobile-nav-subagent-children::before/);
});

test("phone session rows render package badges through the shared session-list slot", async () => {
  const source = await read("../src/components/mobile/MobileNavigator.tsx");
  const rowStart = source.indexOf("function SessionRow(");
  const rowEnd = source.indexOf("export default function MobileNavigator", rowStart);
  const row = source.slice(rowStart, rowEnd);

  assert.match(source, /import SlotHost from "\.\.\/slots\/SlotHost\.ts"/);
  const lead = row.indexOf('className="mobile-nav-session-lead"');
  const title = row.indexOf('className="mobile-nav-session-title"');
  const toggle = row.indexOf('className="mobile-nav-subagent-toggle"');
  const trailing = row.indexOf('<span className="mobile-nav-session-trailing">');
  const badge = row.indexOf('slot="session.list.badges"');
  const pin = row.indexOf('className="mobile-nav-pin-icon"');
  assert.ok(lead > 0 && lead < title && title < toggle && toggle < trailing,
    "fixed columns: state mark, then title with its subagent disclosure, then meta");
  assert.ok(trailing < badge && badge < pin,
    "package badges and the pin share the trailing identity group, pin last");
  assert.match(row, /context=\{\{ sessionId: session\.id, questions: session\.attention\?\.questions \?\? 0, permissions: session\.attention\?\.permissions \?\? 0 \}\}/);
});

test("phone navigator shares the mobile Workspace surface", async () => {
  const [css, workspaceCss, sharedCss] = await Promise.all([
    read("../src/components/mobile/MobileNavigator.css"),
    read("../src/workspacePanelPremium.css"),
    read("../src/styles.css"),
  ]);

  assert.match(sharedCss, /body:not\(\[data-glass="off"\]\):not\(\[data-desktop-low-resource="true"\]\) :is\([^)]*\.sheet,\s*\.mobile-navigator,[^)]*\)\s*\{\s*background:\s*radial-gradient/,
    "Workspace and phone navigator share the final preference-aware glass rule");

  assert.match(css, /\.mobile-navigator\s*\{[^}]*background:\s*var\(--material-glass-strong\);/s);
  assert.match(workspaceCss, /\.workspace-panel-sheet\.sheet\s*\{[^}]*background:\s*var\(--material-glass-strong\);/s);
  assert.doesNotMatch(css, /body:not\(\[data-glass="off"\]\):not\(\[data-desktop-low-resource="true"\]\) \.mobile-navigator/);
  assert.doesNotMatch(css, /\.mobile-nav-toolbar\s*\{[^}]*background:\s*var\(--material-glass-chrome\);/s);
});

test("adding a project and starting a chat are visibly different actions", async () => {
  const source = await read("../src/components/mobile/MobileNavigator.tsx");

  assert.match(source, /className="mobile-nav-add-project"[\s\S]{0,320}?icon=\{AddProjectIcon\}[\s\S]{0,160}?\{tr\("sidebar\.addProject"\)\}/,
    "add project is a labelled row closing the list, with the folder-plus glyph");
  assert.match(source, /aria-label=\{tr\("sidebar\.newChatInValue"[\s\S]{0,220}?icon=\{NewChatIcon\}/,
    "new chat uses the chat-plus glyph");
  assert.doesNotMatch(source, /conversation\.newInValue[\s\S]{0,120}?PeopleIcon/,
    "the project row carries no new-conversation control; it is a project-menu verb");
  // The isolation shortcut stays in the project menu; the row carries no
  // second plus-like action next to "new chat".
  assert.match(source, /id:\s*"isolate"[\s\S]*?openWorktreeSessionDialog\(project\.id\)/);
});

test("the pin stays outside the session zone while package identity badges use the shared slot", async () => {
  const [source, css] = await Promise.all([
    read("../src/components/mobile/MobileNavigator.tsx"),
    read("../src/components/mobile/MobileNavigator.css"),
  ]);

  assert.match(source, /className="mobile-nav-session-flags"[\s\S]*?mobile-nav-pin-icon/);
  assert.match(source, /icon=\{PinIcon\}/);
  assert.doesNotMatch(source, /mobile-nav-isolation-icon|icon=\{LockIcon\}/);
  // The open button is an empty full-row surface; marks paint above it.
  assert.match(source, /className="mobile-nav-session-main"[\s\S]*?\n\s*\/>\s*<span className="mobile-nav-session-body">/);
  assert.match(css, /\.mobile-nav-session-main\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;/s);
  assert.match(css, /\.mobile-nav-session-body\s*\{[^}]*grid-template-columns:\s*var\(--nav-lead-col\) minmax\(0, 1fr\) max-content;[^}]*pointer-events:\s*none;/s);
  assert.match(css, /\.mobile-nav-subagent-toggle\s*\{[^}]*pointer-events:\s*auto;/s);
  assert.match(css, /\.mobile-nav-session-flags\s*\{[^}]*display:\s*inline-flex;/s);
  assert.match(css, /\.mobile-nav-pin-icon\s*\{[^}]*width:\s*var\(--icon-sm\);[^}]*height:\s*var\(--icon-sm\);/s);
  // Host marks (pin, sharing) draw at the package badges' glyph size and
  // weight, so the identity group reads at one optical size.
  assert.match(css, /\.mobile-nav-session-flags \.ui-icon\s*\{[^}]*width:\s*calc\(var\(--icon-sm\) - 3px\);[^}]*stroke-width:\s*2;/s);
});

test("session actions stay a nested menu and can copy the session id", async () => {
  const source = await read("../src/components/mobile/MobileNavigator.tsx");

  assert.match(source, /copyText\(session\.id\)/);
  assert.match(source, /id:\s*"copy-id"[\s\S]*?label:\s*tr\("sidebar\.sessionlist\.copySessionId"\)/);
  assert.match(source, /id:\s*"delete"[\s\S]*?onSelect:\s*\(\) => void remove\(\)/);
  assert.doesNotMatch(source, /if \(session\.isolation\) return;/,
    "explicit hard-delete stays available while isolation recovery is pending");
  assert.match(source, /session\.isolation[\s\S]*?theLocalIsolationWorkspaceAndEveryFileInItWillAlsoBePermanentlyDeleted/,
    "mobile confirmation names the isolation workspace that will be removed");
  assert.match(source, /<Menu[\s\S]*?phonePresentation="popover"[\s\S]*?open=\{menuOpen\}/);
});

test("phone chats are pinned-first, date-filtered, and grouped without row ages", async () => {
  const [source, css] = await Promise.all([
    read("../src/components/mobile/MobileNavigator.tsx"),
    read("../src/components/mobile/MobileNavigator.css"),
  ]);

  assert.match(source, /list\.sort\(compareSessionNavigation\)/);
  assert.match(source, /sessionMatchesDateFilter\(session, dateFilter\)/);
  assert.match(source, /<SessionDateFilterControls value=\{dateFilter\} onChange=\{setDateFilter\}/);
  // Group by / Sort by come from the shared entries; the shared arrangement
  // orders the rows and names the headings (none for today, none ungrouped).
  assert.match(source, /\.\.\.arrangementEntries/);
  assert.match(source, /arrangeSessions\(roots\.map\(\(node\) => node\.item\), grouping, sessionSort\)/);
  assert.match(source, /\{label && \(\s*<div className="mobile-nav-date-divider"/);
  assert.match(source, /className="mobile-nav-date-divider is-pinned"/);
  assert.match(source, /className="mobile-nav-pin-icon"/);
  assert.doesNotMatch(source, /function activityLabel/);
  assert.doesNotMatch(source, /mobile-nav-session-time/);
  // The Pinned caption groups pinned chats; the rows carry no tint (it read
  // as a second current row) and no pin glyph inside the group.
  assert.doesNotMatch(css, /\.mobile-nav-session-row\.is-pinned[^{]*\{[^}]*background/);
  assert.match(css, /\.mobile-nav-pinned \.mobile-nav-pin-icon\s*\{[^}]*display:\s*none;/s);
  // The label is centred between two short hairlines that fade in toward it;
  // the pinned caption keeps the same faint voice and only its glyph takes
  // the accent.
  assert.match(css, /\.mobile-nav-date-divider\s*\{[\s\S]*?--date-rule:\s*var\(--border-soft\)[\s\S]*?justify-content:\s*center/);
  assert.match(css, /\.mobile-nav-date-divider::before,\s*\.mobile-nav-date-divider::after\s*\{[\s\S]*?flex:\s*0 1 [^;]+;[\s\S]*?linear-gradient\(to right, transparent, var\(--date-rule\)\)/);
  assert.match(css, /\.mobile-nav-date-divider::after\s*\{[\s\S]*?linear-gradient\(to left, transparent, var\(--date-rule\)\)/);
  assert.doesNotMatch(css, /\.mobile-nav-date-divider\.is-pinned\s*\{[^}]*(?:--date-rule|color):/);
  assert.match(css, /\.mobile-nav-date-divider\.is-pinned svg\s*\{[^}]*color:\s*var\(--accent\);/s);
});

test("phone navigator shares project sorting and moves projects from the project row", async () => {
  const [source, css] = await Promise.all([
    read("../src/components/mobile/MobileNavigator.tsx"),
    read("../src/components/mobile/MobileNavigator.css"),
  ]);

  assert.match(source, /useProjectSortMode\(\)/);
  assert.match(source, /useProjectOrder\(\)/);
  assert.match(source, /if \(sort === "manual"\) return applyManualProjectOrder\(projects, projectOrder\)/);
  assert.match(source, /id: "manual"[\s\S]*?label: tr\("sidebar\.manualOrder"\)/);
  // The row is moved by the shared arrange engine (projectArrange.test.ts
  // drives it); no second, hand-rolled gesture and no browser drag and drop.
  assert.match(source, /useArrange\(\{/);
  assert.doesNotMatch(source, /draggable|onDragStart|elementFromPoint/);
  assert.doesNotMatch(source, /mobile-nav-project-drag-handle/);
  assert.doesNotMatch(source, /mobile-nav-disclosure/);
  assert.match(source, /className="mobile-nav-project-head"/);
  assert.match(source, /data-project-id=\{project\.id\}/);
  assert.match(source, /aria-expanded=\{expanded\}/);
  // A still press lifts the row, so the press never selects text or opens the
  // system callout; the held project's chats fold while it is up.
  assert.match(css, /\.mobile-nav-project\.is-reorderable > \.mobile-nav-project-head\s*\{[^}]*user-select:\s*none;[^}]*-webkit-touch-callout:\s*none;/s);
  assert.match(css, /\.mobile-nav-project\.is-arrange-held > \.mobile-nav-project-body\s*\{\s*display:\s*none;/);
  assert.match(css, /\.mobile-nav-project\s*\{[^}]*background:\s*transparent;/s);
  assert.doesNotMatch(css, /\.mobile-nav-project\.is-drag(?:ging|-over)/);
  assert.doesNotMatch(css, /\.mobile-nav-disclosure/);
  assert.doesNotMatch(css, /\.mobile-nav-project-drag-handle/);
});

test("tapping a session row in mobile navigator closes the drawer immediately and opens the session", async () => {
  const source = await read("../src/components/mobile/MobileNavigator.tsx");

  assert.match(source, /const openCurrent = \(\) => \{\s*setSidebarOpen\(false\);\s*void openSession\(session\.id\)/);
  // Reopening the drawer during a slow open shows which row is loading.
  assert.match(source, /aria-busy=\{opening \|\| undefined\}/);
  // Micro-jitter during pointerdown/pointermove must not swallow the click
  assert.doesNotMatch(source, /if \(Math\.abs\(swipeX\) > 0\)/,
    "transient swipeX state must not suppress click events; use gesture refs");
  assert.match(source, /swipedDuringTouch\.current/);
  assert.match(source, /swipeSettledRef\.current/);
});

test("phone navigator remembers which projects show all their sessions", async () => {
  const [source, state] = await Promise.all([
    read("../src/components/mobile/MobileNavigator.tsx"),
    read("../src/navigatorState.ts"),
  ]);

  assert.match(state, /SHOW_ALL_PROJECTS_KEY = "polyth\.sidebar\.showAllProjects"/);
  assert.match(source, /useState<ReadonlySet<string>>\(loadShowAll\)/);
  assert.match(source, /writeNavigatorState\(SHOW_ALL_PROJECTS_KEY, JSON\.stringify\(\[\.\.\.showAllProjects\]\)\)/);
});

test("phone navigator state goes through navigatorState, not bare localStorage", async () => {
  const source = await read("../src/components/mobile/MobileNavigator.tsx");

  // The mobile app serves its shell from a new loopback port on every launch,
  // so a bare localStorage read or write is forgotten at the next start.
  assert.match(source, /writeNavigatorState\(EXPANDED_PROJECTS_KEY, JSON\.stringify\(\[\.\.\.expandedProjects\]\)\)/);
  assert.doesNotMatch(source, /localStorage\.(?:get|set)Item\((?:EXPANDED|SHOW_ALL)_PROJECTS_KEY/);
});
