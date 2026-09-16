import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("visible chat actions use direct canonical controls", () => {
  const timeline = read("../src/components/Timeline.tsx");
  const actionButton = read("../src/components/ChatActionButton.tsx");
  const messageActions = read("../src/components/MessageQuickActions.tsx");
  const responseFooter = read("../src/components/ChatResponseFooter.tsx");
  const pin = read("../src/components/messagePinAction.tsx");

  assert.match(timeline, /rewound-tail-body/);
  assert.match(timeline, /statusFor\("user", row\.eventSeq\)/);
  assert.match(timeline, /statusFor\("assistant", row\.eventSeq\)/);
  assert.match(actionButton, /size="sm"/);
  assert.match(actionButton, /IconButton/);
  assert.match(actionButton, /Tooltip/);
  assert.match(actionButton, /import "\.\/ChatChrome\.css"/);
  assert.match(messageActions, /className="chat-message-actions"/);
  assert.match(messageActions, /data-actions-seq=\{message\.eventSeq\}/);
  assert.match(messageActions, /<ChatActionButton/);
  assert.doesNotMatch(messageActions, /Icon\.more|<Menu\b|actions-popup/);
  assert.match(responseFooter, /className="chat-response-actions"/);
  assert.match(responseFooter, /prefs\.responseActions\.map/);
  assert.doesNotMatch(responseFooter, /overflowActions|response-footer-more|<Menu/);
  assert.match(pin, /ChatActionButton/);
  assert.match(pin, /PinIcon/);
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

test("generic Menu contains no response-footer special case", () => {
  const menu = read("../src/components/ui/Menu.tsx");
  assert.doesNotMatch(menu, /response-footer|RESPONSE_QUICK_ICON|isResponseFooterOverflowTrigger|ChatIcon/);
});

test("chat chrome is component-owned, compact and readable", () => {
  const css = read("../src/components/ChatChrome.css");
  const footer = read("../src/components/ChatResponseFooter.tsx");
  const messageActions = read("../src/components/MessageQuickActions.tsx");
  assert.match(css, /\.chat-response-footer\s*\{[^}]*display:\s*grid;/s);
  assert.match(css, /grid-template-areas:\s*"identity info actions"/);
  assert.match(css, /@media \(max-width:\s*600px\)[\s\S]*grid-template-areas:\s*"identity info actions"/s);
  assert.match(css, /@media \(max-width:\s*340px\) and \(pointer:\s*coarse\)[\s\S]*grid-template-columns:\s*repeat\(4, var\(--control-h-sm\)\)[\s\S]*\.chat-response-action-item\s*\{\s*display:\s*contents;/s);
  assert.match(css, /@media \(hover:\s*none\), \(pointer:\s*coarse\)[\s\S]*\.ui-tooltip\.chat-action-tooltip\s*\{\s*display:\s*none;/s);
  assert.match(css, /\.chat-action-status\s*\{[^}]*max-width:\s*min\(24ch, 100%\)/s);
  assert.match(messageActions, /chat-action-status/);
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
  assert.match(statusCss, /\.agent-status-dock-primary strong/);
  assert.match(statusCss, /fit-content\(72%\)/);
  assert.match(statusCss, /\.agent-status-dock--stacked \.agent-status-dock-content/);
  assert.match(statusCss, /gap:\s*calc\(var\(--space-1\) \/ 2\)/);
  assert.match(statusCss, /\.agent-status-dock-primary \{[^}]*line-height:\s*1\.2/s);
  assert.match(statusCss, /\.agent-status-dock-secondary \{[^}]*line-height:\s*1\.15/s);
  assert.match(statusDock, /title=\{model\}/);
});

test("shell no longer mutates model catalog or imports override-only chrome", () => {
  const main = read("../src/components/Main.tsx");
  assert.doesNotMatch(main, /ModelPresentationNormalizer|chatChromePolish/);
});
