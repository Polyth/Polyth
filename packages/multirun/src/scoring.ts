// Server-side rubric scoring pass: after every Multirun answer exists, ask
// Judgment to score each one against the shared rubric. Judgment is a narrow
// injected port so this module is testable with a fake service and carries no
// host coupling. Failure, a disabled use or an invalid rubric never produces a
// score: the Multirun simply behaves as it does today.
import { createJudgmentBudget, score as scoreQuestion } from "@polyth/judgment";
import type { JudgmentBudgetPool, JudgmentRuntime } from "@polyth/judgment";
import {
  answerTail,
  boundPrompt,
  buildScoreInstructions,
  DEFAULT_CRITERIA,
  INVALID_RUBRIC_NOTE,
  MULTIRUN_RUBRIC_SCORE_SCOPE,
  MULTIRUN_RUBRIC_SCORE_USE_ID,
  parseRubric,
  resolveMaxAnswerChars,
  type RubricAnswerRef,
} from "./rubric.ts";

/** Minimal Judgment seam: only what scoring needs, so tests can fake it. */
export interface RubricJudgmentPort {
  resolveUse(useId: string): Promise<{ enabled: boolean; params: Record<string, string | number | boolean> }>;
  createRun(options?: { budget?: JudgmentBudgetPool }): Promise<JudgmentRuntime>;
}

export interface RubricScoreInput {
  sessionId: string;
  prompt: string;
  answers: readonly RubricAnswerRef[];
}

export interface RubricScoreOutcome {
  runId: string;
  score?: number;
  levels?: number;
  confidence?: number;
  note?: string;
  /** Resolved `fusionTopK` at scoring time, so Fusion never reads Judgment settings. */
  fusionTopK?: number;
}

const PER_CALL_WALL_MS = 15_000;

const normalizeCriteria = (value: unknown): string =>
  typeof value === "string" && value.trim() ? value.trim() : DEFAULT_CRITERIA;

/**
 * Scores each answer that has text. Returns one outcome per scorable answer;
 * an outcome without a score means "no score" (Judgment off, failure or skip).
 * Never throws.
 */
export async function scoreMultirunAnswers(
  port: RubricJudgmentPort,
  input: RubricScoreInput,
): Promise<RubricScoreOutcome[]> {
  const answers = input.answers.filter((answer) => answer.output.trim().length > 0);
  if (!answers.length) return [];

  let use: { enabled: boolean; params: Record<string, string | number | boolean> };
  try {
    use = await port.resolveUse(MULTIRUN_RUBRIC_SCORE_USE_ID);
  } catch {
    return [];
  }
  if (!use.enabled) return [];

  const rubric = parseRubric(String(use.params.rubric ?? ""));
  if (!rubric) return answers.map((answer) => ({ runId: answer.runId, note: INVALID_RUBRIC_NOTE }));

  const topK = use.params.fusionTopK;
  const fusionTopK = Number.isSafeInteger(topK) && (topK as number) >= 0 && (topK as number) <= 8 ? topK as number : 0;
  const criteria = normalizeCriteria(use.params.criteria);
  const maxAnswerChars = resolveMaxAnswerChars(use.params.maxAnswerChars);
  const instructions = buildScoreInstructions(criteria, rubric);

  const budget = createJudgmentBudget({
    maxCalls: answers.length,
    maxInputBytes: answers.reduce(
      (total, answer) => total + Math.min(answer.output.length, maxAnswerChars) + 8_192,
      0,
    ),
    maxWallClockMs: answers.length * PER_CALL_WALL_MS,
  });

  const outcomes: RubricScoreOutcome[] = [];
  for (const answer of answers) {
    const state = {
      prompt: boundPrompt(input.prompt),
      answer: answerTail(answer.output, maxAnswerChars),
      criteria,
    };
    let result;
    try {
      // One run per answer keeps each evaluation inside Judgment's per-run call
      // limit while the shared budget bounds the whole pass.
      const run = await port.createRun({ budget });
      try {
        result = await run.judge({
          scope: MULTIRUN_RUBRIC_SCORE_SCOPE,
          state,
          questions: { score: scoreQuestion(instructions, rubric) },
          metadata: { sessionId: input.sessionId },
        });
      } finally {
        run.dispose();
      }
    } catch {
      outcomes.push({ runId: answer.runId });
      continue;
    }
    if (result.ok) {
      outcomes.push({
        runId: answer.runId,
        score: result.answers.score.score,
        levels: rubric.length,
        confidence: result.answers.score.confidence,
        fusionTopK,
      });
    } else {
      outcomes.push({ runId: answer.runId });
    }
  }
  return outcomes;
}
