// What the person chose for the focus timer: segment lengths, the cycle and
// how a finished segment announces itself. Account-wide (the web entry
// registers it as the `package.focus-timer` UI preference), so it follows the
// person to every device. Parsing clamps every field, so a hand-edited or
// older value can never stall the timer.

export const SOUND_IDS = ["chime", "bell", "digital", "soft"] as const;
export type SoundId = (typeof SOUND_IDS)[number];

export interface FocusTimerSettings {
  /** Minutes of one focus segment. */
  focusMin: number;
  /** Minutes of a short break. */
  shortMin: number;
  /** Minutes of the long break that closes a cycle. */
  longMin: number;
  /** Focus segments in one cycle; the last one is followed by the long break. */
  rounds: number;
  /** A break starts on its own when focus ends. */
  autoStartBreaks: boolean;
  /** Focus starts on its own when a break ends. */
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
}

export const DEFAULT_SETTINGS: Readonly<FocusTimerSettings> = Object.freeze({
  focusMin: 25,
  shortMin: 5,
  longMin: 15,
  rounds: 4,
  autoStartBreaks: false,
  autoStartFocus: false,
  sound: true,
  soundId: "chime",
  volume: 0.6,
  repeat: 2,
  flash: true,
  color: true,
  system: false,
});

export const LIMITS = Object.freeze({
  focusMin: { min: 1, max: 180 },
  shortMin: { min: 1, max: 60 },
  longMin: { min: 1, max: 120 },
  rounds: { min: 1, max: 12 },
  repeat: { min: 1, max: 5 },
});

type NumericKey = keyof typeof LIMITS;

export function clampSetting(key: NumericKey, value: number): number {
  const { min, max } = LIMITS[key];
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS[key];
  return Math.min(max, Math.max(min, Math.round(value)));
}

const bool = (value: unknown, fallback: boolean): boolean => typeof value === "boolean" ? value : fallback;
const num = (key: NumericKey, value: unknown): number =>
  typeof value === "number" ? clampSetting(key, value) : DEFAULT_SETTINGS[key];

export function parseSettings(raw: unknown): FocusTimerSettings {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const soundId = SOUND_IDS.includes(value.soundId as SoundId) ? value.soundId as SoundId : DEFAULT_SETTINGS.soundId;
  const volume = typeof value.volume === "number" && Number.isFinite(value.volume)
    ? Math.min(1, Math.max(0, Math.round(value.volume * 100) / 100))
    : DEFAULT_SETTINGS.volume;
  return {
    focusMin: num("focusMin", value.focusMin),
    shortMin: num("shortMin", value.shortMin),
    longMin: num("longMin", value.longMin),
    rounds: num("rounds", value.rounds),
    autoStartBreaks: bool(value.autoStartBreaks, DEFAULT_SETTINGS.autoStartBreaks),
    autoStartFocus: bool(value.autoStartFocus, DEFAULT_SETTINGS.autoStartFocus),
    sound: bool(value.sound, DEFAULT_SETTINGS.sound),
    soundId,
    volume,
    repeat: num("repeat", value.repeat),
    flash: bool(value.flash, DEFAULT_SETTINGS.flash),
    color: bool(value.color, DEFAULT_SETTINGS.color),
    system: bool(value.system, DEFAULT_SETTINGS.system),
  };
}

export function sameSettings(a: FocusTimerSettings, b: FocusTimerSettings): boolean {
  return (Object.keys(DEFAULT_SETTINGS) as Array<keyof FocusTimerSettings>).every((key) => a[key] === b[key]);
}
