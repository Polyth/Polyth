// Browser-safe Multirun rubric contracts shared by the server scoring pass, the
// Multirun view and Fusion's "pick sources" preselection. It carries no Node,
// network or Judgment runtime import: only the descriptor, the parameter
// defaults and the pure helpers that both sides must agree on.
import type { MultirunDto, MultirunRunDto, ModelRef } from "@polyth/contracts";
import type { JudgmentUseDescriptor } from "@polyth/judgment";

/** Judgment use registered by the Multirun package; Fusion reads the same id. */
export const MULTIRUN_RUBRIC_SCORE_USE_ID = "multirun.rubric-score";
/** Versioned question scope sent with every scoring call. */
export const MULTIRUN_RUBRIC_SCORE_SCOPE = "multirun.rubric-score.v1";

export const DEFAULT_CRITERIA = "correctness, completeness";
export const DEFAULT_MAX_ANSWER_CHARS = 6000;
export const MIN_ANSWER_CHARS = 1000;
export const MAX_ANSWER_CHARS = 20000;
export const MIN_RUBRIC_LEVELS = 2;
export const MAX_RUBRIC_LEVELS = 8;
/** The prompt is part of the evidence; it is trimmed to this many characters. */
export const PROMPT_CHAR_LIMIT = 2000;
/** Below this a score is shown, but marked as low confidence instead of hidden. */
export const LOW_SCORE_CONFIDENCE = 0.6;
export const INVALID_RUBRIC_NOTE = "Not scored — the rubric needs 2–8 non-empty lines.";

/** Default 5-level correctness rubric, one level per line. */
export const DEFAULT_RUBRIC = [
  "0 wrong or off-topic",
  "1 mostly incorrect",
  "2 partly correct with real gaps",
  "3 correct but incomplete",
  "4 correct, complete and verified",
].join("\n");

export function multirunRubricScoreUse(): JudgmentUseDescriptor {
  return {
    id: MULTIRUN_RUBRIC_SCORE_USE_ID,
    packageId: "multirun",
    title: "Score Multirun answers",
    description: "After a Multirun comparison finishes, rate every answer against one shared rubric.",
    effect: "Shows a rubric score and confidence beside each answer; Fusion can preselect the highest-scoring sources for you to confirm.",
    scope: MULTIRUN_RUBRIC_SCORE_SCOPE,
    evidence: "long",
    defaultEnabled: false,
    order: 30,
    params: [
      {
        id: "rubric",
        kind: "text",
        label: "Rubric",
        hint: "One level per line, weakest first (2–8 lines). The first line is score 0, the last is the maximum.",
        multiline: true,
        maxLength: 2000,
        default: DEFAULT_RUBRIC,
      },
      {
        id: "criteria",
        kind: "text",
        label: "Criteria",
        hint: "What the answer is judged on, in the prompt's own terms.",
        maxLength: 400,
        default: DEFAULT_CRITERIA,
      },
      {
        id: "maxAnswerChars",
        kind: "integer",
        label: "Answer tail (characters)",
        hint: "How much of the end of each answer is shown to Judgment. The prompt is included separately.",
        min: MIN_ANSWER_CHARS,
        max: MAX_ANSWER_CHARS,
        default: DEFAULT_MAX_ANSWER_CHARS,
      },
      {
        id: "fusionTopK",
        kind: "integer",
        label: "Fusion sources preselected by score",
        hint: "0 disables preselection. The person still confirms the sources before fusing.",
        min: 0,
        max: 8,
        default: 0,
      },
    ],
  };
}

/** Non-empty trimmed rubric lines, or null when the text is not 2–8 usable levels. */
export function parseRubric(raw: string): string[] | null {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length < MIN_RUBRIC_LEVELS || lines.length > MAX_RUBRIC_LEVELS) return null;
  return lines;
}

/** Clamps a resolved `maxAnswerChars` parameter to the declared bounds. */
export function resolveMaxAnswerChars(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value)
    && value >= MIN_ANSWER_CHARS && value <= MAX_ANSWER_CHARS
    ? value
    : DEFAULT_MAX_ANSWER_CHARS;
}

/** The last `max` characters of an answer (the tail carries the conclusion). */
export function answerTail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

/** Bounds the prompt half of the evidence before judging. */
export function boundPrompt(text: string): string {
  return text.length <= PROMPT_CHAR_LIMIT ? text : text.slice(0, PROMPT_CHAR_LIMIT);
}

export function buildScoreInstructions(criteria: string, rubric: readonly string[]): string {
  const max = Math.max(0, rubric.length - 1);
  return `Judge how well the answer in <answer> satisfies the prompt in <prompt>, on ${criteria}. `
    + `Use the 0–${max} rubric levels (0 is weakest), be strict about correctness, and do not reward length.`;
}

/** e.g. `3.4 / 4 · 82%`. Confidence is always shown, including when it is low. */
export function formatScore(score: number, levels: number, confidence: number): string {
  const max = Math.max(1, levels - 1);
  const value = Number.isFinite(score) ? score.toFixed(1) : "0.0";
  const percent = Math.round(Math.min(1, Math.max(0, Number.isFinite(confidence) ? confidence : 0)) * 100);
  return `${value} / ${max} · ${percent}%`;
}

export function isLowScoreConfidence(confidence: number): boolean {
  return Number.isFinite(confidence) && confidence < LOW_SCORE_CONFIDENCE;
}

/** Score fields attached to one Multirun run next to its answer. */
export interface MultirunRunScoreFields {
  /** Continuous 0-based rubric score. */
  score?: number;
  /** Number of rubric levels; the maximum score is `scoreLevels - 1`. */
  scoreLevels?: number;
  scoreConfidence?: number;
  /** Visible note when scoring was skipped (e.g. an invalid rubric). */
  scoreNote?: string;
}

export type ScoredMultirunRun = MultirunRunDto & MultirunRunScoreFields;

/** Multirun DTO with the optional scoring fields the server adds to the wire JSON. */
export interface ScoredMultirunDto extends Omit<MultirunDto, "runs"> {
  runs: ScoredMultirunRun[];
  /** True while the bounded scoring pass is still running. */
  scoring?: boolean;
}

export interface RubricAnswerRef {
  runId: string;
  model?: ModelRef;
  output: string;
}
