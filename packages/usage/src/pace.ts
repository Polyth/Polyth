// Pace and exhaustion prediction (WP12). Pure: quota windows plus a short
// sample history in, probabilistic pace out. Never extrapolates from a single
// point, clamps counter resets, and returns null when the data cannot honestly
// support a prediction.
import type { QuotaPace, QuotaWindow } from "@polyth/contracts";

export interface QuotaSample {
  at: number;   // ms epoch when observed
  used: number;
}

export interface PaceOptions {
  /** minimum span between first and last usable sample (default 5 min) */
  minObservationMs?: number;
  now?: number;
}

/** Drop history before the most recent counter decrease (reset/rollover). */
export function usableSamples(samples: QuotaSample[]): QuotaSample[] {
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  let cut = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.used < sorted[i - 1]!.used) cut = i;
  }
  return sorted.slice(cut);
}

export function computePace(win: QuotaWindow, samples: QuotaSample[], opts: PaceOptions = {}): QuotaPace | null {
  if (!Number.isFinite(win.limit) || win.limit <= 0) return null;
  if (win.resetsAt === undefined || win.periodMs === undefined || win.periodMs <= 0) return null; // unknown period

  const usable = usableSamples(samples);
  const last = usable[usable.length - 1];
  const rawNow = opts.now ?? Date.now();
  // clock skew guard: never let "now" run behind the newest observation
  const now = last ? Math.max(rawNow, last.at) : rawNow;

  const used = last?.used ?? win.used;
  const usageFraction = Math.min(1, Math.max(0, used / win.limit));
  const elapsed = Math.min(win.periodMs, Math.max(0, win.periodMs - (win.resetsAt - now)));
  const timeFraction = Math.min(1, Math.max(0, elapsed / win.periodMs));

  let pace: QuotaPace["pace"];
  if (timeFraction <= 0) {
    pace = usageFraction > 0 ? "over" : "on-track";
  } else {
    const ratio = usageFraction / timeFraction;
    pace = ratio > 1.15 ? "over" : ratio < 0.85 ? "under" : "on-track";
  }

  const result: QuotaPace = { usageFraction, timeFraction, pace };

  // prediction needs at least two samples spanning the observation minimum
  const minSpan = opts.minObservationMs ?? 5 * 60_000;
  const first = usable[0];
  if (!first || !last || usable.length < 2 || last.at - first.at < minSpan) return result;

  const slope = (last.used - first.used) / (last.at - first.at); // units per ms
  if (slope <= 0) {
    result.predictedAtReset = Math.max(0, used);
    return result;
  }
  const untilReset = Math.max(0, win.resetsAt - last.at);
  result.predictedAtReset = used + slope * untilReset;
  const msToLimit = (win.limit - used) / slope;
  const exhaustsAt = last.at + msToLimit;
  if (msToLimit >= 0 && exhaustsAt <= win.resetsAt) result.exhaustsAt = exhaustsAt;
  return result;
}
