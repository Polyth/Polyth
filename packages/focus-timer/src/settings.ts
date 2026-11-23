// What the person chose for the focus timer: the cycle that runs (a
// ready-made one or one of their own, src/cycles.ts), the countdown's name,
// the flow and how a finished segment announces itself. Account-wide (the web
// entry registers it as the `package.focus-timer` UI preference), so it
// follows the person to every device. Parsing clamps every field, so a
// hand-edited or older value can never stall the timer.
import {
  BUILTIN_CYCLES,
  classicSteps,
  clampMinutes,
  cycleExists,
  DEFAULT_CYCLE_ID,
  findCycle,
  LABEL_MAX,
  normalizeLabel,
  parseCycles,
  sameCycles,
  type CycleSet,
} from "./cycles.ts";

export { LABEL_MAX, normalizeLabel };

export const SOUND_IDS = ["chime", "bell", "digital", "soft"] as const;
export type SoundId = (typeof SOUND_IDS)[number];

export interface FocusTimerSettings {
  /** The person's own cycles. */
  cycles: CycleSet[];
  /** The cycle that runs: one of `cycles` or a built-in `builtin:<preset>`. */
  cycleId: string;
  /** A break starts on its own when the step before it ends. */
  autoStartBreaks: boolean;
  /** A focus step starts on its own when the step before it ends. */
  autoStartFocus: boolean;
  /** Play a sound when a segment ends. */
  sound: boolean;
  soundId: SoundId;
  /** 0..1. */
  volume: number;
  /** How many times the sound plays. */
  repeat: number;
  /** The window (and the screen's edge) pulses when a segment ends. */
  flash: boolean;
  /** The window takes the segment's colour while it runs and fills with it
   *  when the segment ends. */
  color: boolean;
  /** A system notification while Polyth is in the background. */
  system: boolean;
  /** The person's name for the plain countdown; "" keeps the built-in one. */
  countdownLabel: string;
}

export const DEFAULT_SETTINGS: Readonly<FocusTimerSettings> = Object.freeze({
  cycles: [],
  cycleId: DEFAULT_CYCLE_ID,
  autoStartBreaks: false,
  autoStartFocus: false,
  sound: true,
  soundId: "chime",
  volume: 0.6,
  repeat: 2,
  flash: true,
  color: true,
  system: false,
  countdownLabel: "",
});

export const LIMITS = Object.freeze({
  repeat: { min: 1, max: 5 },
});

type NumericKey = keyof typeof LIMITS;

export function clampSetting(key: NumericKey, value: number): number {
  const { min, max } = LIMITS[key];
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS[key];
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** The cycle that runs. */
export function activeCycle(settings: Pick<FocusTimerSettings, "cycles" | "cycleId">): CycleSet {
  return findCycle(settings.cycles, settings.cycleId);
}

const bool = (value: unknown, fallback: boolean): boolean => typeof value === "boolean" ? value : fallback;
const num = (key: NumericKey, value: unknown): number =>
  typeof value === "number" ? clampSetting(key, value) : DEFAULT_SETTINGS[key];

/** Settings saved before cycles had fixed lengths, a round count and a label
 *  per phase. Anything other than the defaults becomes the person's own
 *  cycle, so an upgrade keeps exactly the timer they had. */
function legacyCycle(value: Record<string, unknown>): CycleSet | null {
  const minutes = (key: string, fallback: number, max: number): number =>
    typeof value[key] === "number" ? Math.min(max, clampMinutes(value[key] as number)) : fallback;
  const focusMin = minutes("focusMin", 25, 180);
  const shortMin = minutes("shortMin", 5, 60);
  const longMin = minutes("longMin", 15, 120);
  const rounds = typeof value.rounds === "number" && Number.isFinite(value.rounds)
    ? Math.min(8, Math.max(1, Math.round(value.rounds)))
    : 4;
  const names = { focus: normalizeLabel(value.focusLabel), short: normalizeLabel(value.shortLabel), long: normalizeLabel(value.longLabel) };
  const changed = focusMin !== 25 || shortMin !== 5 || longMin !== 15 || rounds !== 4 || names.focus || names.short || names.long;
  if (!changed) return null;
  const name = [names.focus, names.short].filter(Boolean).join(" / ");
  return { id: "c-legacy", name: normalizeLabel(name), preset: "pomodoro", steps: classicSteps(focusMin, shortMin, longMin, rounds, names) };
}

export function parseSettings(raw: unknown): FocusTimerSettings {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const soundId = SOUND_IDS.includes(value.soundId as SoundId) ? value.soundId as SoundId : DEFAULT_SETTINGS.soundId;
  const volume = typeof value.volume === "number" && Number.isFinite(value.volume)
    ? Math.min(1, Math.max(0, Math.round(value.volume * 100) / 100))
    : DEFAULT_SETTINGS.volume;
  let cycles = parseCycles(value.cycles);
  let cycleId = typeof value.cycleId === "string" ? value.cycleId : DEFAULT_CYCLE_ID;
  if (!("cycles" in value) && !("cycleId" in value)) {
    const legacy = legacyCycle(value);
    if (legacy) {
      cycles = [legacy];
      cycleId = legacy.id;
    }
  }
  if (!cycleExists(cycles, cycleId)) cycleId = DEFAULT_CYCLE_ID;
  return {
    cycles,
    cycleId,
    autoStartBreaks: bool(value.autoStartBreaks, DEFAULT_SETTINGS.autoStartBreaks),
    autoStartFocus: bool(value.autoStartFocus, DEFAULT_SETTINGS.autoStartFocus),
    sound: bool(value.sound, DEFAULT_SETTINGS.sound),
    soundId,
    volume,
    repeat: num("repeat", value.repeat),
    flash: bool(value.flash, DEFAULT_SETTINGS.flash),
    color: bool(value.color, DEFAULT_SETTINGS.color),
    system: bool(value.system, DEFAULT_SETTINGS.system),
    countdownLabel: normalizeLabel(value.countdownLabel),
  };
}

export function sameSettings(a: FocusTimerSettings, b: FocusTimerSettings): boolean {
  return (Object.keys(DEFAULT_SETTINGS) as Array<keyof FocusTimerSettings>).every((key) =>
    key === "cycles" ? sameCycles(a.cycles, b.cycles) : a[key] === b[key]);
}

export { BUILTIN_CYCLES };
