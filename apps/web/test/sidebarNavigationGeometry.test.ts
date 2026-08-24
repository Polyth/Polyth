import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("session rows reserve one right status zone and have no ellipsis action", async () => {
  const sessions = await source("../src/components/sidebar/SessionList.tsx");
  const rowStart = sessions.indexOf("function SessionRow(");
  const rowEnd = sessions.indexOf("export default function SessionList", rowStart);
  const row = sessions.slice(rowStart, rowEnd);

  assert.match(row, /className="session-btn"/);
  assert.match(row, /className="session-title"/);
  assert.match(row, /className="session-status-zone"/);
  assert.match(row, /<AttentionBadges status=\{rowStatus\} \/>/);
  assert.match(row, /<StatusBadge status=\{rowStatus\} \/>/);
  assert.doesNotMatch(row, /session-actions/);
  assert.doesNotMatch(row, /<Icon\.more/);
  assert.doesNotMatch(row, /session-title-line/);
  assert.match(row, /onTouchStart=\{startLongPress\}/);
});

test("sidebar geometry scales type from ui font size and density controls rows", async () => {
  const css = await source("../src/styles.css");
  for (const variable of [
    "--nav-project-size",
    "--nav-branch-size",
    "--nav-session-size",
    "--nav-meta-size",
    "--nav-indent-project: 12px",
    "--nav-indent-worktree: 28px",
    "--nav-indent-session: 44px",
    "--nav-status-width: 76px",
  ]) assert.ok(css.includes(variable), `${variable} is part of the sidebar geometry contract`);

  assert.match(css, /--nav-project-size:\s*calc\(var\(--ui-font-size,\s*14px\)\s*\*\s*1\.357\)/);
  assert.match(css, /--nav-session-size:\s*calc\(var\(--ui-font-size,\s*14px\)\s*\*\s*1\.214\)/);
  assert.match(css, /--nav-meta-size:\s*calc\(var\(--ui-font-size,\s*14px\)\s*\*\s*1\.071\)/);
  for (const density of ["compact", "balanced", "comfortable"]) {
    assert.match(css, new RegExp(`(?:html|body)\\[data-density="${density}"\\] \\.sidebar`));
  }
  assert.match(css, /\.session-btn\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\) var\(--nav-status-width\)/);
  assert.doesNotMatch(css, /\.session-actions\b/);
  assert.doesNotMatch(css, /\.session-sync-icon\b/);
});

test("search results are flat and retain project and worktree context", async () => {
  const [sidebar, sessions] = await Promise.all([
    source("../src/components/Sidebar.tsx"),
    source("../src/components/sidebar/SessionList.tsx"),
  ]);
  assert.match(sidebar, /query\.trim\(\) !== ""[\s\S]*?searchMode[\s\S]*?searchProjectName/);
  assert.match(sessions, /className="session-org session-search-mode"/);
  assert.match(sessions, /`\$\{searchProjectName\} · \$\{worktreeNameForSession\(session\)\}`/);
  assert.match(sessions, /className="session-search-context"/);
});
