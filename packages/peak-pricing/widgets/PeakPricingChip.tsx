// The chip's one presentation, shared by the composer indicator and the
// settings preview so the two can never drift. It owns markup and geometry
// only: the indicator supplies state, the accessible name and the handlers.
import { forwardRef, type ButtonHTMLAttributes } from "react";
import type { PricePhase } from "../src/schedule.ts";
import type { PeakPricingDisplay } from "./prefs.ts";

export interface PeakPricingChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  phase: PricePhase;
  display: PeakPricingDisplay;
  /** Progress through the current phase, 0–1 (the arc). */
  progress: number;
  /** "Peak" / "Off-peak". */
  stateLabel: string;
  /** Countdown text; read only in `full`. */
  remaining: string;
  /** Where the chip sits. The status bar draws it as one of its own segments
   *  (the host `.sb` primitive) instead of the composer's config chip. */
  surface?: PeakPricingSurface;
}

export type PeakPricingSurface = "composer" | "statusbar";

/** The 14px glyph keeps today's ring; dot-only draws a 16px one around an
 *  8px dot, the size the glyph needs to stand alone. */
const GLYPH = {
  chip: { size: 14, radius: 5.2 },
  dot: { size: 16, radius: 6.5 },
} as const;

const PeakPricingChip = forwardRef<HTMLButtonElement, PeakPricingChipProps>(function PeakPricingChip(
  { phase, display, progress, stateLabel, remaining, surface = "composer", className, ...button },
  ref,
) {
  const dot = display === "dot";
  const bar = surface === "statusbar";
  const { size, radius } = dot ? GLYPH.dot : GLYPH.chip;
  const center = size / 2;
  const classes = [
    // Dot-only has no chip chrome, so it does not take the chip primitive;
    // in the status bar every display is a bar segment.
    bar ? "sb sb-action" : dot ? "" : "config-chip",
    "peak-pricing-chip",
    className ?? "",
  ].filter(Boolean).join(" ");
  return (
    <button
      ref={ref}
      type="button"
      {...button}
      className={classes}
      data-phase={phase}
      data-display={display}
      {...(bar ? { "data-surface": surface } : {})}
    >
      <span className="peak-pricing-glyph" aria-hidden="true">
        <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
          <circle className="peak-pricing-ring-track" cx={center} cy={center} r={radius} />
          <circle
            className="peak-pricing-ring-value"
            cx={center}
            cy={center}
            r={radius}
            pathLength={100}
            strokeDasharray={`${Math.min(1, Math.max(0, progress)) * 100} 100`}
            transform={`rotate(-90 ${center} ${center})`}
          />
        </svg>
        <span className="peak-pricing-dot" />
      </span>
      {!dot && (
        <span className="peak-pricing-text">
          <span className="peak-pricing-state">{stateLabel}</span>
          {display === "full" && (
            <span className="peak-pricing-remaining" aria-hidden="true">{remaining}</span>
          )}
        </span>
      )}
    </button>
  );
});

export default PeakPricingChip;
