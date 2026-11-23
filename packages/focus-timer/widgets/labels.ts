// What a segment is called on screen: the person's own label when they gave
// one (settings.ts), the built-in phase name otherwise. The window, the pill,
// the status chip and the time-up notices all read it here.
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { customLabel, type FocusTimerSettings, type LabelKey, type LabelTone } from "../src/settings.ts";
import type { TimerState } from "../src/timerModel.ts";

export type Tone = LabelTone;

export function toneOf(timer: Pick<TimerState, "mode" | "phase">): Tone {
  return timer.mode === "countdown" ? "countdown" : timer.phase;
}

export function builtInLabel(tone: Tone): string {
  if (tone === "countdown") return tr("focustimer.countdown");
  return tr(`focustimer.phase.${tone}`);
}

export function phaseLabel(tone: Tone, settings?: Pick<FocusTimerSettings, LabelKey>): string {
  return (settings && customLabel(settings, tone)) || builtInLabel(tone);
}
