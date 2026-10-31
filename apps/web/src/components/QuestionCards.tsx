// An agent's open question, asked inside the conversation (stepper). It
// is a timeline row at the point it was asked, so it scrolls with the chat at
// its full height: nothing is capped, clipped or layered over the composer.
// One question is visible at a time; numbered segments, Back/Next, and Submit
// only on the final valid step. Draft answers live in a module-level map so
// navigation, remounts, and reconnects never lose them. Once answered,
// declined or expired, QuestionRecord takes over the same row.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { JsonObject, QuestionItem } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import type { QuestionMsg } from "../reduce.ts";
import {
  answersForSubmit, answerText, answerValid, firstInvalidStep, isOtherLike, normalizeQuestions, questionsToJson, questionsToMarkdown,
  type AnswerMap,
} from "../questionSerializers.ts";
import QuestionRecord from "./QuestionRecord.tsx";
import AdaptiveTextInput, { type TextInputHandle } from "./input/AdaptiveTextInput.tsx";
import { announce } from "./a11y/live.tsx";
import { tr } from "../i18n/index.ts";
import { friendlyError } from "../settings.ts";
import { copyText } from "../utils.ts";
import {
  Button,
  CheckIcon,
  HelpIcon,
  Icon,
  IconButton,
  JsonIcon,
  MarkdownIcon,
} from "./ui/index.ts";

// Draft answers survive card remounts (tab switches, WS reconnect replays).
const drafts = new Map<string, AnswerMap>();

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
  const otherInput = useRef<TextInputHandle>(null);
  const focusOther = useRef(false);
  const options = (item.options ?? []).filter((o) => !item.allowOther || (!isOtherLike(o.label) && !isOtherLike(o.value)));
  const multi = item.type === "multi";
  const selected = new Set(Array.isArray(answer) ? answer : answer !== undefined ? [answer] : []);
  const otherValue = [...selected].find((v) => !options.some((o) => o.value === v));
  const otherOn = otherValue !== undefined;

  // Choosing "Other" is a request to type: the field appears with the caret.
  useEffect(() => {
    if (!otherOn || !focusOther.current) return;
    focusOther.current = false;
    otherInput.current?.focus();
  }, [otherOn]);

  const setSingle = (value: string) => onChange(value);
  const toggleMulti = (value: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(value); else next.delete(value);
    onChange([...next]);
  };
  const setOther = (text: string) => {
    if (multi) {
      const next = [...selected].filter((v) => options.some((o) => o.value === v));
      next.push(text);
      onChange(next);
    } else {
      onChange(text);
    }
  };

  return (
    <div
      className="question-options"
      role={multi ? "group" : "radiogroup"}
      aria-label={item.prompt}
      data-kind={multi ? "multi" : "single"}
    >
      {options.map((o) => {
        const on = selected.has(o.value);
        return (
          <label key={o.value} className={`question-option${on ? " selected" : ""}`}>
            <input
              type={multi ? "checkbox" : "radio"}
              name={groupName}
              checked={on}
              onChange={(e) => (multi ? toggleMulti(o.value, e.target.checked) : setSingle(o.value))}
            />
            <span className="question-option-mark" aria-hidden="true">
              {multi && <Icon icon={CheckIcon} size="sm" />}
            </span>
            <span className="question-option-copy" dir="auto">
              <span className="question-option-label">{o.label}</span>
              {o.description && <span className="question-option-desc">{o.description}</span>}
            </span>
          </label>
        );
      })}
      {item.allowOther && (
        <label className={`question-option question-option-other${otherOn ? " selected" : ""}`}>
          <input
            type={multi ? "checkbox" : "radio"}
            name={groupName}
            checked={otherOn}
            onChange={(e) => {
              if (multi && !e.target.checked) {
                onChange([...selected].filter((v) => options.some((o) => o.value === v)));
                return;
              }
              if (otherOn) return;
              focusOther.current = true;
              if (multi) onChange([...selected, ""]); else setSingle("");
            }}
          />
          <span className="question-option-mark" aria-hidden="true">
            {multi && <Icon icon={CheckIcon} size="sm" />}
          </span>
          <span className="question-option-copy">
            <span className="question-option-label">{tr("questioncards.other")}</span>
          </span>
        </label>
      )}
      {item.allowOther && otherOn && (
        <AdaptiveTextInput
          ref={otherInput}
          key={`${item.id}-other`}
          initialText={otherValue ?? ""}
          rows={1}
          className="ui-textarea question-answer-input question-other-input"
          placeholder={tr("questioncards.otherAnswer")}
          ariaLabel={tr("questioncards.otherAnswer2")}
          onTextChange={setOther}
        />
      )}
    </div>
  );
}

/** The open question, rendered as its own timeline row. */
export default function QuestionPrompt({ m, sessionId, entering = false, leaving = false }: {
  m: QuestionMsg;
  /** The session whose log holds the ask (a subagent mirror included). */
  sessionId: string;
  entering?: boolean;
  leaving?: boolean;
}) {
  const id = useId();
  const cardRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const items = useMemo(() => normalizeQuestions(m.questions), [m.questions]);
  const [answers, setAnswers] = useState<AnswerMap>(() => drafts.get(m.requestId) ?? {});
  const [step, setStepState] = useState(0);
  // The decision as sent, shown as its record before the server confirms it.
  const [sent, setSent] = useState<Pick<QuestionMsg, "status" | "answers" | "answeredAt"> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const item = items[Math.min(step, items.length - 1)];
  if (sent) return <QuestionRecord m={{ ...m, ...sent }} leaving={leaving} />;
  if (!item) return null;

  const setAnswer = (key: string, a: string | string[]) => {
    setError(null);
    setAnswers((prev) => {
      const next = { ...prev, [key]: a };
      drafts.set(m.requestId, next);
      return next;
    });
  };

  const invalid = firstInvalidStep(items, answers);
  const multiStep = items.length > 1;
  const last = step === items.length - 1;
  const canSubmit = invalid === -1;
  const stepValid = answerValid(item, answers[item.id]);

  // A button that moved the step may vanish (Next becomes Submit): keep the
  // keyboard inside the card on the new question without opening a keyboard.
  const setStep = (next: number) => {
    setStepState(next);
    const card = cardRef.current;
    if (card && card.contains(document.activeElement) && !tabRefs.current.includes(document.activeElement as HTMLButtonElement)) {
      requestAnimationFrame(() => panelRef.current?.focus({ preventScroll: true }));
    }
  };

  // The row turns into its record at the click; the canonical
  // `question/answered` event later replaces it with the same record. A
  // failure brings the stepper back with the draft and the error.
  const send = async (kind: "answer" | "reject") => {
    if (kind === "answer" && !canSubmit) { setStep(invalid); return; }
    const submitted = answersForSubmit(answers) as unknown as JsonObject;
    setSent(kind === "answer"
      ? { status: "answered", answers: submitted, answeredAt: Date.now() }
      : { status: "rejected" });
    setError(null);
    try {
      if (kind === "answer") await api.answerQuestion(sessionId, m.requestId, submitted);
      else await api.rejectQuestion(sessionId, m.requestId);
      drafts.delete(m.requestId);
    } catch (reason) {
      setError(friendlyError(tr("questioncards.sendFailed"), reason));
      setSent(null);
    }
  };
  const advance = () => {
    if (last) void send("answer");
    else setStep(Math.min(items.length - 1, step + 1));
  };
  const selectTabFromKeyboard = (index: number) => {
    const next = (index + items.length) % items.length;
    setStepState(next);
    tabRefs.current[next]?.focus();
  };
  // Cmd/Ctrl+Enter moves on from anywhere in the card, text fields included.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (last ? canSubmit : stepValid) advance();
  };

  const motion = `${entering ? " timeline-row-enter" : ""}${leaving ? " rewind-leaving" : ""}`;
  const title = tr("questioncards.questionFromTheAgent");
  return (
    <section
      ref={cardRef}
      className={`msg question-open${motion}`}
      data-msg-id={m.id}
      data-message-seq={m.eventSeq}
      aria-labelledby={`${id}-title`}
      onKeyDown={onKeyDown}
    >
      <div className="question-card question-stepper">
        <header className="question-head">
          <span className="question-badge" aria-hidden="true"><Icon icon={HelpIcon} size="sm" /></span>
          <span className="question-head-copy">
            <span className="question-eyebrow" id={`${id}-title`}>{title}</span>
            {multiStep && (
              <span className="question-progress" aria-live="polite">
                {tr("questioncards.stepValueOfValue", { value: step + 1, length: items.length })}
              </span>
            )}
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
              onClick={() => copyQuestions(questionsToJson(m.requestId, items, answers), "JSON")}
            />
          </span>
        </header>
        {multiStep && (
          <div className="question-tabs" role="tablist" aria-label={tr("questioncards.questions")}>
            {items.map((it, i) => {
              // Done means answered: an optional question left blank is valid
              // but still unanswered, so it keeps its number.
              const done = answerText(it, answers[it.id]) !== "";
              return (
                <button
                  key={it.id}
                  type="button"
                  ref={(node) => { tabRefs.current[i] = node; }}
                  id={`${id}-tab-${i}`}
                  role="tab"
                  aria-selected={i === step}
                  aria-controls={`${id}-panel`}
                  aria-label={`${i + 1}. ${it.title ?? it.prompt}`}
                  tabIndex={i === step ? 0 : -1}
                  className={`question-tab${i === step ? " active" : ""}${done ? " done" : ""}`}
                  onClick={() => setStepState(i)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowRight") selectTabFromKeyboard(step + 1);
                    else if (event.key === "ArrowLeft") selectTabFromKeyboard(step - 1);
                    else if (event.key === "Home") selectTabFromKeyboard(0);
                    else if (event.key === "End") selectTabFromKeyboard(items.length - 1);
                    else return;
                    event.preventDefault();
                  }}
                >
                  <span className="question-tab-index">{done && i !== step ? <Icon icon={CheckIcon} size="sm" /> : i + 1}</span>
                </button>
              );
            })}
          </div>
        )}
        <div
          ref={panelRef}
          className="question-body"
          id={`${id}-panel`}
          tabIndex={-1}
          role={multiStep ? "tabpanel" : undefined}
          aria-labelledby={multiStep ? `${id}-tab-${step}` : undefined}
        >
          {item.title && <div className="question-item-title" dir="auto">{item.title}</div>}
          <div className="question-prompt" dir="auto">
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
            <OptionField
              key={item.id}
              item={item}
              answer={answers[item.id]}
              onChange={(a) => setAnswer(item.id, a)}
            />
          )}
        </div>
        {error && <p className="question-error" role="alert">{error}</p>}
        <footer className="question-actions">
          <Button
            size="sm"
            variant="ghost"
            className="question-reject"
            onClick={() => void send("reject")}
          >
            {tr("questioncards.reject")}
          </Button>
          <span className="question-actions-end">
            {multiStep && step > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setStep(Math.max(0, step - 1))}>
                {tr("common.back")}
              </Button>
            )}
            {!last && (
              <Button size="sm" variant="primary" onClick={advance}>
                {tr("common.next")}
              </Button>
            )}
            {last && (
              <Button
                size="sm"
                variant="primary"
                disabled={!canSubmit}
                onClick={() => void send("answer")}
              >
                {multiStep ? tr("questioncards.submitAll") : tr("common.submit")}
              </Button>
            )}
          </span>
        </footer>
      </div>
    </section>
  );
}
