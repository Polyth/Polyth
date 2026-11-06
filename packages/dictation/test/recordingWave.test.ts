// The recording waveform's model: loudness mapping, a time-keyed bar history
// and the bar layout both placements draw. The canvas itself only paints
// these bars.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const { WAVE_BAR_MS, WaveHistory, waveBars, waveLevel, waveMotionAllowed } = await import("../widgets/recordingWave.tsx");

test("loudness maps through decibels: room tone is a dot, speech moves, loud speech fills", () => {
  assert.equal(waveLevel(0), 0);
  assert.equal(waveLevel(Number.NaN), 0);
  assert.ok(waveLevel(0.008) === 0, "room tone sits at the floor");
  const quiet = waveLevel(0.03);
  const normal = waveLevel(0.1);
  assert.ok(quiet > 0.25 && quiet < normal, `quiet speech still moves (${quiet})`);
  assert.ok(normal > 0.6 && normal < 1, `ordinary speech does not saturate (${normal})`);
  assert.equal(waveLevel(0.5), 1);
});

test("the history keys bars by time, keeps each bar's peak and reads gaps as silence", () => {
  const history = new WaveHistory(1_000);
  history.push(0.2, 1_000);
  history.push(0.7, 1_000 + WAVE_BAR_MS / 2);
  history.push(0.4, 1_000 + WAVE_BAR_MS);
  assert.ok(Math.abs(history.at(0) - 0.7) < 1e-6, "a bar shows its loudest chunk");
  assert.ok(Math.abs(history.at(1) - 0.4) < 1e-6);
  // A stalled capture: bars nobody heard stay silent.
  history.push(0.9, 1_000 + WAVE_BAR_MS * 5);
  assert.equal(history.at(2), 0);
  assert.equal(history.at(4), 0);
  assert.ok(Math.abs(history.at(5) - 0.9) < 1e-6);
  assert.equal(history.at(6), 0, "the future is silent");
  assert.equal(history.at(-1), 0);
  // Long-forgotten bars read as silence instead of wrapping around.
  history.push(0.5, 1_000 + WAVE_BAR_MS * 300);
  assert.equal(history.at(5), 0);
  assert.ok(Math.abs(history.at(300) - 0.5) < 1e-6);
  assert.ok(history.head(1_000 + WAVE_BAR_MS * 10) < 10, "the drawing trails the clock by an audio chunk");
});

test("scrolling bars enter at the inline end, fade toward the start and mirror in RTL", () => {
  const history = new WaveHistory(0);
  for (let k = 0; k < 40; k++) history.push(k % 2 ? 1 : 0, k * WAVE_BAR_MS + 1);
  const geometry = { width: 100, height: 20, bar: 3, gap: 2, mode: "scroll" as const, rtl: false };
  const bars = waveBars(history, 30.5, geometry);
  assert.ok(bars.length >= 20 && bars.length <= 22, `about width / pitch bars (${bars.length})`);
  assert.ok(bars.every((bar) => bar.height >= 3 && bar.height <= 20), "silence is a dot, speech fits the strip");
  assert.equal(bars[0]!.x, 100, "the newest bar is at the inline end");
  assert.ok(bars.at(-1)!.x < bars[0]!.x);
  assert.ok(bars.at(-1)!.alpha < 0.4 && bars[0]!.alpha === 1, "older bars fade toward the start");
  assert.ok(new Set(bars.map((bar) => bar.height)).size === 2, "loud and silent bars alternate");
  const rtl = waveBars(history, 30.5, { ...geometry, rtl: true });
  assert.deepEqual(rtl.map((bar) => bar.x), bars.map((bar) => 100 - bar.x), "RTL mirrors the strip");
  // The strip glides: a later frame moves every bar toward the start.
  const later = waveBars(history, 30.7, geometry);
  assert.ok(later[0]!.x < bars[0]!.x && later[1]!.x < bars[1]!.x, "every bar moves toward the start");
  assert.ok(later[0]!.x > bars[1]!.x, "by less than a pitch per bar's worth of time");
});

test("the centred wave leaves the middle toward both sides", () => {
  const history = new WaveHistory(0);
  for (let k = 0; k < 20; k++) history.push(0.5, k * WAVE_BAR_MS + 1);
  const bars = waveBars(history, 12.6, { width: 30, height: 14, bar: 2, gap: 2, mode: "center", rtl: false });
  const xs = bars.map((bar) => bar.x);
  assert.ok(xs.every((x) => x >= -2 && x <= 32), "bars stay on the canvas");
  for (const bar of bars) {
    if (Math.abs(bar.x - 15) < 0.5) continue;
    assert.ok(bars.some((other) => Math.abs(other.x - (30 - bar.x)) < 1e-9), "every side bar has its mirror");
  }
  const nearest = bars.reduce((a, b) => (Math.abs(a.x - 15) < Math.abs(b.x - 15) ? a : b));
  const farthest = bars.reduce((a, b) => (Math.abs(a.x - 15) > Math.abs(b.x - 15) ? a : b));
  assert.ok(nearest.alpha > farthest.alpha, "the middle is the present");
  assert.deepEqual(waveBars(history, 3, { width: 0, height: 14, bar: 2, gap: 2, mode: "center", rtl: false }), [],
    "a hidden canvas draws nothing");
});

test("motion is off without a document, matching the shell's reduced-motion switches", () => {
  assert.equal(waveMotionAllowed(), false);
});
