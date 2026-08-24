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
  assert.match(sidebar, /project-tree-chevron/);
  assert.match(sidebar, /project-count/);
  assert.match(sidebar, /className="project-new-session"/);
  assert.doesNotMatch(sidebar, /className="side-foot"/);
  assert.match(sidebar, /className="sidebar-service-bar"/);
  assert.match(sidebar, /className="sidebar-list-controls"/);
  assert.match(sidebar, /Clear session search/);
  assert.match(sidebar, /Server connection:/);
  assert.match(sidebar, />Reconnect</);
  assert.doesNotMatch(sessions, /session-sync-icon/);
  assert.match(sessions, /sessionActivityLabel/);
  assert.match(sessions, /session-worktree-actions/);
  assert.match(sessions, /const isEmptyWorktree = !projectSessions\.some/);
  assert.match(sessions, /startNewSession\(projectId, key === "__main__" \? \{\} : \{ worktreePath: key \}\)/);
  assert.match(sessions, /group\.worktree && !group\.worktree\.isMain/);
  assert.match(sessions, /setRemoveTarget\(group\.worktree\)/);
  assert.match(sessions, /Delete empty worktree\?/);
  assert.match(sessions, /api\.removeWorktree\(projectId, removeTarget\.path, deleteBranch\)/);
  assert.match(styles, /\.session-worktree-toggle\s*\{[\s\S]*?width: auto;/);
  assert.match(styles, /\.session-worktree-actions\s*\{[\s\S]*?flex: none;/);
});

test("header and composer controls are configurable and purpose-specific", async () => {
  const [header, composer, widgets, metrics] = await Promise.all([
    source("../src/components/Header.tsx"),
    source("../src/components/Composer.tsx"),
    source("../src/components/settings/WidgetsPage.tsx"),
    source("../src/components/ChatMetrics.tsx"),
  ]);
  assert.match(header, /const rest = primaries\.filter\(\(c\) => !visibleIds\.has\(c\.descriptor\.id\)\)/);
  assert.match(header, /rest\.length > 0/);
  assert.doesNotMatch(header, /const rest = resolved\.filter/);
  assert.doesNotMatch(composer, /Modalities:/);
  assert.match(composer, /aria-label="Add files"/);
  assert.doesNotMatch(widgets, /Session header stats|Response hover actions|Technical menu/);
  assert.match(widgets, /Response actions/);
  assert.match(widgets, /Where buttons appear/);
  assert.match(widgets, /draggable/);
  assert.match(metrics, /headerMetrics\.map/);
});

test("assistant response header carries identity, timing, and configured actions", async () => {
  const timeline = await source("../src/components/Timeline.tsx");
  for (const label of [
    "Copy answer",
    "Save as image",
    "Save as plan",
    "Pin into context",
    "Start new session from this answer",
    "Start new multi-run from this answer",
  ]) assert.ok(timeline.includes(label), `${label} is available`);
  assert.match(timeline, /<ProviderLogo/);
  assert.match(timeline, /className="agent-reply-duration"/);
  assert.match(timeline, /timeShort\(assistantTime\(m\)\)/);
  const response = timeline.indexOf("<div className=\"bubble\"");
  const footer = timeline.lastIndexOf("<AssistantAgentHeader m={m} announce={announce} />");
  assert.ok(footer > response, "assistant identity and actions follow the response body");
});
