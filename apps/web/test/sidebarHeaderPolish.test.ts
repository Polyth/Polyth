import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("sidebar removes labels, row ornaments, project counts, and the entire desktop footer", async () => {
  const [sidebar, sessions, styles] = await Promise.all([
    source("../src/components/Sidebar.tsx"),
    source("../src/components/sidebar/SessionList.tsx"),
    source("../src/styles.css"),
  ]);
  assert.doesNotMatch(sidebar, /className="sidebar-title">Sessions/);
  assert.doesNotMatch(sidebar, /project-tree-chevron/);
  assert.doesNotMatch(sidebar, /project-count/);
  assert.match(sidebar, /\{compact && \(\s*<div className="side-foot">/);
  assert.doesNotMatch(sessions, /session-sync-icon/);
  assert.match(sessions, /sessionActivityLabel/);
  assert.match(sessions, /session-worktree-empty-actions/);
  assert.match(sessions, /const isEmptyWorktree = !projectSessions\.some/);
  assert.match(sessions, /openWorktreeSessionDialog\(projectId, group\.key\)/);
  assert.match(sessions, /group\.worktree && !group\.worktree\.isMain/);
  assert.match(sessions, /setRemoveTarget\(group\.worktree\)/);
  assert.match(sessions, /Delete empty worktree\?/);
  assert.match(sessions, /api\.removeWorktree\(projectId, removeTarget\.path, deleteBranch\)/);
  assert.match(styles, /\.session-worktree-head \.session-worktree-toggle \{ width: auto;/);
  assert.match(styles, /\.session-worktree-empty-actions \{[\s\S]*?flex: none;/);
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
  assert.match(widgets, /Session header stats/);
  assert.match(widgets, /Response hover actions/);
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
});
