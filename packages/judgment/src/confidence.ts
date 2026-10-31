import type { ChoiceAnswer, NoulAnswer, ScoreAnswer } from "./types.ts";
export const topChoiceProbability = (answer: ChoiceAnswer): number => Math.max(...Object.values(answer.probabilities));
export const choiceMargin = (answer: ChoiceAnswer): number => {
  const values = Object.values(answer.probabilities).sort((a, b) => b - a);
  return (values[0] ?? 0) - (values[1] ?? 0);
};
export const noulPolarity = (answer: NoulAnswer): number => 2 * answer.probability - 1;
export const nearestScoreLevel = (answer: ScoreAnswer): number => Math.round(answer.score);
export const isAbove = (answer: NoulAnswer | ScoreAnswer, threshold: number): boolean =>
  (answer.type === "noul" ? answer.probability : answer.score) > threshold;
