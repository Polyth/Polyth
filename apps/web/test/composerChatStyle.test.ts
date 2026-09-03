import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");

test("working status stays visible, reports live work, and does not claim repository indexing", () => {
  const timeline = read("../src/components/Timeline.tsx");
  const css = read("../src/styles.css");

  assert.doesNotMatch(timeline, /Scanning repositories|indexing|usually takes a few seconds/i);
  assert.doesNotMatch(timeline, /turnWorking && !hasRunningAction/);
  assert.match(timeline, /turnWorking && <WorkingIndicator model=\{model\} \/>/);
  assert.match(timeline, /message\.status === "pending" \|\| message\.status === "running"/);
  assert.match(timeline, /<time className="focus-working-elapsed"/);
  assert.match(timeline, /<span className="focus-working-context-label">\{tr\("capabilities\.context"\)\}<\/span>/);
  assert.match(css, /\.working-status-dock\s*\{[^}]*grid-template-columns:[^}]*border-inline-start:\s*2px solid var\(--accent\)/s);
  assert.match(css, /\.focus-working-spinner\s*\{[^}]*animation:\s*focus-working-pulse/s);
});

test("composer radius uses the shared corner setting", () => {
  const css = read("../src/styles.css");

  assert.match(css, /\.composer-card\s*\{[^}]*border-radius:\s*var\(--radius-composer\)/s);
  assert.match(css, /\.composer-simple \.composer-card\s*\{[^}]*border-radius:\s*var\(--radius-composer\)/s);
  assert.match(css, /\.composer-mobile \.composer-card\s*\{[^}]*border-radius:\s*var\(--radius-composer\)/s);
});

test("conversation rows omit role chrome, keep assistant prose flat, and accent user turns", () => {
  const timeline = read("../src/components/Timeline.tsx");
  const css = read("../src/styles.css");

  assert.doesNotMatch(timeline, /className="msg-author"/);
  assert.doesNotMatch(timeline, /<strong>(?:Polyth|You|User)<\/strong>/);
  assert.match(css, /\.msg\.user\s*\{\s*align-items:\s*flex-end;/);
  assert.match(css, /\.msg\.assistant\s*\{\s*align-items:\s*flex-start;/);
  assert.match(css, /\.msg\.user \.bubble\s*\{[^}]*background:\s*var\(--bubble-user-bg\)/s);
  assert.match(css, /\.msg\.assistant > \.bubble\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent/s);
});

test("message actions use one lightweight copy control and local hover zones", () => {
  const timeline = read("../src/components/Timeline.tsx");
  const css = read("../src/styles.css");

  assert.match(timeline, /className="msg-action-btn"/);
  assert.match(timeline, /key: "copy"/);
  assert.doesNotMatch(timeline, /key: "md"|key: "json"/);
  assert.match(timeline, /prefs\.showMessageActions &&/);
  assert.match(timeline, /data-tooltip=\{entry\.disabledReason \?\? entry\.label\}/);
  assert.match(timeline, /<Icon\.more \/>/);
  assert.match(timeline, /className="msg-actions-item-label">\{entry\.label\}/);
  assert.match(css, /\.msg-action-btn\s*\{[^}]*border:\s*1px solid transparent;[^}]*background:\s*transparent;/s);
  assert.match(css, /\.msg-action-btn::after\s*\{[^}]*content:\s*attr\(data-tooltip\);/s);
  assert.match(css, /\.msg > \.bubble:hover ~ \.msg-meta \.msg-actions,/);
  assert.doesNotMatch(css, /\.msg:hover \.msg-actions|\.msg\.assistant \.msg-actions\s*\{[^}]*pointer-events:\s*auto/s);
  assert.match(css, /\.msg-actions\s*\{[^}]*gap:\s*1px;/s);
  assert.match(css, /@media \(hover:\s*none\) and \(pointer:\s*coarse\) and \(min-width:\s*481px\)/);
  assert.match(css, /@media \(max-width:\s*480px\)[\s\S]*\.msg\.assistant \.msg-actions\s*\{\s*display:\s*flex;/);
  assert.match(timeline, /key: "gallery"/);
  assert.match(timeline, /key: "regenerate"/);
  assert.match(timeline, /<AssistantAgentHeader m=\{m\} announce=\{announce\} turn=\{turn\} segmentStartedAt=\{segmentStartedAt\} \/>/);
  assert.match(timeline, /prefs\.responseActions\.map/);
  assert.match(timeline, /tr\("timeline\.startNewMultiRunFromThisAnswer"\)/);
});

test("assistant identity panel renders once per turn, after the turn completes", () => {
  const timeline = read("../src/components/Timeline.tsx");
  // While the session is actively working (or paused mid-turn on a request),
  // no answer renders any metadata row. After the turn completes, exactly the
  // terminal answer (last assistant message before the next prompt) carries
  // the identity panel; a turn stranded by an unclear session state still
  // counts as completed and shows the panel.
  assert.match(timeline, /const sessionActive = sessionStatus === "working" \|\| sessionStatus === "waiting";/);
  assert.match(timeline, /terminal=\{r\.kind === "assistant" && !sessionActive && terminalAnswers\.has\(r\.eventSeq\)\}/);
  assert.match(timeline, /if \(lastAssistant !== null\) terminal\.set\(lastAssistant\.eventSeq, openAt\);/);
  assert.doesNotMatch(timeline, /preliminary|assistant-preliminary|agent-reply-header-preliminary/);
});

test("answer text blocks expose a hover copy control at the block end", () => {
  const timeline = read("../src/components/Timeline.tsx");
  const css = read("../src/styles.css");

  assert.match(timeline, /className="bubble-copy"/);
  assert.match(timeline, /<CopyButton text=\{m\.text\} label=\{tr\("timeline\.copyAnswer"\)\} \/>/);
  assert.match(css, /\.bubble-copy\s*\{[^}]*position:\s*absolute;[^}]*inset-block-end:\s*4px;[^}]*inset-inline-end:\s*4px;[^}]*opacity:\s*0;/s);
  assert.match(css, /\.msg\.assistant > \.bubble:hover \.bubble-copy,[\s\S]*?focus-within \.bubble-copy \{\s*opacity:\s*1;/);
  assert.match(css, /\.bubble-copy \.copy-btn\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--panel\) 84%, transparent\);/s);
  assert.match(css, /@media \(hover: none\) and \(pointer: coarse\) and \(min-width: 481px\)[\s\S]*?\.bubble-copy \{\s*opacity:\s*1;/);
});

test("thinking, tasks, and every execution share the compact activity-card treatment", () => {
  const timeline = read("../src/components/Timeline.tsx");
  const execution = read("../src/components/ExecutionRow.tsx");
  const css = read("../src/styles.css");

  assert.match(timeline, /className=\{`reasoning\$\{open \? " open" : ""\}`\}>/);
  assert.match(timeline, /<strong>Thinking<\/strong>/);
  assert.match(execution, /<div className=\{`tool-card execution-row/);
  assert.match(css, /\.reasoning,\s*\.task-list\s*\{[^}]*border:\s*0;/s);
  assert.match(css, /\.tool-card\.execution-row\s*\{[^}]*border:\s*0;/s);
  assert.match(css, /\.task-list\s*\{[^}]*margin:\s*var\(--space-1\) 0 0;/s);
});

test("task plans expand as a styled list instead of opening raw task activity", () => {
  const timeline = read("../src/components/Timeline.tsx");
  const css = read("../src/styles.css");

  assert.match(timeline, /className="task-list-expand-shell"/);
  assert.match(timeline, /className="task-list-item-mark"/);
  assert.doesNotMatch(timeline, /const revealTask|onClick=\{\(\) => revealTask/);
  assert.match(css, /\.task-list\.open > \.task-list-expand-shell\s*\{[^}]*grid-template-rows:\s*1fr;/s);
  assert.match(css, /\.task-list li\.active\s*\{[^}]*background:\s*var\(--accent-wash\)/s);
});

test("todowrite details use the same task presentation instead of raw input", () => {
  const execution = read("../src/components/ExecutionRow.tsx");
  const css = read("../src/styles.css");
  assert.match(execution, /TodoWritePreview/);
  assert.match(execution, /if \(!\/\^\(\?:todowrite\|todo\)\$\/i\.test\(message\.tool\)\)/);
  assert.match(execution, /todoItems && todoItems\.length > 0 \? <TodoWritePreview/);
  assert.match(css, /\.execution-todo-list li\.active\s*\{[^}]*background:\s*var\(--accent-wash\)/s);
});

test("a live thought reveals expanded, types out, then folds when formed", () => {
  const timeline = read("../src/components/Timeline.tsx");

  // The latest assistant row of a working turn owns the live reveal.
  assert.match(timeline, /live=\{r\.kind === "assistant" && turnWorking && r\.id === latestAssistantId\}/);
  // Fresh live thought types from empty instead of popping in fully formed.
  assert.match(timeline, /const fresh = live && m\.text === "" && !reasoningSeen\(m\.reasoning\);/);
  assert.match(timeline, /const reasoning = useSmoothText\(m\.reasoning, fresh\);/);
  // Block stays expanded while forming: typing OR the reasoning part has not
  // finalized yet (turn working, latest row, no answer). Pauses do not fold.
  assert.match(timeline, /const active = typing \|\| \(!m\.finalized && live && m\.text === ""\);/);
  // The initial reveal types over a watchable window, later chunks keep the
  // bounded catch-up.
  assert.match(timeline, /const frames = revealRef\.current \? 90 : 18;/);
  // A played reveal never re-types: remounts (reasoning→answer merge, session
  // switch-back) show the thought formed.
  assert.match(timeline, /function reasoningSeen\(text: string\): boolean/);
  assert.match(timeline, /if \(fresh && !typing\) revealedReasoning\.add\(m\.reasoning\);/);
});
