import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("visible chat actions use direct canonical controls", () => {
  const timeline = read("../src/components/Timeline.tsx");
  const messageActions = read("../src/components/MessageQuickActions.tsx");
  const responseFooter = read("../src/components/ChatResponseFooter.tsx");
  const pin = read("../src/components/messagePinAction.tsx");

  assert.match(timeline, /<MessageQuickActions/);
  assert.match(timeline, /<ChatResponseFooter/);
  assert.match(messageActions, /className="chat-message-actions"/);
  assert.match(messageActions, /<ChatActionButton/);
  assert.doesNotMatch(messageActions, /Icon\.more|Menu|actions-popup/);
  assert.match(responseFooter, /className="chat-response-actions"/);
  assert.match(responseFooter, /prefs\.responseActions\.map/);
  assert.doesNotMatch(responseFooter, /overflowActions|response-footer-more|<Menu/);
  assert.match(pin, /ChatActionButton/);
  assert.match(pin, /PinIcon/);
});

test("generic Menu contains no response-footer special case", () => {
  const menu = read("../src/components/ui/Menu.tsx");
  assert.doesNotMatch(menu, /response-footer|RESPONSE_QUICK_ICON|isResponseFooterOverflowTrigger/);
});

test("chat chrome is component-owned, compact and readable", () => {
  const css = read("../src/components/ChatChrome.css");
  const footer = read("../src/components/ChatResponseFooter.tsx");
  assert.match(css, /\.chat-response-footer\s*\{[^}]*display:\s*grid;/s);
  assert.match(css, /grid-template-areas:\s*"identity info actions"/);
  assert.match(css, /@media \(max-width:\s*600px\)[\s\S]*"identity info"[\s\S]*"\. actions"/s);
  assert.match(css, /\.ui-popover\.chat-response-metadata\s*\{[^}]*background:\s*var\(--elevated\);/s);
  assert.match(css, /\.ui-tooltip\.chat-action-tooltip\s*\{[^}]*background:\s*var\(--elevated\);/s);
  assert.match(footer, /<Popover/);
  assert.doesNotMatch(css, /!important/);
});

test("shell no longer mutates model catalog or imports override-only chrome", () => {
  const main = read("../src/components/Main.tsx");
  assert.doesNotMatch(main, /ModelPresentationNormalizer|chatChromePolish/);
});
