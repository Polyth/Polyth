import { useState } from "react";
import { api } from "@polyth/session/web-api";
import { registerSlot } from "../slots.ts";
import { applyEvent, setUiError, useStore } from "../store.ts";
import { Icon } from "../icons.tsx";
import { tr } from "../i18n/index.ts";

function MessagePinAction({ sessionId, eventSeq }: { sessionId: string; eventSeq: number }) {
  const events = useStore((state) => state.events[sessionId] ?? []);
  const [busy, setBusy] = useState(false);
  let pinned = false;
  for (const event of events) {
    const source = Number((event.data as { sourceEventSeq?: unknown }).sourceEventSeq);
    if (source !== eventSeq) continue;
    if (event.type === "context/pinned") pinned = true;
    if (event.type === "context/unpinned") pinned = false;
  }
  const label = pinned ? tr("messagepinaction.unpinMessageFromCompactionContext") : tr("messagepinaction.pinMessageForCompactionContext");
  return (
    <button
      className="msg-action-btn msg-bookmark-action"
      aria-label={label}
      title={label}
      data-tooltip={label}
      aria-pressed={pinned}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void (pinned ? api.unpinContext(sessionId, eventSeq) : api.pinContext(sessionId, eventSeq))
          .then(applyEvent)
          .catch((error: unknown) => {
            setUiError(error instanceof Error ? error.message : String(error));
          })
          .finally(() => setBusy(false));
      }}
    >
      <span aria-hidden="true"><Icon.bookmark /></span>
    </button>
  );
}

registerSlot("session.message.actions", "builtin.message-pin", (context) => {
  const sessionId = typeof context.sessionId === "string" ? context.sessionId : "";
  const eventSeq = Number(context.eventSeq);
  const kind = context.kind;
  if (!sessionId || !Number.isSafeInteger(eventSeq) || (kind !== "user" && kind !== "assistant")) return null;
  return <MessagePinAction sessionId={sessionId} eventSeq={eventSeq} />;
}, 10);
