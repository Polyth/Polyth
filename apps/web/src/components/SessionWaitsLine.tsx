// What this chat waits for: a chat it watches or a polyth_wait, armed to wake
// it. One quiet line of the pending stack above the composer while the chat
// is at rest, on the stack's grid like the suggestion line: hourglass on the
// marks' column, "Continues after «Title»" from the labels' column, the title
// in the line's one stronger ink. The waited-on chat opens from it.
// State: `SessionProjection.waits`; docs/dev/ui.md "Waiting chats".
import type { SessionProjection, SessionWait } from "@polyth/contracts";
import { displaySessionTitle } from "../format.ts";
import { getLocale, tr } from "../i18n/index.ts";
import { openSession } from "../init.ts";
import { useStore } from "../store.ts";
import ComposerNoticeRow from "./ui/ComposerNoticeRow.tsx";
import UiIcon from "./ui/Icon.tsx";
import { HourglassIcon } from "./ui/icons.ts";
import "./SessionWaitsLine.css";

const NO_WAITS: readonly SessionWait[] = [];
// Stands in for the object while the sentence is split around it, so every
// locale keeps its own word order.
const SLOT = "\u0000";

/** One wait in words. A watched chat is named by the title this client may
 *  read; one it does not hold is "another chat", never its id. `object` is the
 *  waited-on thing alone; `text` is the whole sentence. */
export function sessionWaitText(wait: SessionWait, sessions: readonly SessionProjection[]): {
  text: string;
  object: string;
  key: "sessionwaits.forChat" | "sessionwaits.forThing";
  sourceSessionId?: string;
} {
  if (wait.sourceSessionId) {
    const source = sessions.find((session) => session.id === wait.sourceSessionId);
    const title = source ? displaySessionTitle(source.title ?? "", source.id) : tr("sessionwaits.anotherChat");
    return {
      text: tr("sessionwaits.forChat", { title }),
      object: title,
      key: "sessionwaits.forChat",
      ...(source ? { sourceSessionId: source.id } : {}),
    };
  }
  const label = wait.label ?? wait.kind;
  return { text: tr("sessionwaits.forThing", { label }), object: label, key: "sessionwaits.forThing" };
}

function deadlineText(deadline: number | undefined): string {
  if (!deadline || !Number.isFinite(deadline)) return "";
  const time = new Date(deadline).toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" });
  return tr("sessionwaits.until", { time });
}

/** The sentence with its object set apart, in the locale's own order. */
function Sentence({ lead }: { lead: ReturnType<typeof sessionWaitText> }) {
  const shape = lead.key === "sessionwaits.forChat"
    ? tr(lead.key, { title: SLOT })
    : tr(lead.key, { label: SLOT });
  const at = shape.indexOf(SLOT);
  if (at < 0) return <span className="session-waits-text">{lead.text}</span>;
  return (
    <span className="session-waits-text">
      {shape.slice(0, at)}
      <span className="session-waits-object">{lead.object}</span>
      {shape.slice(at + SLOT.length)}
    </span>
  );
}

export default function SessionWaitsLine({ waits, idle }: {
  waits: readonly SessionWait[] | undefined;
  /** The chat is at rest: a running turn's own status line says enough. */
  idle: boolean;
}) {
  const sessions = useStore((state) => state.sessions);
  const list = waits ?? NO_WAITS;
  const open = idle && list.length > 0;
  const first = list[0];
  const line = open && first ? (() => {
    const lead = sessionWaitText(first, sessions);
    const until = deadlineText(first.deadline);
    const rest = list.slice(1).map((wait) => sessionWaitText(wait, sessions).text);
    const detail = [lead.text, ...rest, until, tr("sessionwaits.wakes")].filter(Boolean).join("\n");
    const meta = [until, rest.length > 0 ? tr("sessionwaits.more", { count: rest.length }) : ""].filter(Boolean);
    const body = (
      <>
        <UiIcon icon={HourglassIcon} size="sm" className="session-waits-mark" />
        <Sentence lead={lead} />
        {meta.map((item) => <span key={item} className="session-waits-meta">{item}</span>)}
      </>
    );
    return (
      <div className="session-waits" role="status" aria-label={detail}>
        {lead.sourceSessionId ? (
          <button
            type="button"
            className="session-waits-row"
            title={detail}
            aria-label={tr("sessionwaits.open", { text: lead.text })}
            onClick={() => void openSession(lead.sourceSessionId!)}
          >
            {body}
          </button>
        ) : (
          <div className="session-waits-row" title={detail}>{body}</div>
        )}
      </div>
    );
  })() : null;
  return <ComposerNoticeRow open={open}>{line}</ComposerNoticeRow>;
}
