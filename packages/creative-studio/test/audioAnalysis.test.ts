import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeAudio, ANALYSIS_SAMPLE_RATE, estimateKey } from "../src/audio/dsp.ts";
import { curveAt, sectionAt, summarizeAnalysis } from "../src/audio/analysis.ts";
import { alignPlainLyrics, isLrc, parseLrc } from "../src/audio/lyrics.ts";

const SR = ANALYSIS_SAMPLE_RATE;

/** Deterministic synthetic song: kick on every beat, hats on off-beats,
 * sustained triads; a louder, busier middle section with a different chord. */
function synthSong(options: { bpm: number; seconds: number; sections: Array<{ from: number; to: number; chord: number[]; gain: number; hats: boolean }> }): Float32Array {
  const out = new Float32Array(Math.round(options.seconds * SR));
  let seed = 7;
  const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; };
  const beat = 60 / options.bpm;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const section = options.sections.find((s) => t >= s.from && t < s.to) ?? options.sections[0]!;
    const sinceBeat = t % beat;
    const kick = Math.sin(2 * Math.PI * (55 + 80 * Math.exp(-sinceBeat * 30)) * sinceBeat) * Math.exp(-sinceBeat * 9) * 0.9;
    const sinceHat = (t + beat / 2) % beat;
    const hat = section.hats ? noise() * Math.exp(-sinceHat * 60) * 0.25 : 0;
    let pad = 0;
    for (const midi of section.chord) pad += Math.sin(2 * Math.PI * 440 * 2 ** ((midi - 69) / 12) * t);
    out[i] = (kick + hat + pad * 0.08) * section.gain;
  }
  return out;
}

const song = synthSong({
  bpm: 120,
  seconds: 48,
  sections: [
    { from: 0, to: 16, chord: [60, 64, 67], gain: 0.45, hats: false },
    { from: 16, to: 32, chord: [57, 60, 64, 69], gain: 1, hats: true },
    { from: 32, to: 48, chord: [60, 64, 67], gain: 0.45, hats: false },
  ],
});
const analysis = analyzeAudio(song, SR, { source: "synthetic.wav" });

test("tempo and beat grid follow a 120 BPM kick", () => {
  assert.ok(Math.abs(analysis.bpm - 120) < 2.5, `bpm ${analysis.bpm}`);
  assert.ok(analysis.beats.length >= 80 && analysis.beats.length <= 100, `beats ${analysis.beats.length}`);
  const gaps = analysis.beats.slice(1).map((t, i) => t - analysis.beats[i]!);
  const median = gaps.toSorted((a, b) => a - b)[Math.floor(gaps.length / 2)]!;
  assert.ok(Math.abs(median - 0.5) < 0.03, `median beat gap ${median}`);
  // Beats land on the kicks (multiples of 0.5 s) within one analysis hop.
  const offGrid = analysis.beats.filter((t) => Math.abs(t - Math.round(t * 2) / 2) > 0.06);
  assert.ok(offGrid.length <= 3, `off-grid beats ${offGrid.slice(0, 5)}`);
  assert.equal(analysis.beatsPerBar, 4);
  assert.ok(Math.abs(analysis.downbeats.length - analysis.beats.length / 4) <= 1);
});

test("sections split where energy and harmony change", () => {
  assert.ok(analysis.sections.length >= 3, JSON.stringify(analysis.sections));
  const boundaries = analysis.sections.slice(1).map((section) => section.start);
  for (const expected of [16, 32]) {
    assert.ok(boundaries.some((t) => Math.abs(t - expected) <= 2.1), `no boundary near ${expected}: ${boundaries}`);
  }
  assert.equal(analysis.sections[0]!.start, 0);
  assert.equal(analysis.sections.at(-1)!.end, analysis.durationSec);
  const loud = sectionAt(analysis, 24)!;
  const quiet = sectionAt(analysis, 8)!;
  assert.ok(loud.energy > quiet.energy, "middle section is louder");
  assert.equal(sectionAt(analysis, 8)!.group, sectionAt(analysis, 40)!.group, "repeated material shares a group");
  assert.notEqual(loud.group, quiet.group);
});

test("feature curves, lanes and accents are bounded and aligned", () => {
  assert.equal(analysis.curve.rate, 20);
  assert.ok(Math.abs(analysis.curve.rms.length - 48 * 20) <= 1);
  for (const values of Object.values(analysis.curve)) {
    if (!Array.isArray(values)) continue;
    assert.ok(values.every((value) => value >= 0 && value <= 1));
  }
  assert.ok(curveAt(analysis.curve.rms, 20, 24) > curveAt(analysis.curve.rms, 20, 8));
  const drums = analysis.instruments.find((lane) => lane.id === "drums")!;
  assert.ok(drums.coverage > 0.3, `drums coverage ${drums.coverage}`);
  const highs = analysis.instruments.find((lane) => lane.id === "highs")!;
  const at = (t: number) => highs.activity[Math.floor(t * 2)]!;
  assert.ok(at(24) > at(8), "hats raise the highs lane in the middle section");
  assert.ok(analysis.accents.length > 0 && analysis.accents.every((t, i, all) => i === 0 || t > all[i - 1]!));
  const summary = summarizeAnalysis(analysis);
  assert.ok(!("curve" in summary));
});

test("key estimation recognises C major and A minor profiles", () => {
  const cMajor = [1, 0, 0.6, 0, 0.9, 0.5, 0, 1, 0, 0.5, 0, 0.3];
  assert.deepEqual([estimateKey(cMajor).tonic, estimateKey(cMajor).mode], ["C", "major"]);
  const aMinor = [0.8, 0, 0.4, 0, 0.9, 0.4, 0, 0.5, 0.1, 1, 0, 0.3];
  const result = estimateKey(aMinor);
  assert.deepEqual([result.tonic, result.mode], ["A", "minor"]);
});

test("silence and very short input produce warnings, not crashes", () => {
  const silent = analyzeAudio(new Float32Array(SR * 2), SR);
  assert.ok(silent.warnings.length >= 1);
  assert.ok(silent.sections.length >= 1);
});

test("LRC lyrics keep author timestamps; plain lyrics are spread over the track", () => {
  const lrc = "[ti:Song]\n[00:12.50]First line\n[00:15.00][00:40.00]Hook line\n[00:20]Third";
  assert.ok(isLrc(lrc));
  const lines = parseLrc(lrc, 48);
  assert.deepEqual(lines.map((line) => [line.start, line.text]), [[12.5, "First line"], [15, "Hook line"], [20, "Third"], [40, "Hook line"]]);
  assert.ok(lines.every((line) => line.end > line.start && line.end <= 48));
  assert.ok(!isLrc("Just words\nMore words"));
  const plain = alignPlainLyrics("one short\n[Chorus]\na rather longer second line\nthree", analysis);
  assert.equal(plain.length, 3);
  assert.ok(plain.every((line, i) => line.end > line.start && (i === 0 || line.start >= plain[i - 1]!.end - 1e-6)));
  assert.ok(plain.at(-1)!.end <= analysis.durationSec);
});
