// Voice mode preferences. Voice, speed and recognition engines belong to the
// Voice (dictation) settings; these only shape the conversation itself.
import { VOICE_COMMAND_IDS, parsePhraseList, type VoiceCommandId } from "./commands.ts";

export type VoiceTurnTaking = "auto" | "manual";
export type VoicePause = "quick" | "normal" | "patient";
export type VoiceBargeIn = "auto" | "on" | "off";
export type VoiceRecognitionChoice = "dictation" | "browser";
/** Compact everywhere unless the person chose full screen; the dock's expand
 *  button opens full screen for one conversation. */
export type VoicePresentation = "compact" | "immersive";
/** Spoken replies and sounds, or a silent control mode (voice in, no audio out). */
export type VoiceFeedback = "voice" | "silent";
/** Reasoning read aloud while the agent works: never, its headline, or all of it. */
export type VoiceThoughts = "off" | "brief" | "full";
/** How often work is narrated: grouped key moments, or every step. */
export type VoiceNarrationCadence = "key" | "every";
/** Who words the narration: built-in phrases, or the account's small model. */
export type VoiceNarrator = "templates" | "model";

export interface VoiceModePrefs {
  /** Send a turn when the speaker pauses, or only on an explicit tap. */
  turnTaking: VoiceTurnTaking;
  pause: VoicePause;
  /** Speaking over a reply stops it and starts listening. */
  bargeIn: VoiceBargeIn;
  recognition: VoiceRecognitionChoice;
  presentation: VoicePresentation;
  captions: boolean;
  sounds: boolean;
  feedback: VoiceFeedback;
  /** Spoken commands ("stop", "send now", …) act instead of being sent. */
  commands: boolean;
  /** Custom phrases per command; a missing command uses the defaults. */
  commandPhrases: Partial<Record<VoiceCommandId, string[]>>;
  /** Spoken asides while the agent works; its reply always comes first. */
  thoughts: VoiceThoughts;
  /** Say what the agent is doing (reading, editing, running tests…). */
  actions: boolean;
  narrationCadence: VoiceNarrationCadence;
  narrator: VoiceNarrator;
}

export const VOICE_MODE_PREFS_KEY = "polyth.voice-mode";

/** Silence that ends a spoken turn, per pause preference. */
export const PAUSE_MS: Readonly<Record<VoicePause, number>> = {
  quick: 650,
  normal: 1_000,
  patient: 1_700,
};

export function defaultVoiceModePrefs(): VoiceModePrefs {
  return {
    turnTaking: "auto",
    pause: "normal",
    bargeIn: "auto",
    recognition: "dictation",
    presentation: "compact",
    captions: true,
    sounds: true,
    feedback: "voice",
    commands: true,
    commandPhrases: {},
    thoughts: "off",
    actions: false,
    narrationCadence: "key",
    narrator: "templates",
  };
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : fallback;

export function parseVoiceModePrefs(raw: string | null | undefined): VoiceModePrefs {
  const d = defaultVoiceModePrefs();
  let data: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw ?? "") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    return d;
  }
  const known: VoiceModePrefs = {
    turnTaking: oneOf(data.turnTaking, ["auto", "manual"], d.turnTaking),
    pause: oneOf(data.pause, ["quick", "normal", "patient"], d.pause),
    bargeIn: oneOf(data.bargeIn, ["auto", "on", "off"], d.bargeIn),
    recognition: oneOf(data.recognition, ["dictation", "browser"], d.recognition),
    // The retired "auto" (full screen on phones) reads as the compact default.
    presentation: oneOf(data.presentation, ["compact", "immersive"], d.presentation),
    captions: typeof data.captions === "boolean" ? data.captions : d.captions,
    sounds: typeof data.sounds === "boolean" ? data.sounds : d.sounds,
    feedback: oneOf(data.feedback, ["voice", "silent"], d.feedback),
    commands: typeof data.commands === "boolean" ? data.commands : d.commands,
    commandPhrases: parseCommandPhrases(data.commandPhrases),
    thoughts: oneOf(data.thoughts, ["off", "brief", "full"], d.thoughts),
    actions: typeof data.actions === "boolean" ? data.actions : d.actions,
    narrationCadence: oneOf(data.narrationCadence, ["key", "every"], d.narrationCadence),
    narrator: oneOf(data.narrator, ["templates", "model"], d.narrator),
  };
  // Keys this client does not know (a newer client's settings) are carried
  // through untouched, so saving here does not erase them on other devices.
  const unknown = Object.fromEntries(Object.entries(data).filter(([key]) => !(key in known)));
  return { ...unknown, ...known };
}

function parseCommandPhrases(value: unknown): Partial<Record<VoiceCommandId, string[]>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Partial<Record<VoiceCommandId, string[]>> = {};
  for (const id of VOICE_COMMAND_IDS) {
    const list = (value as Record<string, unknown>)[id];
    if (!Array.isArray(list)) continue;
    out[id] = parsePhraseList(list.filter((item): item is string => typeof item === "string").join(",")).slice(0, 12);
  }
  return out;
}

/** Apple mobile WebKit routes playback to the earpiece (quietly) while the
 *  microphone is open, so automatic barge-in stays off there. */
export function isAppleMobile(nav: { userAgent?: string; platform?: string; maxTouchPoints?: number } | undefined): boolean {
  if (!nav) return false;
  const ua = nav.userAgent ?? "";
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  // iPadOS reports a desktop Mac user agent; touch support gives it away.
  return /Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1;
}

export function bargeInEnabled(prefs: Pick<VoiceModePrefs, "bargeIn">, nav: Parameters<typeof isAppleMobile>[0]): boolean {
  if (prefs.bargeIn === "on") return true;
  if (prefs.bargeIn === "off") return false;
  return !isAppleMobile(nav);
}
