import type { CoachStore, CoachTone, CoachInitiative } from "./index.ts";

export interface CoachSetupInput {
  confirm: true;
  timeZone: string;
  tone: CoachTone;
  initiative: CoachInitiative;
  challengeAssumptions: boolean;
  dailyCheckIn: boolean;
  dailyMinuteOfDay: number;
  weeklyReview: boolean;
  weeklyDay: number;
  weeklyMinuteOfDay: number;
}

const invalid = (message: string) => Object.assign(new Error(message), { code: "invalid-input" });

export function parseCoachSetup(value: Record<string, unknown>): CoachSetupInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Expected an object");
  if (value.confirm !== true) throw invalid("Confirm Coach preferences explicitly");
  const bool = (key: string): boolean => {
    if (typeof value[key] !== "boolean") throw invalid(`${key} must be explicitly true or false`);
    return value[key] as boolean;
  };
  const choice = <T extends string>(key: string, options: readonly T[]): T => {
    if (!options.includes(value[key] as T)) throw invalid(`Invalid ${key}`);
    return value[key] as T;
  };
  const integer = (key: string, maximum: number): number => {
    const n = value[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > maximum) throw invalid(`Invalid ${key}`);
    return n;
  };
  const timeZone = typeof value.timeZone === "string" ? value.timeZone.trim() : "";
  if (!timeZone || timeZone.length > 120) throw invalid("Choose a valid IANA time zone");
  try { new Intl.DateTimeFormat("en", { timeZone }).format(0); }
  catch { throw invalid("Choose a valid IANA time zone"); }
  return {
    confirm: true, timeZone,
    tone: choice("tone", ["supportive", "balanced", "direct"]),
    initiative: choice("initiative", ["reactive", "balanced", "proactive"]),
    challengeAssumptions: bool("challengeAssumptions"),
    dailyCheckIn: bool("dailyCheckIn"),
    dailyMinuteOfDay: integer("dailyMinuteOfDay", 1439),
    weeklyReview: bool("weeklyReview"),
    weeklyDay: integer("weeklyDay", 6),
    weeklyMinuteOfDay: integer("weeklyMinuteOfDay", 1439),
  };
}

/** Explicit UI confirmation uses the same deterministic profile and reminder
 * operations as conversational setup. It cannot accept a model proposal. */
export function completeCoachSetup(
  store: Pick<CoachStore, "updateProfile">,
  input: CoachSetupInput,
  configure?: (input: CoachSetupInput) => void,
) {
  if ((input.dailyCheckIn || input.weeklyReview) && !configure) {
    throw Object.assign(new Error("Schedule is unavailable. Turn reminders off to finish setup."), { code: "unavailable" });
  }
  configure?.(input);
  return store.updateProfile({
    timeZone: input.timeZone,
    tone: input.tone,
    initiative: input.initiative,
    challengeAssumptions: input.challengeAssumptions,
    onboardingState: "complete",
  });
}
