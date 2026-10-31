// A permission judge's note on one waiting request, inside that request's card
// (`session.permission.notes`): that it is checking, that it got no answer, or
// its verdict with the judge's chance that the request is safe. The answer is
// a second model's opinion: only an approval or a denial acts (and closes the
// card), so every note a card still shows leaves the decision to its person.
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { SessionEvent } from "@polyth/contracts";
import { tr } from "@polyth/web/i18n";
import { Badge, Spinner, VisuallyHidden, type BadgeTone } from "@polyth/web/ui";
import {
  REQUEST_CHECK_EVENT, REQUEST_CHECK_STALE_MS, REQUEST_VERDICT_EVENT, REQUEST_VERDICTS,
  type RequestCheckData, type RequestVerdictData, type RequestVerdictKind,
} from "../src/types.ts";

const chance = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const percent = (value: number) => Math.round(value * 100);
const named = (data: { judgeId?: unknown; title?: unknown; requestId?: unknown }) =>
  typeof data.judgeId === "string" && typeof data.title === "string" && typeof data.requestId === "string";

export function readVerdict(event: SessionEvent): RequestVerdictData | undefined {
  if (event.type !== REQUEST_VERDICT_EVENT) return undefined;
  const data = event.data as Partial<RequestVerdictData>;
  if (!named(data) || !REQUEST_VERDICTS.includes(data.verdict as RequestVerdictKind) || !chance(data.safety)) return undefined;
  return data as RequestVerdictData;
}

export function readCheck(event: SessionEvent): RequestCheckData | undefined {
  if (event.type !== REQUEST_CHECK_EVENT) return undefined;
  const data = event.data as Partial<RequestCheckData>;
  if (!named(data) || (data.state !== "checking" && data.state !== "no-answer")) return undefined;
  return data as RequestCheckData;
}

export type RequestNote = { seq: number; judgeId: string } & (
  | { kind: "verdict"; data: RequestVerdictData }
  | { kind: "check"; data: RequestCheckData; since: number });

/**
 * The latest note of each judge on one request (a check or a verdict), oldest
 * judge first. A mirrored card (`sourceSessionId`) shows only copies naming
 * the same child. Notes follow their request, so the scan stops at it.
 */
export function requestNotes(events: readonly SessionEvent[], requestId: string, sourceSessionId?: string): RequestNote[] {
  const latest = new Map<string, RequestNote>();
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.type === "permission/requested" && (event.data as { requestId?: unknown }).requestId === requestId) break;
    const verdict = readVerdict(event), check = verdict ? undefined : readCheck(event);
    const data = verdict ?? check;
    if (!data || data.requestId !== requestId || data.sourceSessionId !== sourceSessionId || latest.has(data.judgeId)) continue;
    latest.set(data.judgeId, verdict ? { seq: event.seq, judgeId: data.judgeId, kind: "verdict", data: verdict }
      : { seq: event.seq, judgeId: data.judgeId, kind: "check", data: check!, since: typeof check!.ts === "number" && Number.isFinite(check!.ts) ? check!.ts : event.time });
  }
  return [...latest.values()].sort((a, b) => a.seq - b.seq);
}

/** The words carry the verdict; the tone only repeats it. */
const TONES: Record<RequestVerdictKind, BadgeTone> = { approve: "success", clear: "success", unsure: "warning", against: "danger", deny: "danger" };

/** Why an approval or denial did not go through: the known skips in the person's language, anything else as the server said it. */
function notAppliedText(action: NonNullable<RequestVerdictData["action"]>): string {
  if (action.reason === "space-never-approves") return tr("judgesverdict.spaceNeverApproves");
  if (action.reason === "acts-for-no-one") return tr("judgesverdict.actsForNoOne");
  return tr("judgesverdict.notApplied", { reason: typeof action.detail === "string" && action.detail ? action.detail : action.status });
}

export function VerdictNote({ data }: { data: RequestVerdictData }) {
  const safety = percent(data.safety);
  const acted = data.verdict === "approve" || data.verdict === "deny";
  const notApplied = acted && data.action ? notAppliedText(data.action) : undefined;
  // The judge's own answer is detail: the tooltip names it, the line stays short.
  const answer = typeof data.label === "string" && data.label && chance(data.probability)
    ? tr("judgesverdict.answer", { judge: data.title, answer: data.label, percent: percent(data.probability) }) : "";
  const title = [answer, acted && !notApplied ? "" : tr("judgesverdict.yours")].filter(Boolean).join(" ");
  return <p className="judges-verdict" data-verdict={data.verdict} title={title || undefined}>
    <Badge tone={TONES[data.verdict]} dot>{tr(`judgesverdict.${data.verdict}`)}</Badge>
    <span className="judges-verdict-judge">{data.title}</span>
    <span className="judges-verdict-safety">
      <span className="judges-verdict-meter" aria-hidden="true" style={{ "--judges-verdict-safety": data.safety } as CSSProperties} />
      <span className="judges-verdict-percent">{tr("judgesverdict.safety", { percent: safety })}</span>
    </span>
    {notApplied && <span className="judges-verdict-detail">{notApplied}</span>}
    {title && <VisuallyHidden>{title}</VisuallyHidden>}
  </p>;
}

/** A judge still thinking, or one whose call got no answer (or was cut short): the decision stays the person's. */
export function CheckNote({ data, stale }: { data: RequestCheckData; stale: boolean }) {
  const checking = data.state === "checking" && !stale;
  const title = checking ? tr("judgesverdict.checkingTitle", { judge: data.title })
    : `${tr(data.reason === "timeout" ? "judgesverdict.noAnswerTimeout" : "judgesverdict.noAnswerTitle", { judge: data.title })} ${tr("judgesverdict.yours")}`;
  return <p className="judges-verdict" data-verdict={checking ? "checking" : "no-answer"} title={title}>
    <Badge tone="neutral" dot={!checking}>{checking && <Spinner size="sm" className="judges-verdict-spinner" />}
      {tr(checking ? "judgesverdict.checking" : "judgesverdict.noAnswer")}</Badge>
    <span className="judges-verdict-judge">{data.title}</span>
    <VisuallyHidden>{title}</VisuallyHidden>
  </p>;
}

interface SessionsReader {
  events(sessionId: string): readonly SessionEvent[];
  subscribe(listener: () => void): () => void;
}

/** Every deciding judge's note on the request a card shows; nothing until one starts. */
export default function RequestVerdicts({ sessions, sessionId, requestId, sourceSessionId, now: clock = Date.now }: {
  sessions: SessionsReader; sessionId: string; requestId: string; sourceSessionId?: string; now?: () => number;
}) {
  // The store notifies for every chat; this chat's events keep their identity
  // until it changes, so only its own new events rescan (back to the request).
  const read = useRef<{ events?: readonly SessionEvent[]; target: string; key: string; notes: RequestNote[] }>({ target: "", key: "", notes: [] });
  const target = `${sessionId}\0${requestId}\0${sourceSessionId ?? ""}`;
  useSyncExternalStore(sessions.subscribe, () => {
    const events = sessions.events(sessionId);
    if (events === read.current.events && target === read.current.target) return read.current.key;
    const notes = requestNotes(events, requestId, sourceSessionId);
    const key = notes.map((entry) => entry.seq).join(",");
    read.current = { events, target, key, notes: key === read.current.key && target === read.current.target ? read.current.notes : notes };
    return key;
  });
  const notes = read.current.notes;
  // A check with nothing after it for too long was cut short: re-render when the next one goes stale.
  // One that arrives while the card is open is timed by this device's clock alone, so a clock set
  // ahead of the server's never cuts a live check short; one read from history is timed from its record.
  const [now, setNow] = useState(clock);
  const history = useRef<number | undefined>(undefined);
  const arrived = useRef(new Map<number, number>());
  history.current ??= Math.max(0, ...notes.map((note) => note.seq));
  for (const note of notes) {
    if (note.kind === "check" && note.seq > history.current && !arrived.current.has(note.seq)) arrived.current.set(note.seq, clock());
  }
  const startedAt = (note: RequestNote) => arrived.current.get(note.seq) ?? (note.kind === "check" ? note.since : 0);
  const stale = (note: RequestNote) => note.kind === "check" && startedAt(note) + REQUEST_CHECK_STALE_MS <= now;
  const staleAt = Math.min(...notes.flatMap((note) => note.kind === "check" && note.data.state === "checking" && !stale(note)
    ? [startedAt(note) + REQUEST_CHECK_STALE_MS] : []));
  useEffect(() => {
    if (!Number.isFinite(staleAt)) return;
    const timer = setTimeout(() => setNow(clock()), Math.max(0, staleAt - clock()) + 50);
    return () => clearTimeout(timer);
  }, [staleAt, clock]);
  if (!notes.length) return null;
  // One polite live region for every judge's line, so a check turning into a verdict is announced once.
  return <div className="judges-verdicts" role="status">
    {notes.map((note) => note.kind === "verdict" ? <VerdictNote key={note.judgeId} data={note.data} />
      : <CheckNote key={note.judgeId} data={note.data} stale={stale(note)} />)}
  </div>;
}
