import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");

test("timeline does not claim repository indexing or hide a second working row", () => {
  const timeline = read("../src/components/Timeline.tsx");

  assert.doesNotMatch(timeline, /Scanning repositories|indexing|usually takes a few seconds/i);
  assert.doesNotMatch(timeline, /turnWorking && !hasRunningAction/);
  assert.doesNotMatch(timeline, /function WorkingIndicator/);
});

test("composer and above-composer widgets sit directly on the workspace", () => {
  const css = read("../src/styles.css");

  assert.doesNotMatch(css, /\.focus-conversation\s*\{[^}]*background:/s);
});

test("the conversation keeps the complete glass dock in flow and fresh-turn space inside the timeline", () => {
  const surface = read("../src/components/workspace/builtinSurfaces.tsx");
  const css = read("../src/styles.css");

  assert.match(surface, /className="conversation-composer-dock"[\s\S]*slot="session\.composer\.before"[\s\S]*slot="session\.footer"[\s\S]*spawning && <SessionSpawnStatus \/>[\s\S]*<Composer \/>/);
  assert.doesNotMatch(surface, /composerDock|publishHeight|ResizeObserver/);
  assert.match(css, /\.conversation-composer-dock\s*\{[^}]*position:\s*relative;[^}]*flex:\s*none;/s);
  assert.doesNotMatch(css, /--conversation-dock-height|margin-block-end:\s*var\(--conversation-dock-height\)/);
  assert.match(css, /padding-bottom:\s*calc\(var\(--conversation-group-gap\) \+ var\(--timeline-turn-sheet-space, 0px\)\)/);
});

test("new timeline surfaces animate without moving the measured row", () => {
  const css = read("../src/styles.css");

  assert.match(css, /\.timeline > \.timeline-row-enter:not\(\.activity-group\) > \*/);
  assert.match(css, /animation:\s*timeline-surface-in var\(--motion-surface\) var\(--motion-ease\) both/);
  assert.doesNotMatch(css, /\.timeline > \.timeline-row-enter,\s*\n/);
});

test("spawning is an above-composer activity status and never replaces the composer", () => {
  const surface = read("../src/components/workspace/builtinSurfaces.tsx");
  const composer = read("../src/components/Composer.tsx");

  assert.match(surface, /function SessionSpawnStatus\(\)[\s\S]*spawningAgent[\s\S]*<AgentStatusDock/);
  assert.match(surface, /ProviderLogo providerID=\{harnessId\}[\s\S]*model=\{harnessLabel\}/);
  assert.doesNotMatch(composer, /if \(creatingSession\)\s*\{\s*return/);
  assert.match(composer, /aria-busy=\{creatingSession \|\| undefined\}/);
  assert.match(composer, /!session && !creatingSession && <SessionContextBar/);
});

test("agent status docks center their content with token spacing", () => {
  const css = read("../src/styles.css");

  assert.match(css, /\.agent-status-dock\s*\{[^}]*align-items:\s*center;[^}]*padding:\s*var\(--space-3\) var\(--space-4\)/s);
  assert.match(css, /\.agent-status-dock-icon\s*\{[^}]*place-items:\s*center;[^}]*width:\s*var\(--icon-xl\)/s);
  assert.doesNotMatch(css, /\.agent-status-dock-icon\s*\{[^}]*margin-block-start:/s);
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

test("conversation code surfaces follow the configured glass material", () => {
  const css = read("../src/styles.css");

  assert.match(css, /\.msg \.bubble :is\(code, pre\)\s*\{[^}]*background:\s*var\(--material-glass-medium\)/s);
  assert.match(
    css,
    /body:not\(\[data-glass="off"\]\):not\(\[data-desktop-low-resource="true"\]\)[\s\S]*?\.msg \.bubble :is\(code, pre\)[\s\S]*?backdrop-filter:\s*blur\(var\(--material-glass-blur\)\)/s,
  );
  assert.match(css, /\.msg \.bubble pre code\s*\{[^}]*background:\s*transparent/s);
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
  assert.match(timeline, /<AssistantAgentHeader m=\{m\} announce=\{announce\} turn=\{turn\} segmentStartedAt=\{segmentStartedAt\}[^/]*\/>/);
  // Configured response actions still drive the footer; copy and pin stay
  // direct while everything else folds into the overflow menu.
  assert.match(timeline, /const directActions = prefs\.responseActions\.filter/);
  assert.match(timeline, /const overflowActions = prefs\.responseActions\.filter/);
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

test("answer footers expose the configured copy action", () => {
  const timeline = read("../src/components/Timeline.tsx");
  assert.match(timeline, /copy:\s*tr\("timeline\.copyAnswer"\)/);
  assert.match(timeline, /id === "copy"[\s\S]*?copyText\(m\.text\)/);
  assert.match(timeline, /className="response-footer-actions"/);
});

test("thinking, tasks, and every execution share the compact activity-card treatment", () => {
  const timeline = read("../src/components/Timeline.tsx");
  const execution = read("../src/components/ExecutionRow.tsx");
  const css = read("../src/styles.css");

  assert.match(timeline, /className=\{`reasoning\$\{entering \? " timeline-row-enter" : ""\}\$\{open \? " open" : ""\}`\}>/);
  // The thought header names the work in progress instead of a fixed "Thinking"
  // label: the first line of reasoning when there is one, otherwise run state.
  assert.match(timeline, /<strong>\{head \|\| \(active \? tr\("timeline\.workingThroughTheRequest"\) : tr\("timeline\.activityDetail"\)\)\}<\/strong>/);
  assert.match(execution, /<div className=\{`tool-card execution-row/);
  assert.match(css, /\.reasoning,\s*\.task-list\s*\{[^}]*border:\s*0;/s);
  assert.match(css, /\.tool-card\.execution-row\s*\{[^}]*border:\s*0;/s);
  assert.match(css, /\.task-list\s*\{[^}]*margin:\s*var\(--space-1\) 0 0;/s);
});

test("task plans collapse like other agent actions", () => {
  const timeline = read("../src/components/Timeline.tsx");
  const css = read("../src/styles.css");

  assert.match(timeline, /className="task-list-expand-shell"/);
  assert.match(timeline, /className="task-list-item-mark"/);
  assert.doesNotMatch(timeline, /const revealTask|onClick=\{\(\) => revealTask/);
  assert.match(timeline, /const \[open, setOpen\] = useState\(false\);/);
  assert.match(css, /\.task-list\.open > \.task-list-expand-shell\s*\{[^}]*grid-template-rows:\s*1fr;/s);
  assert.match(css, /\.task-list li\.active\s*\{[^}]*background:\s*var\(--accent-wash\)/s);
});

test("task plans remain represented by the status surfaces", () => {
  const pendingChanges = read("../../../packages/git/widgets/PendingChangesBar.tsx");
  assert.match(pendingChanges, /const activeTask = model\.tasks\?\.items\.find/);
  assert.match(pendingChanges, /activeTask\?\.text/);
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
  assert.match(timeline, /const fresh = live && m\.text === "" && !reasoningSeen\(source\);/);
  assert.match(timeline, /const reasoning = useSmoothText\(source, fresh\);/);
  // Block stays expanded while forming: typing OR the reasoning part has not
  // finalized yet (turn working, latest row, no answer). Pauses do not fold.
  assert.match(timeline, /const active = typing \|\| \(!m\.finalized && live && m\.text === ""\);/);
  // The initial reveal types over a watchable window, later chunks keep the
  // bounded catch-up.
  assert.match(timeline, /const frames = revealRef\.current \? 90 : 18;/);
  // A played reveal never re-types: remounts (reasoning→answer merge, session
  // switch-back) show the thought formed.
  assert.match(timeline, /function reasoningSeen\(text: string\): boolean/);
  assert.match(timeline, /if \(fresh && !typing\) revealedReasoning\.add\(source\);/);
});
