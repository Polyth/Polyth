import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("desktop status shares the live chat column geometry", async () => {
  const [header, rail, styles] = await Promise.all([
    readFile(new URL("../src/components/Header.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/ContextRail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(header, /--sidebar-inline-size/);
  assert.match(header, /--header-leading-inline-end/);
  assert.match(header, /--header-trailing-inline-size/);
  assert.match(header, /session && \(\s*<DesktopSessionStatus\s+showTrigger=\{showSessionStatus\}\s+trailing=/);
  assert.match(header, /slot="session\.header\.status"/);
  assert.match(rail, /--workspace-pane-inline-size/);
  assert.match(styles, /\.desktop-session-status[^}]+--sidebar-inline-size[^}]+--workspace-pane-inline-size/);
  assert.match(styles, /\.desktop-session-status[^}]+--header-leading-inline-end[^}]+--header-trailing-inline-size/s);
  assert.match(styles, /\.desktop-session-status-row\s*\{[^}]*display: flex;[^}]*align-items: center;/s);
  assert.match(styles, /\.header-chat \.desktop-session-status\s*\{[^}]*position: relative;[^}]*flex: 1 1 auto;/s);
  assert.match(styles, /\.app > \.header\s*\{[^}]*--conversation-frame-inline-start:[^}]*--conversation-frame-inline-end:/s);
  assert.doesNotMatch(styles, /\.app > \.header\.header-chat\s*\{[^}]*--conversation-frame-inline-start:/s);
  assert.match(styles, /body\[data-chatwidth="wide"\]\s*\{\s*--chat-measure:\s*1180px;/);
  assert.doesNotMatch(styles, /body\[data-chatwidth="wide"\] \.timeline\s*\{/);
  assert.doesNotMatch(styles, /\.timeline\s*\{[^}]*padding-inline-end:[^}]*--rail-strip-width-right/s);
});

test("desktop and phone titles present normalized task transitions without moving the task list through chat", async () => {
  const [desktop, details, mobile, mobileStyles, progressStyles, timeline] = await Promise.all([
    readFile(new URL("../src/components/DesktopSessionStatus.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/SessionActivityDetails.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/mobile/MobileSessionHeader.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/mobile/MobileSessionHeader.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/ConversationProgress.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/Timeline.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(desktop, /const tasks = tasksForIsland\(model\.tasks, model\.messages\)/);
  assert.match(desktop, /const taskProgressTitle = useTaskProgressTitle\(session\?\.id, tasks\)/);
  assert.match(desktop, /const displayedTitle = taskProgressTitle\?\.text \?\? title/);
  assert.match(desktop, /desktop-session-status-copy\$\{taskProgressTitle \? ` task-progress \$\{taskProgressTitle\.tone\}` : ""\}/);
  assert.match(desktop, /<SessionActivityDetails/);
  assert.match(desktop, /model=\{model\}/);
  assert.match(desktop, /usageEvents=\{events\[session\.id\]\}/);
  assert.match(details, /session-activity-task-list/);
  assert.match(details, /session-activity-swipe-content/);
  assert.match(details, /<Tabs/);
  assert.match(details, /<TabPanel/);
  assert.match(details, /prefs\.sessionActivityDetails === "tabs"/);
  assert.match(desktop, /toggleSessionStatusPopover\(headerRef\.current, "header"\)/);
  assert.match(desktop, /className="desktop-session-status-popover"/);
  assert.match(desktop, /side=\{fromDock \? "up" : "down"\}/);

  assert.match(mobile, /prompt=\{prompt\}/);
  assert.doesNotMatch(mobile, /promptVisible \? undefined : prompt/);
  assert.match(mobile, /const overviewTasks = tasksForIsland\(model\.tasks, model\.messages\)/);
  assert.match(mobile, /const taskProgressTitle = useTaskProgressTitle\(session\?\.id, overviewTasks\)/);
  assert.match(mobile, /const displayedTitle = taskProgressTitle\?\.text \?\? title/);
  assert.match(mobile, /task-progress \$\{taskProgressTitle\.tone\}/);

  assert.match(progressStyles, /\.timeline \.task-list\s*\{\s*display: none;/s);
  // Task lifecycle never takes an activity block's live line: the title and
  // overview own it (tickerStep skips task items).
  assert.match(timeline, /function tickerStep\([\s\S]*?if \(item\.kind === "tool"\) return item;/);
  assert.doesNotMatch(progressStyles, /activity-live/);
  assert.match(progressStyles, /\.timeline > \.msg\.assistant\.progress-update > \.bubble/);
  assert.match(progressStyles, /\.desktop-session-status-copy\.task-progress/);
  // Phone keeps its local guards too, so the behavior survives shell-specific
  // stylesheet loading even if the desktop status module is not mounted.
  assert.match(mobileStyles, /\.timeline \.task-list\s*\{\s*display: none;/s);
});

test("session activity keeps state marks, short tabs, and a filled stat grid borderless", async () => {
  const [details, styles] = await Promise.all([
    readFile(new URL("../src/components/SessionActivityDetails.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/SessionActivityDetails.css", import.meta.url), "utf8"),
  ]);
  assert.match(details, /sessionActivity\.usageTab/);
  assert.match(details, /sessionActivity\.contentTab/);
  assert.doesNotMatch(details, /value=.*wide|is-wide/);
  assert.match(styles, /\.session-activity-task-mark\.is-active\s*\{[^}]*box-shadow:\s*0 0 0 2px var\(--accent\)/s);
  assert.match(styles, /\.session-activity-task-mark\.is-pending\s*\{[^}]*box-shadow:\s*0 0 0 1px var\(--muted\)/s);
  assert.match(styles, /--session-activity-card:\s*var\(--sunken\)/);
  assert.doesNotMatch(styles, /\.session-activity-stat\.is-wide/);
  // Words read as text, like the chat activity block: only figures keep tiles.
  const cards = /\.session-activity-context-card,\n\.session-activity-stat \{([^}]*)\}/.exec(styles)?.[1] ?? "";
  assert.match(cards, /background:\s*var\(--session-activity-card\)/, "figure tiles keep their card");
  assert.doesNotMatch(styles, /\.session-activity-(?:intent|plan),?\s*\{[^}]*(?:background|border:)/, "request and plan have no card");
  // Plan steps hang from a thread that survives Borderless appearance.
  assert.match(styles, /\.session-activity-task-list::before \{[^}]*background:\s*var\(--borderless-edge\)/s);
  assert.match(styles, /\.session-activity-task-list li\.is-active::before \{[^}]*var\(--accent\)/s, "the step in progress lights its stretch");
  assert.doesNotMatch(styles, /\.session-activity-task-list li\.is-failed \{[^}]*color:\s*var\(--red\)/s, "a failure is told by its mark");
});

test("the desktop overview spans the chat column of the window it opens from and reflows by that width", async () => {
  const [desktop, popover, styles, details, sharing] = await Promise.all([
    readFile(new URL("../src/components/DesktopSessionStatus.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/ui/Popover.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/SessionActivityDetails.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/ShareSessionDialog.css", import.meta.url), "utf8"),
  ]);
  // The opener's conversation (the status dock) first, else the chat under the header title.
  assert.match(desktop, /anchor\?\.closest\("\.focus-conversation"\) \?\? document\.querySelector\("\.main \.focus-conversation"\)/);
  assert.match(desktop, /useOpenerColumnWidth\(overlay\.open && shellMode === "wide", overlay\.anchor\)/);
  assert.match(desktop, /"--session-status-column": `\$\{columnWidth\}px`/);
  assert.match(popover, /\.\.\.surfaceStyle,\s*top: position\.top,/, "anchored geometry always wins over a caller's style");
  assert.match(styles, /\.ui-popover\.desktop-session-status-surface \{ width: max\(360px, var\(--session-status-column, 0px\)\); \}/);
  assert.match(styles, /\.desktop-session-status-popover \{\s*container: session-status \/ inline-size;/);
  assert.match(details, /@container session-activity \(min-width: 540px\) \{\s*\.session-activity-stat-grid \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); \}/);
  assert.match(details, /@container session-activity \(min-width: 720px\) \{\s*\.session-activity-usage \{ grid-template-columns: minmax\(0, 1fr\) minmax\(0, 2fr\); \}/);
  assert.doesNotMatch(details, /\.session-activity-content[^{]*\{[^}]*grid-template-columns/, "request and plan stay one column: no hole beside a long plan");
  assert.match(sharing, /@container session-status \(min-width: 560px\) \{\s*\.desktop-session-status-popover > header > \.session-sharing-line \{ flex: none;/, "the sharing line never shrinks to a glyph beside the title");
});

test("the wide session title expands only prompt-derived fallbacks", async () => {
  const [desktop, format] = await Promise.all([
    readFile(new URL("../src/components/DesktopSessionStatus.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/format.ts", import.meta.url), "utf8"),
  ]);
  assert.match(desktop, /displayWideSessionTitle\(\s*session\.title,\s*session\.titleSource,/s);
  assert.match(format, /export function displayWideSessionTitle\([\s\S]+maxPromptLength = 72/);
  assert.match(format, /const promptDerived = titleSource === "polyth"[\s\S]+titleSource === "placeholder"[\s\S]+isPlaceholderTitle\(title, sessionId\)/);
  assert.match(format, /if \(promptDerived\) return titleFromPrompt\(firstUserText, maxPromptLength\);/);
  assert.match(format, /return displaySessionTitle\(title, sessionId, firstUserText\);/);
});

test("desktop and phone session titles use centered size roles", async () => {
  const [styles, tokens, mobile] = await Promise.all([
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/tokens.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/mobile/MobileSessionHeader.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(tokens, /--font-session-title:\s*calc\(15px \* var\(--text-scale, 1\)\)/);
  assert.match(styles, /\.desktop-session-status-trigger\s*\{[^}]*display: inline-grid;[^}]*grid-template-columns: minmax\(0, 1fr\) auto;[^}]*font-size: var\(--font-session-title\)/s);
  assert.match(styles, /\.desktop-session-status-end\s*\{[^}]*display: inline-flex;[^}]*align-items: center;/s);
  assert.match(styles, /\.desktop-session-status-copy\s*\{[^}]*justify-content: center;/s);
  assert.match(styles, /\.mobile-session-selector\s*\{[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\) var\(--icon-md\);[^}]*font-size: var\(--font-session-title-compact\)/s);
  assert.match(styles, /\.mobile-session-title-row\s*\{[^}]*display: flex;[^}]*align-items: center;/s);
  assert.match(styles, /\.mobile-island-text\s*\{[^}]*text-align: center;/s);
  assert.match(mobile, /slot="session\.header\.status"/);
  // Tablet tools never scroll sideways: whole shortcuts fit, the rest is in More.
  assert.match(styles, /\.mobile-shortcut-track\s*\{[^}]*display: flex;/s);
  assert.doesNotMatch(styles, /\.mobile-shortcut-rail\s*\{[^}]*overflow-x: auto/s);
});

test("session status popover toggles on the same anchor and moves to a new one", async () => {
  const popover = await import("../src/sessionStatusPopover.ts");
  popover.closeSessionStatusPopover();
  const dock = { id: "dock" } as HTMLElement;
  const header = { id: "header" } as HTMLElement;
  popover.openSessionStatusPopover(dock);
  assert.equal(popover.getSessionStatusPopover().open, true);
  assert.equal(popover.getSessionStatusPopover().anchor, dock);
  assert.equal(popover.getSessionStatusPopover().source, "header");
  popover.toggleSessionStatusPopover(dock, "dock");
  assert.equal(popover.getSessionStatusPopover().source, "dock", "a semantic opener can change without moving the anchor");
  popover.toggleSessionStatusPopover(header, "header");
  assert.equal(popover.getSessionStatusPopover().open, true);
  assert.equal(popover.getSessionStatusPopover().anchor, header);
  assert.equal(popover.getSessionStatusPopover().source, "header");
  popover.toggleSessionStatusPopover(header, "header");
  assert.equal(popover.getSessionStatusPopover().open, false);
  popover.closeSessionStatusPopover();
});
