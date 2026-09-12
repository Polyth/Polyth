import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("chat motion replaces positional timeline animation with event-driven entrances", () => {
  const controller = source("../src/chatMotion.ts");
  const css = source("../src/motion.css");

  assert.match(controller, /MutationObserver/);
  assert.match(controller, /\.composer-chat button\.send/);
  assert.match(controller, /pendingUserSendUntil/);
  assert.match(controller, /nearTimelineTail/);
  assert.match(controller, /element\.animate\(/);
  assert.match(css, /\.timeline > \.timeline-row-enter[^}]*animation: none !important/s);
});

test("chat motion is compositor-friendly and shorter on touch", () => {
  const controller = source("../src/chatMotion.ts");
  const css = source("../src/motion.css");

  assert.match(controller, /DESKTOP_DURATION_MS = 300/);
  assert.match(controller, /TOUCH_DURATION_MS = 260/);
  assert.match(controller, /translate3d/);
  assert.match(css, /@media \(max-width: 620px\), \(pointer: coarse\)/);
  assert.match(css, /--chat-motion-distance: 6px/);
  assert.doesNotMatch(css, /filter\s*:/);
  assert.doesNotMatch(css, /scale\s*\(/);
});

test("new-chat and conversation surfaces share the same motion profile", () => {
  const css = source("../src/motion.css");
  assert.match(css, /\.stage-new \.hero-body/);
  assert.match(css, /\.stage-new \.hero-dock/);
  assert.match(css, /\.focus-conversation > \.timeline-wrap/);
  assert.match(css, /\.focus-conversation > \.conversation-composer-dock/);
});
