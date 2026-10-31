// An agent's question and the person's reply, kept in the conversation where
// it was asked. The open stepper (QuestionCards) owns a pending question in
// the same row; once it is answered, declined or expired this record takes
// over. The answer is a turn of the person's own, so it carries the prompt's
// actions: copy, and Revert & edit, which rewinds to the answer and returns it
// to the composer.
import { useMemo } from "react";
import type { QuestionMsg } from "../reduce.ts";
import {
  answerText,
  normalizeQuestions,
  questionsToJson,
  questionsToMarkdown,
  type AnswerMap,
} from "../questionSerializers.ts";
import {
  copyAnnouncement,
  timeFull,
  timeIso,
  timeShort,
  type ActionAnnounceAnchor,
  type ActionAvailability,
} from "../messageActions.ts";
import type { UserMessageActionId } from "../messageActionLayout.ts";
import { useUiSettings } from "../uiPrefs.ts";
import { copyText } from "../utils.ts";
import { setUiError, useStore } from "../store.ts";
import { useTimelineProjectId, useTimelineSessionId } from "../timelineSession.ts";
import { tr } from "../i18n/index.ts";
import MessageActionBar, { useActionConfirmation, type MessageActionDef } from "./MessageActionBar.tsx";
import { MESSAGE_ACTION_ICONS, messageActionName } from "./messageActionCatalog.ts";

/** Only an answered question of this session's own can be rewound: a
 *  declined one has nothing to edit, and a subagent's mirror was answered for
 *  the child. The server applies the same rule. */
export function questionAnswerRewindable(m: QuestionMsg): boolean {
  return m.status === "answered"
    && m.answeredSeq !== undefined
    && m.answers !== undefined
    && m.sourceSessionId === undefined
    && m.answerRewindMarkerSeq === undefined;
}

function AnswerActions({ m, answerTime, markdown, json, announce, onRevert, revert }: {
  m: QuestionMsg;
  answerTime: number;
  markdown: string;
  json: string;
  announce: (text: string, anchor?: ActionAnnounceAnchor) => void;
  onRevert?: (message: QuestionMsg) => void;
  revert?: ActionAvailability;
}) {
  const prefs = useUiSettings();
  const sessionId = useTimelineSessionId();
  const projectId = useTimelineProjectId();
  const spaceId = useStore((state) => state.projectRegistry.projects.find((project) => project.id === projectId)?.spaceId);
  const [confirmed, confirm] = useActionConfirmation();
  const seq = m.answeredSeq!;
  const anchor = { role: "user" as const, eventSeq: seq };
  const copyFormat = prefs.messageCopyFormat;
  const actions: Array<MessageActionDef<UserMessageActionId>> = [{
    id: "copy",
    icon: MESSAGE_ACTION_ICONS.copy,
    label: tr("questioncards.copyAnswer"),
    menuLabel: messageActionName("copy"),
    run: () => {
      void copyText(copyFormat === "markdown" ? markdown : json).then((ok) => {
        const text = copyAnnouncement(ok ? copyFormat : "failed");
        if (ok) confirm("copy");
        announce(text, anchor);
        if (!ok) setUiError(text);
      });
    },
  }];
  if (onRevert && questionAnswerRewindable(m)) {
    const reason = revert?.enabled === false ? revert.reason : undefined;
    actions.push({
      id: "revert",
      icon: MESSAGE_ACTION_ICONS.revert,
      label: tr("questioncards.revertAnswerSentAt", { date: timeFull(answerTime) }),
      menuLabel: messageActionName("revert"),
      ...(reason ? { disabledReason: reason } : {}),
      disabled: reason !== undefined,
      data: { "data-revert-seq": seq },
      run: () => onRevert(m),
    });
  }
  return (
    <div className="msg-meta">
      <time className="msg-time" dateTime={timeIso(answerTime)} aria-label={tr("questioncards.answeredAt", { date: timeFull(answerTime) })}>
        {timeShort(answerTime)}
      </time>
      {prefs.showMessageActions && (
        <MessageActionBar
          role="user"
          className="chat-message-actions"
          layout={prefs.userMessageActions}
          actions={actions}
          confirmed={confirmed}
          label={tr("questioncards.actionsForAnswerAt", { date: timeFull(answerTime) })}
          moreLabel={tr("messageActions.more")}
          data={{ "data-actions-seq": seq }}
          context={{
            sessionId,
            projectId,
            spaceId,
            kind: "question",
            messageId: m.id,
            messageRole: "user",
            messageText: markdown,
            eventSeq: seq,
          }}
        />
      )}
    </div>
  );
}

export default function QuestionRecord({ m, entering = false, leaving = false, answerLeaving = false, announce, onRevert, revert }: {
  m: QuestionMsg;
  entering?: boolean;
  leaving?: boolean;
  /** Revert & edit of this answer was confirmed: the answer plays the cut's
   *  exit while the question stays. */
  answerLeaving?: boolean;
  announce?: (text: string, anchor?: ActionAnnounceAnchor) => void;
  onRevert?: (message: QuestionMsg) => void;
  revert?: ActionAvailability;
}) {
  const items = useMemo(() => normalizeQuestions(m.questions), [m.questions]);
  const answers = (m.answers ?? {}) as AnswerMap;
  const motion = `${entering ? " timeline-row-enter" : ""}${leaving ? " rewind-leaving" : ""}`;
  const showAnswer = m.status === "answered" && (m.answerRewindMarkerSeq === undefined || answerLeaving);
  const status = showAnswer ? null : m.status === "rejected"
    ? tr("questioncards.noAnswerGiven")
    : m.answerRewindMarkerSeq !== undefined
      ? m.answerReplaced ? tr("questioncards.answerReplaced") : tr("questioncards.answerReverted")
      : null;
  const at = m.answeredAt ?? m.time;
  return (
    <>
      <section className={`msg assistant question-record${motion}`} data-message-seq={m.eventSeq} aria-label={tr("questioncards.questionFromTheAgent")}>
        <div className="question-record-card">
          <div className="question-record-label">{tr("questioncards.questionFromTheAgent")}</div>
          {items.map((item, index) => {
            // Several questions are numbered so each answer below finds its own.
            const number = items.length > 1 ? `${index + 1}. ` : "";
            return (
              <div key={item.id} className="question-record-item" dir="auto">
                {item.title && <div className="question-record-title">{number}{item.title}</div>}
                <div className="question-record-prompt">{item.title ? "" : number}{item.prompt}</div>
              </div>
            );
          })}
          {status && <div className="question-record-status">{status}</div>}
        </div>
      </section>
      {showAnswer && (
        <div
          className={`msg user question-answer${entering ? " timeline-row-enter" : ""}${leaving || answerLeaving ? " rewind-leaving" : ""}`}
          data-message-seq={m.answeredSeq}
          role="article"
          aria-label={tr("questioncards.answeredAt", { date: timeFull(at) })}
        >
          <div className="bubble" dir="auto">
            {items.map((item, index) => {
              const text = answerText(item, answers[item.id]) || tr("questioncards.noAnswer");
              return items.length > 1
                ? (
                    <div key={item.id} className="question-answer-line">
                      <span className="question-answer-prompt">{index + 1}. {item.title ?? item.prompt}</span>
                      <span className="question-answer-text">{text}</span>
                    </div>
                  )
                : <div key={item.id} className="question-answer-text">{text}</div>;
            })}
          </div>
          {announce && (
            <AnswerActions
              m={m}
              answerTime={at}
              markdown={questionsToMarkdown(items, answers)}
              json={questionsToJson(m.requestId, items, answers)}
              announce={announce}
              onRevert={onRevert}
              revert={revert}
            />
          )}
        </div>
      )}
    </>
  );
}
