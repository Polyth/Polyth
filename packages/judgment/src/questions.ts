import type { ChoiceQuestion, NoulQuestion, ScoreQuestion } from "./types.ts";

export const noul = (instructions: string): NoulQuestion => ({ type: "noul", instructions });
export const choice = <const T extends string>(instructions: string, criteria: Record<T, string>): ChoiceQuestion<T> =>
  ({ type: "choice", instructions, criteria: { ...criteria } });
export const score = (instructions: string, rubric: readonly string[]): ScoreQuestion =>
  ({ type: "score", instructions, rubric: [...rubric] });
