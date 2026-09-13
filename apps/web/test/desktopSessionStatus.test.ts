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

test("desktop title stays fixed while the phone title can briefly present a task start", async () => {
  const [desktop, mobile, timeline] = await Promise.all([
    readFile(new URL("../src/components/DesktopSessionStatus.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/mobile/MobileSessionHeader.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/Timeline.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(desktop, /desktop-session-status-copy"><span>{title}<\/span>/);
  assert.doesNotMatch(desktop, /setInterval|nextSessionSwitcherIndex/);
  assert.match(mobile, /promptVisible \? undefined : prompt/);
  assert.match(mobile, /const displayedTitle = taskStartTitle/);
  assert.match(mobile, />{displayedTitle}<\/span>/);
  assert.match(timeline, /activity-live.*task-started/);
  assert.match(timeline, /row\.bottom > viewport\.top && row\.top < viewport\.bottom/);
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
