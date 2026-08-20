// F9 idle assist: recap under the last message + ONE suggestion chip. The
// assist rides the session projection; it renders only while fresh (the log
// tail still matches assist.atSeq — any new event hides it immediately).
// Tapping the chip fills the composer and NEVER sends.
import { useState } from "react";
import { useStore } from "../store.ts";
import { requestComposerInsert } from "../composerInsert.ts";

// dismissals are ephemeral, in-memory only (never the event log / localStorage)
const dismissed = new Set<string>();

export default function AssistStrip() {
  const sessionId = useStore((s) => s.activeSessionId);
  const assist = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId)?.assist);
  const lastSeq = useStore((s) => {
    const evs = s.activeSessionId ? s.events[s.activeSessionId] : undefined;
    return evs && evs.length > 0 ? evs[evs.length - 1]!.seq : 0;
  });
  const [, bump] = useState(0);

  if (!sessionId || !assist) return null;
  if (assist.atSeq !== lastSeq) return null; // stale: the session moved on
  const key = `${sessionId}:${assist.atSeq}`;
  if (dismissed.has(key)) return null;

  const dismiss = () => {
    dismissed.add(key);
    bump((n) => n + 1);
  };

  return (
    <div className="assist-strip" role="note" aria-label="Session recap and suggestion">
      <div className="assist-recap">
        <span className="assist-tag">recap</span>
        <span className="assist-recap-text">{assist.recap}</span>
        <button className="assist-dismiss" aria-label="Dismiss recap" title="Dismiss" onClick={dismiss}>×</button>
      </div>
      <button
        className="assist-chip"
        title="Fill the composer with this suggestion (does not send)"
        onClick={() => { requestComposerInsert(assist.suggestion); dismiss(); }}
      >
        <span aria-hidden>↳</span> {assist.suggestion}
      </button>
    </div>
  );
}
