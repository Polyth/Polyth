// Packet C: opening an existing chat must not blink or jump. These pin the
// pure load/reveal timings (sessionLoad.ts) and the host wiring that consumes
// them (session surface + its own CSS block), without a live browser.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  advanceSessionLoad,
  IDLE_SESSION_LOAD,
  SESSION_PLACEHOLDER_DELAY_MS,
  SESSION_PLACEHOLDER_FADE_MS,
  SESSION_REVEAL_CACHED_MS,
  SESSION_REVEAL_MS,
  sessionRevealDuration,
  sessionRevealPhase,
} from "../src/sessionLoad.ts";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("a fast open never shows a placeholder before the delay", () => {
  let state = advanceSessionLoad(IDLE_SESSION_LOAD, { loading: true, now: 1_000 });
  assert.equal(state.shown, false, "nothing for the first beat");
  assert.equal(state.nextChangeAt, 1_000 + SESSION_PLACEHOLDER_DELAY_MS);

  state = advanceSessionLoad(state, { loading: true, now: 1_000 + SESSION_PLACEHOLDER_DELAY_MS - 1 });
  assert.equal(state.shown, false);
  state = advanceSessionLoad(state, { loading: true, now: 1_000 + SESSION_PLACEHOLDER_DELAY_MS });
  assert.equal(state.shown, true, "a slow open gets a calm placeholder");
  assert.equal(state.everShown, true, "and the reveal takes the longer beat");
});

test("a slow switch never holds the previous surface for the whole load", () => {
  // The previous transcript stays only for the first beat; holding it until the
  // new session arrived read as the tap bouncing back to the current chat.
  const state = advanceSessionLoad(IDLE_SESSION_LOAD, { loading: true, now: 5_000 });
  assert.equal(state.shown, false);
  const late = advanceSessionLoad(state, { loading: true, now: 5_000 + 10_000 });
  assert.equal(late.shown, true, "a long load shows the loading layer");
});

test("the placeholder cross-fades out under the content and never blinks back", () => {
  const shown = advanceSessionLoad(IDLE_SESSION_LOAD, { loading: true, now: 1_000 });
  const visible = advanceSessionLoad(shown, { loading: true, now: 1_300 });
  assert.equal(visible.shown, true);

  const leaving = advanceSessionLoad(visible, { loading: false, now: 1_400 });
  assert.equal(leaving.leaving, true);
  assert.equal(leaving.shown, false);
  assert.equal(leaving.everShown, true, "the reveal beat remembers the placeholder");
  assert.equal(leaving.nextChangeAt, 1_400 + SESSION_PLACEHOLDER_FADE_MS);

  const fading = advanceSessionLoad(leaving, { loading: false, now: 1_500 });
  assert.equal(fading.leaving, true);
  const done = advanceSessionLoad(fading, { loading: false, now: 1_600 });
  assert.equal(done.leaving, false);
  assert.equal(done.since, null, "the episode is over, so the next open measures its own delay");

  // A new episode starts fresh: no instant placeholder because of a stale clock.
  const next = advanceSessionLoad(done, { loading: true, now: 2_000 });
  assert.equal(next.shown, false);
  assert.equal(next.everShown, false);
  assert.equal(next.nextChangeAt, 2_000 + SESSION_PLACEHOLDER_DELAY_MS);
});

test("the reveal beat is short for a cached switch and long after a placeholder", () => {
  assert.equal(sessionRevealDuration(false), SESSION_REVEAL_CACHED_MS);
  assert.equal(sessionRevealDuration(true), SESSION_REVEAL_MS);
  assert.ok(SESSION_REVEAL_CACHED_MS <= 160, "a cached session reveals in <=160ms");
  assert.ok(SESSION_REVEAL_MS <= 260, "and a cold open in <=260ms");
});

test("a first-send id does not replay the session reveal", () => {
  assert.equal(sessionRevealPhase(true, false, "idle"), "entering", "a normal session change reveals");
  assert.equal(sessionRevealPhase(true, true, "idle"), "idle", "the first-send handoff keeps the surface still");
  assert.equal(sessionRevealPhase(false, true, "entering"), "entering", "a follow-up phase is untouched");
});

test("the session surface holds briefly, shows the loading layer, then reveals", async () => {
  const surface = await read("../src/components/workspace/builtinSurfaces.tsx");
  // Hold: for the first beat of a load the previous surface stays — the hero
  // from a ref, a transcript by rendering on — then the loading layer takes over.
  assert.match(surface, /const heldSurface = useRef<ReactNode>\(null\)/);
  assert.match(surface, /if \(kind === "loading"\) return <>\{heldSurface\.current\}\{picker\}<\/>/);
  // A pending open of another session is a load even while the previous
  // transcript is still the active session.
  assert.match(surface, /const loading = kind === "loading" \|\| \(openingSessionId !== null && openingSessionId !== sessionId\)/);
  assert.match(surface, /useSessionLoad\(loading\)/);
  assert.match(surface, /if \(loading && load\.placeholder\) \{/);
  // Reveal: the surface carries the phase and the duration as a custom property.
  assert.match(surface, /data-session-reveal=\{reveal\}/);
  assert.match(surface, /const revealMs = sessionRevealDuration\(load\.everShown\)/);
  // Focusing the other chat of a split shows a transcript already on screen.
  assert.match(surface, /const reveal = useSessionReveal\(sessionId, revealMs, firstSendHandoff \|\| splitFocus\)/);
  // A first-send id lands on the surface already on screen: it suppresses the
  // reveal instead of replaying it in the middle of the hero handoff.
  assert.match(surface, /if \(suppress \|\| sessionMotionDisabled\(\)/);
  assert.match(surface, /const phase = sessionRevealPhase\(changed, suppress, state\.phase\)/);
  assert.match(surface, /"--session-reveal-ms": `\$\{revealMs\}ms`/);
  assert.match(surface, /data-session-reveal=\{reveal\} style=\{revealStyle\}/);
  // The placeholder is a layer over the transcript area: it must stay the first
  // child in both branches so React never remounts the timeline-wrap under it.
  assert.match(surface, /<SessionLoadingLayer key="session-load" state=\{load\.leaving \? "leaving" : "idle"\} \/>/);
  assert.match(surface, /<SessionLoadingLayer key="session-load" state="visible" \/>/);
  assert.match(surface, /className="session-load-skeleton"/);
  // The arrival observer's host signal: no per-row entrance while a session
  // surface is settling (packet A consumes it in chatMotion).
  assert.match(surface, /root\.dataset\.sessionReveal = "active"/);
  assert.doesNotMatch(surface, /function SessionLoading\(\)/, "the whole-surface loading row is gone");
});

test("the reveal and placeholder CSS is host-owned, attribute-scoped and motion-gated", async () => {
  const css = await read("../src/sessionLoad.css");
  const main = await read("../src/main.tsx");
  assert.match(main, /import "\.\/sessionLoad\.css";/, "the shell loads the host block");
  assert.match(css, /\.focus-conversation\[data-session-reveal="entering"\] > \.timeline-wrap \{[\s\S]*?opacity: 0;[\s\S]*?translate3d\(0, 8px, 0\)/);
  assert.match(css, /\.focus-conversation\[data-session-reveal="idle"\] > \.timeline-wrap \{[\s\S]*?transition:/);
  assert.match(css, /\.session-load-layer\[data-state="idle"\] \{\s*display: none;/);
  assert.match(css, /\.session-load-layer\[data-state="leaving"\] \{[\s\S]*?opacity: 0;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /html\[data-reduce-animations="true"\]/);
  assert.match(css, /body\[data-desktop-low-resource="true"\]/);
  // Scoped to the host attributes, so DOM fixtures without them are untouched.
  assert.doesNotMatch(css, /^\.timeline-wrap/m);
});
