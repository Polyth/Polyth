import type { JsonObject } from "@polyth/contracts";

/**
 * Antigravity's native `ask_question` tool carries
 * `questions[]{question, options[]{id, text}, is_multi_select}` (CLI 1.2.9
 * `CortexStepAskQuestion`). Headless print mode has no dialog for it and
 * records "AskQuestion cancelled by user", so the runtime's PreToolUse hook
 * asks through Polyth instead and returns the answers to the model as the
 * hook's decision reason. The markers below let the stream parser show that
 * settled call as an answered question rather than a failed tool.
 */
export interface AgyQuestion {
  question: string;
  options: Array<{ id: string; text: string }>;
  multi: boolean;
}

export const AGY_QUESTION_ANSWERED = "Answered by the user in Polyth";
export const AGY_QUESTION_DISMISSED = "Dismissed by the user in Polyth";
const MAX_QUESTIONS = 16;
const MAX_OPTIONS = 64;
const MAX_REPLY_CHARS = 32 * 1024;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const row = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const first = (item: Record<string, unknown> | undefined, keys: string[]): unknown =>
  keys.map((key) => item?.[key]).find((value) => value !== undefined);

/** Normalize the tool arguments; an unrecognizable shape returns undefined. */
export function parseAgyQuestions(args: Record<string, unknown>): AgyQuestion[] | undefined {
  const listed = first(args, ["questions", "Questions"]);
  const raw = Array.isArray(listed) ? listed : text(first(args, ["question", "Question"])) ? [args] : undefined;
  if (!raw?.length || raw.length > MAX_QUESTIONS) return undefined;
  const questions: AgyQuestion[] = [];
  for (const value of raw) {
    const item = row(value);
    const question = text(first(item, ["question", "Question", "text", "prompt"]));
    if (!item || !question) return undefined;
    const optionList = first(item, ["options", "Options"]);
    const options: AgyQuestion["options"] = [];
    const seen = new Set<string>();
    (Array.isArray(optionList) ? optionList : []).forEach((option, index) => {
      const entry = row(option);
      const label = typeof option === "string" ? text(option) : text(first(entry, ["text", "Text", "label"]));
      const id = (entry ? text(first(entry, ["id", "Id"])) : undefined) ?? String(index + 1);
      if (!label || seen.has(id) || options.length >= MAX_OPTIONS) return;
      seen.add(id);
      options.push({ id: id.slice(0, 256), text: label.slice(0, 2000) });
    });
    const multi = ["is_multi_select", "isMultiSelect", "IsMultiSelect", "multi_select", "multiSelect"]
      .some((key) => item[key] === true);
    questions.push({ question: question.slice(0, 4000), options, multi });
  }
  return questions;
}

/** Polyth `QuestionItem` rows. Native option IDs are the answer values, and a
 * write-in answer is always allowed because the native tool accepts one. */
export const agyQuestionItems = (questions: readonly AgyQuestion[]): JsonObject[] => questions.map((question, index) => ({
  id: `q${index + 1}`,
  prompt: question.question,
  type: question.options.length ? (question.multi ? "multi" : "single") : "text",
  ...(question.options.length
    ? { options: question.options.map((option) => ({ value: option.id, label: option.text })), allowOther: true }
    : {}),
  required: true,
}));

/** The model-visible reply. `reply` is the runtime answer shape Polyth
 * delivers: `{ answers: string[][] }` by question position or `{ action: "reject" }`. */
export function agyQuestionReply(questions: readonly AgyQuestion[], reply: JsonObject): string {
  if (reply.action === "reject") {
    return `${AGY_QUESTION_DISMISSED}: the user closed this question without answering. Do not assume an answer; continue only if you can proceed without it, otherwise ask again in plain text.`;
  }
  const rows = Array.isArray(reply.answers) ? reply.answers : [];
  const lines = questions.map((question, index) => {
    const values = Array.isArray(rows[index])
      ? (rows[index] as unknown[]).filter((value): value is string => typeof value === "string" && value.trim() !== "")
      : [];
    const answers = values.map((value) => question.options.find((option) => option.id === value)?.text ?? value.trim());
    return `${index + 1}. ${question.question}\n   Answer: ${answers.length ? answers.join("; ") : "(no answer)"}`;
  });
  return `${AGY_QUESTION_ANSWERED} (headless Antigravity cannot show its question dialog, so Polyth asked instead):\n${lines.join("\n")}`
    .slice(0, MAX_REPLY_CHARS);
}
