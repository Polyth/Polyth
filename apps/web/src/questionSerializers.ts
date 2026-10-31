// Question normalization + copy serializers (pure — node:test friendly).
// Runtimes deliver loosely-shaped question objects; the stepper renders the
// normalized QuestionItem form. Serializers never include hidden permission
// or session metadata, or internal event envelope fields.
import type { JsonObject, QuestionItem, QuestionOption } from "@polyth/contracts";
import { tr } from "./i18n/index.ts";

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

const OTHER_PATTERNS: readonly RegExp[] = [
  // English
  /^(other|others|another|custom|custom choice|custom answer|write-?in|something else)(\s*(option|answer|choice))?($|\s*[(:—–-])/i,
  // Ukrainian
  /^(свій|власний)\s*(вибір|варіант|відповідь)($|\s*[(:—–-])/i,
  /^(інше|інший|інша)\s*(варіант|відповідь)?($|\s*[(:—–-])/i,
  // Other locales supported by Polyth
  /^(друго|andere[s]?|otro[s]?|otra[s]?|autre[s]?|altro|altra|inne|inny|outro[s]?|outra[s]?)(\s*(option|answer|choix|opción|opzione|opcja|resposta|antwort))?($|\s*[(:—–-])/i,
  /^(其他|آخر)($|\s*[(:—–-])/,
];

export function isOtherLike(text: string): boolean {
  const norm = text.trim();
  if (!norm) return false;
  return OTHER_PATTERNS.some((re) => re.test(norm));
}

function isOptionOther(rawOption: unknown, norm: QuestionOption | null): boolean {
  if (rawOption && typeof rawOption === "object") {
    const rec = rawOption as Record<string, unknown>;
    if (rec.isOther === true || rec.other === true || rec.custom === true) return true;
  }
  if (norm) {
    if (isOtherLike(norm.label) || isOtherLike(norm.value)) return true;
  }
  return false;
}

function optionHasInput(rawOption: unknown): boolean {
  if (rawOption && typeof rawOption === "object") {
    const rec = rawOption as Record<string, unknown>;
    if (rec.input === true || rec.hasInput === true || rec.isInput === true) return true;
    if (rec.type === "input" || rec.type === "text") return true;
  }
  return false;
}

function questionHasInput(item: JsonObject): boolean {
  return (
    item.hasInput === true
    || item.input === true
    || item.isInput === true
    || item.hasTextInput === true
    || item.type === "input"
    || item.type === "text"
  );
}

/** Loose runtime question objects → typed items. Duplicate option values are
 *  dropped (first wins) so radio/checkbox state stays unambiguous.
 *  Choice questions automatically receive allowOther (custom choice with arbitrary text)
 *  unless an input field already exists in the question. Existing other options
 *  in options are deduplicated so they never appear twice. */
export function normalizeQuestions(raw: JsonObject[]): QuestionItem[] {
  return raw.map((item, i) => {
    const options: QuestionOption[] = [];
    const seen = new Set<string>();
    let hasOptionInput = false;
    const others: QuestionOption[] = [];
    const list = Array.isArray(item.options) ? item.options : Array.isArray(item.choices) ? item.choices : [];
    for (const o of list) {
      if (optionHasInput(o)) {
        hasOptionInput = true;
      }
      const norm = normalizeOption(o);
      if (!norm) continue;
      if (isOptionOther(o, norm)) {
        others.push(norm);
        continue;
      }
      if (!seen.has(norm.value)) {
        seen.add(norm.value);
        options.push(norm);
      }
    }
    const declared = str(item.type);
    const multi = declared === "multi" || item.multiple === true || item.multi === true;
    // If the question already has an input field, no more is needed:
    // - no choices left renders a text input field already
    // - question or an option has an explicit input field specified
    const alreadyHasInput = options.length === 0 || questionHasInput(item) || hasOptionInput;
    const allowOther = !alreadyHasInput && item.allowOther !== false && item.other !== false;
    // Without the custom field the agent's own "Other" options are the only way
    // to pick it; a question of nothing but "Other" stays a plain text answer.
    if (!allowOther && options.length > 0) {
      for (const o of others) {
        if (!seen.has(o.value)) { seen.add(o.value); options.push(o); }
      }
    }
    const type: QuestionItem["type"] = options.length === 0 ? "text" : multi ? "multi" : "single";

    return {
      id: str(item.id) ?? `q${i + 1}`,
      ...(str(item.title) ? { title: str(item.title)! } : {}),
      prompt: str(item.prompt)
        ?? str(item.question)
        ?? str(item.text)
        ?? str(item.message)
        ?? tr("questionserializers.questionValue", { number: i + 1 }),
      type,
      ...(options.length > 0 ? { options } : {}),
      required: item.required !== false,
      ...(allowOther ? { allowOther: true } : {}),
    };
  });
}

/** Per-item validation; server stays authoritative, this is UX-side gating. */
export function answerValid(item: QuestionItem, answer: string | string[] | undefined): boolean {
  if (!item.required) return true;
  if (answer === undefined) return false;
  // A ticked "Other" with nothing typed yet is not an answer.
  if (Array.isArray(answer)) return answer.some((value) => value.trim() !== "");
  return answer.trim() !== "";
}

/** What is sent: a ticked-but-empty "Other" entry is dropped from a choice. */
export function answersForSubmit(answers: AnswerMap): AnswerMap {
  const out: AnswerMap = {};
  for (const [key, value] of Object.entries(answers)) {
    out[key] = Array.isArray(value) ? value.filter((entry) => entry.trim() !== "") : value;
  }
  return out;
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

/** One answer as the person would say it: option labels, never raw values. */
export function answerText(item: QuestionItem, answer: string | string[] | undefined): string {
  const values = Array.isArray(answer) ? answer : answer !== undefined ? [answer] : [];
  return values
    .map((value) => item.options?.find((option) => option.value === value)?.label ?? value)
    .filter((text) => text.trim() !== "")
    .join(", ");
}

/** Composer seed after rewinding an answer: each question quoted with its
 *  answer below, so the edited reply still says what it answers. */
export function questionAnswerDraft(items: QuestionItem[], answers: AnswerMap): string {
  return items
    .map((item) => {
      const quoted = (item.title ? `${item.title}\n${item.prompt}` : item.prompt).split("\n").map((line) => `> ${line}`).join("\n");
      return `${quoted}\n${answerText(item, answers[item.id])}`;
    })
    .join("\n\n");
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
