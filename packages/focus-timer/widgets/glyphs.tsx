// The timer's own glyphs (play, pause, skip, reset, compact, timer): the host
// icon set has no media controls. Drawn like the host's Lucide glyphs: 24-unit
// box, round caps, `currentColor` stroke at the size the control asks for.
import type { ReactNode } from "react";

export interface GlyphProps {
  size?: number | string;
  strokeWidth?: number | string;
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}

function glyph(children: ReactNode, filled = false) {
  return function Glyph({ size = 18, strokeWidth = 1.75, className, ...rest }: GlyphProps) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden={rest["aria-hidden"] ?? true}
        focusable="false"
      >
        {children}
      </svg>
    );
  };
}

export const PlayGlyph = glyph(<path d="M7 4.8v14.4a1 1 0 0 0 1.52.85l11.5-7.2a1 1 0 0 0 0-1.7L8.52 3.95A1 1 0 0 0 7 4.8Z" />, true);
export const PauseGlyph = glyph(<><rect x="6" y="4.5" width="4" height="15" rx="1.2" /><rect x="14" y="4.5" width="4" height="15" rx="1.2" /></>, true);
export const SkipGlyph = glyph(<><path d="M5 5.6v12.8a.9.9 0 0 0 1.4.75l9.2-6.4a.9.9 0 0 0 0-1.5L6.4 4.85A.9.9 0 0 0 5 5.6Z" /><path d="M19 5v14" /></>);
export const ResetGlyph = glyph(<><path d="M3 12a9 9 0 1 0 2.64-6.36L3 8.27" /><path d="M3 3v5.27h5.27" /></>);
export const CompactGlyph = glyph(<><path d="M4 14h6v6" /><path d="M20 10h-6V4" /><path d="m14 10 7-7" /><path d="m3 21 7-7" /></>);
export const CheckGlyph = glyph(<path d="M20 6 9 17l-5-5" />);
export const SpeakerGlyph = glyph(<><path d="M11 4.7 6.6 8.5H3.8a.8.8 0 0 0-.8.8v5.4c0 .44.36.8.8.8h2.8l4.4 3.8a.6.6 0 0 0 1-.46V5.16a.6.6 0 0 0-1-.46Z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" /></>);

/** The launcher mark: a stopwatch. While a timer runs its face fills with
 *  progress (`progress` 0..1) and a finished segment adds a dot. */
export function TimerMark({ size = 18, strokeWidth = 1.75, progress, done, phase }: GlyphProps & {
  progress?: number | null;
  done?: boolean;
  phase?: string;
}) {
  const active = typeof progress === "number";
  const angle = Math.min(0.9999, Math.max(0, progress ?? 0)) * Math.PI * 2;
  const cx = 12;
  const cy = 13.5;
  const r = 6.2;
  const x = cx + r * Math.sin(angle);
  const y = cy - r * Math.cos(angle);
  const large = angle > Math.PI ? 1 : 0;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="focus-timer-mark"
      data-phase={phase}
      data-active={active || undefined}
    >
      <circle cx={cx} cy={cy} r="8" />
      <path d="M10 2.5h4" />
      <path d="M12 2.5v3" />
      <path d="m19.2 6.3-1.4 1.4" />
      {active && angle > 0.02 && (
        <path
          className="focus-timer-mark-fill"
          d={`M${cx} ${cy}V${cy - r}A${r} ${r} 0 ${large} 1 ${x.toFixed(2)} ${y.toFixed(2)}Z`}
          stroke="none"
          fill="currentColor"
        />
      )}
      {!active && <path d="M12 13.5V9.8" />}
      {done && <circle className="focus-timer-mark-dot" cx="19.5" cy="4.5" r="3.4" stroke="none" />}
    </svg>
  );
}
