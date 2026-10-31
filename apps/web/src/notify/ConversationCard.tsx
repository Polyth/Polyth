// A person's message or mention as a messenger card in the one notification
// stack (NotificationStack draws the card, its motion and lifetime; this draws
// what is on it). It answers, in reading order: who wrote (their colour and
// monogram, the same as in the chat), where, what — the newest lines of a
// burst, each voice named in its colour — and offers a reply that posts as the
// reader without leaving the chat they are in. The head opens the chat.
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { PERSON_MESSAGE_MAX_CHARS } from "@polyth/contracts";
import { tr } from "../i18n/index.ts";
import { activeBrowserAccountId } from "../accountStorage.ts";
import { assignPersonTones, personToneOf } from "../personIdentity.ts";
import { personInitials, useSessionPeople } from "../sessionPeople.ts";
import IconButton from "../components/ui/IconButton.tsx";
import Icon from "../components/ui/Icon.tsx";
import { ArrowUpIcon, ChatIcon, CheckIcon, MentionIcon } from "../components/ui/icons.ts";
import {
  DEFAULT_DURATION,
  updateNotification,
  type ConversationNotice,
  type ConversationNoticeLine,
  type NotificationRecord,
} from "./store.ts";

/** After a reply went through, the card says so this long, then leaves. */
const SENT_LINGER_MS = 1_400;

type Author = NonNullable<ConversationNoticeLine["author"]>;

/** Distinct authors, newest first. */
function authorsOf(lines: readonly ConversationNoticeLine[]): Author[] {
  const seen = new Map<string, Author>();
  for (let index = lines.length - 1; index >= 0; index--) {
    const author = lines[index]!.author;
    if (author && !seen.has(author.userId)) seen.set(author.userId, author);
  }
  return [...seen.values()];
}

/** "now" within a minute, else the clock time. */
function whenLabel(ts: number, now: number): string {
  if (now - ts < 60_000) return tr("notify.people.now");
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export default function ConversationCard({
  record,
  notice,
  titleId,
  close,
  onClose,
}: {
  record: NotificationRecord;
  notice: ConversationNotice;
  titleId: string;
  /** The stack's close control, placed in the card's corner. */
  close: ReactNode;
  onClose(): void;
}) {
  const people = useSessionPeople(notice.sessionId);
  const tones = useMemo(() => assignPersonTones([
    activeBrowserAccountId(),
    ...people.map((person) => person.userId),
    ...notice.lines.flatMap((line) => line.author ? [line.author.userId] : []),
  ]), [people, notice.lines]);
  const authors = authorsOf(notice.lines);
  const single = authors.length <= 1;
  const latest = notice.lines[notice.lines.length - 1];
  const mention = notice.mention ?? notice.lines.some((line) => line.mention);
  const title = single ? (authors[0]?.name ?? notice.chat) : notice.chat;
  const more = notice.count - notice.lines.length;
  const open = () => {
    notice.open();
    onClose();
  };
  return (
    <>
      <button
        type="button"
        className="notify-conversation-open"
        data-single={single || undefined}
        aria-label={tr("notify.people.open", { chat: notice.chat })}
        onClick={open}
      >
        <ConversationAvatar author={authors[0]} tones={tones} mention={mention} />
        <span className="notify-conversation-head">
          <span className="notify-conversation-title" id={titleId}><bdi>{title}</bdi></span>
          {latest && <time className="notify-conversation-time" dateTime={new Date(latest.ts).toISOString()}>{whenLabel(latest.ts, Date.now())}</time>}
        </span>
        <span className="notify-conversation-where">
          {mention && <span className="notify-conversation-mentioned">{tr("notify.people.mentionedYou")}</span>}
          {single
            ? <bdi className="notify-conversation-chat">{notice.chat}</bdi>
            : <span>{tr("notify.people.newMessages", { count: notice.count })}</span>}
        </span>
        <span className="notify-conversation-lines" data-count={notice.lines.length}>
          {more > 0 && <span className="notify-conversation-earlier">{tr("notify.people.earlier", { count: more })}</span>}
          {notice.lines.map((line) => (
            <span key={line.id} className="notify-conversation-line" dir="auto">
              {!single && line.author && (
                <span className="notify-conversation-who" data-person-tone={personToneOf(tones, line.author.userId) ?? undefined}>
                  <bdi>{line.author.name}</bdi>
                </span>
              )}
              <span className="notify-conversation-text">{line.text}</span>
            </span>
          ))}
        </span>
      </button>
      {close}
      {notice.reply && (
        <ReplyField
          record={record}
          placeholder={single && authors[0]
            ? tr("notify.people.replyTo", { name: authors[0].name.split(/\s+/)[0] || authors[0].name })
            : tr("notify.people.replyInChat", { chat: notice.chat })}
          reply={notice.reply}
          onSent={onClose}
        />
      )}
    </>
  );
}

/** The newest sender's monogram in their colour (a burst names every voice
 *  in its lines). A mention wears a small @ on the corner. */
function ConversationAvatar({ author, tones, mention }: { author: Author | undefined; tones: ReadonlyMap<string, number>; mention: boolean }) {
  return (
    <span className="notify-conversation-avatar" aria-hidden="true">
      {author
        ? (
          <span className="person-mark notify-conversation-mark" data-person-tone={personToneOf(tones, author.userId) ?? undefined}>
            {personInitials(author.name)}
          </span>
        )
        : <span className="person-mark notify-conversation-mark is-empty"><Icon icon={ChatIcon} size="md" /></span>}
      {mention && <span className="notify-conversation-badge"><Icon icon={MentionIcon} size="sm" /></span>}
    </span>
  );
}

type ReplyState = "idle" | "sending" | "sent" | "failed";

/** One line to answer in place. While it holds a draft the card stays; once
 *  sent it says so and leaves. A failure keeps the words and says why. */
function ReplyField({ record, placeholder, reply, onSent }: {
  record: NotificationRecord;
  placeholder: string;
  reply(text: string): Promise<void>;
  onSent(): void;
}) {
  const [text, setText] = useState("");
  const [state, setState] = useState<ReplyState>("idle");
  const live = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    live.current = false;
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  // A started reply keeps the card until it is sent or cleared — also when
  // the chat's next message replaces the record (which brings a countdown).
  const holding = text.trim().length > 0 || state === "sending";
  useEffect(() => {
    if (holding && record.duration !== "sticky") updateNotification(record.id, { duration: "sticky" });
    else if (!holding && record.duration === "sticky") updateNotification(record.id, { duration: DEFAULT_DURATION[record.kind] });
  }, [holding, record.id, record.kind, record.duration]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const words = text.trim();
    if (!words || state === "sending" || state === "sent") return;
    setState("sending");
    void reply(words).then(() => {
      if (!live.current) return;
      setText("");
      setState("sent");
      timer.current = setTimeout(onSent, SENT_LINGER_MS);
    }, () => {
      if (live.current) setState("failed");
    });
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // Escape clears a draft first; on an empty field it closes the card.
    if (event.key === "Escape" && text) {
      event.stopPropagation();
      event.preventDefault();
      setText("");
      if (state === "failed") setState("idle");
    }
  };

  if (state === "sent") {
    return (
      <p className="notify-reply-sent" role="status">
        <Icon icon={CheckIcon} size="sm" />
        {tr("notify.people.sent")}
      </p>
    );
  }
  const ready = text.trim().length > 0 && state !== "sending";
  return (
    <form className="notify-reply" data-state={state} onSubmit={submit}>
      <span className="notify-reply-field">
        <input
          className="notify-reply-input"
          type="text"
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          enterKeyHint="send"
          autoComplete="off"
          maxLength={PERSON_MESSAGE_MAX_CHARS}
          disabled={state === "sending"}
          onChange={(event) => {
            setText(event.target.value);
            if (state === "failed") setState("idle");
          }}
          onKeyDown={onKeyDown}
        />
        <IconButton
          type="submit"
          icon={ArrowUpIcon}
          size="sm"
          variant="ghost"
          className="notify-reply-send"
          data-ready={ready || undefined}
          label={tr("notify.people.send")}
          busy={state === "sending"}
          disabled={!ready}
        />
      </span>
      {state === "failed" && <span className="notify-reply-error" role="alert">{tr("notify.people.failed")}</span>}
    </form>
  );
}
