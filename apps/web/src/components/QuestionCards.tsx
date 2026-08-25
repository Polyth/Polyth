// Multi-question stepper (WP15): one visible question, numbered tabs,
// Back/Next, Submit only on the final valid step. Draft answers live in a
// module-level map so navigation, remounts, and reconnects never lose them.
import { useMemo, useState } from "react";
import type { JsonObject, QuestionItem } from "@polyth/contracts";
import { answerQuestion, rejectQuestion } from "../init.ts";
import type { PendingQuestion } from "../reduce.ts";
import {
  answerValid, firstInvalidStep, normalizeQuestions, questionsToJson, questionsToMarkdown,
  type AnswerMap,
} from "../questionSerializers.ts";
import AdaptiveTextInput from "./input/AdaptiveTextInput.tsx";
import { announce } from "./a11y/live.tsx";
import { tr } from "../i18n/index.ts";
import { Icon } from "../icons.tsx";

// Draft answers survive card remounts (tab switches, WS reconnect replays).
const drafts = new Map<string, AnswerMap>();

const OTHER = "__other__";

function copyText(text: string, what: string): void {
  const done = () => announce(tr("questioncards.valueCopiedToClipboard", { what: what }));
  const fail = () => announce(tr("questioncards.copyFailedClipboardUnavailable"));
  try {
    void navigator.clipboard.writeText(text).then(done, fail);
  } catch {
    fail();
  }
}

function OptionField({ item, answer, onChange }: {
  item: QuestionItem;
  answer: string | string[] | undefined;
  onChange: (a: string | string[]) => void;
}) {
  const options = item.options ?? [];
  const multi = item.type === "multi";
  const selected = new Set(Array.isArray(answer) ? answer : answer !== undefined ? [answer] : []);
  const otherValue = [...selected].find((v) => !options.some((o) => o.value === v));
  const otherOn = otherValue !== undefined;

  const setSingle = (value: string) => onChange(value);
  const toggleMulti = (value: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(value); else next.delete(value);
    onChange([...next]);
  };
  const setOther = (text: string) => {
    if (multi) {
      const next = [...selected].filter((v) => options.some((o) => o.value === v));
      if (text.trim() !== "") next.push(text);
      onChange(next);
    } else {
      onChange(text);
    }
  };

  return (
    <div role={multi ? "group" : "radiogroup"} aria-label={item.prompt}>
      {options.map((o) => {
        const on = selected.has(o.value);
        return (
          <label key={o.value} className={`question-option ${on ? "selected" : ""}`}>
            <input
              type={multi ? "checkbox" : "radio"}
              name={item.id}
              checked={on}
              onChange={(e) => (multi ? toggleMulti(o.value, e.target.checked) : setSingle(o.value))}
            />
            <span>
              {o.label}
              {o.description && <span className="question-option-desc">{o.description}</span>}
            </span>
          </label>
        );
      })}
      {item.allowOther && (
        <label className={`question-option ${otherOn ? "selected" : ""}`}>
          <input
            type={multi ? "checkbox" : "radio"}
            name={item.id}
            checked={otherOn}
            onChange={(e) => {
              if (multi) { if (!e.target.checked) setOther(""); }
              else if (!otherOn) setSingle("");
            }}
          />
          <span>{tr("questioncards.other")}</span>
        </label>
      )}
      {item.allowOther && (
        <AdaptiveTextInput
          key={`${item.id}-other`}
          initialText={otherValue ?? ""}
          rows={1}
          placeholder={tr("questioncards.otherAnswer")}
          ariaLabel={tr("questioncards.otherAnswer2")}
          onTextChange={setOther}
        />
      )}
    </div>
  );
}

function QuestionStepper({ q }: { q: PendingQuestion }) {
  const items = useMemo(() => normalizeQuestions(q.questions), [q.questions]);
  const [answers, setAnswers] = useState<AnswerMap>(() => drafts.get(q.requestId) ?? {});
  const [step, setStep] = useState(0);
  const item = items[Math.min(step, items.length - 1)];
  if (!item) return null;

  const setAnswer = (id: string, a: string | string[]) => {
    setAnswers((prev) => {
      const next = { ...prev, [id]: a };
      drafts.set(q.requestId, next);
      return next;
    });
  };

  const invalid = firstInvalidStep(items, answers);
  const last = step === items.length - 1;
  const canSubmit = invalid === -1;

  const submit = () => {
    if (!canSubmit) { setStep(invalid); return; }
    drafts.delete(q.requestId);
    void answerQuestion(q.requestId, answers as unknown as JsonObject);
  };
  const reject = () => {
    drafts.delete(q.requestId);
    void rejectQuestion(q.requestId);
  };

  return (
    <div className="question-card question-stepper">
      <div className="q-title">
        {tr("questioncards.questionFromTheAgent")}<span className="question-progress" aria-live="polite">
          {items.length > 1 ? tr("questioncards.stepValueOfValue", { value: step + 1, length: items.length }) : ""}
        </span>
        <span className="question-copy">
          <button
            className="question-copy-btn"
            aria-label={tr("questioncards.copyQuestionsAsMarkdown")}
            title={tr("questioncards.copyAsMarkdown")}
            onClick={() => copyText(questionsToMarkdown(items, answers), "Markdown")}
          ><Icon.markdown /></button>
          <button
            className="question-copy-btn"
            aria-label={tr("questioncards.copyQuestionsAsJson")}
            title={tr("questioncards.copyAsJson")}
            onClick={() => copyText(questionsToJson(q.requestId, items, answers), "JSON")}
          ><Icon.json /></button>
        </span>
      </div>
      {items.length > 1 && (
        <div className="question-tabs" role="tablist" aria-label={tr("questioncards.questions")}>
          {items.map((it, i) => (
            <button
              key={it.id}
              role="tab"
              aria-selected={i === step}
              className={`question-tab ${i === step ? "active" : ""} ${answerValid(it, answers[it.id]) ? "done" : ""}`}
              onClick={() => setStep(i)}
            >
              {i + 1}
            </button>
          ))}
        </div>
      )}
      <div className="question-body">
        {item.title && <div className="question-item-title">{item.title}</div>}
        <label className="question-prompt">{item.prompt}{item.required ? "" : tr("questioncards.optional")}</label>
        {item.type === "text" ? (
          <AdaptiveTextInput
            key={item.id}
            initialText={typeof answers[item.id] === "string" ? (answers[item.id] as string) : ""}
            rows={2}
            placeholder={tr("questioncards.answer")}
            ariaLabel={item.prompt}
            onTextChange={(t) => setAnswer(item.id, t)}
          />
        ) : (
          <OptionField item={item} answer={answers[item.id]} onChange={(a) => setAnswer(item.id, a)} />
        )}
      </div>
      <div className="question-actions">
        {items.length > 1 && (
          <button disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>{tr("common.back")}</button>
        )}
        {!last && <button onClick={() => setStep((s) => Math.min(items.length - 1, s + 1))}>{tr("common.next")}</button>}
        {last && (
          <button className="primary" disabled={!canSubmit} onClick={submit}>
            {tr("common.submit")}{items.length > 1 ? tr("questioncards.all") : ""}
          </button>
        )}
        <button className="danger" onClick={reject}>{tr("questioncards.reject")}</button>
      </div>
    </div>
  );
}

export default function QuestionCards({ questions }: { questions: PendingQuestion[] }) {
  if (questions.length === 0) return null;
  return (
    <div className="question-cards">
      {questions.map((q) => (
        <QuestionStepper key={q.requestId} q={q} />
      ))}
    </div>
  );
}
