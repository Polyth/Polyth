// Audio analysis result — browser-safe types and lookups shared by the
// server analyzer, the render runtime input and the studio UI.

export const ANALYSIS_VERSION = 1;
/** Feature curve sample rate (Hz). 20 Hz = one value every 50 ms. */
export const CURVE_RATE = 20;
/** Instrument activity lane sample rate (Hz). */
export const LANE_RATE = 2;

export type SectionKind = "intro" | "verse" | "chorus" | "bridge" | "drop" | "breakdown" | "outro";

export interface AnalysisSection {
  start: number;
  end: number;
  /** Repetition group: sections with the same letter sound alike. */
  group: string;
  kind: SectionKind;
  /** Mean loudness relative to the whole track, 0..1. */
  energy: number;
}

export interface InstrumentLane {
  id: "drums" | "bass" | "vocals" | "harmony" | "highs";
  /** 0..1 estimated presence at LANE_RATE. Heuristic, not stem separation. */
  activity: number[];
  /** Share of the track where the lane is clearly present. */
  coverage: number;
}

export interface LyricLine {
  start: number;
  end: number;
  text: string;
}

export interface AudioAnalysis {
  version: number;
  source: string;
  durationSec: number;
  sampleRate: number;
  bpm: number;
  /** 0..1, how periodic the onset envelope is at the chosen tempo. */
  bpmConfidence: number;
  beats: number[];
  downbeats: number[];
  beatsPerBar: number;
  key: { tonic: string; mode: "major" | "minor"; confidence: number };
  sections: AnalysisSection[];
  instruments: InstrumentLane[];
  /** Strong transients (seconds) worth hitting visually. */
  accents: number[];
  curve: {
    rate: number;
    /** Normalized 0..1 loudness. */
    rms: number[];
    low: number[];
    mid: number[];
    high: number[];
    /** Normalized 0..1 onset strength. */
    onset: number[];
  };
  lyrics?: { source: "lrc" | "text" | "transcribed"; lines: LyricLine[] };
  warnings: string[];
}

/** Linear-interpolated curve value at time t (seconds). */
export function curveAt(values: readonly number[], rate: number, t: number): number {
  if (!values.length) return 0;
  const position = Math.max(0, t * rate);
  const index = Math.floor(position);
  if (index >= values.length - 1) return values[values.length - 1] ?? 0;
  const frac = position - index;
  return (values[index] ?? 0) * (1 - frac) + (values[index + 1] ?? 0) * frac;
}

/** Index of the last element <= t in a sorted array, or -1. */
export function lastIndexAtOrBefore(sorted: readonly number[], t: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] ?? Infinity) <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

export function sectionAt(analysis: Pick<AudioAnalysis, "sections">, t: number): AnalysisSection | undefined {
  return analysis.sections.find((section) => t >= section.start && t < section.end) ?? analysis.sections.at(-1);
}

/** Compact summary for tool output and prompts (no curves). */
export function summarizeAnalysis(analysis: AudioAnalysis): Record<string, unknown> {
  return {
    durationSec: analysis.durationSec,
    bpm: analysis.bpm,
    bpmConfidence: analysis.bpmConfidence,
    beatsPerBar: analysis.beatsPerBar,
    beats: analysis.beats.length,
    bars: analysis.downbeats.length,
    firstDownbeat: analysis.downbeats[0],
    key: `${analysis.key.tonic} ${analysis.key.mode}`,
    sections: analysis.sections.map((section) => ({
      start: section.start, end: section.end, kind: section.kind, group: section.group, energy: section.energy,
    })),
    instruments: analysis.instruments.map((lane) => ({ id: lane.id, coverage: lane.coverage })),
    accents: analysis.accents.slice(0, 24),
    lyrics: analysis.lyrics
      ? { source: analysis.lyrics.source, lines: analysis.lyrics.lines.slice(0, 40) }
      : null,
    warnings: analysis.warnings,
  };
}
