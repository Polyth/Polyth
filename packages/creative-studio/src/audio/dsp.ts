// Creative Studio audio analyzer. Pure TypeScript DSP over mono PCM: no Node
// APIs, no native deps, deterministic — so it is unit-tested on synthetic
// signals. Decoding (FFmpeg) lives in decode.ts.
//
// Pipeline: STFT (Hann, 2048/512) → per-frame features (loudness, four bands,
// spectral flux, chroma, flatness) → onset envelope → tempo by weighted
// autocorrelation → beats by dynamic programming (Ellis 2007) → downbeats by
// low-end emphasis → bar-level self-similarity novelty → sections with
// repetition groups → key by Krumhansl profiles → heuristic instrument lanes.

import {
  ANALYSIS_VERSION,
  CURVE_RATE,
  LANE_RATE,
  type AnalysisSection,
  type AudioAnalysis,
  type InstrumentLane,
  type SectionKind,
} from "./analysis.ts";

export const ANALYSIS_SAMPLE_RATE = 22050;
const FFT_SIZE = 2048;
const HOP = 512;
const PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// ------------------------------------------------------------------- FFT

interface FftPlan { n: number; rev: Uint32Array; cos: Float64Array; sin: Float64Array; window: Float64Array }

function fftPlan(n: number): FftPlan {
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  const window = new Float64Array(n);
  for (let i = 0; i < n; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return { n, rev, cos, sin, window };
}

/** In-place iterative radix-2 FFT. */
function fft(plan: FftPlan, re: Float64Array, im: Float64Array): void {
  const { n, rev, cos, sin } = plan;
  for (let i = 0; i < n; i++) {
    const j = rev[i]!;
    if (j > i) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step]!;
        const wi = sin[k * step]!;
        const a = start + k;
        const b = a + half;
        const xr = re[b]! * wr - im[b]! * wi;
        const xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
      }
    }
  }
}

// -------------------------------------------------------------- features

interface FrameFeatures {
  count: number;
  rate: number;
  rms: Float64Array;
  low: Float64Array;
  lowMid: Float64Array;
  mid: Float64Array;
  high: Float64Array;
  flux: Float64Array;
  fluxLow: Float64Array;
  fluxHigh: Float64Array;
  flatness: Float64Array;
  chroma: Float64Array; // count × 12
}

function extractFeatures(samples: Float32Array, sampleRate: number): FrameFeatures {
  const plan = fftPlan(FFT_SIZE);
  const bins = FFT_SIZE / 2 + 1;
  const count = Math.max(1, Math.floor((samples.length - FFT_SIZE) / HOP) + 1);
  const hz = (bin: number) => (bin * sampleRate) / FFT_SIZE;
  const binOf = (frequency: number) => Math.min(bins - 1, Math.max(1, Math.round((frequency * FFT_SIZE) / sampleRate)));
  const bands = { low: [binOf(20), binOf(150)], lowMid: [binOf(150), binOf(400)], mid: [binOf(400), binOf(2500)], high: [binOf(2500), binOf(8000)] };
  // Onset flux is averaged inside 12 log-spaced bands, then summed, so a
  // narrow kick weighs as much as broadband hats/noise.
  const fluxBand = new Int8Array(bins).fill(-1);
  const fluxBandSize = new Float64Array(12);
  for (let bin = binOf(30); bin <= binOf(10_000); bin++) {
    const band = Math.min(11, Math.floor((Math.log2(hz(bin) / 30) / Math.log2(10_000 / 30)) * 12));
    fluxBand[bin] = band;
    fluxBandSize[band]! += 1;
  }
  const bandFlux = new Float64Array(12);
  const pitchClass = new Int8Array(bins).fill(-1);
  for (let bin = binOf(55); bin <= binOf(4200); bin++) {
    const midi = 69 + 12 * Math.log2(hz(bin) / 440);
    pitchClass[bin] = ((Math.round(midi) % 12) + 12) % 12;
  }
  const out: FrameFeatures = {
    count,
    rate: sampleRate / HOP,
    rms: new Float64Array(count),
    low: new Float64Array(count),
    lowMid: new Float64Array(count),
    mid: new Float64Array(count),
    high: new Float64Array(count),
    flux: new Float64Array(count),
    fluxLow: new Float64Array(count),
    fluxHigh: new Float64Array(count),
    flatness: new Float64Array(count),
    chroma: new Float64Array(count * 12),
  };
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const mag = new Float64Array(bins);
  const prevLog = new Float64Array(bins);
  for (let frame = 0; frame < count; frame++) {
    const offset = frame * HOP;
    let energy = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const value = samples[offset + i] ?? 0;
      energy += value * value;
      re[i] = value * plan.window[i]!;
      im[i] = 0;
    }
    out.rms[frame] = Math.sqrt(energy / FFT_SIZE);
    fft(plan, re, im);
    let fluxLow = 0;
    let fluxHigh = 0;
    bandFlux.fill(0);
    for (let bin = 0; bin < bins; bin++) {
      const m = Math.hypot(re[bin]!, im[bin]!);
      mag[bin] = m;
      const logMag = Math.log1p(100 * m);
      const diff = logMag - prevLog[bin]!;
      prevLog[bin] = logMag;
      if (diff > 0 && frame > 0) {
        if (fluxBand[bin]! >= 0) bandFlux[fluxBand[bin]!]! += diff;
        if (bin <= bands.low[1]!) fluxLow += diff;
        if (bin >= bands.high[0]!) fluxHigh += diff;
      }
      const pc = pitchClass[bin]!;
      if (pc >= 0) out.chroma[frame * 12 + pc]! += m;
    }
    let flux = 0;
    for (let band = 0; band < 12; band++) if (fluxBandSize[band]) flux += bandFlux[band]! / fluxBandSize[band]!;
    out.flux[frame] = flux;
    out.fluxLow[frame] = fluxLow;
    out.fluxHigh[frame] = fluxHigh;
    const bandEnergy = ([from, to]: number[]) => {
      let sum = 0;
      for (let bin = from!; bin <= to!; bin++) sum += mag[bin]! * mag[bin]!;
      return sum / Math.max(1, to! - from! + 1);
    };
    out.low[frame] = bandEnergy(bands.low);
    out.lowMid[frame] = bandEnergy(bands.lowMid);
    out.mid[frame] = bandEnergy(bands.mid);
    out.high[frame] = bandEnergy(bands.high);
    let logSum = 0;
    let linSum = 0;
    const [from, to] = bands.mid;
    for (let bin = from!; bin <= to!; bin++) {
      const power = mag[bin]! * mag[bin]! + 1e-12;
      logSum += Math.log(power);
      linSum += power;
    }
    const width = to! - from! + 1;
    out.flatness[frame] = Math.exp(logSum / width) / (linSum / width);
  }
  return out;
}

// ---------------------------------------------------------------- helpers

function percentile(values: ArrayLike<number>, p: number): number {
  if (!values.length) return 0;
  const sorted = Float64Array.from(values).sort();
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[index]!;
}

function normalizeTo(values: ArrayLike<number>, p = 0.98): Float64Array {
  const ref = percentile(values, p) || 1;
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = Math.min(1, Math.max(0, values[i]! / ref));
  return out;
}

function movingAverage(values: Float64Array, radius: number): Float64Array {
  const out = new Float64Array(values.length);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length + radius; i++) {
    if (i < values.length) { sum += values[i]!; count++; }
    const drop = i - 2 * radius - 1;
    if (drop >= 0) { sum -= values[drop]!; count--; }
    const center = i - radius;
    if (center >= 0 && center < values.length) out[center] = sum / Math.max(1, count);
  }
  return out;
}

/** Average frame values into fixed-rate buckets. */
function resample(values: Float64Array, fromRate: number, toRate: number, duration: number): number[] {
  const buckets = Math.max(1, Math.ceil(duration * toRate));
  const out: number[] = new Array(buckets).fill(0);
  for (let bucket = 0; bucket < buckets; bucket++) {
    const from = Math.floor((bucket / toRate) * fromRate);
    const to = Math.max(from + 1, Math.floor(((bucket + 1) / toRate) * fromRate));
    let sum = 0;
    let count = 0;
    for (let i = from; i < to && i < values.length; i++) { sum += values[i]!; count++; }
    out[bucket] = count ? sum / count : 0;
  }
  return out;
}

const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// ----------------------------------------------------------- onset/tempo

function movingMax(values: Float64Array, radius: number): Float64Array {
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let max = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) max = Math.max(max, values[j]!);
    out[i] = max;
  }
  return out;
}

/** Positive spectral flux above its local mean, with adaptive gain so quiet
 * passages keep a usable pulse next to loud ones. */
function onsetEnvelope(features: FrameFeatures): Float64Array {
  const local = movingAverage(features.flux, Math.round(features.rate * 0.25));
  const raw = new Float64Array(features.count);
  for (let i = 0; i < features.count; i++) raw[i] = Math.max(0, features.flux[i]! - local[i]!);
  const global = percentile(raw, 0.99) || 1;
  const localMax = movingMax(raw, Math.round(features.rate * 1.5));
  const out = new Float64Array(features.count);
  for (let i = 0; i < features.count; i++) out[i] = Math.min(1, raw[i]! / (0.25 * global + 0.75 * localMax[i]! + 1e-9));
  return out;
}

export interface TempoEstimate { bpm: number; periodFrames: number; confidence: number }

export function estimateTempo(onset: Float64Array, frameRate: number, minBpm = 60, maxBpm = 200): TempoEstimate {
  const n = onset.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += onset[i]!;
  mean /= Math.max(1, n);
  const centered = onset.map((value) => value - mean);
  const minLag = Math.floor((60 * frameRate) / maxBpm);
  const maxLag = Math.min(n - 1, Math.ceil((60 * frameRate) / minBpm));
  const ac = new Float64Array(maxLag + 2);
  for (let lag = 0; lag <= maxLag + 1 && lag < n; lag++) {
    let sum = 0;
    for (let i = lag; i < n; i++) sum += centered[i]! * centered[i - lag]!;
    ac[lag] = sum / (n - lag);
  }
  const zero = ac[0] || 1;
  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = Math.max(1, minLag); lag <= maxLag; lag++) {
    const bpm = (60 * frameRate) / lag;
    // Log-Gaussian tempo prior centred on 120 BPM (one octave ≈ 1 sigma).
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 1) ** 2);
    const harmonic = ac[lag]! + 0.5 * (ac[Math.min(ac.length - 1, lag * 2)] ?? 0);
    const score = harmonic * prior;
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  if (!bestLag) return { bpm: 120, periodFrames: (60 * frameRate) / 120, confidence: 0 };
  // Parabolic refinement around the integer lag.
  const y0 = ac[bestLag - 1] ?? ac[bestLag]!;
  const y1 = ac[bestLag]!;
  const y2 = ac[bestLag + 1] ?? ac[bestLag]!;
  const denom = y0 - 2 * y1 + y2;
  const shift = denom ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0;
  const period = bestLag + shift;
  return {
    bpm: round((60 * frameRate) / period, 2),
    periodFrames: period,
    confidence: round(Math.max(0, Math.min(1, y1 / zero)), 3),
  };
}

/** Dynamic-programming beat tracker (Ellis 2007). Returns beat frames. */
export function trackBeats(onset: Float64Array, period: number, tightness = 100): number[] {
  const n = onset.length;
  if (n < period * 2) return [];
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const minPrev = Math.max(1, Math.round(period / 2));
  const maxPrev = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let best = 0;
    let arg = -1;
    for (let prev = t - maxPrev; prev <= t - minPrev; prev++) {
      if (prev < 0) continue;
      const deviation = Math.log((t - prev) / period);
      const candidate = score[prev]! - tightness * deviation * deviation;
      if (candidate > best || arg < 0) { best = candidate; arg = prev; }
    }
    score[t] = onset[t]! + (arg >= 0 ? Math.max(0, best) : 0);
    back[t] = arg >= 0 && best > 0 ? arg : -1;
  }
  // Best end within the last period.
  let end = n - 1;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++) if (score[t]! > score[end]!) end = t;
  const beats: number[] = [];
  for (let t = end; t >= 0; t = back[t]!) {
    beats.push(t);
    if (back[t]! < 0) break;
  }
  beats.reverse();
  // Extend backwards to the start at the tempo period, so the grid covers intros.
  while (beats.length && beats[0]! - period > period * 0.5) beats.unshift(Math.round(beats[0]! - period));
  return beats;
}

// --------------------------------------------------------------- sections

interface Segment { from: number; to: number } // bar indices, [from, to)

function noveltyBoundaries(vectors: number[][], kernel: number, minGap: number): number[] {
  const n = vectors.length;
  if (n < kernel * 2 + 2) return [];
  const sim = (i: number, j: number) => cosine(vectors[i]!, vectors[j]!);
  const novelty = new Float64Array(n);
  for (let center = kernel; center <= n - kernel; center++) {
    let value = 0;
    for (let a = -kernel; a < kernel; a++) {
      for (let b = -kernel; b < kernel; b++) {
        const i = center + a;
        const j = center + b;
        if (i < 0 || j < 0 || i >= n || j >= n) continue;
        const sign = (a < 0) === (b < 0) ? 1 : -1;
        const taper = Math.exp(-((a + 0.5) ** 2 + (b + 0.5) ** 2) / (2 * (kernel * 0.6) ** 2));
        value += sign * taper * sim(i, j);
      }
    }
    novelty[center] = Math.max(0, value);
  }
  let mean = 0;
  for (const value of novelty) mean += value;
  mean /= n;
  let variance = 0;
  for (const value of novelty) variance += (value - mean) ** 2;
  const threshold = mean + 0.4 * Math.sqrt(variance / n);
  const peaks: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (novelty[i]! < threshold || novelty[i]! < novelty[i - 1]! || novelty[i]! < novelty[i + 1]!) continue;
    const last = peaks.at(-1);
    if (last !== undefined && i - last < minGap) {
      if (novelty[i]! > novelty[last]!) peaks[peaks.length - 1] = i;
      continue;
    }
    peaks.push(i);
  }
  return peaks;
}

function labelSections(
  segments: Array<{ start: number; end: number; vector: number[]; energy: number }>,
): AnalysisSection[] {
  const groups: Array<{ letter: string; vector: number[] }> = [];
  const letters = segments.map((segment) => {
    const match = groups.find((group) => cosine(group.vector, segment.vector) > 0.965);
    if (match) return match.letter;
    const letter = String.fromCharCode(65 + Math.min(25, groups.length));
    groups.push({ letter, vector: segment.vector });
    return letter;
  });
  const maxEnergy = Math.max(1e-9, ...segments.map((segment) => segment.energy));
  const groupEnergy = new Map<string, { sum: number; count: number }>();
  segments.forEach((segment, index) => {
    const entry = groupEnergy.get(letters[index]!) ?? { sum: 0, count: 0 };
    entry.sum += segment.energy;
    entry.count += 1;
    groupEnergy.set(letters[index]!, entry);
  });
  let chorusGroup: string | undefined;
  let chorusScore = -1;
  for (const [letter, entry] of groupEnergy) {
    const score = (entry.sum / entry.count / maxEnergy) * (entry.count > 1 ? 1.25 : 1);
    if (score > chorusScore) { chorusScore = score; chorusGroup = letter; }
  }
  return segments.map((segment, index): AnalysisSection => {
    const energy = round(segment.energy / maxEnergy, 3);
    const letter = letters[index]!;
    const isFirst = index === 0;
    const isLast = index === segments.length - 1;
    let kind: SectionKind;
    if (isFirst && segments.length > 2 && energy < 0.75) kind = "intro";
    else if (isLast && segments.length > 2 && energy < 0.75) kind = "outro";
    else if (letter === chorusGroup && energy >= 0.7) kind = (groupEnergy.get(letter)?.count ?? 0) > 1 ? "chorus" : "drop";
    else if (energy < 0.45) kind = "breakdown";
    else if ((groupEnergy.get(letter)?.count ?? 0) === 1 && index > 1 && energy >= 0.55) kind = "bridge";
    else kind = "verse";
    return { start: round(segment.start), end: round(segment.end), group: letter, kind, energy };
  });
}

// -------------------------------------------------------------------- key

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(a: number[], b: number[]): number {
  const ma = a.reduce((s, v) => s + v, 0) / a.length;
  const mb = b.reduce((s, v) => s + v, 0) / b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

export function estimateKey(chroma: number[]): AudioAnalysis["key"] {
  const scores: Array<{ tonic: number; mode: "major" | "minor"; score: number }> = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = chroma.map((_, i) => chroma[(i + tonic) % 12]!);
    scores.push({ tonic, mode: "major", score: pearson(rotated, MAJOR) });
    scores.push({ tonic, mode: "minor", score: pearson(rotated, MINOR) });
  }
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0]!;
  const second = scores[1]!;
  return {
    tonic: PITCH_NAMES[best.tonic]!,
    mode: best.mode,
    confidence: round(Math.max(0, Math.min(1, (best.score - second.score) * 4 + Math.max(0, best.score) * 0.5)), 3),
  };
}

// ------------------------------------------------------------------ main

export interface AnalyzeOptions { source?: string }

export function analyzeAudio(samples: Float32Array, sampleRate: number, options: AnalyzeOptions = {}): AudioAnalysis {
  const warnings: string[] = [];
  const durationSec = round(samples.length / sampleRate, 3);
  if (durationSec < 3) warnings.push("Track is shorter than 3 seconds; tempo and sections are unreliable.");
  const features = extractFeatures(samples, sampleRate);
  const rate = features.rate;
  const onset = onsetEnvelope(features);
  const loud = percentile(features.rms, 0.98);
  if (loud < 1e-4) warnings.push("Audio is silent or nearly silent.");

  const tempo = estimateTempo(onset, rate);
  if (tempo.confidence < 0.08) warnings.push("Weak rhythmic pulse: the beat grid is approximate.");
  const beatFrames = trackBeats(onset, tempo.periodFrames);
  const beats = beatFrames.map((frame) => round((frame * HOP + FFT_SIZE / 2) / sampleRate));

  // Downbeats: the beat phase (mod 4) with the most low-end attack.
  const beatsPerBar = 4;
  let phase = 0;
  let phaseScore = -1;
  const lowNorm = normalizeTo(features.low);
  const fluxLowNorm = normalizeTo(features.fluxLow);
  for (let candidate = 0; candidate < beatsPerBar; candidate++) {
    let score = 0;
    for (let i = candidate; i < beatFrames.length; i += beatsPerBar) {
      const frame = beatFrames[i]!;
      score += lowNorm[frame]! + 1.5 * fluxLowNorm[frame]! + onset[frame]!;
    }
    if (score > phaseScore) { phaseScore = score; phase = candidate; }
  }
  const downbeats = beats.filter((_, index) => index % beatsPerBar === phase);

  // Per-frame descriptor used for bar vectors and section means.
  const descriptor = (from: number, to: number): { vector: number[]; energy: number } => {
    const chroma = new Array(12).fill(0);
    const bands: [number, number, number, number] = [0, 0, 0, 0];
    let energy = 0;
    let count = 0;
    for (let frame = Math.max(0, from); frame < Math.min(features.count, to); frame++) {
      for (let pc = 0; pc < 12; pc++) chroma[pc] += features.chroma[frame * 12 + pc]!;
      bands[0] += Math.log1p(features.low[frame]! * 1e3);
      bands[1] += Math.log1p(features.lowMid[frame]! * 1e3);
      bands[2] += Math.log1p(features.mid[frame]! * 1e3);
      bands[3] += Math.log1p(features.high[frame]! * 1e3);
      energy += features.rms[frame]!;
      count++;
    }
    const chromaSum = chroma.reduce((sum, value) => sum + value, 0) || 1;
    const bandSum = bands.reduce((sum, value) => sum + value, 0) || 1;
    return {
      vector: [...chroma.map((value) => value / chromaSum), ...bands.map((value) => (value / bandSum) * 1.5), (energy / Math.max(1, count) / (loud || 1)) * 0.6],
      energy: energy / Math.max(1, count),
    };
  };

  // Section boundaries on bar vectors; fall back to 4-second blocks without a grid.
  const frameOf = (seconds: number) => Math.round((seconds * sampleRate - FFT_SIZE / 2) / HOP);
  const blockStarts = downbeats.length >= 6
    ? downbeats
    : Array.from({ length: Math.ceil(durationSec / 4) }, (_, i) => i * 4);
  const blocks = blockStarts.map((start, index) => {
    const end = blockStarts[index + 1] ?? durationSec;
    return { start, end, ...descriptor(frameOf(start), frameOf(end)) };
  });
  const barSeconds = blocks.length > 1 ? (blocks.at(-1)!.start - blocks[0]!.start) / (blocks.length - 1) : 4;
  const minGapBars = Math.max(2, Math.round(6 / Math.max(0.5, barSeconds)));
  const kernel = Math.max(2, Math.min(8, Math.round(8 / Math.max(0.5, barSeconds))));
  const cuts = noveltyBoundaries(blocks.map((block) => block.vector), kernel, minGapBars);
  const segments: Segment[] = [];
  let from = 0;
  for (const cut of cuts) {
    if (cut - from >= 1) segments.push({ from, to: cut });
    from = cut;
  }
  if (blocks.length) segments.push({ from, to: blocks.length });
  const segmentRows = segments.map((segment, index) => {
    const start = index === 0 ? 0 : blocks[segment.from]!.start;
    const end = index === segments.length - 1 ? durationSec : blocks[segment.to]?.start ?? durationSec;
    return { start, end, ...descriptor(frameOf(start), frameOf(end)) };
  });
  // Merge slivers (< 4 s) into their neighbour.
  for (let i = 0; i < segmentRows.length && segmentRows.length > 1; i++) {
    const row = segmentRows[i]!;
    if (row.end - row.start >= 4) continue;
    const target = i === 0 ? 1 : i - 1;
    const merged = segmentRows[target]!;
    merged.start = Math.min(merged.start, row.start);
    merged.end = Math.max(merged.end, row.end);
    Object.assign(merged, descriptor(frameOf(merged.start), frameOf(merged.end)), { start: merged.start, end: merged.end });
    segmentRows.splice(i, 1);
    i--;
  }
  const sections = segmentRows.length
    ? labelSections(segmentRows)
    : [{ start: 0, end: durationSec, group: "A", kind: "verse" as SectionKind, energy: 1 }];

  // Key from loudness-weighted chroma.
  const meanChroma = new Array(12).fill(0);
  for (let frame = 0; frame < features.count; frame++) {
    const weight = features.rms[frame]!;
    for (let pc = 0; pc < 12; pc++) meanChroma[pc] += features.chroma[frame * 12 + pc]! * weight;
  }
  const key = estimateKey(meanChroma);

  // Heuristic instrument presence lanes.
  const total = new Float64Array(features.count);
  for (let i = 0; i < features.count; i++) total[i] = features.low[i]! + features.lowMid[i]! + features.mid[i]! + features.high[i]! + 1e-12;
  const ratio = (band: Float64Array) => band.map((value, i) => value / total[i]!);
  const gate = features.rms.map((value) => (value > loud * 0.05 ? 1 : 0));
  const chromaPeak = new Float64Array(features.count);
  for (let frame = 0; frame < features.count; frame++) {
    let max = 0;
    let sum = 0;
    for (let pc = 0; pc < 12; pc++) {
      const value = features.chroma[frame * 12 + pc]!;
      max = Math.max(max, value);
      sum += value;
    }
    chromaPeak[frame] = sum ? max / sum : 0;
  }
  const lane = (id: InstrumentLane["id"], raw: Float64Array): InstrumentLane => {
    // Smooth over half a second first: transient lanes (drums) are spiky.
    const gated = movingAverage(raw.map((value, i) => value * gate[i]!), Math.round(rate * 0.25));
    const activity = resample(normalizeTo(gated, 0.9), rate, LANE_RATE, durationSec).map((value) => round(Math.min(1, value), 2));
    return { id, activity, coverage: round(activity.filter((value) => value >= 0.5).length / Math.max(1, activity.length), 2) };
  };
  const lowRatio = ratio(features.low);
  const midRatio = ratio(features.mid);
  const highRatio = ratio(features.high);
  const instruments: InstrumentLane[] = [
    lane("drums", features.fluxHigh.map((value, i) => value * 0.6 + features.fluxLow[i]! * 0.4)),
    lane("bass", lowRatio.map((value, i) => value * Math.sqrt(features.low[i]!))),
    lane("vocals", midRatio.map((value, i) => value * (1 - Math.min(1, features.flatness[i]! * 4)) * Math.sqrt(features.mid[i]!))),
    lane("harmony", chromaPeak.map((value, i) => value * Math.sqrt(features.lowMid[i]! + features.mid[i]!))),
    lane("highs", highRatio.map((value, i) => value * Math.sqrt(features.high[i]!))),
  ];

  // Accents: strong onsets on loud frames, at least 250 ms apart.
  const accentScore = onset.map((value, i) => value * Math.sqrt(features.rms[i]! / (loud || 1)));
  const threshold = Math.max(0.15, percentile(accentScore, 0.97));
  const minGap = Math.round(rate * 0.25);
  const accentFrames: number[] = [];
  for (let i = 1; i < accentScore.length - 1; i++) {
    if (accentScore[i]! < threshold || accentScore[i]! < accentScore[i - 1]! || accentScore[i]! < accentScore[i + 1]!) continue;
    const last = accentFrames.at(-1);
    if (last !== undefined && i - last < minGap) {
      if (accentScore[i]! > accentScore[last]!) accentFrames[accentFrames.length - 1] = i;
      continue;
    }
    accentFrames.push(i);
  }
  const accents = accentFrames
    .toSorted((a, b) => accentScore[b]! - accentScore[a]!)
    .slice(0, 64)
    .sort((a, b) => a - b)
    .map((frame) => round((frame * HOP + FFT_SIZE / 2) / sampleRate));

  const bandCurve = (band: Float64Array) =>
    resample(normalizeTo(band.map((value) => Math.log1p(value * 1e3))), rate, CURVE_RATE, durationSec).map((value) => round(value, 3));
  return {
    version: ANALYSIS_VERSION,
    source: options.source ?? "",
    durationSec,
    sampleRate,
    bpm: tempo.bpm,
    bpmConfidence: tempo.confidence,
    beats,
    downbeats,
    beatsPerBar,
    key,
    sections,
    instruments,
    accents,
    curve: {
      rate: CURVE_RATE,
      rms: resample(normalizeTo(features.rms), rate, CURVE_RATE, durationSec).map((value) => round(value, 3)),
      low: bandCurve(features.low),
      mid: bandCurve(features.mid),
      high: bandCurve(features.high),
      onset: resample(onset, rate, CURVE_RATE, durationSec).map((value) => round(value, 3)),
    },
    warnings,
  };
}
