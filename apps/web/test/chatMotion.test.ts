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

test("explicit sends rise from the composer and preserve previous row continuity", () => {
  const controller = source("../src/chatMotion.ts");
  const timeline = source("../src/components/Timeline.tsx");
  const follow = source("../src/timelineFollow.ts");
  const lift = source("../src/timelineLift.ts");

  assert.match(controller, /captureSendTransition/);
  assert.match(controller, /composer\.closest\("\.focus-conversation"\)/);
  assert.match(controller, /snapshot\.rows/);
  assert.match(controller, /row\.rect\.top - after\.top/);
  assert.match(controller, /playSendTransition/);
  assert.match(controller, /SEND_LIFT_TOUCH_MS = 420/);
  assert.match(controller, /SEND_LIFT_DESKTOP_MS = 360/);
  assert.match(controller, /playTransform\(element, sourceTop - promptRect\.top, duration, 0\.72, TIMELINE_SEND_FLIGHT_ANIMATION_ID\)/);
  assert.doesNotMatch(controller, /PROMPT_SETTLE_PX/);
  assert.match(controller, /SEND_LIFT_EASE = "cubic-bezier\(0\.16, 1, 0\.3, 1\)"/);
  assert.match(timeline, /focusLineScrollTop/);
  assert.match(timeline, /timelineTurnReserve/);
  assert.match(follow, /TIMELINE_FOCUS_RATIO = 0\.5/);
  assert.doesNotMatch(timeline, /freshTurnContextOffset/);
  assert.match(timeline, /freshTurnPending\.current = turnSheetPromptId\.current !== null/);
  assert.match(timeline, /followUpSendRef/);
  assert.match(timeline, /liveFollowUp/);
  assert.match(timeline, /newestPendingDelivery === "steer" \|\| newestPendingDelivery === "interrupt"/);
  assert.match(timeline, /model\.turn\?\.status === "aborted"/);
  assert.match(timeline, /TIMELINE_LIFT_ROW_SELECTOR/);
  assert.match(lift, /TIMELINE_LIFT_ROW_SELECTOR =[\s\S]{0,80}?\.activity-group, \.execution-row/);
  assert.doesNotMatch(lift, /activity-live/, "no live row exists outside its block");
});

test("a live turn fills down into its reserve and hands it over without moving a row", () => {
  const timeline = source("../src/components/Timeline.tsx");
  const css = source("../src/styles.css");

  assert.match(timeline, /turnSheetStarted/);
  assert.match(timeline, /TURN_END_SETTLE_WAIT_MS/);
  assert.doesNotMatch(timeline, /heldTurnSheetPadding|freshTurnContextOffset/);
  // Every arrival fills down: rows stay still while new ones land under the
  // tail, and the view follows only once the tail reaches the composer edge
  // (timelineFollow.test.ts pins fillDownScrollTop itself). Nothing is lifted
  // onto the mid-screen focus line, so nothing waits there to drop back down.
  assert.match(timeline, /const fillsDown = blankBelow;/);
  assert.doesNotMatch(timeline, /TIMELINE_PROSE_ROW_SELECTOR|const fillDown = !live/);
  assert.match(timeline, /fillDownScrollTop\(\{/);
  // A revert lands at rest on the composer edge: no focus-line hold after it.
  assert.doesNotMatch(timeline, /turnSheetFocusHold/);
  // Lift transforms must never be measured as sheet geometry.
  assert.match(timeline, /if \(!liftBusy\.current && !rewindMotionActive\.current\) syncTurnSheet\(\)/);
  // The reserve is scoped to a live turn only.
  assert.match(timeline, /turnLiveRef\.current = pendingSends\.length > 0 \|\| model\.turn\?\.status === "working";/);
  assert.match(timeline, /const turnLive = turnLiveRef\.current;/);
  assert.doesNotMatch(timeline, /const turnLive = [^;]*!turnSheetStarted\.current/);
  // Turn status reaches the geometry callbacks through refs, so a status
  // change never re-subscribes the timeline's Resize/Mutation observers.
  assert.match(timeline, /\}, \[sessionId, scrollToTail, syncTurnSheet, handOverTurnTail, holdReaderAnchor\]\);/);
  assert.doesNotMatch(timeline, /\}, \[model\.turn\?\.status, (pendingSends\.length, )?(setTurnSheetPadding|updateTimelineExtent)\]\);/);
  assert.match(timeline, /updateTimelineExtent = useCallback\(\(element: HTMLElement, live: boolean\)/);
  assert.match(timeline, /const release = updateTimelineExtent\(el, live \|\| turnSheetPadding\.current > 0\s*\|\| turnEndTimer\.current !== null \|\| turnSettleDue\.current\)/);
  // The turn's end moves nothing: its reserve becomes a floor held at the
  // reader's position, released only once nobody can see it. No glide.
  const handOver = timeline.slice(timeline.indexOf("const handOverTurnTail = useCallback"), timeline.indexOf("const syncTurnSheet = useCallback"));
  assert.ok(handOver.length > 0);
  assert.doesNotMatch(handOver, /playTimelineLift|captureTimelineLiftRows|el\.scrollTop = /);
  assert.match(handOver, /heldTailScroll\.current = el\.scrollTop;\s*writeTimelineExtentSpace\(el, needed\);/);
  assert.doesNotMatch(timeline, /TIMELINE_SETTLE_DURATION_MS/);
  assert.match(timeline, /const trimHeldTail = useCallback/);
  // A finger defers the handover; it is paid once the scroll has rested.
  assert.match(timeline, /turnSettleDue\.current = true;/);
  assert.match(timeline, /if \(turnSettleDue\.current\) handOverTurnTail\(\);/);
  assert.match(timeline, /const ownsTail = turnSheetPromptId\.current !== null/);
  assert.match(timeline, /timelineExtentSpace\.current > 0/);
  assert.match(timeline, /setTurnSheetPadding\(0\)/);
  assert.match(timeline, /resetTimelineExtent\(el\)/);
  assert.doesNotMatch(css, /\.timeline\.idle-tail/);
  assert.doesNotMatch(timeline, /classList\.toggle\("idle-tail"/);
});

test("touch WebKit momentum keeps the finger's ownership until the scroll rests", () => {
  const timeline = source("../src/components/Timeline.tsx");
  assert.match(timeline, /const TOUCH_SCROLL_REST_MS = 150;/);
  // A gesture that scrolled only arms the rest timer when the finger lifts;
  // momentum scrolls re-arm it. A tap moved nothing and releases at once, so
  // its own layout change (a card answered under the finger) is followed.
  assert.match(timeline, /if \(!touchScrolled\.current\) \{\s*touchActive\.current = false;/);
  assert.match(timeline, /if \(touchActive\.current\) \{\s*touchScrolled\.current = true;\s*if \(touchRestTimer\.current !== null\) armTouchRest\(\);/);
  // The touched node can unmount mid-gesture: the document hears its end too.
  assert.match(timeline, /document\.addEventListener\("touchend", end, true\);/);
  assert.match(timeline, /const releaseTouch = useCallback\(\(\) => \{\s*touchRestTimer\.current = null;\s*touchActive\.current = false;/);
});

test("the live line swaps in place and honours the motion switch", () => {
  const controller = source("../src/chatMotion.ts");
  const css = source("../src/styles.css");
  const ticker = source("../src/activityTicker.ts");

  assert.doesNotMatch(controller, /activity-live/, "no live row gets its own entrance");
  assert.doesNotMatch(controller, /playActionRise|actionRiseTimeline|composerOrigin/,
    "actions never travel across transcript content from the composer");
  assert.match(ticker, /if \(timelineLiftMotionDisabled\(\)\) \{/);
  assert.match(css, /html\[data-reduce-animations="true"\] \.activity-ticker-line/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.activity-ticker-line \{ animation: none !important; \}/);
});

test("a burst of steps keeps one dwell per line and never queues behind the agent", () => {
  const timeline = source("../src/components/Timeline.tsx");
  const controller = source("../src/chatMotion.ts");
  const ticker = source("../src/activityTicker.ts");
  const dwell = Number(/ACTIVITY_TICKER_DWELL_MS = ([\d_]+)/.exec(ticker)?.[1]?.replaceAll("_", ""));
  const entrance = Number(/DESKTOP_DURATION_MS = (\d+)/.exec(controller)?.[1]);

  // A line must outlast its own entrance, or a burst reads as flicker.
  assert.ok(dwell > entrance, `${dwell}ms dwell must exceed the ${entrance}ms entrance`);
  // No backlog: the line skips to the newest step, and no row waits for one.
  assert.doesNotMatch(timeline, /ACTION_SHOW_MS|ACTION_BACKLOG_MS|deferredRowIds|presentedActivityKey/);
  // An arriving action announces what it is; its output stays one tap away.
  assert.doesNotMatch(timeline, /defaultOpen=\{live\}/);
});

test("live activity stays inside its block: no row is added, removed or overlaid per step", () => {
  const controller = source("../src/chatMotion.ts");
  const css = source("../src/styles.css");
  const timeline = source("../src/components/Timeline.tsx");

  assert.doesNotMatch(timeline, /activity-live-stage|createPortal\(stage|activity-live-layer|onStageChange/);
  assert.match(timeline, /ticking=\{turnWorking && r\.id === renderedCurrentActivityId && r\.id === latestRowId\}/);
  assert.match(timeline, /copy=\{<ActivityTicker ticker=\{ticker\} render=\{renderLine\} \/>\}/);
  // What describes the line follows the words on screen, not the newest event.
  assert.match(timeline, /const ticker = useTickerKey\(target\?\.id \?\? "summary"\);/);
  assert.match(timeline, /const stopCandidate = shownTool && shownTool\.status === "running" && !open/);
  assert.match(controller, /TOP_LEVEL_TIMELINE_ROW_SELECTOR = "[^"]*\.activity-group/);
  assert.match(controller, /TOP_LEVEL_TIMELINE_ROW_SELECTOR = "[^"]*\.pkg-harnesses-switch-marker/);
  assert.doesNotMatch(controller, /activity-merge-claimed/);
  const groupRule = /\n\.activity-group \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.doesNotMatch(groupRule, /background|box-shadow|border:/, "the block is no card");
  assert.doesNotMatch(css, /\n\.activity-live \{|\.activity-live-layer|\.activity-live-stage/);
});

test("new-chat and conversation surfaces share the same motion profile", () => {
  const css = source("../src/motion.css");
  assert.match(css, /\.stage-new \.hero-body/);
  assert.match(css, /\.stage-new \.hero-dock/);
  assert.match(css, /\.focus-conversation > \.conversation-composer-dock \{\s*animation: chat-fade-in/);
  // The transcript's arrival has one owner, the host session reveal
  // (sessionLoad.css); a mount fade here would race it on a cold open.
  assert.doesNotMatch(css, /\.focus-conversation > \.timeline-wrap,/);
});

test("rows landing with a session reveal get no per-row entrance", () => {
  const controller = source("../src/chatMotion.ts");
  assert.match(controller, /document\.documentElement\.dataset\.sessionReveal === "active"/);
  assert.match(controller, /const suppressNavigationBatch = navigationBatch \|\| sessionRevealActive\(\);/);
  assert.match(controller, /animateAddedNode\(node, suppressNavigationBatch, handover, dockHandover\)/);
});
