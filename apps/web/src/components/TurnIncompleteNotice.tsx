import { tr } from "../i18n/index.ts";
import type { NoticeMsg } from "../reduce.ts";
import Icon from "./ui/Icon.tsx";
import { Button } from "./ui/index.ts";
import { InfoIcon, PlayIcon } from "./ui/icons.ts";
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
 * it offers a quiet Continue.
 */
export default function TurnIncompleteNotice({ notice, onContinue, entering = false, leaving = false }: {
  notice: NoticeMsg;
  /** Present only while a person's Continue still makes sense. */
  onContinue?: () => void;
  entering?: boolean;
  leaving?: boolean;
}) {
  const length = notice.incompleteKind === "length";
  return (
    <div
      className={`turn-incomplete turn-incomplete--${length ? "length" : "empty"}${entering ? " timeline-row-enter" : ""}${leaving ? " rewind-leaving" : ""}`}
      data-msg-id={notice.id}
      role="note"
    >
      <span className="turn-incomplete-mark" aria-hidden="true"><Icon icon={InfoIcon} size="sm" /></span>
      <span className="turn-incomplete-text">
        <span className="turn-incomplete-fact">{tr(length ? "timeline.incompleteLength" : "timeline.incompleteEmpty")}</span>
        {notice.autoContinued
          ? <span className="turn-incomplete-note">{tr("timeline.incompleteAutoContinued")}</span>
          : null}
      </span>
      {!notice.autoContinued && onContinue
        ? <Button className="turn-incomplete-continue" variant="ghost" size="sm" iconStart={PlayIcon} onClick={onContinue}>
          {tr("timeline.incompleteContinue")}
        </Button>
        : null}
    </div>
  );
}
