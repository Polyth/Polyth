import { useRef, useState } from "react";
import { fmtTokens } from "../format.ts";
import { tr } from "../i18n/index.ts";
import { contextTone, formatContextPercent, type ContextGauge } from "../reduce.ts";
import { contextUsageLabel } from "../sessionMetrics.ts";
import type { ContextGaugeDisplay } from "./ContextLiquid.tsx";
import { ContextUsageCard } from "./SessionActivityDetails.tsx";
import SlotHost from "./slots/SlotHost.ts";
import { Button, Popover } from "./ui/index.ts";

/** The sector is a stroke as wide as its own radius: r = 3.5 with a 7-unit
 *  stroke paints a solid disc of radius 7, and a dash of the circumference
 *  share paints the pie slice. Explicit lengths, not `pathLength`, keep WebKit
 *  and Chromium on the same geometry. */
const SECTOR_R = 3.5;
const SECTOR_C = 2 * Math.PI * SECTOR_R;

/** The pie stays on the composer line of every open session, even while the
 *  runtime reports nothing measurable (a fresh leg, a compaction, an epoch
 *  replacement or a catalog without the window): it is also the way into the
 *  context card, its cache controls and compaction. Unmeasured windows draw
 *  the dashed empty ring. */
export function contextPieVisible(gauge: ContextGauge | null | undefined): gauge is ContextGauge {
  return !!gauge;
}

/** "Context 42% · 84.0k / 200.0k" — the accessible name and the desktop
 *  tooltip. Estimated values keep their `~` mark. */
export function contextPieLabel(gauge: ContextGauge): string {
  const percent = formatContextPercent(gauge);
  const usage = contextUsageLabel(gauge, percent, null, tr("context.usageUnavailable"), fmtTokens);
  if (!percent) return usage;
  const head = tr("context.indicatorPercent", { percent });
  return usage === percent ? head : `${head} · ${usage}`;
}

/** The pie glyph alone, so tests and other surfaces can reuse the geometry. */
export function ContextPieGlyph({ gauge }: { gauge: ContextGauge }) {
  const percent = gauge.percent === null ? null : Math.min(100, Math.max(0, gauge.percent));
  const dash = percent === null ? 0 : (SECTOR_C * percent) / 100;
  return (
    <svg className="context-pie-glyph" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <circle className="context-pie-track" cx="10" cy="10" r="8.75" />
      {percent !== null && (
        <circle
          className="context-pie-sector"
          cx="10"
          cy="10"
          r={SECTOR_R}
          transform="rotate(-90 10 10)"
          style={{ strokeDasharray: `${dash.toFixed(3)} ${SECTOR_C.toFixed(3)}` }}
        />
      )}
    </svg>
  );
}

/** Context-window pie beside the composer's thinking effort. It renders the
 *  same gauge as the running action's liquid and the session overview: the
 *  slice follows the window share, warms to amber at 70% and red at 90%,
 *  dims while the last known value awaits fresh telemetry, and shows a dashed
 *  empty ring when the window limit is unknown or nothing is measured yet.
 *  Activation opens the shared context card — the only way to read the exact
 *  numbers on touch, where a tooltip never appears. The card also says when
 *  the agent was asked to delegate (`pressureLevel`), hosts package details
 *  such as cache warmth (`composer.context.details`) and offers compaction
 *  when the harness supports it. */
export default function ContextPie({ gauge, phone = false, sessionId, projectId, pressureLevel, compact }: {
  gauge: ContextGaugeDisplay | null;
  phone?: boolean;
  sessionId?: string;
  projectId?: string;
  pressureLevel?: number | undefined;
  compact?: { pending: boolean; disabled: boolean; run: () => void };
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // A tap while the phone editor is focused keeps the keyboard up; handing
  // focus back to the pie on close would blur the editor and collapse the
  // composer. Only a trigger that held focus itself gets it back.
  const [restoreFocus, setRestoreFocus] = useState(false);
  const visible = contextPieVisible(gauge);
  // A session without a gauge takes its open card with it; it must not pop
  // back open with the next one.
  if (!visible && open) setOpen(false);
  if (!visible) return null;
  const label = contextPieLabel(gauge);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="config-chip composer-context-pie"
        data-level={contextTone(gauge)}
        data-quality={gauge.quality}
        data-pending={gauge.pending ? "true" : undefined}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (open) { setOpen(false); return; }
          setRestoreFocus(document.activeElement === triggerRef.current);
          setOpen(true);
        }}
      >
        <ContextPieGlyph gauge={gauge} />
      </button>
      {open && (
        <Popover
          open
          onClose={() => setOpen(false)}
          anchorRef={triggerRef}
          side="up"
          align="start"
          compact={phone}
          restoreFocus={restoreFocus}
          ariaLabel={tr("capabilities.context")}
          className="composer-context-pop"
        >
          <ContextUsageCard gauge={gauge} />
          {pressureLevel !== undefined && (
            <p className="composer-context-note">
              {tr("context.delegationHint", { percent: `${Math.round(pressureLevel * 100)}%` })}
            </p>
          )}
          <SlotHost slot="composer.context.details" context={{ sessionId: sessionId ?? null, projectId: projectId ?? null }} />
          {compact && (
            <Button
              type="button"
              size="sm"
              block
              className="composer-context-compact"
              title={tr("commands.compactDescription")}
              disabled={compact.disabled || compact.pending}
              busy={compact.pending}
              onClick={compact.run}
            >
              {tr("context.compact")}
            </Button>
          )}
        </Popover>
      )}
    </>
  );
}
