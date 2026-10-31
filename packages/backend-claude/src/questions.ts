import type { JsonObject } from "@polyth/contracts";

/**
 * Claude Code's `AskUserQuestion` tool reaches the host through `canUseTool`
 * like any other tool. It is not a permission: approving it without answers
 * makes the tool return "The user did not answer the questions." at once, and
 * Auto-Approve or Full access would do exactly that. The runtime asks through
 * Polyth instead and returns the answers as the tool's `updatedInput.answers`
 * (question text -> answer; multi-select answers comma-separated), which is the
 * Agent SDK's documented reply for this tool.
 */
export const CLAUDE_QUESTION_TOOL = "AskUserQuestion";

export interface ClaudeQuestion {
    question: string;
    header?: string;
    options: Array<{ label: string; description?: string }>;
    multi: boolean;
}

const MAX_QUESTIONS = 16;
const MAX_OPTIONS = 64;

const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
const row = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Normalize the tool input; an unrecognizable shape returns undefined. */
export function parseClaudeQuestions(input: Record<string, unknown>): ClaudeQuestion[] | undefined {
    const raw = input.questions;
    if (!Array.isArray(raw) || !raw.length || raw.length > MAX_QUESTIONS) return undefined;
    const questions: ClaudeQuestion[] = [];
    for (const value of raw) {
        const item = row(value);
        const question = text(item?.question);
        if (!item || !question) return undefined;
        const options: ClaudeQuestion["options"] = [];
        const seen = new Set<string>();
        for (const option of Array.isArray(item.options) ? item.options : []) {
            const entry = row(option);
            const label = text(entry?.label);
            if (!label || seen.has(label) || options.length >= MAX_OPTIONS) continue;
            seen.add(label);
            const description = text(entry?.description);
            options.push({ label, ...(description ? { description } : {}) });
        }
        const header = text(item.header);
        questions.push({ question, ...(header ? { header } : {}), options, multi: item.multiSelect === true });
    }
    return questions;
}

/** Polyth `QuestionItem` rows. The option label is the answer value, and a
 * write-in answer is always allowed: Claude Code offers "Other" itself. */
export const claudeQuestionItems = (questions: readonly ClaudeQuestion[]): JsonObject[] => questions.map((question, index) => ({
    id: `q${index + 1}`,
    ...(question.header ? { title: question.header } : {}),
    prompt: question.question,
    type: question.options.length ? (question.multi ? "multi" : "single") : "text",
    ...(question.options.length
        ? { options: question.options.map((option) => ({ value: option.label, label: option.label, ...(option.description ? { description: option.description } : {}) })), allowOther: true }
        : {}),
    required: true,
}));

/** The tool's `answers` map from Polyth's runtime reply shape
 * (`{ answers: string[][] }` by question position). Unanswered questions are
 * left out so the model sees them as unanswered rather than as empty text. */
export function claudeQuestionAnswers(questions: readonly ClaudeQuestion[], reply: JsonObject): Record<string, string> {
    const rows = Array.isArray(reply.answers) ? reply.answers : [];
    const answers: Record<string, string> = {};
    questions.forEach((question, index) => {
        const values = Array.isArray(rows[index])
            ? (rows[index] as unknown[]).flatMap((value) => typeof value === "string" && value.trim() ? [value.trim()] : [])
            : [];
        if (values.length) answers[question.question] = values.join(", ");
    });
    return answers;
}

export const CLAUDE_QUESTION_DISMISSED = "The user dismissed this question in Polyth without answering. Do not assume an answer; continue only if you can proceed without it, otherwise ask again in plain text.";
export const CLAUDE_QUESTION_UNREADABLE = "Polyth could not display this question; ask the user in plain text instead.";
