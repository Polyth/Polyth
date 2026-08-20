// Question normalization + copy serializers (WP15, pure — node:test friendly).
// Runtimes deliver loosely-shaped question objects; the stepper renders the
// normalized QuestionItem form. Serializers never include hidden permission
// or session metadata, or internal event envelope fields.
import type { JsonObject, QuestionItem, QuestionOption } from "@polyth/contracts";

export type AnswerMap = Record<string, string | string[]>;

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

function normalizeOption(raw: unknown): QuestionOption | null {
  if (typeof raw === "string") return raw === "" ? null : { value: raw, label: raw };
  if (raw && typeof raw === "object") {
    const o = raw as JsonObject;
    const value = str(o.value) ?? str(o.id) ?? str(o.label);
    if (!value) return null;
    return {
      value,
      label: str(o.label) ?? value,
      ...(str(o.description) ? { description: str(o.description)! } : {}),
    };
  }
  return null;
}

/** Loose runtime question objects → typed items. Duplicate option values are
 *  dropped (first wins) so radio/checkbox state stays unambiguous. */
export function normalizeQuestions(raw: JsonObject[]): QuestionItem[] {
  return raw.map((item, i) => {
    const options: QuestionOption[] = [];
    const seen = new Set<string>();
    const list = Array.isArray(item.options) ? item.options : Array.isArray(item.choices) ? item.choices : [];
    for (const o of list) {
      const norm = normalizeOption(o);
      if (norm && !seen.has(norm.value)) {
        seen.add(norm.value);
        options.push(norm);
      }
    }
    const declared = str(item.type);
    const multi = declared === "multi" || item.multiple === true || item.multi === true;
    const type: QuestionItem["type"] = options.length === 0 ? "text" : multi ? "multi" : "single";
    return {
      id: str(item.id) ?? `q${i + 1}`,
      ...(str(item.title) ? { title: str(item.title)! } : {}),
      prompt: str(item.prompt) ?? str(item.question) ?? str(item.text) ?? str(item.message) ?? `Question ${i + 1}`,
      type,
      ...(options.length > 0 ? { options } : {}),
      required: item.required !== false,
      ...(item.allowOther === true || item.other === true ? { allowOther: true } : {}),
    };
  });
}

/** Per-item validation; server stays authoritative, this is UX-side gating. */
export function answerValid(item: QuestionItem, answer: string | string[] | undefined): boolean {
  if (!item.required) return true;
  if (answer === undefined) return false;
  if (Array.isArray(answer)) return answer.length > 0;
  return answer.trim() !== "";
}

export function firstInvalidStep(items: QuestionItem[], answers: AnswerMap): number {
  for (let i = 0; i < items.length; i++) {
    if (!answerValid(items[i]!, answers[items[i]!.id])) return i;
  }
  return -1;
}

const mdEscape = (s: string): string => s.replace(/([\\`*_[\]])/g, "\\$1");

/** Copy as Markdown: heading, prompt, options with selected markers, answers. */
export function questionsToMarkdown(items: QuestionItem[], answers: AnswerMap): string {
  const lines: string[] = [];
  items.forEach((item, i) => {
    lines.push(`## ${i + 1}. ${mdEscape(item.title ?? item.prompt)}`);
    if (item.title) lines.push(mdEscape(item.prompt));
    const a = answers[item.id];
    const selected = new Set(Array.isArray(a) ? a : a !== undefined ? [a] : []);
    if (item.options && item.options.length > 0) {
      for (const o of item.options) {
        const mark = selected.has(o.value) ? "x" : " ";
        lines.push(`- [${mark}] ${mdEscape(o.label)}${o.description ? ` — ${mdEscape(o.description)}` : ""}`);
      }
      const other = [...selected].filter((v) => !item.options!.some((o) => o.value === v));
      for (const v of other) lines.push(`- [x] Other: ${mdEscape(v)}`);
    } else {
      lines.push(a === undefined || a === "" ? "_No answer_" : `> ${String(a).split("\n").join("\n> ")}`);
    }
    lines.push("");
  });
  return lines.join("\n").trimEnd() + "\n";
}

/** Copy as JSON: stable `{requestId, questions, answers}` with deterministic
 *  key order — question order as asked, answer keys in question order. */
export function questionsToJson(requestId: string, items: QuestionItem[], answers: AnswerMap): string {
  const orderedAnswers: AnswerMap = {};
  for (const item of items) {
    if (answers[item.id] !== undefined) orderedAnswers[item.id] = answers[item.id]!;
  }
  return JSON.stringify(
    {
      requestId,
      questions: items.map((q) => ({
        id: q.id,
        ...(q.title !== undefined ? { title: q.title } : {}),
        prompt: q.prompt,
        type: q.type,
        ...(q.options !== undefined ? { options: q.options } : {}),
        ...(q.required !== undefined ? { required: q.required } : {}),
        ...(q.allowOther !== undefined ? { allowOther: q.allowOther } : {}),
      })),
      answers: orderedAnswers,
    },
    null,
    2,
  );
}
