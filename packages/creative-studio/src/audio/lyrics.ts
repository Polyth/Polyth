// Lyrics timing. Three sources, in order of trust:
//   1. LRC (`[mm:ss.xx] line`) — timestamps from the author;
//   2. plain text — lines spread over the vocal-active parts of the track and
//      snapped to beats (an estimate, labelled as such);
//   3. transcription through the user's configured dictation engine (server).
import { lastIndexAtOrBefore, LANE_RATE, type AudioAnalysis, type LyricLine } from "./analysis.ts";

const TAG = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;

export function isLrc(text: string): boolean {
  return /^\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/m.test(text);
}

export function parseLrc(text: string, durationSec: number): LyricLine[] {
  const stamped: Array<{ start: number; text: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const tags = [...raw.matchAll(TAG)];
    if (!tags.length) continue;
    const lyric = raw.replace(TAG, "").trim();
    for (const tag of tags) {
      const seconds = Number(tag[1]) * 60 + Number(String(tag[2]).replace(":", "."));
      if (Number.isFinite(seconds) && seconds <= durationSec + 1) stamped.push({ start: seconds, text: lyric });
    }
  }
  stamped.sort((a, b) => a.start - b.start);
  return stamped
    .map((line, index) => ({
      start: round(line.start),
      end: round(Math.min(durationSec, stamped[index + 1]?.start ?? line.start + 5, line.start + 8)),
      text: line.text.slice(0, 200),
    }))
    .filter((line) => line.text && line.end > line.start);
}

/** Vocal-active spans from the heuristic vocal lane, merged across short gaps. */
export function vocalSpans(analysis: Pick<AudioAnalysis, "instruments" | "durationSec" | "sections">): Array<[number, number]> {
  const lane = analysis.instruments.find((item) => item.id === "vocals");
  const spans: Array<[number, number]> = [];
  if (lane) {
    let open: number | undefined;
    lane.activity.forEach((value, index) => {
      const t = index / LANE_RATE;
      if (value >= 0.45 && open === undefined) open = t;
      if (value < 0.45 && open !== undefined) { spans.push([open, t]); open = undefined; }
    });
    if (open !== undefined) spans.push([open, analysis.durationSec]);
  }
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] - last[1] < 1.5) last[1] = span[1];
    else merged.push([...span]);
  }
  const useful = merged.filter(([a, b]) => b - a >= 1);
  if (useful.length) return useful;
  // No usable vocal estimate: everything except a low-energy intro/outro.
  const body = analysis.sections.filter((section) => section.kind !== "intro" && section.kind !== "outro");
  return body.length ? [[body[0]!.start, body.at(-1)!.end]] : [[0, analysis.durationSec]];
}

/** Spread plain lyric lines over vocal spans proportionally to their length. */
export function alignPlainLyrics(text: string, analysis: Pick<AudioAnalysis, "instruments" | "durationSec" | "sections" | "beats">): LyricLine[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^\[.*\]$/.test(line)).slice(0, 400);
  if (!lines.length) return [];
  const spans = vocalSpans(analysis);
  const available = spans.reduce((sum, [a, b]) => sum + (b - a), 0);
  const weights = lines.map((line) => Math.max(4, line.length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const out: LyricLine[] = [];
  let spanIndex = 0;
  let cursor = spans[0]![0];
  for (let i = 0; i < lines.length; i++) {
    let need = (weights[i]! / totalWeight) * available;
    const start = cursor;
    while (need > 1e-6 && spanIndex < spans.length) {
      const room = spans[spanIndex]![1] - cursor;
      if (room >= need) { cursor += need; need = 0; }
      else {
        need -= room;
        spanIndex++;
        cursor = spans[spanIndex]?.[0] ?? cursor;
      }
    }
    out.push({ start: snap(start, analysis.beats), end: round(cursor), text: lines[i]!.slice(0, 200) });
  }
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    if (next && out[i]!.end > next.start) out[i]!.end = next.start;
    if (out[i]!.end <= out[i]!.start) out[i]!.end = round(out[i]!.start + 0.5);
  }
  return out;
}

function snap(t: number, beats: readonly number[]): number {
  const index = lastIndexAtOrBefore(beats, t);
  const candidates = [beats[index], beats[index + 1]].filter((value): value is number => value !== undefined);
  const nearest = candidates.sort((a, b) => Math.abs(a - t) - Math.abs(b - t))[0];
  return round(nearest !== undefined && Math.abs(nearest - t) < 0.35 ? nearest : t);
}

const round = (value: number) => Math.round(value * 1000) / 1000;
