// Wizard structure: which steps each user level sees and when a step is
// complete. Pure, so the flow is unit-tested without rendering.
import { specProblems, USER_LEVELS, type MediaSpec, type UserLevel } from "../src/brief.ts";
import type { MediaKind } from "../src/index.ts";

export const WIZARD_STEPS = ["kind", "song", "style", "format", "models", "delivery", "review"] as const;
export type WizardStep = typeof WIZARD_STEPS[number];

/**
 * quick  — one screen: what, idea, song; smart defaults for everything else.
 * guided — five short steps with sensible defaults already chosen (the session
 *          model is a row on Format).
 * expert — every knob, including a per-work-part model step, delivery spec,
 *          rules and the editable brief.
 */
export function stepsFor(level: UserLevel): readonly WizardStep[] {
  if (level === "quick") return ["kind"];
  if (level === "guided") return ["kind", "song", "style", "format", "review"];
  return WIZARD_STEPS;
}

/** First problem that blocks leaving a step, if any. */
export function stepBlocker(step: WizardStep, spec: MediaSpec): string | null {
  const problems = specProblems(spec);
  if (step === "kind") return problems.find((problem) => problem.field === "idea")?.message ?? null;
  if (step === "format") return problems.find((problem) => problem.field === "durationSec")?.message ?? null;
  if (step === "delivery") return problems.find((problem) => problem.field === "outputPath" || problem.field === "reportPath")?.message ?? null;
  if (step === "review" || step === "song" || step === "style" || step === "models") return null;
  return null;
}

export function canStart(spec: MediaSpec, level: UserLevel): boolean {
  return stepsFor(level).every((step) => stepBlocker(step, spec) === null) && specProblems(spec).length === 0;
}

/** Steps the user may jump to: every step up to the first blocked one. */
export function reachableSteps(level: UserLevel, spec: MediaSpec): Set<WizardStep> {
  const reachable = new Set<WizardStep>();
  for (const step of stepsFor(level)) {
    reachable.add(step);
    if (stepBlocker(step, spec)) break;
  }
  return reachable;
}

const LEVEL_KEY = "polyth.creative-studio.level";

export function readLevel(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): UserLevel {
  const value = storage?.getItem(LEVEL_KEY);
  return (USER_LEVELS as readonly string[]).includes(value ?? "") ? value as UserLevel : "guided";
}

export function writeLevel(level: UserLevel, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  try { storage?.setItem(LEVEL_KEY, level); } catch { /* private mode: keep in memory only */ }
}

function safeStorage(): Storage | undefined {
  try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return undefined; }
}

/** Example ideas per kind: one tap fills the idea field. */
export const IDEA_SEEDS: Readonly<Record<MediaKind, readonly string[]>> = {
  story: ["seedStory1", "seedStory2", "seedStory3"],
  dance: ["seedDance1", "seedDance2", "seedDance3"],
  lyric: ["seedLyric1", "seedLyric2"],
  visualizer: ["seedVis1", "seedVis2"],
  teaser: ["seedTeaser1", "seedTeaser2"],
};

/** Audio/lyrics file classification for drops and pickers. */
export const isAudioFile = (file: Pick<File, "name" | "type">) =>
  file.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|flac|ogg|oga|opus|webm)$/i.test(file.name);
export const isLyricsFile = (file: Pick<File, "name">) => /\.(lrc|txt)$/i.test(file.name);
