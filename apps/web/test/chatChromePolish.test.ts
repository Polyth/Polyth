import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("visible chat actions use direct canonical controls", () => {
  const timeline = read("../src/components/Timeline.tsx");
  const actionButton = read("../src/components/ChatActionButton.tsx");
  const messageActions = read("../src/components/MessageQuickActions.tsx");
  const responseFooter = read("../src/components/ChatResponseFooter.tsx");
  const actionBar = read("../src/components/MessageActionBar.tsx");
  const styles = read("../src/styles.css");
  const rewindStyles = read("../src/components/RewindMarker.css");

  assert.match(timeline, /<RewindMarker/);
  assert.match(timeline, /suppressRewindMarker/);
  assert.doesNotMatch(timeline, /rewound-tail|revertedTimeline|undoneRows/);
  assert.doesNotMatch(timeline, /statusText|statusFor|liveAnchor/);
  assert.match(timeline, /className="msg-live sr-only"/);
  assert.match(actionButton, /size="sm"/);
  assert.match(actionButton, /IconButton/);
  assert.match(actionButton, /Tooltip/);
  assert.match(actionButton, /import "\.\/ChatChrome\.css"/);
  // Both roles render the one shared bar; its More menu is the only overflow
  // surface and exists only when the configured layout places actions there.
  assert.match(messageActions, /className="chat-message-actions"/);
  assert.match(messageActions, /"data-actions-seq": message\.eventSeq/);
  assert.match(messageActions, /<MessageActionBar[\s\S]*layout=\{prefs\.userMessageActions\}/);
  assert.doesNotMatch(messageActions, /Icon\.more|<Menu\b|actions-popup/);
  assert.match(responseFooter, /className="chat-response-actions"/);
  assert.match(responseFooter, /<MessageActionBar[\s\S]*layout=\{prefs\.assistantMessageActions\}/);
  assert.doesNotMatch(responseFooter, /overflowActions|response-footer-more|<Menu/);
  assert.match(actionBar, /<ChatActionButton/);
  assert.match(actionBar, /menuEntries\.length > 0 && \(\s*<Menu/);
  // Pin is a configurable action on both roles, not a slot button beside them.
  assert.match(messageActions, /id: "pin"/);
  assert.match(responseFooter, /"pin"/);
  assert.equal(timeline.includes("messagePinAction"), false);
  assert.doesNotMatch(styles, /prompt-in-flight|msg-meta-pending::before/,
    "an optimistic prompt must not pulse or guess extra metadata height");
  assert.doesNotMatch(rewindStyles, /rewind-flight|rewind-arrival|data-state="leaving"/,
    "rewind uses one layout transition, not a ghost flight or composer decoration");
});

test("chat chrome does not expose a header overflow pin menu", () => {
  const header = read("../src/components/Header.tsx");
  const mobileHeader = read("../src/components/mobile/MobileSessionHeader.tsx");
  const prefs = read("../src/uiPrefs.ts");
  const timeline = read("../src/components/Timeline.tsx");
  const css = read("../src/styles.css");

  assert.doesNotMatch(header, /ChatMenu/);
  assert.doesNotMatch(mobileHeader, /ChatMenu|mobile-chat-menu/);
  assert.doesNotMatch(prefs, /pinLatestUserMessage/);
  assert.doesNotMatch(timeline, /latest-user-pinned|pinLatestUserMessage/);
  assert.doesNotMatch(css, /header-chat-menu|mobile-chat-menu|latest-user-pinned/);
  assert.match(css, /\.focus-conversation:has\(> \.conversation-composer-dock\) \.timeline\s*\{[\s\S]*?padding-bottom:\s*calc\(var\(--conversation-message-gap\) \+ var\(--conversation-group-gap\)/);
});

test("prompt bookmark opens bounded conversation history using the desktop prompt styles", () => {
  const settings = read("../src/components/settings/pages.tsx");
  const prefs = read("../src/uiPrefs.ts");
  const timeline = read("../src/components/Timeline.tsx");
  const bookmark = read("../src/components/PromptBookmark.tsx");
  const css = read("../src/styles.css");

  assert.match(prefs, /pinLatestPrompt:\s*false/);
  assert.match(prefs, /pinLatestPrompt:\s*data\.pinLatestPrompt === true/);
  assert.match(settings, /itemId="chat\.pinLatestPrompt"/);
  assert.match(settings, /setUiSettings\(\{ pinLatestPrompt \}\)/);
  assert.match(prefs, /promptBookmarkDesktop:\s*data\.promptBookmarkDesktop === true/);
  assert.match(settings, /itemId="chat\.promptBookmarkDesktop"/);
  assert.match(settings, /itemId="chat\.promptNavigator"/);
  assert.match(settings, /setUiSettings\(\{ promptNavigator: on \? "auto" : "off" \}\)/);
  assert.match(timeline, /const showBookmark = prefs\.pinLatestPrompt \|\| prefs\.promptBookmarkDesktop;/);
  assert.match(timeline, /showBookmark && sessionId && \(latestPrompt \|\| canLoadOlder\)/);
  assert.match(timeline, /narrow=\{prefs\.pinLatestPrompt\}\s*wide=\{prefs\.promptBookmarkDesktop\}/);
  assert.match(bookmark, /data-narrow=\{narrow \? undefined : "off"\}/);
  assert.match(bookmark, /data-wide=\{wide \? undefined : "off"\}/);
  assert.match(timeline, /<PromptBookmark/);
  assert.match(timeline, /const visibleArea = timelineVisibleArea\(el\)/);
  assert.match(timeline, /row\.bottom > visibleArea\.top && row\.top < visibleArea\.bottom/);
  assert.match(timeline, /bookmarkJumpGeneration/);
  assert.match(timeline, /loadOlder\(\)/);
  assert.match(timeline, /behavior: opts\?\.smooth === true/);
  assert.match(timeline, /jumpRef\.current\?\.\(bookmarkJumpId, \{ smooth: true, focus: true \}\)/);
  assert.match(bookmark, /aria-expanded=\{open\}/);
  assert.match(bookmark, /<Popover/);
  assert.match(bookmark, /await onJump\(target\)/);
  assert.match(bookmark, /aria-busy=\{jumping === target\.id/);
  assert.doesNotMatch(timeline, /latest-prompt-pinned|pinned=\{prefs\.pinLatestPrompt/);
  assert.doesNotMatch(css, /latest-prompt-pinned/);
  assert.match(css, /\.prompt-bookmark\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?inset-block-start:[\s\S]*?inset-inline-end:\s*0;/);
  assert.match(bookmark, /className="prompt-nav-panel prompt-bookmark-peek"/);
  assert.match(css, /\.ui-popover\.prompt-bookmark-peek\s*\{[\s\S]*?position:\s*fixed/);
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*?\.prompt-bookmark-toggle\s*\{[^}]*min-inline-size:\s*var\(--tap\)/s);
  assert.match(bookmark, /prompts\.slice\(start, end\)/);
});

test("generic Menu contains no response-footer special case", () => {
  const menu = read("../src/components/ui/Menu.tsx");
  assert.doesNotMatch(menu, /response-footer|RESPONSE_QUICK_ICON|isResponseFooterOverflowTrigger|ChatIcon/);
});

test("chat chrome is component-owned, compact and readable", () => {
  const css = read("../src/components/ChatChrome.css");
  const footer = read("../src/components/ChatResponseFooter.tsx");
  const messageActions = read("../src/components/MessageQuickActions.tsx");
  assert.match(css, /\.chat-response-footer\s*\{[^}]*display:\s*flex;/s);
  assert.match(css, /\.chat-action-bar\s*\{[^}]*display:\s*flex;[^}]*gap:\s*var\(--space-2\)/s);
  assert.match(footer, /action\("info", tr\("timeline\.showResponseMetadata"\)/);
  assert.doesNotMatch(css, /grid-template-areas:\s*"identity info actions"/);
  assert.doesNotMatch(css, /chat-response-action-item/);
  assert.doesNotMatch(footer, /chat-response-action-item/);
  assert.match(css, /@media \(hover:\s*none\), \(pointer:\s*coarse\)[\s\S]*\.ui-tooltip\.chat-action-tooltip\s*\{\s*display:\s*none;/s);
  assert.doesNotMatch(css, /\.chat-action-status\s*\{/);
  assert.doesNotMatch(messageActions, /statusText|chat-action-status/);
  assert.doesNotMatch(footer, /statusText|chat-action-status/);
  // Confirmation is owned by the shared bar, so both roles acknowledge alike.
  const actionBar = read("../src/components/MessageActionBar.tsx");
  assert.match(footer, /useActionConfirmation\(\)/);
  assert.match(messageActions, /useActionConfirmation\(\)/);
  assert.match(actionBar, /CheckIcon/);
  assert.match(actionBar, /chat-action-button--confirmed/);
  assert.match(css, /\.chat-action-button\.ui-icon-btn\.chat-action-button--confirmed[\s\S]*?color:\s*var\(--green\)/s);
  assert.match(css, /@keyframes chat-action-check-pop/);
  assert.match(css, /\.ui-tooltip\.chat-action-tooltip\s*\{[^}]*background:\s*var\(--elevated\);/s);
  assert.match(footer, /<Popover/);
  assert.doesNotMatch(css, /!important/);
});

test("chat, context and agent activity share human model presentation", () => {
  const footer = read("../src/components/ChatResponseFooter.tsx");
  const execution = read("../src/components/ExecutionRow.tsx");
  const contextRail = read("../src/components/railSurfaces.tsx");
  const statusDock = read("../src/components/ui/AgentStatusDock.tsx");
  const statusCss = read("../src/components/ui/AgentStatusDock.css");
  assert.match(footer, /resolveModelPresentation\(modelRef, models, harnessId\)/);
  assert.match(execution, /resolveModelPresentation\(model, models, harnessId\)\.name/);
  assert.match(contextRail, /resolveModelPresentation\(activeModel, models, session\.resolvedHarnessId\)/);
  assert.doesNotMatch(contextRail, /session\.model\.providerID\}\/\$\{session\.model\.modelID/);
  assert.doesNotMatch(execution, /model \? `\$\{model\.providerID\}\/\$\{model\.modelID\}`/);
  assert.match(statusDock, /import "\.\/AgentStatusDock\.css"/);
  assert.match(statusDock, /hasSecondary \? "agent-status-dock--stacked"/);
  // The status is a line of text: no glass, plate or shadow in any look.
  assert.doesNotMatch(statusDock, /ui-glass-dock/);
  assert.match(statusCss, /\.agent-status-dock \{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none/s);
  assert.match(statusCss, /\.agent-status-dock-primary strong \{[^}]*max-width:\s*45%/s);
  assert.match(statusCss, /\.agent-status-dock-primary \{[^}]*line-height:\s*1\.2/s);
  assert.match(statusCss, /\.agent-status-dock-secondary \{[^}]*line-height:\s*1\.2/s);
  assert.match(statusCss, /body\[data-composer-status-style="tab"\] \.agent-status-dock \{/);
  assert.match(statusCss, /body\[data-composer-status-style="capsule"\] \.agent-status-dock \{[^}]*width:\s*fit-content/s);
  assert.match(statusDock, /title=\{model\}/);
});

test("shell no longer mutates model catalog or imports override-only chrome", () => {
  const main = read("../src/components/Main.tsx");
  assert.doesNotMatch(main, /ModelPresentationNormalizer|chatChromePolish/);
});

test("spawn status dock preserves model name room without harness suffix", () => {
  const surface = read("../src/components/workspace/builtinSurfaces.tsx");
  const statusCss = read("../src/components/ui/AgentStatusDock.css");
  assert.match(surface, /effectiveModel\s*=\s*\(spawning\s*\?\s*spawn\?\.model\s*:\s*undefined\)\s*\?\?\s*pendingModel/);
  assert.match(surface, /startupModel\s*=\s*activity\.pendingSend\?\.model\s*\?\?\s*activity\.model\s*\?\?\s*sessionRecord\?\.model/);
  assert.doesNotMatch(surface, /\$\{harnessName\}\s+harness/);
  assert.match(statusCss, /\.agent-status-dock--status\s+\.agent-status-dock-primary\s*\{[^}]*display:\s*flex/);
  assert.match(statusCss, /\.agent-status-dock--status\s+\.agent-status-dock-state\s*\{[^}]*flex:\s*0\s+0\s+auto/);
});

test("working sessions provide a fallback live agent status dock when session.footer has no git widget", () => {
  const surface = read("../src/components/workspace/builtinSurfaces.tsx");
  assert.match(surface, /hasLiveFooterDock\s*=\s*\(layout\.slotPlacements\["session\.footer"\]\s*\?\?\s*\[\]\)\.some/);
  assert.match(surface, /defId === "git\.pending-changes" && widget !== undefined/);
  assert.match(surface, /working && !hasLiveFooterDock && <AgentLiveStatusDock activity=\{activity\} model=\{model\} \/>/);
  // One dock implementation: the git package renders the same component.
  assert.match(read("../../../packages/git/widgets/PendingChangesBar.tsx"), /<AgentLiveStatusDock/);
});
