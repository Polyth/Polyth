import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sessionOverviewMode } from "../src/sessionOverviewMode.ts";

const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");

test("mobile session overview only renders sections that have content", () => {
  const source = read("../src/components/mobile/MobileSessionHeader.tsx");
  assert.match(source, /showActiveSection/);
  assert.match(source, /showRecentSection/);
  assert.match(source, /mobile\.island\.active/);
  assert.match(source, /mobile\.island\.noRecent/);
  assert.match(source, /fullScreen/);
  assert.match(source, /origin="top"/);
});

test("phone activity details reuse the session model and dock anchor", () => {
  const source = read("../src/components/mobile/MobileSessionHeader.tsx");
  assert.match(source, /fullScreen \? tr\("header\.polyth"\) : tr\("mobile\.island\.overview"\)/);
  assert.match(source, /headerLeading=\{fullScreen \? <img src=\{POLYTH_MARK_SRC\}/);
  assert.match(source, /activeSessionsForIsland\(projectSessions, session\?\.id\)/);
  assert.match(source, /\{fullScreen \? \(/);
  assert.match(source, /<SessionActivityDetails/);
  // The rendered variant follows the live mode and keeps the last one through
  // the exit, so a closing full-screen overview does not flip to the compact sheet.
  assert.match(source, /fullScreen=\{renderedOverviewMode === "full"\}/);
  assert.match(source, /const renderedOverviewMode = overviewMode === "closed" \? lastOverviewModeRef\.current : overviewMode/);
  assert.match(source, /sessionOverviewMode\(surface === "island", statusPopover\)/);
  assert.doesNotMatch(source, /classList\.contains\("agent-status-dock"\)/);
  assert.match(source, /model=\{model\}/);
  assert.doesNotMatch(source, /mobile-island-project-tile|ProjectStatusPills/);
  assert.match(source, /statusLabel\(itemStatus\)/);
  assert.match(source, /contextMeta\(gauge, contextPercent\)/);
  assert.match(source, /eventsHaveCodeChanges\(events\[item\.id\]\)/);
});

test("recent sessions render grouped, bounded, and accessible load-more semantics", () => {
  const source = read("../src/components/mobile/MobileSessionHeader.tsx");
  const css = read("../src/components/mobile/MobileSessionHeader.css");
  assert.match(source, /groupRecentSessionsByDay\(recent, locale\)/);
  assert.match(source, /mobile-island-recent-scroll\$\{fullScreen \? " is-full-screen" : ""\}/);
  assert.match(source, /role="region"[\s\S]*tabIndex=\{fullScreen \? undefined : 0\}/);
  assert.match(source, /className="mobile-island-load-more"/);
  assert.match(source, /aria-busy=\{isLoadingMore\}/);
  // Each tap reveals one more bounded step; the server pages in only once the
  // rows already loaded are exhausted.
  assert.match(source, /setRecentVisibleLimit\(\(current\) => current \+ ISLAND_RECENT_LIMIT\)/);
  assert.match(source, /if \(recent\.length >= recentTotal\) void pages\.more\(\)/);
  assert.match(css, /mobile-island-recent-scroll[\s\S]*max-height:[^;]+[\s\S]*overflow-y: auto/);
  assert.match(css, /mobile-island-load-more[\s\S]*min-height: var\(--tap\)/);
});

test("recent day headings re-render when the app locale changes", () => {
  const source = read("../src/components/mobile/MobileSessionHeader.tsx");
  assert.match(source, /getLocaleSnapshot, subscribeLocale/);
  assert.match(source, /useSyncExternalStore\(subscribeLocale, getLocaleSnapshot, getLocaleSnapshot\)/);
  assert.match(source, /groupRecentSessionsByDay\(recent, locale\), \[recent, locale\]\)/);
});

test("recent session rows keep worktree and isolation semantics in metadata", () => {
  const source = read("../src/components/mobile/MobileSessionHeader.tsx");
  assert.match(source, /function locationMeta\(session: SessionProjection\)/);
  assert.match(source, /hasWorktreeSession\(session\)/);
  assert.match(source, /isIsolatedSession\(session\)/);
  assert.match(source, /mobile\.island\.worktree/);
  assert.match(source, /mobile\.island\.isolated/);
  assert.doesNotMatch(source, /BranchIcon|LockIcon|mobile-island-location-icon/);
  assert.match(source, /meta=\{\[location, changed\]/);
});

test("quick menu uses a product header and section counts instead of project tiles", () => {
  const source = read("../src/components/mobile/MobileSessionHeader.tsx");
  assert.match(source, /POLYTH_MARK_SRC/);
  assert.match(source, /activeTotal=\{active\.length\}/);
  assert.match(source, /fullScreen/);
  assert.doesNotMatch(source, /ProjectStatusPills|ProjectGlyph|projectStatusCounts\(/);
});

test("phone overview uses full-screen safe-area geometry and dense adaptive rows", () => {
  const css = read("../src/components/mobile/MobileSessionHeader.css");
  assert.doesNotMatch(css, /86dvh/);
  assert.match(css, /\.mobile-island-sheet--full-screen\.sheet[\s\S]*?height:\s*var\(--visual-vh, 100dvh\)/);
  assert.match(css, /\.mobile-island-sheet--full-screen \.sheet-body[\s\S]*?padding: 0 var\(--screen-gutter\) calc\(var\(--safe-bottom\) \+ var\(--space-4\)\)/);
  assert.match(css, /\.mobile-island-sheet--full-screen \.sheet-head[\s\S]*?min-height:\s*calc\(var\(--safe-top\) \+ var\(--tap\) \+ var\(--space-3\)\)/);
  assert.match(css, /\.mobile-island-sheet--full-screen \.sheet-grabber[\s\S]*?display:\s*none/);
  assert.match(css, /\.mobile-island-sheet--full-screen \.mobile-island-session-entry \.sheet-row[\s\S]*?min-height:\s*52px/);
  assert.match(css, /\.mobile-island-sheet--full-screen \.mobile-island-session-entry\.has-meta \.sheet-row[\s\S]*?min-height:\s*64px/);
  assert.match(css, /\.mobile-island-sheet--full-screen \.sheet-row-copy strong[\s\S]*?-webkit-line-clamp:\s*2/);
  assert.match(css, /\.mobile-island-sheet \.mobile-island-live\.unread[\s\S]*?color:\s*var\(--green\)/);
  assert.match(css, /\.mobile-island-sheet--full-screen \.mobile-island-session-entry \.sheet-row[\s\S]*?gap:\s*var\(--space-3\)/);
  assert.doesNotMatch(css, /mobile-island-prompt-toggle/);
});

test("mobile session overview keeps its clear glass out of the modal scrim", () => {
  const css = read("../src/components/mobile/MobileSessionHeader.css");
  assert.match(
    css,
    /\.sheet-backdrop-top:has\(> \.mobile-island-sheet\)\s*\{[^}]*background:\s*transparent;/s,
  );
});

test("mobile session overview polls unresolved titles only while it is open", () => {
  const source = read("../src/components/mobile/MobileSessionHeader.tsx");
  assert.match(source, /pollSessionTail/);
  assert.match(source, /!overviewOpen \|\| !projectId/);
  assert.match(source, /window\.setTimeout\(/);
  assert.match(source, /window\.clearTimeout\(/);
});


test("compact tablets reuse the phone session quick-access sheet", () => {
  const mobile = read("../src/components/mobile/MobileSessionHeader.tsx");
  const desktop = read("../src/components/DesktopSessionStatus.tsx");

  assert.match(mobile, /export function SessionQuickAccessSheet/);
  assert.match(mobile, /<SessionQuickAccessSheet/);
  assert.match(desktop, /useShellMode\(\)/);
  assert.match(desktop, /shellMode === "compact"/);
  assert.match(desktop, /<SessionQuickAccessSheet/);
  assert.doesNotMatch(desktop, /project=\{project\}|projectStatusCounts/);
  assert.match(desktop, /sessionTitle=\{title\}/);
  assert.match(desktop, /tasks=\{tasks\}/);
  assert.match(desktop, /recent=\{recent\}/);
  assert.match(desktop, /prefetchSessionTail\(item\.id\)/);
  assert.match(desktop, /<Popover/);
});

test("phone session overview opens from the above-composer agent activity dock", () => {
  const mobile = read("../src/components/mobile/MobileSessionHeader.tsx");
  assert.match(mobile, /useSessionStatusPopover\(\)/);
  assert.match(mobile, /closeSessionStatusPopover\(\)/);
  assert.match(mobile, /statusPopover\.open/);
});

test("overview mode routes dock to details and header to full navigation without inspecting DOM", () => {
  const closed = { open: false, source: null } as const;
  const dock = { open: true, source: "dock" } as const;
  const header = { open: true, source: "header" } as const;
  assert.equal(sessionOverviewMode(false, closed), "closed");
  assert.equal(sessionOverviewMode(true, closed), "full", "phone header opens full overview");
  assert.equal(sessionOverviewMode(false, dock), "details", "phone and compact dock open details");
  assert.equal(sessionOverviewMode(true, dock), "details", "dock wins over a previously open header");
  assert.equal(sessionOverviewMode(false, header), "full", "compact header opens full overview");
  assert.equal(sessionOverviewMode(true, closed), "full", "header handoff after closing dock keeps overview open");
});
