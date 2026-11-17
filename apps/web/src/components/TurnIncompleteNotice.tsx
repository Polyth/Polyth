import { tr } from "../i18n/index.ts";
import type { NoticeMsg } from "../reduce.ts";
import "./TurnIncompleteNotice.css";

/** The text a person's Continue sends: a normal, visible prompt. */
export const CONTINUE_PROMPT = "Continue";

type Send = (text: string, model?: undefined, agent?: undefined, opts?: { targetSessionId?: string }) => Promise<boolean>;

/** Continue through the ordinary send path as a visible message (never the
 *  hidden continuation Polyth itself sends). */
export function continueIncompleteTurn(send: Send, sessionId: string): Promise<boolean> {
  return send(CONTINUE_PROMPT, undefined, undefined, { targetSessionId: sessionId });
}

/**
 * A completed turn whose answer is not whole: it hit the model's output limit,
 * or the agent stopped without replying. When Polyth already asked it to
 * continue, the notice says so; otherwise, while it is the chat's newest row,
 * it offers Continue as a text action right after the fact.
 */
export default function TurnIncompleteNotice({ notice, onContinue, entering = false, leaving = false }: {
  notice: NoticeMsg;
  /** Present only while a person's Continue still makes sense. */
  onContinue?: () => void;
  entering?: boolean;
  leaving?: boolean;
}) {
  const length = notice.incompleteKind === "length";
  // The action names what it does ("Ask it to continue" sends a visible
  // message), so nobody mistakes it for expanding a truncated text.
  // A footnote of the agent's turn in its own column, like the model line:
  // no icon and no disc, so it never reads as a message from Polyth.
  return (
    <div
      className={`turn-incomplete${entering ? " timeline-row-enter" : ""}${leaving ? " rewind-leaving" : ""}`}
      data-msg-id={notice.id}
      role="note"
    >
      <span className="turn-incomplete-fact">{tr(length ? "timeline.incompleteLength" : "timeline.incompleteEmpty")}</span>
      {notice.autoContinued
        ? <span className="turn-incomplete-note">{tr("timeline.incompleteAutoContinued")}</span>
        : onContinue
          ? <button type="button" className="turn-incomplete-continue" onClick={onContinue}>
            {tr("timeline.incompleteContinue")}
          </button>
          : null}
    </div>
  );
}
