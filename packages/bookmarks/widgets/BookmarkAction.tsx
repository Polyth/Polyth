// The button under an answer. Contributed through `session.message.actions`, so
// the host owns its place: the person puts it on the bar, in the More menu or
// off in Settings, like every other quick action. In the menu the host keeps it
// mounted without a trigger and signals a selection through a request counter.
import { useEffect, useRef, useState } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import ChatActionButton from "../../../apps/web/src/components/ChatActionButton.tsx";
import { BookmarkIcon } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { getAnswerBookmark, useAnswerBookmark } from "./client.ts";
import { removeWithUndo, saveWithUndo } from "./commands.ts";

const seqOf = (value: unknown): number | null => (Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null);
const textOf = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

export function answerActionAvailable(context: Readonly<Record<string, unknown>>): boolean {
  return textOf(context.sessionId) !== null && seqOf(context.eventSeq) !== null && textOf(context.messageText) !== null;
}

/** The menu row says what a press would do for this answer right now. */
export function answerActionMenuLabel(context: Readonly<Record<string, unknown>>): string {
  const sessionId = textOf(context.sessionId);
  const eventSeq = seqOf(context.eventSeq);
  return sessionId && eventSeq !== null && getAnswerBookmark(sessionId, eventSeq)
    ? tr("bookmarks.action.remove")
    : tr("bookmarks.action.add");
}

export default function BookmarkAction({ host, context }: {
  host: WebPackageHost;
  context: Readonly<Record<string, unknown>>;
}) {
  const sessionId = textOf(context.sessionId);
  const eventSeq = seqOf(context.eventSeq);
  const text = textOf(context.messageText);
  const inMenu = context.messageActionPlacement === "menu";
  const request = typeof context.messageActionRequest === "number" ? context.messageActionRequest : 0;
  const seenRequest = useRef(request);
  const [busy, setBusy] = useState(false);
  const bookmark = useAnswerBookmark(sessionId, eventSeq);

  const toggle = async () => {
    if (!sessionId || eventSeq === null || !text || busy) return;
    setBusy(true);
    try {
      // Read now: a menu selection may follow a change the last render missed.
      const current = getAnswerBookmark(sessionId, eventSeq);
      if (current) await removeWithUndo(host, current.id);
      else await saveWithUndo(host, { kind: "answer", sessionId, eventSeq, body: text });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (request === seenRequest.current) return;
    seenRequest.current = request;
    if (inMenu) void toggle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  if (inMenu || !sessionId || eventSeq === null || !text) return null;
  return (
    <ChatActionButton
      icon={BookmarkIcon}
      label={bookmark ? tr("bookmarks.action.remove") : tr("bookmarks.action.add")}
      pressed={bookmark !== undefined}
      busy={busy}
      data-action-id="bookmarks.toggle"
      onClick={() => void toggle()}
    />
  );
}
