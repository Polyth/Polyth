// Multi-question stepper (WP15): one visible question, numbered tabs,
// Back/Next, Submit only on the final valid step. Draft answers live in a
// module-level map so navigation, remounts, and reconnects never lose them.
import { useId, useMemo, useRef, useState } from "react";
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
import { copyText } from "../utils.ts";
import {
  Button,
  IconButton,
  JsonIcon,
  MarkdownIcon,
} from "./ui/index.ts";

// Draft answers survive card remounts (tab switches, WS reconnect replays).
const drafts = new Map<string, AnswerMap>();

const OTHER = "__other__";

function copyQuestions(text: string, what: string): void {
  void copyText(text).then((ok) => {
    announce(ok
      ? tr("questioncards.valueCopiedToClipboard", { what: what })
      : tr("questioncards.copyFailedClipboardUnavailable"));
  });
}

function OptionField({ item, answer, onChange }: {
  item: QuestionItem;
  answer: string | string[] | undefined;
  onChange: (a: string | string[]) => void;
}) {
  const groupName = useId();
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
    <div className="question-options" role={multi ? "group" : "radiogroup"} aria-label={item.prompt}>
      {options.map((o) => {
        const on = selected.has(o.value);
        return (
          <label key={o.value} className={`question-option ${on ? "selected" : ""}`}>
            <input
              type={multi ? "checkbox" : "radio"}
              name={groupName}
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
            name={groupName}
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
          className="ui-textarea question-answer-input"
          placeholder={tr("questioncards.otherAnswer")}
          ariaLabel={tr("questioncards.otherAnswer2")}
          onTextChange={setOther}
        />
      )}
    </div>
  );
}

function QuestionStepper({ q }: { q: PendingQuestion }) {
  const id = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
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
    if (!q.sessionId) return;
    drafts.delete(q.requestId);
    void answerQuestion(q.sessionId, q.requestId, answers as unknown as JsonObject);
  };
  const reject = () => {
    if (!q.sessionId) return;
    drafts.delete(q.requestId);
    void rejectQuestion(q.sessionId, q.requestId);
  };
  const selectTabFromKeyboard = (index: number) => {
    const next = (index + items.length) % items.length;
    setStep(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <section className="question-card question-stepper" aria-labelledby={`${id}-title`}>
      <div className="q-title" id={`${id}-title`}>
        <span className="question-title-copy">
          <strong>{tr("questioncards.questionFromTheAgent")}</strong>
          <span className="question-progress" aria-live="polite">
            {items.length > 1 ? tr("questioncards.stepValueOfValue", { value: step + 1, length: items.length }) : ""}
          </span>
        </span>
        <span className="question-copy">
          <IconButton
            icon={MarkdownIcon}
            size="sm"
            variant="ghost"
            className="question-copy-btn"
            label={tr("questioncards.copyQuestionsAsMarkdown")}
            title={tr("questioncards.copyAsMarkdown")}
            onClick={() => copyQuestions(questionsToMarkdown(items, answers), "Markdown")}
          />
          <IconButton
            icon={JsonIcon}
            size="sm"
            variant="ghost"
            className="question-copy-btn"
            label={tr("questioncards.copyQuestionsAsJson")}
            title={tr("questioncards.copyAsJson")}
            onClick={() => copyQuestions(questionsToJson(q.requestId, items, answers), "JSON")}
          />
        </span>
      </div>
      {items.length > 1 && (
        <div className="question-tabs" role="tablist" aria-label={tr("questioncards.questions")}>
          {items.map((it, i) => (
            <button
              key={it.id}
              ref={(node) => { tabRefs.current[i] = node; }}
              id={`${id}-tab-${i}`}
              role="tab"
              aria-selected={i === step}
              aria-controls={`${id}-panel`}
              aria-label={`${i + 1}. ${it.title ?? it.prompt}`}
              tabIndex={i === step ? 0 : -1}
              className={`question-tab ${i === step ? "active" : ""} ${answerValid(it, answers[it.id]) ? "done" : ""}`}
              onClick={() => setStep(i)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight") selectTabFromKeyboard(step + 1);
                else if (event.key === "ArrowLeft") selectTabFromKeyboard(step - 1);
                else if (event.key === "Home") selectTabFromKeyboard(0);
                else if (event.key === "End") selectTabFromKeyboard(items.length - 1);
                else return;
                event.preventDefault();
              }}
            >
              {i + 1}
            </button>
          ))}
        </div>
      )}
      <div
        className="question-body"
        id={`${id}-panel`}
        role={items.length > 1 ? "tabpanel" : undefined}
        aria-labelledby={items.length > 1 ? `${id}-tab-${step}` : undefined}
      >
        {item.title && <div className="question-item-title">{item.title}</div>}
        <div className="question-prompt">
          {item.prompt}
          {!item.required && <span className="question-optional"> {tr("questioncards.optional")}</span>}
        </div>
        {item.type === "text" ? (
          <AdaptiveTextInput
            key={item.id}
            initialText={typeof answers[item.id] === "string" ? (answers[item.id] as string) : ""}
            rows={2}
            className="ui-textarea question-answer-input"
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
          <Button size="sm" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>
            {tr("common.back")}
          </Button>
        )}
        {!last && (
          <Button size="sm" onClick={() => setStep((s) => Math.min(items.length - 1, s + 1))}>
            {tr("common.next")}
          </Button>
        )}
        {last && (
          <Button size="sm" variant="primary" disabled={!canSubmit} onClick={submit}>
            {items.length > 1 ? tr("questioncards.submitAll") : tr("common.submit")}
          </Button>
        )}
        <Button size="sm" variant="danger" className="question-reject" onClick={reject}>
          {tr("questioncards.reject")}
        </Button>
      </div>
    </section>
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
