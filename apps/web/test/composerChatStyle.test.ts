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

  assert.match(surface, /className="conversation-composer-dock"[\s\S]*slot="session\.composer\.before"[\s\S]*slot="session\.footer"[\s\S]*!working && \(spawning \|\| awaitingTurn\) && \(\s*<SessionSpawnStatus[\s\S]*<Composer \/>/);
  assert.doesNotMatch(surface, /composerDock|publishHeight|ResizeObserver/);
  assert.match(css, /\.conversation-composer-dock\s*\{[^}]*position:\s*relative;[^}]*flex:\s*none;/s);
  assert.doesNotMatch(css, /--conversation-dock-height|margin-block-end:\s*var\(--conversation-dock-height\)/);
  assert.match(css, /padding-bottom:\s*calc\(var\(--conversation-group-gap\) \+ var\(--timeline-turn-sheet-space, 0px\)\)/);
});

test("the transcript remains the bounded vertical scroll root", () => {
  const css = read("../src/styles.css");

  for (const selector of [".timeline-wrap", ".timeline-shell", ".timeline-viewport"]) {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start >= 0, `${selector} is missing`);
    const block = css.slice(start, css.indexOf("}", start));
    assert.match(block, /min-height:\s*0/);
    assert.match(block, /overflow:\s*hidden/);
  }
  const start = css.indexOf(".timeline {");
  const timeline = css.slice(start, css.indexOf("}", start));
  assert.match(timeline, /overflow-y:\s*auto/);
  assert.match(timeline, /overscroll-behavior-y:\s*contain/);
  assert.match(timeline, /touch-action:\s*pan-y/);
  assert.match(timeline, /-webkit-overflow-scrolling:\s*touch/);
});

test("new timeline surfaces animate without moving the measured row", () => {
  const css = read("../src/styles.css");

  assert.match(css, /\.timeline > \.timeline-row-enter:not\(\.activity-group\) > \*/);
  assert.match(css, /animation:\s*timeline-surface-in var\(--motion-surface\) var\(--motion-ease\) both/);
  assert.doesNotMatch(css, /\.timeline > \.timeline-row-enter,\s*\n/);
});

test("idle recap remains mounted at the transcript tail with one current style contract", () => {
  const timeline = read("../src/components/Timeline.tsx");
  const strip = read("../src/components/AssistStrip.tsx");
  const css = read("../src/styles.css");

  assert.match(timeline, /import AssistStrip from "\.\/AssistStrip\.tsx"/);
  assert.match(timeline, /\{model\.workflowRun && <WorkflowTimelineCard[\s\S]*<AssistStrip \/>/);
  assert.match(strip, /assistFreshnessSeq/);
  assert.match(strip, /freshnessSeq > assist\.atSeq/);
  assert.equal(css.match(/\.assist-strip\s*\{/g)?.length, 1);
  assert.match(css, /\.assist-dismiss\s*\{[^}]*width:\s*var\(--tap\);[^}]*height:\s*var\(--tap\)/s);
});

test("startup yields to the existing live activity dock once work is canonical", () => {
  const surface = read("../src/components/workspace/builtinSurfaces.tsx");
  const composer = read("../src/components/Composer.tsx");
  const pendingChanges = read("../../../packages/git/widgets/PendingChangesBar.tsx");

  assert.match(surface, /function SessionSpawnStatus\(\{[\s\S]*spawningAgent[\s\S]*<AgentStatusDock/);
  assert.match(surface, /startingTurn[\s\S]*<AgentStatusDock/);
  assert.match(surface, /const working = model\.turn\?\.status === "working" \|\| sessionRecord\?\.status === "working"/);
  assert.match(surface, /!working && \(spawning \|\| awaitingTurn\)/,
    "startup chrome must disappear as soon as the session becomes working");

  assert.match(pendingChanges, /const working = model\.turn\?\.status === "working" \|\| sessionRecord\?\.status === "working"/);
  assert.match(pendingChanges, /const awaitingTurn = pendingSends\.length > 0 && !working/);
  const liveActivity = pendingChanges.indexOf("if (working) {");
  const hideEditedFiles = pendingChanges.indexOf("if (spawning || awaitingTurn) return null;");
  assert.ok(liveActivity >= 0 && hideEditedFiles > liveActivity,
    "live activity must replace edited files before startup suppression");
  assert.match(pendingChanges, /<AgentStatusDock[\s\S]*activeTask\?\.text[\s\S]*activeSubagent\?\.currentTask/);
  assert.match(pendingChanges, /toggleSessionStatusPopover\(event\.currentTarget\)/);

  assert.match(composer, /immediateFollowUpDelivery/);
  assert.match(composer, /beginPendingSend\(\{/);
  assert.doesNotMatch(composer, /if \(creatingSession\)\s*\{\s*return/);
  assert.match(composer, /aria-busy=\{creatingSession \|\| undefined\}/);
  assert.match(composer, /!session && !creatingSession && <SessionContextBar/);
  assert.match(composer, /visibleComposerDraft\(/);
  assert.match(composer, /hasInFlightPrompt\(getState\(\), session\?\.id \?\? null\)/);
});

test("agent status docks use compact borderless glass chrome", () => {
  const css = read("../src/styles.css");

  assert.match(css, /\.agent-status-dock\s*\{[^}]*min-height:\s*var\(--activity-row-height\);[^}]*align-items:\s*center;[^}]*padding:\s*var\(--space-2\) var\(--space-3\);[^}]*border:\s*0;[^}]*background:\s*var\(--material-glass\);[^}]*box-shadow:\s*var\(--shadow-sm\)/s);
  assert.match(css, /\.agent-status-dock\.ui-glass-dock\s*\{[^}]*var\(--material-glass-control-fill\)[^}]*var\(--material-glass-control-edge\)/s);
  assert.match(css, /\.agent-status-dock-icon\s*\{[^}]*place-items:\s*center;[^}]*width:\s*var\(--icon-xl\)/s);
  assert.doesNotMatch(css, /\.agent-status-dock-icon\s*\{[^}]*margin-block-start:/s);
  assert.match(css, /\.agent-status-dock-content\s*\{[^}]*align-content:\s*center;[^}]*gap:\s*0/s);
  assert.match(css, /\.agent-status-dock-primary\s*\{[^}]*fit-content\(72%\)[^}]*align-items:\s*baseline;[^}]*line-height:\s*1\.2/s);
  assert.match(css, /\.agent-status-dock-secondary\s*\{[^}]*line-height:\s*1\.15/s);
  assert.doesNotMatch(css, /\.agent-status-dock-primary strong \{[^}]*max-width:\s*42%/);
});

test("conversation chrome shares one horizontal frame", () => {
  const css = read("../src/styles.css");
  const frame = css.slice(css.indexOf("/* All conversation chrome shares one horizontal frame."));

  assert.match(frame, /\.focus-conversation\s*\{[^}]*--conversation-frame-inline-start:[^}]*--conversation-frame-inline-end:/s);
  assert.match(frame, /\.timeline,\s*\.composer-chat\s*\{[^}]*padding-inline-start:\s*var\(--conversation-frame-inline-start\);[^}]*padding-inline-end:\s*var\(--conversation-frame-inline-end\)/s);
  assert.match(frame, /\.agent-status-dock\s*\{[^}]*width:\s*min\([\s\S]*calc\(100% - var\(--conversation-frame-inline-start\) - var\(--conversation-frame-inline-end\)\)/s);
  assert.match(frame, /@container app-shell \(min-width: 961px\)[\s\S]*\.focus-conversation\s*\{[^}]*--conversation-frame-inline-end:/s);
  assert.match(frame, /\.app > \.header\s*\{[^}]*--conversation-frame-inline-start:/s);
  assert.match(frame, /\.desktop-session-status\s*\{[^}]*var\(--conversation-frame-inline-start\)[^}]*var\(--conversation-frame-inline-end\)/s);
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
  assert.match(css, /\.msg\.assistant > \.bubble,\s*\.msg\.assistant \.bubble\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent/s);
});

test("chat prompt type uses the same role as the assistant response", () => {
  const css = read("../src/styles.css");

  assert.match(css, /\.msg\.user \.bubble\s*\{[^}]*font-size:\s*var\(--font-response\);[^}]*line-height:\s*var\(--font-response-lh\)/s);
  assert.match(css, /\.msg\.assistant > \.bubble,\s*\.msg\.assistant \.bubble\s*\{[^}]*font-size:\s*var\(--font-response\);[^}]*line-height:\s*var\(--font-response-lh\)/s);
  assert.match(css, /\.composer-card textarea\s*\{[^}]*font-size:\s*var\(--font-response\);[^}]*line-height:\s*var\(--font-response-lh\)/s);
  assert.match(css, /\.composer-editor\s*\{[^}]*font-size:\s*var\(--font-response\);[^}]*line-height:\s*var\(--font-response-lh\)/);
  assert.doesNotMatch(css, /\.composer-simple \.composer-card textarea\s*\{[^}]*font-size:\s*14px/);
});

test("visible assistant prose uses the answer type role around activity", () => {
  const timeline = read("../src/components/Timeline.tsx");
  const css = read("../src/styles.css");

  assert.match(timeline, /function AssistantProse/);
  assert.match(timeline, /const source = m\.reasoning;/);
  assert.doesNotMatch(timeline, /m\.reasoning \|\| m\.text/);
  assert.match(timeline, /<AssistantProse key=\{`\$\{item\.id\}-text`\}/);
  assert.match(css, /\.activity-live-content \.reasoning-body\s*\{[^}]*font-size:\s*var\(--font-response\)/s);
  assert.match(css, /\.activity-group-items \.reasoning-body\s*\{[^}]*font-size:\s*var\(--font-technical\)/s);
  assert.doesNotMatch(css, /\.msg\.assistant > \.bubble \{\s*font-size:\s*calc\(15px/);
});

test("conversation code surfaces follow the configured glass material", () => {
  const css = read("../src/styles.css");

  assert.match(css, /\.msg \.bubble :is\(code, pre\),\s*\.msg \.bubble \.md-code-block\s*\{[^}]*background:\s*var\(--material-glass-medium\)/s);
  // Only the block surface takes the glass pass. An inline code span is a word
  // in a sentence: it keeps a flat tint and clones its decoration across a
  // wrap, so a per-fragment backdrop blur never bands through the prose.
  assert.match(
    css,
    /body:not\(\[data-glass="off"\]\):not\(\[data-desktop-low-resource="true"\]\) :is\([\s\S]*?\.msg \.bubble pre,\s*\.msg \.bubble \.md-code-block\s*\)[\s\S]*?backdrop-filter:\s*blur\(var\(--material-glass-blur\)\)/s,
  );
  assert.doesNotMatch(
    css,
    /body:not\(\[data-glass="off"\]\):not\(\[data-desktop-low-resource="true"\]\)[\s\S]*?\.msg \.bubble :is\(code, pre\)[\s\S]*?backdrop-filter/s,
  );
  assert.match(
    css,
    /body\[data-glass="off"\] :is\(\.msg \.bubble pre, \.msg \.bubble \.md-code-block\)\s*\{[^}]*background:\s*var\(--material-glass-medium\);[^}]*backdrop-filter:\s*none !important/s,
  );
  assert.match(css, /\.msg \.bubble :not\(pre\) > code\s*\{[^}]*font-size:\s*var\(--font-code\);[^}]*box-decoration-break:\s*clone/s);
  assert.match(
    css,
    /body:not\(\[data-glass="off"\]\):not\(\[data-desktop-low-resource="true"\]\) \.msg \.bubble \.md-code-block pre\s*\{[^}]*backdrop-filter:\s*none !important/s,
  );
  assert.match(css, /\.msg \.bubble pre code,\s*\.msg \.bubble \.md-code-block pre\s*\{[^}]*background:\s*transparent/s);
  assert.match(css, /\.msg \.bubble pre,\s*\.msg \.bubble pre code\s*\{[^}]*font-size:\s*var\(--font-code\)/s);
  assert.match(css, /\.msg\.assistant > \.bubble a\s*\{[^}]*color:\s*var\(--accent\)/s);
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

test("sent attachments sit outside the message bubble and response info dismisses on the next activation", () => {
  const timeline = read("../src/components/Timeline.tsx");
  const css = read("../src/styles.css");

  assert.match(timeline, /<\/div>\s*\{m\.attachments && m\.attachments\.length > 0 && \(\s*<AttachmentPills attachments=\{m\.attachments\} \/>/);
  assert.match(css, /\.msg\.user > \.attachment-pills\s*\{[^}]*align-self:\s*flex-end;/s);
  assert.match(timeline, /className="response-footer-metadata-trigger"[\s\S]*?<InfoIcon \/>/);
  assert.match(timeline, /document\.addEventListener\("click", dismiss, true\)/);
  assert.match(timeline, /queueMicrotask\(\(\) => setMetadataOpen\(false\)\)/);
  assert.match(timeline, /aria-expanded=\{metadataOpen\}/);
});

test("thinking, tasks, and every execution share the compact activity-card treatment", () => {
  const timeline = read("../src/components/Timeline.tsx");
  const execution = read("../src/components/ExecutionRow.tsx");
  const css = read("../src/styles.css");

  assert.match(timeline, /className=\{`reasoning\$\{entering \? " timeline-row-enter" : ""\}\$\{open \? " open" : ""\}`\}>/);
  // The thought header names the work in progress instead of a fixed "Thinking"
  // label: the first line of reasoning when there is one, otherwise run state.
  assert.match(timeline, /<strong className="reasoning-preview">\{head \|\| \(active \? tr\("timeline\.workingThroughTheRequest"\) : tr\("timeline\.activityDetail"\)\)\}<\/strong>/);
  assert.match(execution, /<div className=\{`tool-card execution-row/);
  assert.match(css, /\.reasoning,\s*\.task-list\s*\{[^}]*border:\s*0;/s);
  assert.match(css, /\.tool-card\.execution-row\s*\{[^}]*border:\s*0;/s);
  assert.match(css, /\.task-list\s*\{[^}]*margin:\s*var\(--space-1\) 0 0;/s);
  assert.match(css, /\.reasoning\s*\{[^}]*max-width:\s*100%;[^}]*min-width:\s*0;/s);
  assert.match(css, /\.reasoning-toggle\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/s);
  assert.match(css, /\.reasoning-preview\s*\{[^}]*overflow:\s*hidden;[^}]*-webkit-mask-image:\s*linear-gradient\(to right, #000 90%, transparent 100%\);/s);
  assert.match(css, /\.reasoning-main \.reasoning-preview\s*\{\s*flex:\s*1 1 auto;/);
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
  assert.match(pendingChanges, /pendingSend\?\.model/);
  assert.match(pendingChanges, /replacingTurn/);
  assert.match(pendingChanges, /toggleSessionStatusPopover\(event\.currentTarget\)/);
  assert.doesNotMatch(pendingChanges, /openWorkspacePane\("events"\)/);
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


test("idle recap assist stays mounted at the transcript tail with usable chrome", () => {
  const timeline = read("../src/components/Timeline.tsx");
  const assist = read("../src/components/AssistStrip.tsx");
  const css = read("../src/styles.css");

  assert.match(timeline, /import AssistStrip from "\.\/AssistStrip\.tsx";/);
  assert.match(timeline, /\{model\.workflowRun && <WorkflowTimelineCard run=\{model\.workflowRun\} \/>\}\s*<AssistStrip \/>/);
  assert.match(assist, /assist\.atSeq !== lastSeq/);
  assert.match(css, /\.assist-strip\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
  assert.match(css, /\.assist-chip\s*\{[^}]*min-height:\s*var\(--tap\);/s);
});


test("mobile transcript keeps native touch ownership and hidden replays release stale turn-sheet geometry", () => {
  const timeline = read("../src/components/Timeline.tsx");

  assert.match(timeline, /const touchActive = useRef\(false\)/);
  assert.match(timeline, /if \(!el \|\| touchActive\.current\) return;/);
  assert.match(timeline, /if \(!el \|\| !promptId \|\| touchActive\.current\) return;/);
  assert.match(timeline, /freshTurnPending\.current \|\| touchActive\.current/);
  assert.match(timeline, /onTouchStartCapture=\{\(event\) => \{\s*touchActive\.current = true;/);
  assert.match(timeline, /onTouchEndCapture=\{finishTouchScroll\}/);
  assert.match(timeline, /const becameHidden = !previous\.hidden && model\.lastUserMessageHidden;[\s\S]*turnSheetPromptId\.current = null;[\s\S]*setTurnSheetPadding\(0\);/);
});
