// The recording's waveform: measured speech drawn as bars that enter at the
// strip's inline end and glide toward the microphone, fading as they go (on a
// phone, inside the mic, they leave its middle). It is activity semantics, like a
// spinner: it moves only while a recording runs and only when the person's
// motion settings allow it. Reduced motion, Reduce animations and Low
// resource mode get the still capsule instead (see styles.css).
//
// One canvas, redrawn once per frame, so a 25-chunks-a-second level feed
// never re-renders React or restyles the composer. Its geometry comes from
// CSS (`--mic-wave-bar`, `--mic-wave-gap`, `--mic-wave-mode`, `color`), so the
// desktop strip and the phone's in-button wave share one renderer.
import { useEffect, useRef, useSyncExternalStore } from "react";

/** One bar per this many milliseconds of audio. */
export const WAVE_BAR_MS = 80;
/** The drawing trails the clock by one 40ms audio chunk, so a bar has
 *  usually heard its audio before it slides into view. */
const WAVE_LATENCY_MS = 40;
/** Bars remembered: far more than the widest strip shows (~10s). */
const HISTORY_BARS = 128;

// Loudness for the eye, in decibels: quiet speech still moves the bars and
// ordinary speech does not flatten into a solid block. Room tone sits at the
// floor, so silence reads as a row of dots.
const FLOOR_DB = -40;
const CEILING_DB = -12;

export function waveLevel(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (db - FLOOR_DB) / (CEILING_DB - FLOOR_DB)));
}

const clock = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** The loudest level heard in each bar-long slice of the recording. Bars are
 *  keyed by time, not by arrival, so a late audio chunk lands in its own bar
 *  and the strip keeps gliding at the clock's pace. */
export class WaveHistory {
  readonly origin: number;
  private readonly bars = new Float32Array(HISTORY_BARS);
  private latest = -1;

  constructor(origin = clock()) {
    this.origin = origin;
  }

  push(level: number, at = clock()): void {
    const index = Math.floor((at - this.origin) / WAVE_BAR_MS);
    if (index < 0 || index <= this.latest - HISTORY_BARS) return;
    if (index > this.latest) {
      // Bars no chunk reached (a stalled capture) read as silence.
      for (let k = Math.max(this.latest + 1, index - HISTORY_BARS + 1); k <= index; k++) this.bars[k % HISTORY_BARS] = 0;
      this.latest = index;
    }
    const slot = index % HISTORY_BARS;
    this.bars[slot] = Math.max(this.bars[slot]!, Math.max(0, Math.min(1, level)));
  }

  /** Bar `index`'s level; 0 for a bar not heard yet or long forgotten. */
  at(index: number): number {
    if (index < 0 || index > this.latest || index <= this.latest - HISTORY_BARS) return 0;
    return this.bars[index % HISTORY_BARS]!;
  }

  /** The bar position the drawing shows at `now`, in bars. */
  head(now = clock()): number {
    return (now - this.origin - WAVE_LATENCY_MS) / WAVE_BAR_MS;
  }
}

export interface WaveGeometry {
  width: number;
  height: number;
  /** Bar thickness and the space between bars, CSS px. */
  bar: number;
  gap: number;
  /** `scroll`: bars travel from the inline end toward the start.
   *  `center`: bars leave the middle toward both sides. */
  mode: "scroll" | "center";
  rtl: boolean;
}

export interface WaveBar {
  /** Bar centre, CSS px from the canvas's left edge. */
  x: number;
  /** Bar length, at least its thickness (a dot). */
  height: number;
  alpha: number;
}

/** The bars visible at `head`, newest first. Pure, so the shape of the wave is
 *  testable without a canvas. */
export function waveBars(history: WaveHistory, head: number, g: WaveGeometry): WaveBar[] {
  const pitch = g.bar + g.gap;
  if (!(pitch > 0) || !(g.width > 0) || !(g.height > 0)) return [];
  const span = g.mode === "center" ? g.width / 2 : g.width;
  const newest = Math.floor(head);
  const out: WaveBar[] = [];
  for (let k = newest; ; k--) {
    // Distance of the bar's centre from where bars appear: it enters half a
    // pitch beyond the edge (or the middle) and glides one pitch per bar.
    const d = (head - k - 0.5) * pitch;
    if (d > span + pitch / 2) break;
    if (d < -pitch / 2) continue;
    const level = history.at(k);
    const height = Math.max(g.bar, Math.min(g.height, g.bar + level * (g.height - g.bar)));
    if (g.mode === "center") {
      // Bars fade as they travel out; the middle is the present.
      const t = Math.min(1, Math.max(0, d / span));
      const alpha = 1 - 0.7 * t * t;
      out.push({ x: g.width / 2 + d, height, alpha });
      if (d > pitch / 4) out.push({ x: g.width / 2 - d, height, alpha });
    } else {
      // The older half of the strip fades toward its start.
      const t = Math.min(1, Math.max(0, (span - d) / (span * 0.5)));
      const alpha = 0.16 + 0.84 * t;
      out.push({ x: g.rtl ? d : g.width - d, height, alpha });
    }
  }
  return out;
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const PERFORMANCE_EVENT = "polyth:desktop-performance-changed";

/** The same switches the shell's own motion honours: the OS preference,
 *  Reduce animations and Low resource mode. */
export function waveMotionAllowed(): boolean {
  if (typeof document === "undefined") return false;
  if (document.documentElement.dataset.reduceAnimations === "true") return false;
  if (document.body?.dataset.desktopLowResource === "true") return false;
  return !(typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(REDUCED_MOTION).matches);
}

function subscribeMotion(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const media = typeof window.matchMedia === "function" ? window.matchMedia(REDUCED_MOTION) : null;
  media?.addEventListener?.("change", listener);
  window.addEventListener(PERFORMANCE_EVENT, listener);
  return () => {
    media?.removeEventListener?.("change", listener);
    window.removeEventListener(PERFORMANCE_EVENT, listener);
  };
}

export function useWaveMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, waveMotionAllowed, () => false);
}

const cssPx = (style: CSSStyleDeclaration, name: string, fallback: number): number => {
  const value = Number.parseFloat(style.getPropertyValue(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

interface Painter extends WaveGeometry {
  color: string;
  dpr: number;
}

function measure(canvas: HTMLCanvasElement): Painter {
  const style = getComputedStyle(canvas);
  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const backingWidth = Math.round(width * dpr);
  const backingHeight = Math.round(height * dpr);
  if (canvas.width !== backingWidth) canvas.width = backingWidth;
  if (canvas.height !== backingHeight) canvas.height = backingHeight;
  return {
    width,
    height,
    bar: cssPx(style, "--mic-wave-bar", 3),
    gap: cssPx(style, "--mic-wave-gap", 2),
    mode: style.getPropertyValue("--mic-wave-mode").trim() === "center" ? "center" : "scroll",
    rtl: style.direction === "rtl",
    color: style.color,
    dpr,
  };
}

function paint(ctx: CanvasRenderingContext2D, history: WaveHistory, p: Painter): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(p.dpr, 0, 0, p.dpr, 0, 0);
  ctx.fillStyle = p.color;
  const mid = p.height / 2;
  const radius = p.bar / 2;
  const rounded = typeof ctx.roundRect === "function";
  for (const bar of waveBars(history, history.head(), p)) {
    ctx.globalAlpha = bar.alpha;
    const x = bar.x - p.bar / 2;
    const y = mid - bar.height / 2;
    if (rounded) {
      ctx.beginPath();
      ctx.roundRect(x, y, p.bar, bar.height, radius);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, p.bar, bar.height);
    }
  }
  ctx.globalAlpha = 1;
}

/** The live waveform. Draws nothing (and schedules no frames) while CSS hides
 *  it, e.g. in a header placement. */
export function RecordingWave({ history }: { history: WaveHistory }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || typeof requestAnimationFrame !== "function") return;
    let ctx: CanvasRenderingContext2D | null = null;
    try { ctx = canvas.getContext("2d"); } catch { ctx = null; }
    if (!ctx) return;
    const context = ctx;
    let painter = measure(canvas);
    let frame = 0;
    const draw = () => {
      frame = 0;
      if (painter.width <= 0 || painter.height <= 0) return;
      paint(context, history, painter);
      frame = requestAnimationFrame(draw);
    };
    const restart = () => {
      painter = measure(canvas);
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(restart) : null;
    observer?.observe(canvas);
    // A theme change recolours the bars on the next frame.
    window.addEventListener("polyth:theme", restart);
    frame = requestAnimationFrame(draw);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      frame = -1;
      observer?.disconnect();
      window.removeEventListener("polyth:theme", restart);
    };
  }, [history]);
  return <canvas ref={ref} className="mic-wave" aria-hidden="true" />;
}
