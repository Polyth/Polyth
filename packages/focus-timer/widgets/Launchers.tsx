// The timer's ways in besides the window itself: the rail launcher's live
// mark (the stopwatch fills as the segment runs) and a placeable chip for the
// status bar and headers that shows the time left while a timer runs.
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { formatClock, progress, remainingMs } from "../src/timerModel.ts";
import { TimerMark } from "./glyphs.tsx";
import { phaseLabel, toneOf } from "./labels.ts";
import { timerController, useNow, useTimer } from "./runtime.ts";

type MarkProps = { size?: number; strokeWidth?: number; "aria-hidden"?: boolean };

export function RailMark({ size = 18, strokeWidth = 1.75 }: MarkProps) {
  const snapshot = useTimer();
  const timer = snapshot?.timer;
  const now = useNow(timer?.status === "running" ? timer.endsAt : null);
  if (!timer) return <TimerMark size={size} strokeWidth={strokeWidth} />;
  const active = timer.status !== "idle";
  return (
    <TimerMark
      size={size}
      strokeWidth={strokeWidth}
      progress={active ? progress(timer, now) : null}
      done={Boolean(timer.finished && !timer.finished.stale)}
      phase={toneOf(timer)}
    />
  );
}

/** Shown only while a timer runs or is paused (see `chipAvailable`). */
export function TimerChip() {
  const snapshot = useTimer();
  const timer = snapshot?.timer;
  const now = useNow(timer?.status === "running" ? timer.endsAt : null);
  if (!timer || (timer.status === "idle" && !timer.finished)) return null;
  const tone = toneOf(timer);
  const label = `${phaseLabel(tone, snapshot?.settings)} ${formatClock(remainingMs(timer, now))}`;
  return (
    <button
      type="button"
      className="focus-timer-chip-widget"
      data-tone={tone}
      data-status={timer.status}
      data-done={timer.finished && !timer.finished.stale ? true : undefined}
      title={tr("focustimer.action.show")}
      aria-label={`${label}. ${tr("focustimer.action.show")}`}
      onClick={() => {
        const controller = timerController();
        controller?.acknowledge();
        controller?.show();
      }}
    >
      <TimerMark size={14} progress={timer.status === "idle" ? null : progress(timer, now)} phase={tone} />
      <span className="focus-timer-chip-time">{formatClock(remainingMs(timer, now))}</span>
    </button>
  );
}
