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
  const leadStatus = row.indexOf("<LeadMark mark={leadMark} />", lead);
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
    "--nav-gutter: 8px",
    "--nav-glyph-inset: 8px",
    "--nav-text-inset: 32px",
    "--nav-indent-project: var(--nav-glyph-inset)",
    "--nav-indent-worktree: var(--nav-glyph-inset)",
    "--nav-indent-session: var(--nav-glyph-inset)",
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
  assert.doesNotMatch(css, /\.session-row\.active \.session-btn::before\s*\{[^}]*inset/,
    "the current row's pill has the hover pill's extent; only its paint differs");
  // Horizontal rhythm (one grid with the header rows): the state mark one
  // glyph inset in and the title on the text axis; the pill keeps
  // --nav-pill-air before the mark and after the trailing marks.
  // Children, rename text and "show more" all share the title axis.
  assert.match(css, /\.session-org,\s*\.private-room-row,\s*\.private-room-chats,[^{]*?\.sidebar-nav-section\s*\{[\s\S]*?--session-lead-gap:\s*calc\(var\(--nav-text-inset\) - var\(--nav-glyph-inset\) - var\(--session-lead-size\)\);[\s\S]*?--session-pill-inset:\s*var\(--nav-pill-air\);\s*--session-pill-end:\s*calc\(var\(--nav-trailing-inset\) - var\(--nav-pill-air\)\);/);
  assert.match(css, /\.session-row\s*\{[\s\S]*?--session-body-start:\s*var\(--nav-session-row-indent, var\(--nav-indent-session\)\);/);
  assert.match(css, /\.session-subagent-children\s*\{[\s\S]*?--nav-session-row-indent:\s*calc\(var\(--nav-indent-session\) \+ var\(--session-lead-size\) \+ var\(--session-lead-gap\)\);/,
    "a child's state mark sits under its parent's title");
  assert.match(css, /\.session-worktree-group\s*\{\s*--nav-indent-session:\s*var\(--nav-worktree-row-indent, var\(--nav-indent-worktree\)\);/,
    "sessions under a worktree heading share its +/- axis");
  assert.match(css, /\.session-rename-input\s*\{[\s\S]*?margin-inline:\s*calc\(var\(--session-title-start\) - 7px\) 8px;/,
    "renaming keeps the text where the title was");
  assert.match(css, /\.session-pagination\s*\{[\s\S]*?margin-inline-start:\s*var\(--session-title-start, 22px\);/);
  // A day caption labels the group beneath it: the gap above is density air,
  // the gap below is a hairline, so a chat cannot read as the next day's.
  assert.match(css, /\.session-date-divider\s*\{[\s\S]*?padding:\s*calc\(var\(--space-2\) \* var\(--density-scale\)\) var\(--space-2\) 1px;/, "a date heading sits closer to its own day than to the one above");
  assert.match(css, /\.session-row-body\s*\{[\s\S]*?padding-inline:\s*var\(--session-body-start\) var\(--nav-trailing-inset, 4px\);/,
    "row geometry is logical so RTL mirrors it; trailing meta ends on the navigator's shared trailing axis");
  assert.match(css, /--nav-trailing-inset:\s*4px;/, "one trailing inset for chat and agent rows");
  // The never-scrolling header block (agent rows live there) reserves the same
  // scrollbar gutter as the scrolling chat list, so the trailing axes cannot drift.
  assert.match(css, /\.sidebar-nav-block\s*\{[\s\S]*?overflow-y:\s*hidden;\s*scrollbar-gutter:\s*stable;/);
  assert.match(css, /\.sidebar-nav-block \+ \.side-scroll\s*\{[^}]*scrollbar-gutter:\s*stable;/);
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
  // The row's highlight belongs to the shell, which spans the whole row; the
  // card is only the leading track, so a card-scoped surface stopped at the
  // title and left the new-chat and ⋮ controls beside it unlit.
  assert.match(css, /\.project-card-shell::before,\s*\n\.session-worktree-toggle::before,/,
    "the project row's highlight is the shell's, not the card's");
  assert.match(css, /\.project-card-shell:hover:where\(:not\(\[data-session-drop-over="true"\]\)\)::before\s*\{[\s\S]*?background:\s*var\(--elevated\);/,
    "hovering anywhere on the project row paints that full-width highlight");
  assert.doesNotMatch(css, /\.project-card:hover[^{]*::before/,
    "the card itself never paints a partial row highlight");
  assert.match(css, /\.project-actions\s*\{[\s\S]*?position:\s*relative;\s*\n\s*z-index:\s*1;/,
    "the row's controls sit above the highlight its shell paints");
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

test("the highlight pill hugs the title when the state column is empty, and a resting pin fills that column", async () => {
  const [styles, fluent, macos, liquid, looks, sessions, lead] = await Promise.all([
    source("../src/styles.css"),
    source("../src/fluentTheme.css"),
    source("../src/macosTheme.css"),
    source("../src/liquidGlassTheme.css"),
    source("../src/shellLooks.css"),
    source("../src/components/sidebar/SessionList.tsx"),
    source("../src/sessionLead.ts"),
  ]);
  // One start variable: --session-pill-inset before the state mark, or the
  // same inset before the title when the column shows nothing.
  assert.match(styles, /\.session-row\s*\{[^}]*--session-pill-start:\s*calc\(var\(--session-body-start\) - var\(--session-pill-inset\)\);/);
  assert.match(styles, /\.session-row\[data-lead="empty"\]\s*\{\s*--session-pill-start:\s*calc\(var\(--session-title-start\) - var\(--session-pill-inset\)\);\s*\}/);
  // Hover, press, focus, selection and the pinned fill share one extent.
  assert.match(styles, /\.session-btn::before\s*\{\s*inset-inline:\s*var\(--session-pill-start\) var\(--session-pill-end, 0px\);[^}]*inset-inline-start var\(--motion-fast\) var\(--motion-ease\);/);
  assert.match(styles, /\.session-btn:focus-visible::before\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\);[^}]*outline-offset:\s*-2px;/,
    "keyboard focus rings the pill, not the row box");
  assert.doesNotMatch(styles, /\.session-btn::before\s*\{[^}]*inset-inline:\s*calc\(var\(--session-body-start\)/,
    "no rule pins the pill to the state column directly");
  // The global reduced-motion and reduce-animations rules switch the slide off.
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*, \*::before, \*::after\s*\{\s*transition: none !important;/);
  assert.match(styles, /html\[data-reduce-animations="true"\], body\[data-desktop-low-resource="true"\]\) \*::before,[^{]*\{[^}]*transition: none !important;/);
  // OS styles and looks restyle the pill's paint, never its start; Fluent's
  // accent bar follows the same start.
  assert.match(fluent, /\.session-row\.active \.session-btn::after\s*\{[^}]*inset-inline-start:\s*var\(--session-pill-start\);/);
  for (const css of [fluent, macos, liquid, looks]) {
    assert.doesNotMatch(css, /\.session-btn::before\s*\{[^}]*inset/, "a theme never moves the pill start");
  }
  // The pin is a state-column mark, quiet accent; looks keep it in quiet ink.
  assert.match(styles, /\.session-lead-pin\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*color:\s*color-mix\(in oklab, var\(--accent\) 65%, var\(--muted\)\);/);
  // Sized like the old trailing pin, centred in the column: quieter than a live mark.
  assert.match(styles, /\.session-lead-pin svg\s*\{\s*width:\s*calc\(var\(--icon-sm\) - 3px\);\s*height:\s*calc\(var\(--icon-sm\) - 3px\);\s*\}/);
  assert.match(looks, /:is\(\.session-pinned-divider, \.session-lead-pin, \.mobile-nav-lead-pin\)\s*\{\s*color:\s*var\(--look-ink-quiet\);/);
  assert.doesNotMatch(styles, /\.session-pin-icon/);
  assert.doesNotMatch(sessions, /session-pin-icon/, "the trailing pin is gone");
  // data-lead comes from the same decision that renders the mark.
  assert.match(sessions, /data-lead=\{sessionLeadState\(leadMark, selectMode\)\}/);
  assert.match(sessions, /<LeadMark mark=\{leadMark\} \/>/);
  assert.match(lead, /default:\s*return pinned \? "pin" : null;/, "a pin only shows when no live state does");
});
