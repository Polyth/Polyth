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

test("explicit sends lift the prompt from the composer and FLIP previous rows upward", () => {
  const controller = source("../src/chatMotion.ts");

  assert.match(controller, /captureSendTransition/);
  assert.match(controller, /\.composer-chat \[data-composer-input\]/);
  assert.match(controller, /snapshot\.rows/);
  assert.match(controller, /row\.rect\.top - after\.top/);
  assert.match(controller, /playSendTransition/);
  assert.match(controller, /SEND_LIFT_TOUCH_MS = 420/);
  assert.match(controller, /SEND_LIFT_EASE = "cubic-bezier\(0\.16, 1, 0\.3, 1\)"/);
});

test("every live action rises out of the composer and honours the motion switch", () => {
  const controller = source("../src/chatMotion.ts");
  const css = source("../src/styles.css");

  assert.match(controller, /element\.matches\("\.activity-live"\)/);
  assert.match(controller, /playActionRise/);
  assert.match(controller, /composerAnchor\(\)/);
  assert.match(controller, /function playActionRise[^}]*motionDisabled\(\)/s);
  assert.match(css, /html\[data-reduce-animations="true"\] \.activity-live/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.activity-live \{ transition: none; \}/);
});

test("the rise stays smooth over long travel and the block never clips it", () => {
  const controller = source("../src/chatMotion.ts");
  const css = source("../src/styles.css");

  // Opacity lands on its own early offset; transform keeps the full duration.
  assert.match(controller, /\{ opacity: 1, offset: 0\.32 \}/);
  // Longer travel, longer duration: a fixed one reads as a teleport.
  assert.match(controller, /Math\.min\(Math\.abs\(delta\) \/ 1200, 0\.45\)/);
  // A live action is its own timeline card wearing the block's frame, not a
  // nested list inside a block whose own clipping would swallow the travel.
  assert.match(css, /\.activity-group,\s*\.activity-live,\s*\.task-list \{/);
  assert.match(css, /--activity-live-exit: 280ms/);
  assert.match(css, /opacity calc\(var\(--activity-live-exit\) \* 0\.55\) linear/);
  assert.match(css, /\.activity-live\.leaving \{[^}]*grid-template-rows: 0fr[^}]*scale\(\.985\)/s);
});

test("new-chat and conversation surfaces share the same motion profile", () => {
  const css = source("../src/motion.css");
  assert.match(css, /\.stage-new \.hero-body/);
  assert.match(css, /\.stage-new \.hero-dock/);
  assert.match(css, /\.focus-conversation > \.timeline-wrap/);
  assert.match(css, /\.focus-conversation > \.conversation-composer-dock/);
});
