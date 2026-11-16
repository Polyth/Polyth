// "Answer later": the questions and approvals a person folded (or that folded
// themselves while they typed) wait as one plateless line of the pending stack
// above the composer: "1 question waiting · Answer". The whole line is the
// target; it opens every waiting item and the first one takes the focus.
// State lives in @polyth/web-sdk/answer-later; docs/dev/ui.md "Answer later".
import type { RenderModel } from "../reduce.ts";
import { answerLaterKey, isDeferred, openAnswerLater, useAnswerLaterVersion } from "@polyth/web-sdk/answer-later";
import { tr } from "../i18n/index.ts";
import { HelpIcon, Icon } from "./ui/index.ts";
import "./AnswerLaterLine.css";

/** The waiting items of one chat, oldest first, questions before approvals. */
export function waitingItems(sessionId: string, model: Pick<RenderModel, "questions" | "permissions">): {
  questions: string[];
  approvals: string[];
} {
  const questions = model.questions
    .filter((q) => q.status === "pending")
    .map((q) => answerLaterKey("question", sessionId, q.requestId))
    .filter(isDeferred);
  const approvals = model.permissions
    .filter((p) => p.status === "pending")
    .map((p) => answerLaterKey("approval", p.sessionId, p.requestId))
    .filter(isDeferred);
  return { questions, approvals };
}

export function waitingLabel(questions: number, approvals: number): string {
  const q = questions === 1 ? tr("answerlater.questionOne") : tr("answerlater.questionMany", { count: questions });
  const a = approvals === 1 ? tr("answerlater.approvalOne") : tr("answerlater.approvalMany", { count: approvals });
  const items = questions > 0 && approvals > 0
    ? tr("answerlater.and", { first: q, second: a })
    : questions > 0 ? q : a;
  return tr("answerlater.waiting", { items });
}

export default function AnswerLaterLine({ sessionId, model }: {
  sessionId: string | null;
  model: Pick<RenderModel, "questions" | "permissions">;
}) {
  useAnswerLaterVersion();
  if (!sessionId) return null;
  const { questions, approvals } = waitingItems(sessionId, model);
  if (questions.length + approvals.length === 0) return null;
  const label = waitingLabel(questions.length, approvals.length);
  return (
    <div className="answer-later">
      <button
        type="button"
        className="answer-later-open"
        aria-label={`${label}. ${tr("answerlater.answer")}`}
        onClick={() => openAnswerLater([...questions, ...approvals])}
      >
        <Icon icon={HelpIcon} size="sm" className="answer-later-mark" />
        <span className="answer-later-text">
          <span className="answer-later-count">{label}</span>
          <span className="answer-later-sep" aria-hidden="true"> · </span>
          <span className="answer-later-action">{tr("answerlater.answer")}</span>
        </span>
      </button>
    </div>
  );
}
