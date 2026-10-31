// The voice orb: one shape that shows whose turn it is and how loud. It reads
// the live input/output level straight from the controller on animation
// frames — ~60 updates a second must never re-render React — and paints with
// the theme's own accent and signal tokens. Reduced motion (system or the
// app's "Reduce animations") keeps the colors and drops the movement.
import { useEffect, useRef } from "react";
import type { VoiceModeController, VoicePhase } from "./controller.ts";

type Rgb = readonly [number, number, number];

interface Palette {
  core: Rgb;
  edge: Rgb;
  glow: Rgb;
}

/** Resolve any CSS color (hex, rgb(), color-mix of tokens) to sRGB 0..255 via
 *  the element's computed color, once per phase rather than per frame. */
function resolveRgb(element: HTMLElement, color: string, fallback: Rgb): Rgb {
  const previous = element.style.color;
  element.style.color = color;
  const computed = getComputedStyle(element).color;
  element.style.color = previous;
  const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(computed);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const srgb = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(computed);
  if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255];
  return fallback;
}

const rgba = ([r, g, b]: Rgb, alpha: number): string =>
  `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;

const reducedMotion = (): boolean =>
  (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches)
  || document.documentElement.dataset.reduceAnimations === "true"
  || document.body?.dataset.desktopLowResource === "true";

function palette(canvas: HTMLCanvasElement, phase: VoicePhase): Palette {
  const accent = resolveRgb(canvas, "var(--accent)", [122, 162, 247]);
  const accentHi = resolveRgb(canvas, "var(--accent-hi, var(--accent))", accent);
  switch (phase) {
    case "speaking": {
      const purple = resolveRgb(canvas, "var(--purple, var(--accent))", accent);
      return { core: accentHi, edge: purple, glow: purple };
    }
    case "paused": {
      const muted = resolveRgb(canvas, "var(--muted)", [143, 150, 168]);
      return { core: resolveRgb(canvas, "var(--text-dim)", muted), edge: muted, glow: muted };
    }
    case "error": {
      const red = resolveRgb(canvas, "var(--red)", [247, 118, 142]);
      return { core: red, edge: red, glow: red };
    }
    default:
      return { core: accentHi, edge: accent, glow: accent };
  }
}

/** Resting amplitude and drift speed per phase, before the live level. */
function motion(phase: VoicePhase): { base: number; speed: number; gain: number } {
  switch (phase) {
    case "listening": return { base: 0.035, speed: 0.6, gain: 0.22 };
    case "hearing": return { base: 0.05, speed: 0.9, gain: 0.28 };
    case "speaking": return { base: 0.05, speed: 1.1, gain: 0.3 };
    case "sending":
    case "starting": return { base: 0.06, speed: 0.45, gain: 0 };
    default: return { base: 0.015, speed: 0.2, gain: 0 };
  }
}

const POINTS = 9;

export default function Orb({ controller, phase, size, onActivate, label }: {
  controller: VoiceModeController;
  phase: VoicePhase;
  size: number;
  onActivate(): void;
  label: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    let frame: number | null = null;
    let shown = 0;
    let time = 0;
    let last = performance.now();
    const still = reducedMotion();
    const colors = palette(canvas, phaseRef.current);

    const draw = (now: number) => {
      const current = phaseRef.current;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const { base, speed, gain } = motion(current);
      const levels = controller.getLevels();
      const target = current === "speaking" ? levels.output : LISTENING.has(current) ? levels.input : 0;
      // Rise quickly with the voice, settle slowly between words.
      shown += (target - shown) * (target > shown ? 0.35 : 0.08);
      time += dt * speed;
      const center = size / 2;
      const radius = size * 0.31 * (1 + (still ? 0 : shown * 0.12));
      const amplitude = still ? 0 : base + shown * gain;
      // Thinking breathes slowly so a long tool run still reads as alive.
      const breathe = still || gain > 0 ? 1 : 1 + Math.sin(time * 3.2) * 0.025;

      context.clearRect(0, 0, size, size);
      const glow = context.createRadialGradient(center, center, radius * 0.6, center, center, size / 2);
      glow.addColorStop(0, rgba(colors.glow, 0.28 + shown * 0.25));
      glow.addColorStop(1, rgba(colors.glow, 0));
      context.fillStyle = glow;
      context.fillRect(0, 0, size, size);

      const points: Array<[number, number]> = [];
      for (let i = 0; i < POINTS; i++) {
        const angle = (i / POINTS) * Math.PI * 2;
        const wobble = Math.sin(time * 1.3 + i * 1.7) * 0.5
          + Math.sin(time * 0.7 + i * 2.9) * 0.3
          + Math.sin(time * 2.1 + i * 0.6) * 0.2;
        const r = radius * breathe * (1 + amplitude * wobble);
        points.push([center + Math.cos(angle) * r, center + Math.sin(angle) * r]);
      }
      context.beginPath();
      for (let i = 0; i < POINTS; i++) {
        const [x0, y0] = points[i]!;
        const [x1, y1] = points[(i + 1) % POINTS]!;
        const mx = (x0 + x1) / 2;
        const my = (y0 + y1) / 2;
        if (i === 0) {
          const [px, py] = points[POINTS - 1]!;
          context.moveTo((px + x0) / 2, (py + y0) / 2);
        }
        context.quadraticCurveTo(x0, y0, mx, my);
      }
      context.closePath();
      const sheen = time * 0.6;
      const fill = context.createLinearGradient(
        center + Math.cos(sheen) * radius, center + Math.sin(sheen) * radius,
        center - Math.cos(sheen) * radius, center - Math.sin(sheen) * radius,
      );
      fill.addColorStop(0, rgba(colors.core, 1));
      fill.addColorStop(1, rgba(colors.edge, 1));
      context.fillStyle = fill;
      context.fill();
      // A soft inner highlight gives the shape depth without a border.
      const highlight = context.createRadialGradient(
        center - radius * 0.35, center - radius * 0.4, radius * 0.05,
        center - radius * 0.2, center - radius * 0.2, radius * 1.1,
      );
      highlight.addColorStop(0, "rgba(255, 255, 255, 0.34)");
      highlight.addColorStop(1, "rgba(255, 255, 255, 0)");
      context.fillStyle = highlight;
      context.fill();

      if (!still && current !== "off") frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [controller, size, phase]);

  return (
    <button
      type="button"
      className="voice-orb"
      data-phase={phase}
      aria-label={label}
      title={label}
      onClick={onActivate}
      style={{ inlineSize: size, blockSize: size }}
    >
      <canvas ref={canvasRef} aria-hidden="true" style={{ inlineSize: size, blockSize: size }} />
    </button>
  );
}

const LISTENING = new Set<VoicePhase>(["listening", "hearing"]);
