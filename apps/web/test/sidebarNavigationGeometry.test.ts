import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("session rows reserve one status zone and expose an aligned action menu", async () => {
  const sessions = await source("../src/components/sidebar/SessionList.tsx");
  const rowStart = sessions.indexOf("function SessionRow(");
  const rowEnd = sessions.indexOf("export default function SessionList", rowStart);
  const row = sessions.slice(rowStart, rowEnd);

  assert.match(row, /className="session-btn"/);
  assert.match(row, /className="session-title"/);
  assert.match(row, /className="session-status-zone"/);
  // Fixed columns, in reading order: state mark first, then the title with
  // its subagent disclosure, then meta (clock before identity marks, so the
  // identity icons share one trailing edge).
  const body = row.indexOf('<span className="session-row-body">');
  const lead = row.indexOf('<span className="session-lead"', body);
  const leadStatus = row.indexOf("<LeadStatus status={rowStatus} opening={opening} />", lead);
  const title = row.indexOf('<span className="session-title">', lead);
  const titleText = row.indexOf('className="session-title-text"', title);
  const disclosure = row.indexOf('className="session-subagent-toggle"', titleText);
  const statusZone = row.indexOf('<span className="session-status-zone">', disclosure);
  const elapsed = row.indexOf("<ElapsedBadge status={rowStatus} />", statusZone);
  const listBadge = row.indexOf('slot="session.list.badges"', elapsed);
  assert.ok(body > 0 && lead > body && leadStatus > lead && title > leadStatus,
    "the state mark leads every row in its own slot");
  assert.ok(titleText > title && disclosure > titleText && statusZone > disclosure,
    "the subagent disclosure follows the title text");
  assert.match(row, /\$\{subagents \? " has-subagents" : ""\}/,
    "rows with a disclosure are marked so CSS can keep it clear of the ⋯");
  assert.ok(elapsed > statusZone && listBadge > elapsed,
    "identity badges trail the running clock in the meta column");
  // The open button is the row's hit surface; the body only paints.
  assert.match(row, /className="session-btn"[\s\S]*?\/>\s*<\/SessionHoverCard>/);
  // One trigger per row, wired to the shared ui/Menu with a controlled open
  // state (context menu, long-press, Shift+F10) and dynamic focus return.
  assert.match(row, /className="session-menu-trigger"/);
  assert.match(row, /<Icon\.more \/>/);
  assert.match(row, /open=\{menuOpen\}/);
  assert.match(row, /returnFocusRef=\{menuReturnRef\}/);
  assert.doesNotMatch(row, /session-title-line/);
  assert.match(row, /onTouchStart=\{startLongPress\}/);
});

test("sidebar geometry links worktree and session type while density controls rows", async () => {
  const [tokens, styles] = await Promise.all([
    source("../src/tokens.css"),
    source("../src/styles.css"),
  ]);
  const css = `${tokens}\n${styles}`;
  for (const variable of [
    "--nav-project-size",
    "--nav-branch-size",
    "--nav-session-size",
    "--nav-meta-size",
    "--nav-indent-project: 0px",
    "--nav-indent-worktree: 8px",
    "--nav-indent-session: 2px",
  ]) assert.ok(css.includes(variable), `${variable} is part of the sidebar geometry contract`);

  assert.match(css, /--nav-project-size:\s*var\(--subheader-font-size,\s*16px\)/);
  assert.match(css, /--nav-branch-size:\s*calc\(var\(--nav-session-size\) \+ 1px\)/,
    "worktree names are exactly 1px larger than session names");
  assert.match(css, /--nav-session-size:\s*var\(--ui-font-size,\s*15px\)/,
    "session titles respect the selected general text size");
  assert.match(css, /\.session-worktree-toggle\s*\{[\s\S]*?font-size:\s*var\(--nav-branch-size\);[\s\S]*?font-weight:\s*600;/,
    "worktree names retain semibold emphasis");
  assert.match(css, /--nav-meta-size:\s*var\(--font-meta\)/);
  assert.match(css, /\.session-status-zone\s*\{[\s\S]*?font-size:\s*calc\(var\(--nav-session-size\) \* \.86\)/,
    "session counters scale proportionally with the title size");
  assert.doesNotMatch(css, /\.project-card\.active::before/,
    "the active project does not receive a row highlight");
  assert.match(css, /\.session-row\.active \.session-btn::before\s*\{[\s\S]*?inset-block:\s*0;[\s\S]*?inset-inline:\s*calc\(var\(--session-body-start\) - var\(--session-pill-inset\)\) -2px;/,
    "the active session highlight is taller and wider than its hover surface");
  // Horizontal rhythm: the state column starts 2px into the row, the pill
  // overhangs it by the 6px inset and the title follows one 6px gap later.
  // Children, rename text and "show more" all share the title axis.
  assert.match(css, /\.session-org\s*\{[\s\S]*?--session-lead-gap:\s*6px;[\s\S]*?--session-pill-inset:\s*6px;/);
  assert.match(css, /\.session-row\s*\{[\s\S]*?--session-body-start:\s*var\(--nav-session-row-indent, var\(--nav-indent-session\)\);/);
  assert.match(css, /\.session-subagent-children\s*\{[\s\S]*?--nav-session-row-indent:\s*calc\(var\(--nav-indent-session\) \+ var\(--session-lead-size\) \+ var\(--session-lead-gap\)\);/,
    "a child's state mark sits under its parent's title");
  assert.match(css, /\.session-worktree-group\s*\{\s*--nav-indent-session:\s*var\(--nav-worktree-row-indent, var\(--nav-indent-worktree\)\);/,
    "sessions under a worktree heading share its +/- axis");
  assert.match(css, /\.session-rename-input\s*\{[\s\S]*?margin-inline:\s*calc\(var\(--session-title-start\) - 7px\) 8px;/,
    "renaming keeps the text where the title was");
  assert.match(css, /\.session-pagination\s*\{[\s\S]*?margin-inline-start:\s*var\(--session-title-start, 22px\);/);
  assert.match(css, /\.session-row-body\s*\{[\s\S]*?padding-inline:\s*var\(--session-body-start\) 4px;/,
    "row geometry is logical so RTL mirrors it, and rows use their full width at rest");
  // The ⋯ trigger never paints over the title or the subagent disclosure:
  // whenever it is shown it takes its own trailing slot.
  assert.match(css, /--session-menu-slot:\s*calc\(2px \+ var\(--session-menu-size\)\);/);
  assert.match(css, /\.session-row:hover \.session-row-body,\s*\.session-row:has\(:focus-visible\) \.session-row-body,\s*\.session-row\.menu-open \.session-row-body \{ padding-inline-end: var\(--session-menu-slot\); \}/,
    "a revealed ⋯ claims its slot instead of overlapping the row content");
  assert.match(css, /\.session-row\.has-subagents \.session-status-zone \{ min-width: calc\(var\(--session-menu-slot\) - 4px\); \}/,
    "a subagent disclosure keeps its place when the ⋯ appears");
  assert.doesNotMatch(css, /\.session-row \.session-row-body \{ padding-(?:right|inline-end): calc\(var\(--tap\) \+ 8px\); \}/,
    "touch rows do not permanently reserve space for a hidden ⋯");
  assert.match(css, /\.session-btn:hover:where\(:not\(:disabled\)\)\s*\{\s*background:\s*transparent;/,
    "session hover does not also receive the global button background");
  assert.match(css, /--ui-font-scale:\s*1;/,
    "the build applies the interface font scale to fixed-pixel text rules");
  assert.match(css, /\.project-card-shell\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\) auto/,
    "the project title keeps the flexible track; actions take only what they need");
  assert.match(css, /\.project-new-session,[\s\S]*?\.project-menu-btn\s*\{[\s\S]*?place-items:\s*center;/,
    "project action glyphs are centered inside their hover targets");
  assert.doesNotMatch(css, /#root\s*\{[^}]*\bzoom\s*:/,
    "font scaling must not resize layout geometry");
  for (const density of ["compact", "balanced", "comfortable"]) {
    assert.match(css, new RegExp(`(?:html|body)\\[data-density="${density}"\\] \\.sidebar`));
  }
  assert.match(css, /html\[data-density="compact"\] \.sidebar,[\s\S]*?--nav-row-project:\s*36px;[\s\S]*?--nav-row-branch:\s*32px;[\s\S]*?--nav-row-session:\s*30px;/,
    "compact density substantially tightens every row in the project tree");
  assert.match(css, /html\[data-density="balanced"\] \.sidebar,[\s\S]*?--nav-row-project:\s*38px;[\s\S]*?--nav-row-branch:\s*34px;[\s\S]*?--nav-row-session:\s*32px;/,
    "balanced density remains compact");
  assert.match(css, /html\[data-density="comfortable"\] \.sidebar,[\s\S]*?--nav-row-project:\s*40px;[\s\S]*?--nav-row-branch:\s*36px;[\s\S]*?--nav-row-session:\s*34px;/,
    "comfortable density adds only a small amount of breathing room");
  assert.match(css, /\.session-row-body\s*\{[\s\S]*?grid-template-columns:\s*var\(--session-lead-size\) minmax\(0,\s*1fr\) max-content/,
    "a fixed state column leads; the status column grows to fit workflow badges and timers");
  assert.match(css, /\.session-row-body\s*\{[\s\S]*?pointer-events:\s*none;/,
    "the painted row body lets pointers reach the open button beneath");
  assert.match(css, /\.session-status-zone\s*\{[\s\S]*?overflow:\s*visible;/,
    "workflow badges and timers are not clipped by the status zone");
  assert.match(css, /\.session-row\[data-swipe="dragging"\] \.session-quick,\s*\.session-row\[data-swipe="revealed"\] \.session-quick\s*\{[\s\S]*?right:\s*2px/,
    "swipe-revealed quick actions align to the row's right edge");
  assert.match(css, /\.session-menu-trigger\s*\{[\s\S]*?right:\s*4px;[\s\S]*?width:\s*32px;[\s\S]*?border:\s*0;/,
    "session and project action columns share a clean edge without a button outline");
  assert.match(css, /@media \(max-width:\s*960px\)[\s\S]*?\.project-new-session,\s*\.project-menu-btn\s*\{\s*width:\s*var\(--tap\);\s*height:\s*var\(--tap\);/,
    "mobile project actions grow to the session menu touch target");
  assert.match(css, /\.sidebar \.project-card-shell,\s*\.sidebar \.project-card,\s*\.sidebar \.session-row,[\s\S]*?min-height:\s*var\(--tap\);/,
    "mobile project rows cannot be shorter than their touch controls");
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
