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
  assert.doesNotMatch(sidebar, /project-new-conversation/, "new conversation is a project-menu verb, not a row action");
  assert.doesNotMatch(sidebar, /className="side-foot"/);
  assert.match(sidebar, /icon=\{collapsed \? SidebarExpandIcon : SidebarCollapseIcon\}/);
  assert.match(sidebar, /icon=\{SidebarCollapseIcon\}[\s\S]{0,200}className="sidebar-collapse"[\s\S]{0,200}aria-expanded="true"/);
  assert.match(sidebar, /icon=\{SidebarExpandIcon\}[\s\S]{0,120}className="sidebar-expand"/);
  assert.doesNotMatch(sidebar, /SidebarRailCollapseIcon/);
  assert.match(styles, /\.sidebar-rail-toggle svg \{ stroke-width: 2; \}/);
  assert.doesNotMatch(styles, /\[data-rail-arrow\]/);
  assert.doesNotMatch(sidebar, /sidebar-rail-toggle[\s\S]{0,80}Switch/);
  assert.match(sidebar, /className="sidebar-service-bar customize-zone"/);
  // The toolbar customize (edit) pencil lives in the top toolbar; the bottom
  // of the sidebar reserves no empty bar for it.
  const serviceBar = sidebar.slice(
    sidebar.indexOf('className="sidebar-service-bar customize-zone"'),
    sidebar.indexOf("className={`side-scroll"),
  );
  assert.ok(serviceBar.length > 0, "the service bar precedes the session list");
  assert.match(serviceBar, /<CustomizeZoneButton slot="sidebar\.toolbar"/, "the top toolbar carries the edit pencil");
  assert.doesNotMatch(sidebar, /sidebar-footer-bar/, "no reserved bottom footer bar");
  assert.doesNotMatch(styles, /\.sidebar-footer-bar/);
  assert.match(sidebar, /className="sidebar-drawer-header"/);
  // Compact drawer replaced the decorative identity block with a working
  // toolbar: search toggle, sort, filter, and close.
  assert.match(sidebar, /className="sidebar-drawer-tools"/);
  assert.match(sidebar, /className="drawer-close"/);
  assert.match(sidebar, /className="sidebar-search sidebar-search-inline"/);
  assert.match(sidebar, /className=\{`sidebar-drawer-tool/);
  assert.doesNotMatch(sidebar, /className="sidebar-drawer-identity"/);
  assert.doesNotMatch(sidebar, /className="sidebar-list-controls"/);
  assert.match(sidebar, /tr\("sidebar\.listOptions"\)/);
  assert.match(sidebar, /kind: "radio",\s*checked: sort === "recent"/);
  assert.match(sidebar, /kind: "checkbox",\s*checked: attentionOnly/);
  // Grouping and order are the shared drill-in rows, not more checkboxes.
  assert.match(sidebar, /\.\.\.arrangementEntries/);
  assert.match(sidebar, /tr\("sidebar\.clearSessionSearch"\)/);
  // The sidebar connection indicator was removed; status lives elsewhere.
  assert.doesNotMatch(sidebar, /tr\("sidebar\.serverConnectionValue"/);
  assert.doesNotMatch(sessions, /session-sync-icon/);
  assert.match(sessions, /arrangeSessions\(grouped, grouping, sessionSort\)/);
  assert.match(sessions, /sessionGroupsOf\(roots, grouping, groupLabelContext\)/);
  assert.doesNotMatch(sessions, /className="session-time"/);
  assert.match(sessions, /session-worktree-actions/);
  assert.match(sessions, /session-worktree-toggle-sign/);
  assert.doesNotMatch(sessions, /session-worktree-count/);
  assert.match(sessions, /startFreshSession\(projectId, key === "__main__" \? \{\} : \{ worktreePath: key \}\)/);
  assert.match(sessions, /group\.worktree && !group\.worktree\.isMain/);
  assert.match(sessions, /setRemoveTarget\(group\.worktree\)/);
  assert.match(sessions, /tr\("sidebar\.sessionlist\.deleteWorktreeAndItsSessions"\)/);
  assert.match(sessions, /removePhase === "dirty"/);
  assert.doesNotMatch(sessions, /dirtyWaiter/);
  assert.doesNotMatch(sessions, /removeWorktreeThenDeleteSessions/);
  // Session cleanup after removal runs one delete at a time and still
  // reports any failure once.
  assert.match(sessions, /for \(const id of sessionIds\) \{\s*try \{ await deleteSession\(id\); \} catch \{ cleanupFailed = true; \}/);
  assert.match(sessions, /couldnTCleanUpSessionsAfterRemovingTheWorktree/);
  assert.match(sessions, /gitview\.destroyDirtyWorktree/);
  assert.doesNotMatch(sessions, /api\.removeWorktree\([^)]+true\)/);
  assert.match(sessions, /group\.sessions\.length === 0 && <div className="empty session-list-empty">\{tr\("sidebar\.sessionlist\.noMatchingSessions"\)\}/);
  assert.doesNotMatch(sessions, /session-worktree-empty|sidebar\.sessionlist\.noSessions/);
  assert.doesNotMatch(styles, /\.session-worktree-empty/);
  assert.match(styles, /\.session-worktree-toggle\s*\{[\s\S]*?width: auto;/);
  assert.match(styles, /\.session-worktree-actions\s*\{[\s\S]*?flex: none;/);
  assert.match(styles, /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\.session-worktree-head:hover \.session-worktree-actions,[\s\S]*?opacity: 1;/);
  assert.match(styles, /@media \(any-pointer: coarse\) \{[\s\S]*?\.session-worktree-head:hover \.session-worktree-actions,[\s\S]*?opacity: 0;/);
  assert.doesNotMatch(styles, /\.project-tree-sessions::before/);
  assert.match(styles, /\.session-btn::before\s*\{[\s\S]*?border-radius:\s*var\(--radius-control\)/);
  assert.match(styles, /\.sidebar-drawer-header\s*\{[\s\S]*?var\(--safe-top\)/,
    "the compact drawer has a safe-area-aware identity bar");
  assert.match(styles, /\.sidebar \.project-new-session,\s*\.sidebar \.project-menu-btn\s*\{\s*width:\s*var\(--tap\);\s*height:\s*var\(--tap\);/,
    "compact-drawer project actions grow to full touch size");
  assert.doesNotMatch(styles, /\.project-card\.active::before/,
    "the active project does not receive a competing row glow");
});

test("header and composer controls are configurable and purpose-specific", async () => {
  const [header, composer, settings, metrics] = await Promise.all([
    source("../src/components/Header.tsx"),
    source("../src/components/Composer.tsx"),
    source("../src/components/settings/pages.tsx"),
    source("../src/components/ChatMetrics.tsx"),
  ]);
  // Default top-rail pins live in the pure rail placement model.
  const placement = await source("../src/railPlacement.ts");
  assert.match(placement, /return \(id === "workflow" \|\| id === "terminal"\) && placements\[id\] === undefined;/);
  assert.match(placement, /capability\.tier === "primary" \|\| defaultPinnedTop\(capability\.descriptor\.id, placements\)/);
  assert.match(header, /topRailCapabilities\(resolved, placements/);
  assert.match(header, /topRail\.map/);
  assert.doesNotMatch(header, /const rest = /);
  assert.doesNotMatch(header, /visibleIds|rest\.length > 0/);
  assert.doesNotMatch(composer, /Modalities:/);
  // P2-W3A: the Add menu owns Upload on every layout; the composer wires it
  // through the platform-aware picker callback.
  assert.match(composer, /onUpload=\{\(\) => openAttachmentPicker\("files"\)\}/);
  assert.match(composer, /pickNativeFiles\(source\)\.then/);
  assert.match(settings, /itemId="chat\.responseActions"/);
  assert.match(settings, /itemId="chat\.headerMetrics"/);
  // Canvas is an explicit per-project toggle; chat settings never route to widgets.
  assert.doesNotMatch(settings, /openSettingsPage\("widgets"\)/);
  assert.match(metrics, /headerMetrics\.map/);
});

test("assistant response header carries identity, timing, and configured actions", async () => {
  const timeline = await source("../src/components/Timeline.tsx");
  const footerSource = await source("../src/components/ChatResponseFooter.tsx");
  for (const key of [
    "timeline.copyAnswer",
    "timeline.saveAsImage",
    "timeline.pinIntoContext",
    "timeline.startNewSessionFromThisAnswer",
  ]) assert.ok(footerSource.includes(`tr("${key}")`), `${key} is available`);
  assert.match(footerSource, /<ProviderLogo/);
  assert.match(footerSource, /className="chat-response-duration"/);
  assert.match(footerSource, /timeShort\(assistantTime\(m\)\)/);
  const response = timeline.indexOf("<div className=\"bubble\"");
  const footer = timeline.lastIndexOf("<ChatResponseFooter");
  assert.ok(footer > response, "assistant identity and actions follow the response body");
  assert.match(timeline, /terminal=\{r\.kind === "assistant" && terminalAnswers\.terminal\.has\(r\.eventSeq\)\s*&& \(!turnInProgress \|\| pendingSends\.length > 0 \|\| r\.eventSeq !== terminalAnswers\.trailing\)\}/,
    "the identity panel renders once per completed turn, on the terminal answer only");
});
