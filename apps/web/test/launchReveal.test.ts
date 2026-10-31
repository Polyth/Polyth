// The launch veil lifts once, onto a finished workspace. The
// decision is pure; the controller is driven with a fake clock and a fake veil.
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { LaunchVeil } from "@polyth/mobile/launch";
import {
  decideLaunchReveal,
  holdLaunchReveal,
  LAUNCH_REVEAL_TIMING as T,
  noteLaunchHydrated,
  noteLaunchPackagesSettled,
  noteLaunchPhase,
  noteLaunchSettingsSettled,
  resetLaunchRevealForTest,
  startLaunchReveal,
  type LaunchProgress,
} from "../src/launchReveal.ts";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  MutationObserver: dom.MutationObserver,
});
Object.defineProperty(globalThis, "requestAnimationFrame", {
  value: (callback: FrameRequestCallback) => { callback(0); return 0; },
  configurable: true,
});

const ready = (patch: Partial<LaunchProgress> = {}): LaunchProgress => ({
  phase: "ready",
  committedAt: 400,
  hydratedAt: 1_000,
  settingsSettled: true,
  packagesSettled: true,
  holds: 0,
  lastChangeAt: 1_000,
  ...patch,
});

test("a settled workspace is revealed once it has stopped changing", () => {
  assert.deepEqual(decideLaunchReveal(ready(), 1_100), { reveal: false, wakeAt: 1_000 + T.quietMs });
  assert.deepEqual(decideLaunchReveal(ready(), 1_000 + T.quietMs), { reveal: true, reason: "settled" });
  // A late label or button restarts the quiet window.
  assert.equal(decideLaunchReveal(ready({ lastChangeAt: 1_150 }), 1_200).reveal, false);
  assert.deepEqual(decideLaunchReveal(ready({ lastChangeAt: 1_150 }), 1_150 + T.quietMs), { reveal: true, reason: "settled" });
});

test("the veil waits for the session, the synced theme, packages and critical reads", () => {
  assert.equal(decideLaunchReveal(ready({ hydratedAt: null }), 2_000).reveal, false);
  assert.equal(decideLaunchReveal(ready({ settingsSettled: false }), 2_000).reveal, false);
  const packages = decideLaunchReveal(ready({ packagesSettled: false }), 1_500);
  assert.deepEqual(packages, { reveal: false, wakeAt: 1_000 + T.packagesGraceMs });
  const held = decideLaunchReveal(ready({ holds: 1 }), 1_500);
  assert.deepEqual(held, { reveal: false, wakeAt: 1_000 + T.holdsGraceMs });
});

test("every wait is bounded: graces, the settle cap and the hard cap", () => {
  // A package or a read that never lands stops holding after its grace.
  assert.equal(decideLaunchReveal(ready({ packagesSettled: false }), 1_000 + T.packagesGraceMs).reveal, true);
  assert.equal(decideLaunchReveal(ready({ holds: 2 }), 1_000 + T.holdsGraceMs).reveal, true);
  // Settings that never settle, or a screen that never stops changing.
  assert.deepEqual(
    decideLaunchReveal(ready({ settingsSettled: false }), 1_000 + T.settledCapMs),
    { reveal: true, reason: "settle-cap" },
  );
  assert.deepEqual(
    decideLaunchReveal(ready({ lastChangeAt: 1_000 + T.settledCapMs - 1 }), 1_000 + T.settledCapMs),
    { reveal: true, reason: "settle-cap" },
  );
  // A boot that never gets past auth or hydration.
  assert.deepEqual(decideLaunchReveal(ready({ phase: "checking", committedAt: null }), T.hardCapMs), { reveal: true, reason: "hard-cap" });
  assert.deepEqual(decideLaunchReveal(ready({ hydratedAt: null }), T.hardCapMs), { reveal: true, reason: "hard-cap" });
  assert.deepEqual(decideLaunchReveal(ready({ hydratedAt: null }), 5_000), { reveal: false, wakeAt: T.hardCapMs });
});

test("sign-in, setup and error screens show as soon as they stop changing", () => {
  const locked = ready({ phase: "locked", committedAt: 700, hydratedAt: null, settingsSettled: false, packagesSettled: false, lastChangeAt: 700 });
  assert.deepEqual(decideLaunchReveal(locked, 750), { reveal: false, wakeAt: 700 + T.quietMs });
  assert.deepEqual(decideLaunchReveal(locked, 700 + T.quietMs), { reveal: true, reason: "phase" });
  // Even a screen that keeps changing is shown after the phase cap.
  assert.deepEqual(decideLaunchReveal({ ...locked, lastChangeAt: 700 + T.phaseCapMs - 10 }, 700 + T.phaseCapMs), { reveal: true, reason: "phase" });
});

function fakeVeil() {
  const calls: Array<[string, unknown?]> = [];
  const veil: LaunchVeil = {
    active: true,
    ready: async () => undefined,
    wait: (status) => { calls.push(["wait", status]); },
    setStatus: (status) => { calls.push(["status", status]); },
    lift: async () => { calls.push(["lift"]); },
    restore: async () => { calls.push(["restore"]); },
  };
  return { veil, calls };
}

// Longer than any wake the controller schedules in these tests (the quiet window).
const settle = () => new Promise((resolve) => setTimeout(resolve, T.quietMs + 60));

function mountRoot(): HTMLElement {
  document.body.innerHTML = '<div id="root"></div>';
  return document.getElementById("root")!;
}

test("the controller lifts the veil once, after the workspace settled", async (t) => {
  t.after(resetLaunchRevealForTest);
  mountRoot();
  let clock = 300;
  const { veil, calls } = fakeVeil();
  startLaunchReveal({ veil, clock: () => clock });
  noteLaunchPhase("ready");
  clock = 900;
  noteLaunchHydrated();
  noteLaunchSettingsSettled();
  noteLaunchPackagesSettled();
  await settle();
  assert.deepEqual(calls, [], "not before the quiet window");
  clock = 900 + T.quietMs + 1;
  await settle();
  assert.deepEqual(calls, [["lift"]]);
  clock = 5_000;
  noteLaunchPackagesSettled();
  await settle();
  assert.deepEqual(calls, [["lift"]], "lifts once");
});

test("a critical read keeps the veil until it lands", async (t) => {
  t.after(resetLaunchRevealForTest);
  mountRoot();
  let clock = 300;
  const { veil, calls } = fakeVeil();
  startLaunchReveal({ veil, clock: () => clock });
  noteLaunchPhase("ready");
  const release = holdLaunchReveal();
  clock = 900;
  noteLaunchHydrated();
  noteLaunchSettingsSettled();
  noteLaunchPackagesSettled();
  clock = 900 + T.quietMs + 200;
  await settle();
  assert.deepEqual(calls, [], "the branch label is still on its way");
  release();
  release();
  await settle();
  assert.deepEqual(calls, [["lift"]]);
});

test("arriving content restarts the quiet window", async (t) => {
  t.after(resetLaunchRevealForTest);
  const root = mountRoot();
  let clock = 300;
  const { veil, calls } = fakeVeil();
  startLaunchReveal({ veil, clock: () => clock });
  noteLaunchPhase("ready");
  clock = 900;
  noteLaunchHydrated();
  noteLaunchSettingsSettled();
  noteLaunchPackagesSettled();
  clock = 1_000;
  root.append(document.createElement("button"));
  await settle();
  clock = 900 + T.quietMs + 1;
  await settle();
  assert.deepEqual(calls, [], "the button arrived 100ms after hydration");
  clock = 1_000 + T.quietMs + 1;
  await settle();
  assert.deepEqual(calls, [["lift"]]);
});

test("a streaming transcript does not count as a screen still assembling", async (t) => {
  t.after(resetLaunchRevealForTest);
  const root = mountRoot();
  const timeline = document.createElement("div");
  timeline.className = "timeline";
  root.append(timeline);
  let clock = 300;
  const { veil, calls } = fakeVeil();
  startLaunchReveal({ veil, clock: () => clock });
  noteLaunchPhase("ready");
  clock = 900;
  noteLaunchHydrated();
  noteLaunchSettingsSettled();
  noteLaunchPackagesSettled();
  clock = 1_000;
  timeline.append(document.createElement("p"));
  timeline.lastChild!.textContent = "streamed token";
  await settle();
  clock = 900 + T.quietMs + 1;
  await settle();
  assert.deepEqual(calls, [["lift"]], "only the restored workspace's own assembly holds the veil");
});

test("a slow boot gets the breathing mark and its status line", async (t) => {
  t.after(resetLaunchRevealForTest);
  mountRoot();
  const clock = T.waitingAfterMs - 5;
  const { veil, calls } = fakeVeil();
  startLaunchReveal({ veil, clock: () => clock, waitingStatus: () => "Opening your workspace…" });
  await settle();
  assert.deepEqual(calls, [["wait", "Opening your workspace…"]]);
});

test("without a veil (desktop) nothing is held or lifted", async (t) => {
  t.after(resetLaunchRevealForTest);
  mountRoot();
  const { veil, calls } = fakeVeil();
  startLaunchReveal({ veil: { ...veil, active: false }, clock: () => 100 });
  const release = holdLaunchReveal();
  noteLaunchPhase("ready");
  noteLaunchHydrated();
  release();
  await settle();
  assert.deepEqual(calls, []);
});
