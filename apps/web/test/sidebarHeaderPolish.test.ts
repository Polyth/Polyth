import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("sidebar uses contextual tree actions and no permanent footer", async () => {
  const [sidebar, sessions, styles] = await Promise.all([
    source("../src/components/Sidebar.tsx"),
    source("../src/components/sidebar/SessionList.tsx"),
    source("../src/styles.css"),
  ]);
  assert.doesNotMatch(sidebar, /className="sidebar-title">Sessions/);
  assert.doesNotMatch(sidebar, /project-tree-toggle-sign/);
  assert.doesNotMatch(sidebar, /globalMenuOpen|sidebar-global-menu/);
  assert.doesNotMatch(sidebar, /project-count/);
  assert.match(sidebar, /className="project-new-session"/);
  assert.doesNotMatch(sidebar, /className="side-foot"/);
  assert.match(sidebar, /className="sidebar-service-bar"/);
  assert.match(sidebar, /className="sidebar-drawer-header"/);
  assert.match(sidebar, /className="sidebar-drawer-identity"/);
  assert.match(sidebar, /project\?\.name \|\| project\?\.path \|\| tr\("header\.polyth"\)/);
  assert.match(sidebar, /className="drawer-close"/);
  assert.match(sidebar, /className="sidebar-list-controls"/);
  assert.match(sidebar, /tr\("sidebar\.clearSessionSearch"\)/);
  assert.match(sidebar, /tr\("sidebar\.serverConnectionValue"/);
  assert.match(sidebar, /tr\("sidebar\.reconnect"\)/);
  assert.doesNotMatch(sessions, /session-sync-icon/);
  assert.match(sessions, /sessionActivityLabel/);
  assert.match(sessions, /session-worktree-actions/);
  assert.match(sessions, /session-worktree-toggle-sign/);
  assert.doesNotMatch(sessions, /session-worktree-count/);
  assert.match(sessions, /startNewSession\(projectId, key === "__main__" \? \{\} : \{ worktreePath: key \}\)/);
  assert.match(sessions, /group\.worktree && !group\.worktree\.isMain/);
  assert.match(sessions, /setRemoveTarget\(group\.worktree\)/);
  assert.match(sessions, /tr\("sidebar\.sessionlist\.deleteWorktreeAndItsSessions"\)/);
  assert.match(sessions, /Promise\.all\(sessionsForRemoval\.map\(\(session\) => deleteSession\(session\.id\)\)\)/);
  assert.match(sessions, /api\.removeWorktree\(projectId, removeTarget\.path, deleteBranch\)/);
  assert.match(styles, /\.session-worktree-toggle\s*\{[\s\S]*?width: auto;/);
  assert.match(styles, /\.session-worktree-actions\s*\{[\s\S]*?flex: none;/);
  assert.match(styles, /\.session-worktree-head:hover \.session-worktree-actions,[\s\S]*?opacity: 1;/);
  assert.doesNotMatch(styles, /\.project-tree-sessions::before/);
  assert.match(styles, /\.session-btn::before\s*\{[\s\S]*?border-radius:\s*calc\(8px \* var\(--corner-radius-scale\)\)/);
  assert.match(styles, /\.sidebar-drawer-header\s*\{[\s\S]*?var\(--safe-top\)/,
    "the compact drawer has a safe-area-aware identity bar");
  assert.match(styles, /\.sidebar \.project-card-shell\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\) repeat\(3, var\(--tap\)\)/,
    "touch-sized project actions reserve explicit compact-drawer tracks");
  assert.doesNotMatch(styles, /\.project-card\.active::before/,
    "the active project does not receive a competing row glow");
});

test("header and composer controls are configurable and purpose-specific", async () => {
  const [header, composer, widgets, metrics] = await Promise.all([
    source("../src/components/Header.tsx"),
    source("../src/components/Composer.tsx"),
    source("../src/components/settings/WidgetsPage.tsx"),
    source("../src/components/ChatMetrics.tsx"),
  ]);
  assert.match(header, /const eligiblePrimaries = resolved\.filter\(\(c\) =>[\s\S]*?c\.tier === "primary"[\s\S]*?c\.descriptor\.id === "workflow"/);
  assert.match(header, /topRail\.map/);
  assert.match(header, /const terminal = resolved\.find/);
  assert.doesNotMatch(header, /const rest = /);
  assert.doesNotMatch(header, /visibleIds|rest\.length > 0/);
  assert.doesNotMatch(composer, /Modalities:/);
  // The upload chip is a ui/IconButton; `label` is its mandatory accessible name.
  assert.match(composer, /label=\{tr\("composer\.addFiles"\)\}/);
  assert.doesNotMatch(widgets, /Session header stats|Response hover actions|Technical menu/);
  assert.match(widgets, /tr\("settings\.widgetspage\.responseActions"\)/);
  assert.match(widgets, /tr\("settings\.widgetspage\.whereButtonsAppear"\)/);
  assert.match(widgets, /draggable/);
  assert.match(metrics, /headerMetrics\.map/);
});

test("assistant response header carries identity, timing, and configured actions", async () => {
  const timeline = await source("../src/components/Timeline.tsx");
  for (const key of [
    "timeline.copyAnswer",
    "timeline.saveAsImage",
    "timeline.saveAsPlan",
    "timeline.pinIntoContext",
    "timeline.startNewSessionFromThisAnswer",
    "timeline.startNewMultiRunFromThisAnswer",
  ]) assert.ok(timeline.includes(`tr("${key}")`), `${key} is available`);
  assert.match(timeline, /<ProviderLogo/);
  assert.match(timeline, /className="agent-reply-item agent-reply-duration"/);
  assert.match(timeline, /timeShort\(assistantTime\(m\)\)/);
  const response = timeline.indexOf("<div className=\"bubble\"");
  const footer = timeline.lastIndexOf("<AssistantAgentHeader m={m} announce={announce} turn={turn} preliminary={preliminary} />");
  assert.ok(footer > response, "assistant identity and actions follow the response body");
  assert.match(timeline, /agent-reply-header-preliminary/);
});
