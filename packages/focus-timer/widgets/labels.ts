// What things are called and coloured on screen: a step's own name when the
// person gave one, else its built-in name (preset or kind); a cycle's own name,
// else the ready-made one it is or was copied from. The window, the pill, the
// chip, Settings and the time-up notices all read them here.
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { isBuiltinCycle, type CycleSet, type CycleStep } from "../src/cycles.ts";
import type { FocusTimerSettings } from "../src/settings.ts";
import { currentStep, type TimerState } from "../src/timerModel.ts";

/** A step colour, or `countdown` for the plain timer (styles.css). */
export type Tone = CycleStep["color"] | "countdown";

export function stepLabel(step: CycleStep): string {
  if (step.name) return step.name;
  if (step.preset) return tr(`focustimer.step.${step.preset}`);
  return tr(step.kind === "focus" ? "focustimer.step.focus" : "focustimer.step.break");
}

export function countdownLabel(settings?: Pick<FocusTimerSettings, "countdownLabel">): string {
  return settings?.countdownLabel || tr("focustimer.countdown");
}

export function cycleLabel(cycle: CycleSet): string {
  if (cycle.name) return cycle.name;
  if (!cycle.preset) return tr("focustimer.cycle.untitled");
  const preset = tr(`focustimer.cycle.${cycle.preset}`);
  return isBuiltinCycle(cycle.id) ? preset : tr("focustimer.cycle.copy", { name: preset });
}

export function toneOf(timer: Pick<TimerState, "mode" | "step">, settings: FocusTimerSettings): Tone {
  return currentStep(timer, settings)?.color ?? "countdown";
}

/** The name of what the timer is on: the step, or the countdown. */
export function segmentLabel(timer: Pick<TimerState, "mode" | "step">, settings: FocusTimerSettings): string {
  const step = currentStep(timer, settings);
  return step ? stepLabel(step) : countdownLabel(settings);
}

/** Each step colour as CSS, for swatches the host draws outside the timer's
 *  own styles (styles.css defines the same as --ft-color-*). */
export const STEP_COLOR_CSS: Readonly<Record<CycleStep["color"], string>> = Object.freeze({
  accent: "var(--accent)",
  red: "var(--red)",
  amber: "var(--amber)",
  green: "var(--green)",
  teal: "color-mix(in srgb, var(--green) 50%, var(--blue))",
  blue: "var(--blue)",
  purple: "var(--purple)",
  pink: "color-mix(in srgb, var(--red) 55%, var(--purple))",
});
