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
  assert.match(rail, /--workspace-pane-inline-size/);
  assert.match(styles, /\.desktop-session-status[^}]+--sidebar-inline-size[^}]+--workspace-pane-inline-size/);
  assert.match(styles, /\.desktop-session-status[^}]+--header-leading-inline-end[^}]+--header-trailing-inline-size/s);
  assert.match(styles, /body\[data-chatwidth="wide"\]\s*\{\s*--chat-measure:\s*1180px;/);
  assert.doesNotMatch(styles, /body\[data-chatwidth="wide"\] \.timeline\s*\{/);
  assert.doesNotMatch(styles, /\.timeline\s*\{[^}]*padding-inline-end:[^}]*--rail-strip-width-right/s);
});

test("desktop and phone titles present normalized task transitions without moving the task list through chat", async () => {
  const [desktop, mobile, mobileStyles, progressStyles] = await Promise.all([
    readFile(new URL("../src/components/DesktopSessionStatus.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/mobile/MobileSessionHeader.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/mobile/MobileSessionHeader.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/ConversationProgress.css", import.meta.url), "utf8"),
  ]);

  assert.match(desktop, /const tasks = tasksForIsland\(model\.tasks, model\.messages\)/);
  assert.match(desktop, /const taskProgressTitle = useTaskProgressTitle\(session\?\.id, tasks\)/);
  assert.match(desktop, /const displayedTitle = taskProgressTitle\?\.text \?\? title/);
  assert.match(desktop, /desktop-session-status-copy\$\{taskProgressTitle \? ` task-progress \$\{taskProgressTitle\.tone\}` : ""\}/);
  assert.match(desktop, /className="desktop-session-task-list"/);

  assert.match(mobile, /promptVisible \? undefined : prompt/);
  assert.match(mobile, /const overviewTasks = tasksForIsland\(model\.tasks, model\.messages\)/);
  assert.match(mobile, /const taskProgressTitle = useTaskProgressTitle\(session\?\.id, overviewTasks\)/);
  assert.match(mobile, /const displayedTitle = taskProgressTitle\?\.text \?\? title/);
  assert.match(mobile, /task-progress \$\{taskProgressTitle\.tone\}/);

  assert.match(progressStyles, /\.timeline \.task-list\s*\{\s*display: none;/s);
  assert.match(progressStyles, /\.activity-live\.task-started,\s*\.activity-live:has\(\.task-activity\)\s*\{\s*display: none;/s);
  assert.match(progressStyles, /\.msg\.assistant:not\(\.activity-group\):has\(\+ \.activity-group\) > \.bubble/);
  assert.match(progressStyles, /\.desktop-session-status-copy\.task-progress/);
  // Phone keeps its local guards too, so the behavior survives shell-specific
  // stylesheet loading even if the desktop status module is not mounted.
  assert.match(mobileStyles, /\.timeline \.task-list\s*\{\s*display: none;/s);
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

test("desktop and phone session titles use the centered title role", async () => {
  const [styles, tokens] = await Promise.all([
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/tokens.css", import.meta.url), "utf8"),
  ]);
  assert.match(tokens, /--font-session-title:\s*calc\(15px \* var\(--ui-font-scale\)\)/);
  assert.match(styles, /\.desktop-session-status-trigger\s*\{[^}]*display: inline-grid;[^}]*grid-template-columns: var\(--icon-md\) minmax\(0, 1fr\) var\(--icon-md\);[^}]*font-size: var\(--font-session-title\)/s);
  assert.match(styles, /\.desktop-session-status-copy\s*\{[^}]*justify-content: center;/s);
  assert.match(styles, /\.mobile-session-selector\s*\{[^}]*display: grid;[^}]*grid-template-columns: var\(--icon-md\) minmax\(0, 1fr\) var\(--icon-md\);[^}]*font-size: var\(--font-session-title\)/s);
  assert.match(styles, /\.mobile-island-text\s*\{[^}]*text-align: center;/s);
});
