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

test("composer blur defers server sync while lifecycle flushes persist immediately", () => {
  const composer = read("../src/components/Composer.tsx");
  const persist = composer.slice(composer.indexOf("const persistComposerDraft"), composer.indexOf("const flushComposerDraft"));
  const stageStart = composer.indexOf("const stageTargetDraft");
  const send = composer.slice(stageStart, composer.indexOf("const deliver =", stageStart));

  assert.match(persist, /const changed = loadDraft\(id\) !== draft;\s*if \(changed\) saveDraft\(id, draft\);\s*if \(!localOnly && \(changed \|\| flushServerNow\)\) syncDraftToServer\(id, draft\);\s*if \(!localOnly && flushServerNow\) flushDraftToServer\(id\)/);
  assert.match(composer, /else persistComposerDraft\(false\); \/\/ save locally now; server sync follows idle time/);
  assert.match(send, /cancelDraftSync\(targetSessionId, capturedScope\)/);
});

test("the conversation keeps the complete glass dock in flow and fresh-turn space inside the timeline", () => {
  const surface = read("../src/components/workspace/builtinSurfaces.tsx");
  const css = read("../src/styles.css");

  assert.match(surface, /className="conversation-composer-dock"[\s\S]*slot="session\.composer\.before"[\s\S]*slot="session\.footer"[\s\S]*startupDock && \(\s*<SubagentBranchIsland>\s*<SessionSpawnStatus[\s\S]*<Composer \/>/);
  assert.doesNotMatch(surface, /composerDock|publishHeight|ResizeObserver/);
  assert.match(css, /\.conversation-composer-dock\s*\{[^}]*position:\s*relative;[^}]*flex:\s*none;/s);
  assert.doesNotMatch(css, /--conversation-dock-height|margin-block-end:\s*var\(--conversation-dock-height\)/);
  assert.match(css, /--timeline-pad-bottom:\s*calc\([^;]*var\(--conversation-group-gap\)[^;]*var\(--timeline-turn-sheet-space, 0px\)\)/);
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
  assert.doesNotMatch(timeline, /-webkit-overflow-scrolling/);
});

test("new timeline surfaces animate without moving the measured row", () => {
  const css = read("../src/styles.css");

  assert.match(css, /\.timeline > \.timeline-row-enter:not\(\.activity-group\) > \*/);
  assert.match(css, /animation:\s*timeline-surface-in var\(--motion-surface\) var\(--motion-ease\) both/);
  assert.doesNotMatch(css, /\.timeline > \.timeline-row-enter,\s*\n/);
});

test("startup yields to the existing live activity dock once work is canonical", () => {
  const surface = read("../src/components/workspace/builtinSurfaces.tsx");
  const composer = read("../src/components/Composer.tsx");
  const pendingChanges = read("../../../packages/git/widgets/PendingChangesBar.tsx");
  const activity = read("../src/sessionActivity.ts");

  assert.match(surface, /function SessionSpawnStatus\(\{[\s\S]*spawningAgent[\s\S]*<AgentStatusDock/);
  assert.match(surface, /startingTurn[\s\S]*<AgentStatusDock/);
  assert.match(surface, /const activity = resolveSessionActivity\(sessionRecord, model\.turn, pendingSends\)/);
  assert.match(surface, /!working && !liveDockSeen\.current && \(spawning \|\| awaitingTurn\)/,
    "startup chrome must disappear as soon as the session becomes working");

  assert.match(pendingChanges, /const activity = resolveSessionActivity\(sessionRecord, model\.turn, pendingSends\)/);
  assert.match(pendingChanges, /const working = activity\.working/);
  assert.match(pendingChanges, /const awaitingTurn = activity\.awaitingTurn/);
  const liveActivity = pendingChanges.indexOf("if (working) {");
  const hideEditedFiles = pendingChanges.indexOf("if (spawning || awaitingTurn) return null;");
  assert.ok(liveActivity >= 0 && hideEditedFiles > liveActivity,
    "live activity must replace edited files before startup suppression");
  assert.match(pendingChanges, /<AgentLiveStatusDock/);
  const liveDock = read("../src/components/AgentLiveStatusDock.tsx");
  // The action's words are shared with the subagent branch (liveAction.ts).
  const liveAction = read("../src/liveAction.ts");
  assert.match(liveDock, /liveActionOf\(model\)/);
  assert.match(liveAction, /const activeTask = model\.tasks\?\.items\.find/);
  assert.match(liveAction, /const activeSubagent = model\.subagents\?\.agents\.find/);
  assert.match(liveDock, /<AgentStatusDock/);
  assert.match(liveDock, /toggleSessionStatusPopover\(event\.currentTarget/);
  assert.match(activity, /runtimeLegId/);
  assert.match(activity, /transition\?\.phase === "released"/);
  assert.match(activity, /pendingSend\?\.model/);

  assert.match(composer, /immediateFollowUpDelivery/);
  assert.match(composer, /beginPendingSend\(\{/);
  assert.doesNotMatch(composer, /if \(creatingSession\)\s*\{\s*return/);
  assert.match(composer, /aria-busy=\{creatingSession \|\| undefined\}/);
  assert.match(composer, /!session && !creatingSession && !soloPersonal && heroChrome\.location && \(\s*<SessionContextBar/);
  assert.match(composer, /visibleComposerDraft\(/);
  assert.match(composer, /hasInFlightPrompt\(getState\(\), session\?\.id \?\? null\)/);
});

test("the agent status above the composer is a borderless line, not glass", () => {
  const css = read("../src/styles.css");
  const dock = read("../src/components/ui/AgentStatusDock.css");

  // styles.css keeps only the frame; the look belongs to the primitive.
  assert.doesNotMatch(css, /\.agent-status-dock\.ui-glass-dock/);
  assert.doesNotMatch(css, /\.agent-status-dock\s*\{[^}]*background:\s*var\(--material-glass\)/s);
  assert.match(dock, /\.agent-status-dock \{[^}]*min-height:\s*var\(--agent-status-row\);[^}]*align-items:\s*center;[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none/s);
  assert.match(dock, /\.agent-status-dock-icon \{[^}]*place-items:\s*center;[^}]*width:\s*var\(--icon-md\)/s);
  assert.match(dock, /\.agent-status-dock-content \{[^}]*display:\s*flex;[^}]*align-items:\s*baseline/s);
  // The action outranks the model name, which gives way first.
  assert.match(dock, /\.agent-status-dock-state \{[^}]*flex:\s*1 1 auto;[^}]*min-width:\s*6ch/s);
  assert.match(dock, /@media \(max-width: 600px\) \{\s*\.agent-status-dock \.agent-status-dock-secondary \{ display: none; \}/);
  assert.match(dock, /@media \(prefers-reduced-motion: reduce\) \{\s*\.agent-status-dock-state \{ animation: none;/);
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
  // A shared session names another person's prompt — who, not a role. It
  // renders only for someone else or for a judge's fixed message, never for
  // one's own prompts or the agent.
  assert.match(timeline, /const personLabel = byJudge \? \(otherName \? `\$\{otherName\} · \$\{byJudge\}` : byJudge\) : otherName;/);
  assert.match(timeline, /\{personLabel && <div className="msg-person"/);
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

test("chat prose keeps one type caliber across content types", () => {
  const css = read("../src/styles.css");
  const tokens = read("../src/tokens.css");

  // The conversation caliber defaults to 14.7px at the default chat text size
  // and stays proportional to the user's chat size through `--text-scale`, the
  // multiplier of the surface the rule renders in.
  assert.match(tokens, /--font-response:\s*calc\(14\.7px \* var\(--text-scale, 1\)\)/);
  assert.match(tokens, /--font-response-lh:\s*calc\(var\(--font-response\) \* 1\.5\)/);
  assert.match(tokens, /--font-response-heading:\s*calc\(var\(--font-response\) \+ 1px\)/);

  // An inline identifier is a word in the sentence: it must not drop to the
  // editor's `--font-code` step inside the prose caliber, or the answer reads
  // as mixed-caliber words.
  assert.match(css, /\.msg \.bubble :not\(pre\) > code,\s*:where\(\.timeline-viewport\) :not\(pre\) > code\s*\{[^}]*font-size:\s*1em;/s);
  // Block code is its own framed surface and keeps the editor-derived step.
  assert.match(css, /\.msg \.bubble pre,\s*\.msg \.bubble pre code\s*\{[^}]*font-size:\s*var\(--font-code\)/s);
  // No heading level falls below the prose caliber.
  assert.match(css, /\.bubble h4, \.bubble h5, \.bubble h6 \{ font-size: var\(--font-response\); font-weight: 600; \}/);
  assert.doesNotMatch(css, /\.bubble h4, \.bubble h5, \.bubble h6 \{ font-size: var\(--font-label\)/);
  // A table lays out prose at the answer caliber; the header recedes by color
  // and weight, not by dropping a type step.
  assert.match(css, /\.md-table \{[^}]*font-size:\s*var\(--font-response\);/s);
  assert.match(css, /\.md-table th \{[^}]*font-size:\s*var\(--font-response\);/s);
  assert.doesNotMatch(css, /calc\(var\(--font-response\) \* 0\.88\)/);
  // A thought is conversation prose too: the reasoning separator and its
  // expanded body keep the answer caliber instead of dropping to the compact
  // tool-label step, and a reasoning code block reuses the same framed code
  // surface as an answer code block.
  for (const rule of css.match(/[^{}]*reasoning[^{}]*\{[^}]*\}/g) ?? []) {
    assert.doesNotMatch(rule, /font-tool-label/, `reasoning must keep the answer caliber: ${rule.trim()}`);
  }
  assert.match(css, /\.reasoning-preview\s*\{[^}]*font:\s*400 var\(--font-response\) \/ var\(--font-response-lh\)/s);
  assert.match(css, /\.reasoning-body pre \{[^}]*font-size:\s*var\(--font-code\)/);
});

test("visible assistant prose uses the answer type role around activity", () => {
  const timeline = read("../src/components/Timeline.tsx");
  const css = read("../src/styles.css");

  assert.match(timeline, /function AssistantProse/);
  assert.match(timeline, /const reasoning = m\.reasoning;/);
  assert.doesNotMatch(timeline, /m\.reasoning \|\| m\.text/);
  assert.match(timeline, /<AssistantProse key=\{`\$\{item\.id\}-text`\}/);
  assert.match(css, /\.activity-group-items \.reasoning-body\s*\{[^}]*font:\s*400 var\(--font-response\) \/ var\(--font-response-lh\)/s);
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
  // Package cards in the transcript column (callouts, recaps) share the same
  // translucent chip instead of the opaque global `code` fill.
  assert.match(css, /\.msg \.bubble :not\(pre\) > code,\s*:where\(\.timeline-viewport\) :not\(pre\) > code\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--text\) 8%, transparent\);[^}]*font-size:\s*1em;[^}]*box-decoration-break:\s*clone/s);
  assert.match(
    css,
    /body:not\(\[data-glass="off"\]\):not\(\[data-desktop-low-resource="true"\]\) \.msg \.bubble \.md-code-block pre\s*\{[^}]*backdrop-filter:\s*none !important/s,
  );
  assert.match(css, /\.msg \.bubble pre code,\s*\.msg \.bubble \.md-code-block pre\s*\{[^}]*background:\s*transparent/s);
  assert.match(css, /\.msg \.bubble pre,\s*\.msg \.bubble pre code\s*\{[^}]*font-size:\s*var\(--font-code\)/s);
  assert.match(css, /\.msg\.assistant > \.bubble a\s*\{[^}]*color:\s*var\(--accent\)/s);
});

test("composer command suggestions stay compact and readable with backdrop blur", () => {
  const css = read("../src/styles.css");
  const popupStart = css.indexOf(".ac-popup {");
  assert.ok(popupStart >= 0);
  const popup = css.slice(popupStart, css.indexOf("}", popupStart));

  assert.match(popup, /inline-size:\s*min\(100%, 36rem\)/);
  assert.match(popup, /max-height:\s*min\(calc\(var\(--control-h-sm\) \* 8\)/);
  assert.match(popup, /background:\s*var\(--material-glass-strong\)/);
  assert.match(popup, /overflow:\s*hidden/);
  assert.match(popup, /box-sizing:\s*border-box/);
  assert.match(popup, /isolation:\s*isolate/);
  assert.match(popup, /color:\s*var\(--text\)/);
  assert.match(css, /\.ac-header\s*\{[^}]*color:\s*var\(--text-dim\)/s);
  assert.match(css, /\.ac-detail\s*\{[^}]*color:\s*var\(--text-dim\)/s);
  assert.match(css, /\.ac-item\s*\{[^}]*min-height:\s*max\(var\(--control-h-sm\), var\(--hit-min\)\)/s);
  assert.match(css, /\.ac-copy\s*\{[^}]*display:\s*flex/s);
  assert.match(css, /\.ac-popup::after\s*\{[^}]*inset-block-end:\s*0[^}]*pointer-events:\s*none[^}]*backdrop-filter:\s*blur\(var\(--space-2\)\)/s);
  assert.match(css, /\.ac-popup > \*\s*\{[^}]*position:\s*relative[^}]*z-index:\s*1/s);
  assert.match(
    css,
    /body:not\(\[data-glass="off"\]\):not\(\[data-desktop-low-resource="true"\]\) \.ac-popup\s*\{[^}]*background:\s*radial-gradient\([^}]*color-mix\(in srgb, var\(--material-glass-strong\) 98%, transparent\)[^}]*backdrop-filter:\s*blur\(var\(--material-glass-blur\)\) saturate\(var\(--material-glass-saturation\)\) !important/s,
  );
  assert.match(
    css,
    /body\[data-glass="off"\] :is\([\s\S]*?\.ac-popup[\s\S]*?background:\s*var\(--sidebar-glass-surface, var\(--material-glass\)\)[\s\S]*?backdrop-filter:\s*none !important/s,
  );
  assert.match(
    css,
    /body\[data-glass="off"\] \.ac-popup::after\s*,[\s\S]*?backdrop-filter:\s*none !important/s,
  );
  assert.doesNotMatch(
    css,
    /body:has\(\.composer-card \.model-picker-trigger\[aria-expanded="true"\]\) \.model-pop/,
  );
  assert.match(
    css,
    /\.composer-card :is\(\.ui-popover, \.picker-pop\)\s*\{[^}]*backdrop-filter:\s*none/s,
  );
});

test("message actions use one lightweight copy control and local hover zones", () => {
  const timeline = read("../src/components/Timeline.tsx");
  const footer = read("../src/components/ChatResponseFooter.tsx");
  const bar = read("../src/components/MessageActionBar.tsx");
  const css = read("../src/components/ChatChrome.css");

  // Answer actions render through the shared action bar in the response
  // footer; the timeline no longer carries its own hover strip.
  assert.doesNotMatch(timeline, /className="msg-action-btn"/);
  assert.match(timeline, /<ChatResponseFooter/);
  assert.match(footer, /action\("copy", tr\("timeline\.copyAnswer"\)/);
  assert.doesNotMatch(footer, /action\("md"|action\("json"/);
  assert.match(footer, /action\("regenerate", tr\("timeline\.regenerateThisAssistantAnswer"\)/);
  assert.match(footer, /action\("image", tr\("timeline\.saveAsImage"\)/);
  assert.match(footer, /action\("session", tr\("timeline\.startNewSessionFromThisAnswer"\)/);
  // Multi-run and Save-as-plan are package contributions now, not built-ins.
  assert.doesNotMatch(footer, /startMultiRunFromText|timeline\.startNewMultiRunFromThisAnswer|timeline\.saveAsPlan/);
  // Configured response actions drive the bar; the rest folds into overflow.
  assert.match(footer, /<MessageActionBar[\s\S]*?layout=\{prefs\.assistantMessageActions\}[\s\S]*?hidden=\{!prefs\.showAnswerQuickActions\}/);
  assert.match(bar, /className=\{\["chat-action-bar", className \?\? ""\]/);
  assert.match(bar, /resolved\.bar\.map/);
  assert.match(bar, /className="chat-action-menu"/);
  assert.match(bar, /icon=\{menuConfirmed \? CheckIcon : MoreIcon\}/);
  assert.match(css, /\.chat-action-bar\s*\{[^}]*display:\s*flex;[^}]*gap:\s*var\(--space-2\);/s);
});

test("assistant identity panel renders once per turn, after the turn completes", () => {
  const timeline = read("../src/components/Timeline.tsx");
  const footer = read("../src/components/ChatResponseFooter.tsx");
  const chrome = read("../src/components/ChatChrome.css");
  const css = read("../src/styles.css");
  // While a turn is in progress (working, waiting on a request, or a sent
  // prompt not yet admitted) no answer shows its metadata. The terminal answer
  // of the live turn mounts its panel only after the turn completes; answers
  // already closed by a later prompt keep the panel's box but render it
  // dormant, so the transcript above the live turn never reflows.
  assert.match(timeline, /const sessionActive = sessionStatus === "working" \|\| sessionStatus === "waiting" \|\| pendingSends\.length > 0;/);
  assert.match(timeline, /terminal=\{r\.kind === "assistant" && terminalAnswers\.terminal\.has\(r\.eventSeq\)\s*&& \(!turnInProgress \|\| pendingSends\.length > 0 \|\| r\.eventSeq !== terminalAnswers\.trailing\)\}\s*dormant=\{turnInProgress\}/);
  assert.match(timeline, /if \(lastAssistant !== null\) terminal\.set\(lastAssistant\.eventSeq, openAt\);/);
  // Interim answers keep quick actions (no identity panel). In a live turn an
  // interim answer takes its dormant footer's box as soon as a row lands under
  // it, so the turn's end only reveals footers and moves no row below them.
  assert.match(timeline, /settled=\{r\.kind === "assistant"\s*&& \(!turnInProgress \|\| pendingSends\.length > 0 \|\| r\.eventSeq < terminalAnswers\.openSeq\s*\|\| r\.id !== latestRowId\)\}/);
  assert.match(timeline, /\{m\.finalized && hasAnswer && \(terminal \|\| settled\) && \(/);
  assert.match(footer, /data-actions-only=\{identity \? undefined : "true"\}/);
  assert.match(footer, /data-dormant=\{dormant \|\| undefined\}/);
  assert.match(chrome, /\.chat-response-footer\[data-dormant\] \{ visibility: hidden; \}/);
  assert.match(chrome, /\.chat-response-footer\[data-actions-only\]:has\(\.chat-action-bar\[data-reveal="hover"\]\)\s*\{\s*margin-block-start:\s*0;\s*height:\s*0;\s*\}/);
  assert.match(css, /\.timeline\s*>\s*\.msg\.assistant\s*\+\s*\.activity-group/);
  // Touch shows no actions-only footer (it doubled the activity gaps); the
  // final answer keeps its own. With a mouse, over a block the footer is the
  // group gap itself, not a blank band on top of it; a hover-collapsed one
  // keeps none.
  assert.match(chrome, /@media \(hover: none\), \(pointer: coarse\) \{\s*\.chat-response-footer\[data-actions-only\] \{ display: none; \}/);
  assert.match(chrome, /\.timeline > \.msg\.assistant\.progress-update > \.chat-response-footer\[data-actions-only\] \{\s*margin-block: 0 calc\(-1 \* var\(--conversation-group-gap\)\);\s*\}/);
  assert.match(chrome, /\.progress-update > \.chat-response-footer\[data-actions-only\]:has\(\.chat-action-bar\[data-reveal="hover"\]\) \{\s*margin-block-end: 0;\s*\}/);
  // A thought keeps prose's ink gap: offsets from the timeline gap (not the
  // desktop message gap, which squeezed it to 4px on phones), less its pad.
  assert.match(css, /\.timeline > \.msg\.assistant\.reasoning-row \{\s*--reasoning-head-pad: var\(--space-1\);\s*margin-block:\s*calc\(var\(--conversation-group-gap\) - var\(--timeline-gap\) - var\(--reasoning-head-pad\)\)\s*calc\(-1 \* var\(--reasoning-head-pad\)\);/);
  // Touch rows keep a 44px hit box but lay out as 36px: the block trims the
  // gaps around it, and consecutive blocks' hit boxes meet without overlap.
  assert.match(css, /--activity-row-trim: max\(0px, calc\(\(var\(--hit-min\) - 36px\) \/ 2\)\);/);
  assert.match(css, /\.timeline > \.msg\.activity-group \{ margin-block-end: calc\(-1 \* var\(--activity-row-trim\)\); \}/);
  assert.match(css, /\.timeline > \.msg\.activity-group \+ \.msg\.activity-group \{\s*margin-block-start: calc\(max\(var\(--space-1\), 2 \* var\(--activity-row-trim\)\) - var\(--timeline-gap\) - var\(--activity-row-trim\)\);/);
  const progress = read("../src/components/ConversationProgress.css");
  // A progress update only quiets its ink: new type metrics would reflow the
  // lines right above the block that just arrived under it.
  // Timeline marks it (`progress-update`): a sibling :has() re-matched on
  // every row insertion and could restyle late on older touch WebKit.
  assert.match(timeline, /progress=\{r\.kind === "assistant" && nextRowIsActivity\(chronologicalRows, index\)\}/);
  assert.doesNotMatch(progress, /:has\(\+/);
  const progressRule = /\.timeline\s*>\s*\.msg\.assistant\.progress-update\s*>\s*\.bubble\s*\{([^}]*)\}/.exec(progress)?.[1] ?? "";
  assert.match(progressRule, /color:\s*var\(--text-dim\);/);
  assert.doesNotMatch(progressRule, /font-size|line-height/);
  assert.doesNotMatch(timeline, /preliminary|assistant-preliminary|agent-reply-header-preliminary/);
});

test("answer footers expose the configured copy action", () => {
  const footer = read("../src/components/ChatResponseFooter.tsx");
  assert.match(footer, /action\("copy", tr\("timeline\.copyAnswer"\), \(\) => \{[\s\S]*?copyText\(m\.text\)/);
  assert.match(footer, /className="chat-response-actions"/);
});

test("sent attachments sit outside the message bubble and response info dismisses on the next activation", () => {
  const timeline = read("../src/components/Timeline.tsx");
  const footer = read("../src/components/ChatResponseFooter.tsx");
  const css = read("../src/styles.css");

  assert.match(timeline, /<\/div>\s*\{m\.attachments && m\.attachments\.length > 0 && \(\s*<AttachmentPills attachments=\{m\.attachments\} \/>/);
  assert.match(css, /\.msg\.user > \.attachment-pills\s*\{[^}]*align-self:\s*flex-end;/s);
  assert.match(footer, /action\("info", tr\("timeline\.showResponseMetadata"\)[\s\S]*?expanded: metadataOpen/);
  assert.match(footer, /<Popover[\s\S]*?open=\{metadataOpen\}[\s\S]*?onClose=\{\(\) => setMetadataOpen\(false\)\}/);
});

test("thinking uses a compact one-or-two-line separator, while tools keep the activity-card treatment", () => {
  const timeline = read("../src/components/Timeline.tsx");
  const execution = read("../src/components/ExecutionRow.tsx");
  const css = read("../src/styles.css");

  assert.match(timeline, /className=\{`reasoning\$\{entering \? " timeline-row-enter" : ""\}\$\{open \? " open" : ""\}`\}>/);
  assert.doesNotMatch(timeline, /reasoning-fade/);
  assert.match(timeline, /<span className="reasoning-preview">/);
  assert.match(timeline, /const displayMode = inActivity && prefs\.thinkingDisplayMode === "activity"/);
  assert.match(timeline, /if \(displayMode === "activity" && !inActivity\) return null;/);
  assert.match(timeline, /const expandable = reasoningContinuation\(reasoning\) !== "" \|\| fullPreview\.length > 240;/);
  assert.match(timeline, /reasoningPreview\(reasoning, active, expandable \? 180 : 0\)/);
  // Opened, the whole thought replaces the preview from its first word.
  assert.match(timeline, /\{!open && \(\s*<span className="reasoning-main">/);
  assert.match(timeline, /renderMarkdown\(reasoning, `\$\{m\.id\}-reasoning`/);
  assert.match(timeline, /if \(!expandable\) \{/);
  assert.match(timeline, /deriveRows\.current\(model, prefs\.thinkingDisplayMode, prefs\.actionGrouping,/);
  const derivation = read("../src/timelineDerivation.ts");
  assert.match(derivation, /groupActivity\(mergeThinking\(prefixMessages\), mode, grouping\)/);
  assert.match(derivation, /groupActivity\(mergeThinking\(tail\), mode, grouping\)/);
  assert.match(timeline, /const thinkingInActivity = prefs\.thinkingDisplayMode === "activity";/);
  assert.match(execution, /<div className=\{`tool-card execution-row/);
  assert.match(css, /\.reasoning,\s*\.task-list\s*\{[^}]*border:\s*0;/s);
  assert.match(css, /\.tool-card\.execution-row\s*\{[^}]*border:\s*0;/s);
  assert.match(css, /\.task-list\s*\{[^}]*margin:\s*var\(--space-1\) 0 0;/s);
  assert.match(css, /\.reasoning\s*\{[^}]*max-width:\s*100%;[^}]*min-width:\s*0;/s);
  assert.match(css, /\.reasoning-toggle\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/s);
  assert.match(css, /\.reasoning-preview\s*\{[^}]*color:\s*var\(--text-dim\);[^}]*-webkit-line-clamp:\s*2;/s);
  assert.doesNotMatch(css, /\.reasoning-fade/);
  assert.match(css, /\.reasoning-toggle\s*\{[^}]*min-height:\s*calc\(var\(--font-response-lh\) \+ 2 \* var\(--reasoning-head-pad\)\);/s);
  assert.match(css, /\.reasoning-main\s*\{[^}]*min-height:\s*var\(--font-response-lh\);[^}]*max-height:\s*calc\(2 \* var\(--font-response-lh\)\);/s);
  assert.match(css, /\.reasoning-preview\s*\{[^}]*font:\s*400 var\(--font-response\) \/ var\(--font-response-lh\)/s);
  assert.match(css, /\.reasoning-body\s*\{[^}]*padding:\s*0;[^}]*font:\s*400 var\(--font-response\) \/ var\(--font-response-lh\)/s);
  assert.match(css, /\.reasoning-static-header\s*\{[^}]*min-height:\s*calc\(var\(--font-response-lh\) \+ 2 \* var\(--space-1\)\);/s);
  assert.match(css, /\.reasoning-static \.reasoning-preview\s*\{[^}]*-webkit-line-clamp:\s*unset;[^}]*mask-image:\s*none;/s);
  assert.match(css, /\.reasoning\s*\{[^}]*--reasoning-head-pad:\s*var\(--space-1\);/s);
  assert.match(css, /\.reasoning-toggle\s*\{[^}]*padding:\s*var\(--reasoning-head-pad\) 0;/s);
  assert.doesNotMatch(css, /\.reasoning\.open \.reasoning-main\s*\{/);
  assert.match(css, /\.reasoning-expand-shell\s*\{[^}]*grid-template-rows:\s*0fr;/s);
  assert.match(css, /\.reasoning\.open > \.reasoning-expand-shell\s*\{[^}]*grid-template-rows:\s*1fr;/s);
  // The head is already on screen when the thought opens: nothing slides or
  // fades in, the row grows from the folded header's height, and the body's
  // first line starts at the header's inset beside the chevron.
  assert.doesNotMatch(css, /reasoning-content-in/);
  assert.match(css, /\.reasoning\.open > \.reasoning-toggle\s*\{[^}]*position:\s*absolute;/s);
  assert.match(css, /\.reasoning\.open > \.reasoning-expand-shell > \.reasoning-collapse-content\s*\{[^}]*min-height:\s*calc\(2 \* var\(--font-response-lh\) \+ 2 \* var\(--reasoning-head-pad\)\);/s);
  assert.match(css, /\.reasoning-collapse-content > \.reasoning-content\s*\{[^}]*padding-block-start:\s*var\(--reasoning-head-pad\);[^}]*padding-inline-end:\s*calc\(var\(--icon-sm\) \+ var\(--space-2\)\);/s);
});

test("chat settings expose grouped actions and constrained thinking modes", () => {
  const settings = read("../src/components/settings/pages.tsx");
  const prefs = read("../src/uiPrefs.ts");

  assert.match(settings, /itemId="chat\.actionBlocks"/);
  assert.ok(settings.indexOf('itemId="chat.actionBlocks"') < settings.indexOf('itemId="chat.thinking"'),
    "action grouping stays before its thinking-mode constraint");
  assert.match(settings, /\["grouped", tr\("settings\.pages\.groupedActions"\)\]/);
  assert.match(settings, /\["ungrouped", tr\("settings\.pages\.ungroupedActions"\)\]/);
  assert.match(settings, /itemId="chat\.thinking"/);
  assert.match(settings, /\["collapsed", tr\("settings\.pages\.collapsibleThinking"\)\]/);
  assert.match(settings, /\["expanded", tr\("settings\.pages\.expandedThinking"\)\]/);
  assert.match(settings, /ui\.actionGrouping === "grouped"\s*\?\s*\[\["activity", tr\("settings\.pages\.hideThinkingInActivity"\)\]\s*as/);
  assert.match(prefs, /actionGrouping: "grouped"/);
  assert.match(prefs, /thinkingDisplayMode: "collapsed"/);
  assert.match(prefs, /parseThinkingDisplayMode/);
  assert.match(prefs, /legacyThinking/);
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
  const liveDock = read("../src/components/AgentLiveStatusDock.tsx");
  const liveAction = read("../src/liveAction.ts");
  assert.match(pendingChanges, /<AgentLiveStatusDock/);
  assert.match(liveAction, /const activeTask = model\.tasks\?\.items\.find/);
  assert.match(liveAction, /activeTask\?\.text/);
  assert.match(liveDock, /activity\.model/);
  assert.match(liveDock, /replacingTurn/);
  assert.match(liveDock, /toggleSessionStatusPopover\(event\.currentTarget/);
  for (const source of [pendingChanges, liveDock]) assert.doesNotMatch(source, /openWorkspacePane\("events"\)/);
});

test("todowrite details use the same task presentation instead of raw input", () => {
  const execution = read("../src/components/ExecutionRow.tsx");
  const css = read("../src/styles.css");
  // Native todo tools and `polyth_todo` share one normalizer and one checklist.
  assert.match(execution, /const todoItems = useMemo\(\(\) => nativeTodoItems\(message\.tool, message\.input\)/);
  assert.match(execution, /todoItems && todoItems\.length > 0 \? <TodoChecklist items=\{todoItems\} \/>/);
  assert.match(css, /\.execution-todo-list li\.active\s*\{[^}]*background:[^;]*var\(--accent-wash\)/s);
});

test("a live thought displays received text without a reveal backlog or opening itself", () => {
  const timeline = read("../src/components/Timeline.tsx");

  // The latest assistant row of a working turn owns the live presentation.
  assert.match(timeline, /live=\{r\.kind === "assistant" && turnWorking && r\.id === latestAssistantId\}/);
  // Transport/store batching controls publication. Rendering must not add an
  // independent character queue or retain completed strings across sessions.
  assert.match(timeline, /const reasoning = m\.reasoning;/);
  assert.doesNotMatch(timeline, /useSmoothText|reasoningSeen|revealedReasoning|STREAM_RENDER_INTERVAL/);
  assert.match(timeline, /const preview = reasoningPreview\(reasoning, active, expandable \? 180 : 0\);/);
  assert.match(timeline, /const \[open, setOpenState\] = useState\(\(\) => openThoughts\.has\(openKey\)\);/);
  assert.doesNotMatch(timeline, /useState\(active \|\| prefs\.thinkingDefaultExpanded\)/);
  assert.doesNotMatch(timeline, /setOpen\(true\);\n    \} else if \(!userToggled/);
});


test("mobile transcript keeps native touch ownership and hidden replays release stale turn-sheet geometry", () => {
  const timeline = read("../src/components/Timeline.tsx");

  assert.match(timeline, /const touchActive = useRef\(false\)/);
  assert.match(timeline, /if \(!el \|\| touchActive\.current \|\| readerDetached\.current\) return;/);
  assert.match(timeline, /freshTurnPending\.current \|\| touchActive\.current/);
  assert.match(timeline, /onTouchStartCapture=\{\(event\) => \{\s*touchActive\.current = true;/);
  assert.match(timeline, /onTouchEndCapture=\{\(event\) => \{ if \(event\.touches\.length === 0\) finishTouchScroll\(\); \}\}/);
  assert.match(timeline, /const becameHidden = !previous\.hidden && model\.lastUserMessageHidden;[\s\S]*turnSheetPromptId\.current = null;[\s\S]*setTurnSheetPadding\(0\);/);
});


test("timeline vertical runway is represented by flex spacers instead of scroll-root block padding", () => {
  const css = read("../src/styles.css");

  assert.match(css, /\.timeline::before,\s*\n\.timeline::after\s*\{[^}]*content:\s*"";[^}]*flex:\s*none;/s);
  assert.match(css, /\.timeline::before\s*\{[^}]*flex-basis:\s*var\(--timeline-pad-top\)/s);
  assert.match(css, /\.timeline::after\s*\{[^}]*flex-basis:\s*var\(--timeline-pad-bottom\)/s);
  assert.match(css, /--timeline-pad-bottom:\s*calc\(var\(--conversation-message-gap\) \+ var\(--conversation-group-gap\) \+ var\(--timeline-turn-sheet-space, 0px\)\)/);

  const rules = [...css.matchAll(/([^{}]*\.timeline(?![-\\w])[^{}]*)\{([^{}]*)\}/g)];
  assert.ok(rules.length > 0);
  for (const [, selector, body] of rules) {
    assert.doesNotMatch(String(body), /(?:^|;)\s*padding-(?:block|top|bottom)\s*:/, String(selector));
    assert.doesNotMatch(String(body), /(?:^|;)\s*padding\s*:/, String(selector));
  }
});


test("queued message rows follow the composer's material, type and corner roles", () => {
  const css = read("../src/styles.css");

  const chipStart = css.indexOf(".queue-chip {");
  const chip = css.slice(chipStart, css.indexOf("}", chipStart));
  assert.match(chip, /background:\s*var\(--material-glass-strong\)/);
  assert.match(chip, /border:\s*1px solid var\(--material-glass-border\)/);
  assert.match(chip, /border-radius:\s*var\(--radius-composer\)/);

  const textStart = css.indexOf(".queue-chip .queue-text {");
  const text = css.slice(textStart, css.indexOf("}", textStart));
  assert.match(text, /font-size:\s*var\(--font-response\)/);
  assert.match(text, /line-height:\s*var\(--font-response-lh\)/);

  // The opaque material above is the fallback; the live glass pass is guarded
  // so transparency, low-resource and reduced-motion settings stay readable.
  assert.match(
    css,
    /@supports \(\(-webkit-backdrop-filter: blur\(1px\)\) or \(backdrop-filter: blur\(1px\)\)\)[\s\S]*?body:not\(\[data-glass="off"\]\):not\(\[data-desktop-low-resource="true"\]\)[\s\S]*?\.queue-chip:not\(\.drag-over\)[\s\S]*?backdrop-filter:\s*blur\(var\(--material-glass-blur\)\)/,
  );
});
