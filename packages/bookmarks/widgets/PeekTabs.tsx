// The tabs in the chat's bookmark popover: the same icon and popover as the
// prompt list, so reaching a bookmark is one tap from where a person already
// goes. A name goes to its place, the arrow opens the text in place, and a link
// leaves Polyth like a link in the chat, with the popover still open on return.
import { useState } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import { BookmarkIcon, ChevronDownIcon, ChevronRightIcon, Icon, IconButton, PlusIcon, QuoteIcon, MarkdownIcon, type LucideIcon } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { deriveBookmarkTitle, extractBookmarkSection, type BookmarkKind, type BookmarkView } from "../src/bookmarks.ts";
import { getSessionBookmarks, setBookmarkWalk, useSessionBookmarks } from "./client.ts";
import { openBookmarksPane, reportMissingPlace, revealBookmark, saveWithUndo } from "./commands.ts";
import { LinkRow, SavedText } from "./SavedText.tsx";

type Context = Readonly<Record<string, unknown>>;

const KIND_ICONS: Record<BookmarkKind, LucideIcon> = {
  answer: BookmarkIcon,
  section: BookmarkIcon,
  fragment: QuoteIcon,
  note: MarkdownIcon,
};

const sessionOf = (context: Context): string | null => (typeof context.sessionId === "string" ? context.sessionId : null);
const closerOf = (context: Context): (() => void) => (typeof context.closePromptPopover === "function" ? context.closePromptPopover as () => void : () => {});

interface Place {
  kind: "answer" | "section";
  eventSeq: number;
  body: string;
  title: string;
}

const answerText = (event: { data: unknown }): string | null => {
  const text = (event.data as { text?: unknown }).text;
  return typeof text === "string" && text.trim() ? text : null;
};

/** What the row offers to save: the section being read, else the answer being
 *  read, else the newest finished answer. Nothing once that is already saved. */
function placeToBookmark(host: WebPackageHost, sessionId: string, context: Context): Place | null {
  const events = host.sessions.events(sessionId);
  const position = typeof context.promptReadingPosition === "function"
    ? (context.promptReadingPosition as () => { eventSeq: number; heading?: string } | null)()
    : null;
  const read = position ? events.find((event) => event.seq === position.eventSeq && event.type === "assistant/message") : undefined;
  const answer = read ?? events.findLast((event) => event.type === "assistant/message" && answerText(event) !== null);
  const text = answer ? answerText(answer) : null;
  if (!answer || !text) return null;
  const saved = getSessionBookmarks(sessionId).filter((bookmark) => bookmark.eventSeq === answer.seq);
  const section = read && position?.heading ? extractBookmarkSection(text, position.heading) : null;
  if (section && position?.heading) {
    return saved.some((bookmark) => bookmark.kind === "section" && bookmark.title === position.heading)
      ? null
      : { kind: "section", eventSeq: answer.seq, body: section, title: position.heading };
  }
  if (saved.some((bookmark) => bookmark.kind === "answer")) return null;
  const title = deriveBookmarkTitle(text);
  return title ? { kind: "answer", eventSeq: answer.seq, body: text, title } : null;
}

function AddRow({ host, sessionId, context }: { host: WebPackageHost; sessionId: string; context: Context }) {
  const [busy, setBusy] = useState(false);
  const place = placeToBookmark(host, sessionId, context);
  if (!place) return null;
  return (
    <button
      type="button"
      className="bm-peek-add"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void saveWithUndo(host, {
          kind: place.kind,
          sessionId,
          eventSeq: place.eventSeq,
          body: place.body,
          ...(place.kind === "section" ? { title: place.title } : {}),
        }).finally(() => setBusy(false));
      }}
    >
      <Icon icon={PlusIcon} size="sm" />
      <bdi className="bm-peek-add-text">{tr("bookmarks.peek.add", { title: place.title.length > 48 ? `${place.title.slice(0, 47)}…` : place.title })}</bdi>
    </button>
  );
}

function PeekRow({ host, bookmark, close }: { host: WebPackageHost; bookmark: BookmarkView; close: () => void }) {
  const [open, setOpen] = useState(false);
  const reachable = bookmark.chat === "open" && bookmark.eventSeq !== undefined;
  const go = async () => {
    close();
    if (bookmark.sessionId) setBookmarkWalk({ sessionId: bookmark.sessionId, activeId: bookmark.id });
    if (!await revealBookmark(host, bookmark, true)) {
      setBookmarkWalk(null);
      reportMissingPlace(host);
    }
  };
  return (
    <li className="bm-peek-item" data-open={open || undefined}>
      <div className="bm-peek-line">
        <button
          type="button"
          className="prompt-nav-row bm-peek-name"
          // A note has nowhere to go: its name opens its text.
          onClick={() => { if (reachable) void go(); else setOpen((value) => !value); }}
        >
          <span className="bm-peek-glyph" aria-hidden="true"><Icon icon={KIND_ICONS[bookmark.kind]} size="sm" /></span>
          <bdi className="prompt-nav-row-text">{bookmark.title}</bdi>
        </button>
        <IconButton
          icon={open ? ChevronDownIcon : ChevronRightIcon}
          label={tr(open ? "bookmarks.row.collapse" : "bookmarks.row.expand", { title: bookmark.title })}
          size="sm"
          variant="ghost"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        />
      </div>
      {open && <div className="bm-peek-body"><SavedText bookmark={bookmark} /></div>}
    </li>
  );
}

export function PeekBookmarks({ host, context }: { host: WebPackageHost; context: Context }) {
  const sessionId = sessionOf(context);
  const bookmarks = useSessionBookmarks(sessionId);
  if (!sessionId) return null;
  if (context.promptTabPlacement === "footer") {
    return <div className="bm-peek-foot"><AddRow host={host} sessionId={sessionId} context={context} /></div>;
  }
  const close = closerOf(context);
  return (
    <>
      <ul className="bm-peek-list">
        {bookmarks.map((bookmark) => <PeekRow key={bookmark.id} host={host} bookmark={bookmark} close={close} />)}
      </ul>
      <div className="bm-peek-foot">
        <AddRow host={host} sessionId={sessionId} context={context} />
        <button
          type="button"
          className="bm-peek-all"
          onClick={() => {
            close();
            openBookmarksPane(host);
          }}
        >
          {tr("bookmarks.peek.all")}
          <Icon icon={ChevronRightIcon} size="sm" />
        </button>
      </div>
    </>
  );
}

export function PeekLinks({ context }: { context: Context }) {
  const bookmarks = useSessionBookmarks(sessionOf(context));
  if (context.promptTabPlacement === "footer") return null;
  return (
    <div className="bm-peek-links">
      {bookmarks.filter((bookmark) => bookmark.links.length > 0).map((bookmark) => (
        <section key={bookmark.id}>
          <h3 className="bm-peek-group"><bdi>{bookmark.title}</bdi></h3>
          <ul className="bm-list">
            {bookmark.links.map((link) => <LinkRow key={link.url} link={link} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}
