// First-send handoff: creating a session from a new message must read as one
// continuous motion. The hero body dissolves before the transcript arrives (no
// blank frame), the prompt the reader just submitted keeps its composer→
// timeline flight, and the startup dock hands over to the live activity dock
// without blinking back to "Spawning agent…". Source pins here; the live
// geometry gate exercises the same sequence in a real browser.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("the first-send hero dissolves before the transcript arrives", async () => {
  const surface = await read("../src/components/workspace/builtinSurfaces.tsx");
  const css = await read("../src/motion.css");
  const load = await read("../src/sessionLoad.ts");

  // The hero body is split from its composer dock: the body fades while the
  // composer it is about to hand over to stays put.
  assert.match(surface, /function SessionHeroBody\(/);
  assert.match(surface, /function SessionHero\(/);
  assert.ok(
    surface.indexOf("function SessionHeroBody(") < surface.indexOf("function SessionHero("),
    "the body is defined before its dock wrapper",
  );
  assert.match(surface, /<SessionHero starterContext=\{starterContext\} leaving=\{heroHold\} \/>/);
  assert.match(surface, /data-leaving=\{leaving \? "true" : undefined\}/);

  // The hold is derived during the send render, so the hero stays painted for
  // the first frame, then releases to the transcript after one motion beat.
  assert.match(surface, /previousRawKindRef\.current === "hero"/);
  assert.match(surface, /setHeroHold\(true\)/);
  assert.match(surface, /const effectiveKind: SessionSurfaceKind = heroHold \? "hero" : kind;/);
  assert.match(surface, /setTimeout\(\(\) => setHeroHold\(false\), SESSION_FIRST_SEND_HOLD_MS\)/);
  assert.match(load, /SESSION_FIRST_SEND_HOLD_MS = 260/);
  assert.match(css, /\.stage-new\[data-leaving="true"\] \.hero-body \{\s*opacity: 0;/);
  assert.match(css, /\.stage-new \.hero-body \{[\s\S]*?transition: opacity var\(--chat-motion-surface\) ease-out;/);

  // The arriving transcript and dock never fade up from nothing: that gap is
  // the blank frame between the hero and the transcript.
  assert.match(surface, /data-first-send=\{firstSendSuppressed \? "" : undefined\}/);
  assert.match(surface, /const firstSendTransition = previousRawKindRef\.current === "hero"/);
  assert.match(surface, /if \(firstSendTransition\) firstSendRequest\.current = sessionSpawn!\.requestId/,
    "only the spawn that replaced this hero owns the handoff");
  assert.match(surface, /if \(firstSendHandoff && sessionId !== null\) firstSendSession\.current = sessionId/,
    "the spawned id is latched across delivery");
  assert.match(surface, /const firstSendSuppressed = firstSendHandoff/,
    "the unbound first frame is suppressed before the created id activates");
  assert.match(surface, /firstSendSession\.current !== sessionId[\s\S]{0,180}?firstSendSession\.current = null/,
    "a later session switch clears the suppression");
  assert.match(css, /\[data-first-send\] > \.timeline-wrap[\s\S]*?animation: none;/);
  assert.match(css, /\[data-first-send\] > \.conversation-composer-dock/);
});

test("the first-send prompt keeps its composer→timeline flight", async () => {
  const controller = await read("../src/chatMotion.ts");

  // A newly mounted timeline is normally suppressed as navigation/hydration.
  // During an explicit send the mounted surface carries the submitted prompt,
  // so that one row flies out of the composer instead of appearing.
  assert.match(controller, /function animateFirstSendPrompt\(/);
  assert.match(
    controller,
    /const timeline = firstSendTimeline\(node\);\s*if \(timeline\) animateFirstSendPrompt\(timeline\)/,
  );
  assert.match(controller, /timeline\?\.closest\("\[data-first-send\]"\)/,
    "a recent send cannot animate history in a different mounted session");
  assert.match(controller, /pendingUserSendUntil <= now\(\)/);
  assert.match(controller, /const explicitSend = consumeUserSend\(\);/);
  assert.match(controller, /playSendTransition\(prompt\)/);
});

test("a replaced dock is a status handover, not a fresh entrance", async () => {
  const controller = await read("../src/chatMotion.ts");
  const surface = await read("../src/components/workspace/builtinSurfaces.tsx");

  // A dock removed in the same mutation batch suppresses the incoming dock's
  // entrance, so the shared shell swaps its text instead of fading through
  // blank while the fragment's animation restarts.
  assert.match(controller, /function pendingDockHandovers\(/);
  assert.match(controller, /dockHandover\.remaining > 0[\s\S]*?animated\.add\(status\)/);
  assert.match(controller, /animateAddedNode\(node, suppressNavigationBatch, handover, dockHandover\)/);

  // The startup dock releases the zone the moment a turn runs, so a short turn
  // (or a fast admission) cannot resurrect "Spawning agent…" after the live
  // dock has already shown.
  assert.match(surface, /if \(working\) \{[\s\S]{0,220}?setHeld\(null\);\s*return;/);
  // A brief non-working frame before the spawn record clears must not bring the
  // startup dock back once the live dock has owned this spawn.
  assert.match(surface, /const liveDockSeen = useRef\(false\)/);
  assert.match(surface, /if \(sessionSpawn === null\) liveDockSeen\.current = false/);
  assert.match(surface, /if \(working\) liveDockSeen\.current = true/);
  assert.match(surface, /!working && !liveDockSeen\.current && \(spawning \|\| awaitingTurn\)/);
});

test("a repeated first send creates one chat, and a failed one gives the prompt back", async () => {
  const composer = await read("../src/components/Composer.tsx");

  // The pending latch is marked synchronously on Send; the guard reads it (and
  // the store's spawn record) directly, so a repeat reaching the same `send`
  // closure before the re-render is dropped instead of creating a second chat.
  assert.match(composer, /sendPendingRef\.current = surfacePending\(composerSurfaceRef\.current\);/);
  assert.match(composer,
    /if \(creatingSession \|\| sendPending \|\| sendPendingRef\.current \|\| isActiveSessionSpawning\(getState\(\)\) \|\| compactPending\) return;/);
  const guard = composer.indexOf("sendPendingRef.current || isActiveSessionSpawning(getState())");
  const spawn = composer.indexOf("const spawnRequestId = beginSessionSpawn(");
  assert.ok(guard > 0 && guard < spawn, "the latch is checked before a spawn begins");
  assert.match(composer, /markSendPending\(spawnSurface, true\);/);
  // Release on every outcome; a failed creation restores the text and pills.
  assert.match(composer, /finishSessionSpawn\(spawnRequestId\);\s*markSendPending\(spawnSurface, false\);/);
  assert.match(composer, /startNewSession\(activeProjectId, \{\s*draft: t,/);
});
