// What this chat waits for: a chat it watches or a polyth_wait, armed to wake
// it. One quiet line of the pending stack above the composer while the chat
// is at rest, on the stack's grid like the suggestion line: the waiting clock
// on the marks' column, "Continues after «Title»" from the labels' column, the
// title in the line's one stronger ink. A timer reads as the time left
// ("Continues in 3h 52m · 1:20 PM"). The waited-on chat opens from it.
// State: `SessionProjection.waits`; docs/dev/ui.md "Waiting chats".
import type { SessionProjection, SessionWait } from "@polyth/contracts";
import { displaySessionTitle, fmtDuration } from "../format.ts";
import { formatDate, formatRelativeTime, tr } from "../i18n/index.ts";
import { openSession } from "../init.ts";
import { useNowTick } from "../nowTicker.ts";
import { useStore } from "../store.ts";
import ComposerNoticeRow from "./ui/ComposerNoticeRow.tsx";
import UiIcon from "./ui/Icon.tsx";
import { AwaitingIcon } from "./ui/icons.ts";
import "./SessionWaitsLine.css";

const NO_WAITS: readonly SessionWait[] = [];
// Stands in for the object while the sentence is split around it, so every
// locale keeps its own word order.
const SLOT = "\u0000";
type WaitSentenceKey = "sessionwaits.forChat" | "sessionwaits.forThing" | "sessionwaits.forTimer" | "sessionwaits.timerDue";
/** The one parameter each sentence sets apart; a sentence without one stays whole. */
const SLOT_PARAM: Partial<Record<WaitSentenceKey, string>> = {
  "sessionwaits.forChat": "title",
  "sessionwaits.forThing": "label",
  "sessionwaits.forTimer": "duration",
};

/** A `polyth_wait` timer. Its own label is the raw length ("14400 seconds"),
 *  so the line names the time left instead. */
function isTimer(wait: SessionWait): wait is SessionWait & { deadline: number } {
  return wait.kind === "seconds" && typeof wait.deadline === "number" && Number.isFinite(wait.deadline);
}

/** Time left in words: whole minutes, rounded up ("4h", "3h 52m", "12m");
 *  seconds only in the last minute. */
export function waitRemainingText(ms: number): string {
  return ms < 60_000
    ? fmtDuration(Math.ceil(ms / 1000) * 1000)
    : fmtDuration(Math.ceil(ms / 60_000) * 60_000);
}

const startOfLocalDay = (ms: number): number => {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

/** When a wait ends as a clock reading, without a leading zero: "1:20 PM"
 *  today, "tomorrow 9:05 AM", a weekday within the week, otherwise the date. */
export function waitClockText(deadline: number, now = Date.now()): string {
  const time = formatDate(deadline, { hour: "numeric", minute: "2-digit" });
  // Rounded so a daylight-saving day (23 or 25 hours) still counts as one.
  const days = Math.round((startOfLocalDay(deadline) - startOfLocalDay(now)) / 86_400_000);
  if (days <= 0) return time;
  if (days === 1) return `${formatRelativeTime(1, "day", { numeric: "auto" })} ${time}`;
  if (days < 7) return `${formatDate(deadline, { weekday: "short" })} ${time}`;
  return formatDate(deadline, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** One wait in words. A watched chat is named by the title this client may
 *  read; one it does not hold is "another chat", never its id. A timer is the
 *  time left from `now`. `object` is the waited-on thing alone; `text` is the
 *  whole sentence. */
export function sessionWaitText(wait: SessionWait, sessions: readonly SessionProjection[], now = Date.now()): {
  text: string;
  object: string;
  key: WaitSentenceKey;
  sourceSessionId?: string;
} {
  if (isTimer(wait)) {
    const left = wait.deadline - now;
    if (left <= 0) return { text: tr("sessionwaits.timerDue"), object: "", key: "sessionwaits.timerDue" };
    const duration = waitRemainingText(left);
    return { text: tr("sessionwaits.forTimer", { duration }), object: duration, key: "sessionwaits.forTimer" };
  }
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

/** The trailing clock: a timer's is when it continues, after "in 3h 52m";
 *  any other bounded wait gives up "until" its deadline. */
function deadlineText(wait: SessionWait, now: number): string {
  const { deadline } = wait;
  if (!deadline || !Number.isFinite(deadline)) return "";
  if (isTimer(wait)) return deadline > now ? waitClockText(deadline, now) : "";
  return tr("sessionwaits.until", { time: waitClockText(deadline, now) });
}

/** The sentence with its object set apart, in the locale's own order. */
function Sentence({ lead }: { lead: ReturnType<typeof sessionWaitText> }) {
  const param = SLOT_PARAM[lead.key];
  const shape = param ? tr(lead.key, { [param]: SLOT }) : lead.text;
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
  // Only a timer's words move with the clock.
  const now = useNowTick(open && list.some(isTimer));
  const first = list[0];
  const line = open && first ? (() => {
    const lead = sessionWaitText(first, sessions, now);
    const until = deadlineText(first, now);
    const rest = list.slice(1).map((wait) => sessionWaitText(wait, sessions, now).text);
    const detail = [lead.text, ...rest, until, tr("sessionwaits.wakes")].filter(Boolean).join("\n");
    const meta = [until, rest.length > 0 ? tr("sessionwaits.more", { count: rest.length }) : ""].filter(Boolean);
    const body = (
      <>
        <UiIcon icon={AwaitingIcon} size="sm" className="session-waits-mark" />
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
