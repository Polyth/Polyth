import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("session rows reserve one status zone and expose a visible actions menu", async () => {
  const sessions = await source("../src/components/sidebar/SessionList.tsx");
  const rowStart = sessions.indexOf("function SessionRow(");
  const rowEnd = sessions.indexOf("export default function SessionList", rowStart);
  const row = sessions.slice(rowStart, rowEnd);

  assert.match(row, /className="session-btn"/);
  assert.match(row, /className="session-title"/);
  assert.match(row, /className="session-status-zone"/);
  assert.match(row, /<AttentionBadges status=\{rowStatus\} \/>/);
  assert.match(row, /<StatusBadge status=\{rowStatus\} \/>/);
  assert.doesNotMatch(row, /className="session-actions/);
  assert.match(row, /className="session-quick-btn session-more-btn"/);
  assert.match(row, /aria-haspopup="menu"/);
  assert.match(row, /<Icon\.more/);
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
    "--nav-indent-project: 0px",
    "--nav-indent-worktree: 8px",
    "--nav-indent-session: 26px",
    "--nav-status-width: 56px",
  ]) assert.ok(css.includes(variable), `${variable} is part of the sidebar geometry contract`);

  assert.match(css, /--nav-project-size:\s*calc\(var\(--ui-font-size,\s*14px\)\s*\*\s*1\.143\)/);
  assert.match(css, /--nav-branch-size:\s*calc\(var\(--ui-font-size,\s*14px\)\s*\*\s*1\.071\)/);
  assert.match(css, /--nav-session-size:\s*var\(--ui-font-size,\s*14px\)/,
    "session titles respect the selected interface size without inflation");
  assert.match(css, /--nav-meta-size:\s*calc\(var\(--ui-font-size,\s*14px\)\s*\*\s*1\.071\)/);
  assert.match(css, /\.session-status-zone\s*\{[\s\S]*?font-size:\s*calc\(var\(--nav-session-size\) \* \.86\)/,
    "session counters scale proportionally with the title size");
  assert.doesNotMatch(css, /\.project-card\.active::before/,
    "the active project does not receive a row highlight");
  assert.match(css, /\.session-row\.active \.session-btn::before\s*\{[\s\S]*?left:\s*calc\(var\(--nav-session-row-indent, var\(--nav-indent-session\)\) - 12px\)/,
    "the active session highlight is larger than its hover surface");
  assert.match(css, /\.session-btn:hover\s*\{\s*background:\s*transparent;/,
    "session hover does not also receive the global button background");
  assert.match(css, /--ui-font-scale:\s*1;/,
    "the build applies the interface font scale to fixed-pixel text rules");
  assert.match(css, /\.project-card-shell\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\) repeat\(3,\s*36px\)/,
    "each project action has a dedicated, equally sized grid cell");
  assert.match(css, /\.project-new-session,[\s\S]*?\.project-menu-btn\s*\{[\s\S]*?place-items:\s*center;/,
    "project action glyphs are centered inside their hover targets");
  assert.doesNotMatch(css, /#root\s*\{[^}]*\bzoom\s*:/,
    "font scaling must not resize layout geometry");
  for (const density of ["compact", "balanced", "comfortable"]) {
    assert.match(css, new RegExp(`(?:html|body)\\[data-density="${density}"\\] \\.sidebar`));
  }
  assert.match(css, /html\[data-density="compact"\] \.sidebar,[\s\S]*?--nav-row-project:\s*40px;[\s\S]*?--nav-row-branch:\s*36px;[\s\S]*?--nav-row-session:\s*34px;/,
    "compact density substantially tightens every row in the project tree");
  assert.match(css, /html\[data-density="balanced"\] \.sidebar,[\s\S]*?--nav-row-project:\s*42px;[\s\S]*?--nav-row-branch:\s*38px;[\s\S]*?--nav-row-session:\s*36px;/,
    "balanced density remains compact");
  assert.match(css, /html\[data-density="comfortable"\] \.sidebar,[\s\S]*?--nav-row-project:\s*44px;[\s\S]*?--nav-row-branch:\s*40px;[\s\S]*?--nav-row-session:\s*38px;/,
    "comfortable density adds only a small amount of breathing room");
  assert.match(css, /\.session-btn\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\) fit-content\(var\(--nav-status-width\)\)/,
    "the status column only takes the width its content needs");
  assert.match(css, /\.session-quick\s*\{[\s\S]*?right:\s*8px/,
    "Shift quick actions align with the session row's right content inset");
  const mobile = css.slice(css.indexOf("@media (max-width: 820px) {"));
  assert.match(mobile, /--nav-session-size:\s*calc\(var\(--ui-font-size,\s*14px\)\s*\*\s*1\.143\)/,
    "the drawer reads session titles one interface-scale step up (Large at the default)");
  assert.match(mobile, /\[data-density="comfortable"\] \.sidebar\s*\{[\s\S]*?--nav-row-session:\s*32px/,
    "the normal density packs drawer rows tighter than the desktop compact rows");
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
