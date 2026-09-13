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

test("explicit sends lift the prompt to a contextual anchor and FLIP previous rows upward", () => {
  const controller = source("../src/chatMotion.ts");
  const timeline = source("../src/components/Timeline.tsx");

  assert.match(controller, /captureSendTransition/);
  assert.match(controller, /\.composer-chat \[data-composer-input\]/);
  assert.match(controller, /snapshot\.rows/);
  assert.match(controller, /row\.rect\.top - after\.top/);
  assert.match(controller, /playSendTransition/);
  assert.match(controller, /SEND_LIFT_TOUCH_MS = 420/);
  assert.match(controller, /PROMPT_SETTLE_PX = 2/);
  assert.match(controller, /SEND_LIFT_EASE = "cubic-bezier\(0\.16, 1, 0\.3, 1\)"/);
  assert.match(controller, /sourceTop - promptRect\.top, duration, 0\.72, true/);
  assert.match(timeline, /freshTurnContextOffset/);
  assert.match(timeline, /responseToPromptGap: Math\.max\(0, row\.top - bubbleRect\.bottom\)/);
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

test("a burst of fast actions is paced, not stampeded", () => {
  const timeline = source("../src/components/Timeline.tsx");
  const controller = source("../src/chatMotion.ts");
  const show = Number(/ACTION_SHOW_MS = ([\d_]+)/.exec(timeline)?.[1]?.replaceAll("_", ""));
  const lift = Number(/SEND_LIFT_TOUCH_MS = (\d+)/.exec(controller)?.[1]);
  const stretch = Number(/Math\.min\(Math\.abs\(delta\) \/ 1200, (0\.\d+)\)/.exec(controller)?.[1]);

  // An action must outlast its own longest possible rise, or the motion is cut
  // short by the fold and the burst reads as flicker.
  assert.ok(show > lift * (1 + stretch), `${show}ms outside must exceed the ${lift * (1 + stretch)}ms rise`);
  // The pause between two actions is the fold itself: the previous card is
  // gone before the next one rises.
  assert.match(timeline, /const ACTION_GAP_MS = ACTIVITY_LIVE_EXIT_MS/);
  // A deeper queue would lag behind the agent, so the overflow folds straight
  // into the block instead of narrating stale work.
  assert.match(timeline, /ACTION_BACKLOG_MS = 2 \* \(ACTION_SHOW_MS \+ ACTION_GAP_MS\)/);
  // An arriving action announces what it is; its output stays one tap away.
  assert.doesNotMatch(timeline, /defaultOpen=\{live\}/);
});

test("the rise stays smooth over long travel and the block never clips it", () => {
  const controller = source("../src/chatMotion.ts");
  const css = source("../src/styles.css");

  // Opacity lands on its own early offset; transform keeps the full duration.
  assert.match(controller, /\{ opacity: 1, offset: settle \? 0\.28 : 0\.32 \}/);
  // Longer travel, longer duration: a fixed one reads as a teleport.
  assert.match(controller, /Math\.min\(Math\.abs\(delta\) \/ 1200, 0\.45\)/);
  // A live action is a bare row anchored to the block, not a nested list in
  // the folded block's layout whose clipping would swallow the travel — and it
  // wears no frame of its own: the block is the only framed surface there.
  assert.match(css, /\.activity-group,\s*\.task-list \{/);
  const liveRule = /\n\.activity-live \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.doesNotMatch(liveRule, /border|box-shadow|background/);
  assert.match(css, /\.activity-group \{\s*position: relative;\s*overflow: visible;/);
  assert.match(css, /\.activity-live-stage \{\s*position: absolute;\s*inset-inline: 0;\s*inset-block-start: calc\(100% \+ var\(--space-1\)\);/);
  assert.match(css, /Inserting or\s+growing a live row must not change the scrollport/s);
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
