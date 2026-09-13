import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("chat actions use one direct canonical control without a redundant menu", () => {
  const timeline = read("../src/components/Timeline.tsx");
  const pin = read("../src/components/messagePinAction.tsx");
  assert.match(timeline, /<ChatActionButton/);
  assert.match(timeline, /className="chat-message-actions"/);
  assert.doesNotMatch(timeline, /msg-actions-entry|msg-actions-popup|response-footer-more/);
  assert.match(pin, /ChatActionButton/);
  assert.match(pin, /PinIcon/);
});

test("generic Menu contains no response-footer special case", () => {
  const menu = read("../src/components/ui/Menu.tsx");
  assert.doesNotMatch(menu, /response-footer|RESPONSE_QUICK_ICON|isResponseFooterOverflowTrigger/);
});

test("chat chrome is component-owned, compact and readable", () => {
  const css = read("../src/components/ChatChrome.css");
  assert.match(css, /\.chat-response-footer\s*\{[^}]*display:\s*grid;/s);
  assert.match(css, /grid-template-areas:\s*"identity info actions"/);
  assert.match(css, /\.ui-popover\.chat-response-metadata\s*\{[^}]*background:\s*var\(--elevated\);/s);
  assert.match(css, /\.ui-tooltip\.chat-action-tooltip\s*\{[^}]*background:\s*var\(--elevated\);/s);
  assert.doesNotMatch(css, /!important/);
});

test("shell no longer mutates model catalog or imports override-only chrome", () => {
  const main = read("../src/components/Main.tsx");
  assert.doesNotMatch(main, /ModelPresentationNormalizer|chatChromePolish/);
});
