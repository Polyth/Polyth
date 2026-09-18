// F9 idle assist: recap under the last message + ONE suggestion chip. The
// assist rides the session projection; passive bookkeeping may advance the
// log, but newer conversation activity hides it immediately.
// Tapping the chip fills the composer and NEVER sends.
import { useState } from "react";
import { useStore } from "../store.ts";
import { assistFreshnessSeq } from "@polyth/session/next-action";
import { requestComposerInsert } from "../composerInsert.ts";
import { tr } from "../i18n/index.ts";

// dismissals are ephemeral, in-memory only (never the event log / localStorage)
const dismissed = new Set<string>();

export default function AssistStrip() {
  const sessionId = useStore((s) => s.activeSessionId);
  const assist = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId)?.assist);
  const freshnessSeq = useStore((s) => {
    const evs = s.activeSessionId ? s.events[s.activeSessionId] : undefined;
    return assistFreshnessSeq(evs ?? []);
  });
  const [, bump] = useState(0);

  if (!sessionId || !assist) return null;
  if (freshnessSeq > assist.atSeq) return null; // stale: the conversation moved on
  const key = `${sessionId}:${assist.atSeq}`;
  if (dismissed.has(key)) return null;

  const dismiss = () => {
    dismissed.add(key);
    bump((n) => n + 1);
  };

  return (
    <div className="assist-strip" role="note" aria-label={tr("assiststrip.sessionRecapAndSuggestion")}>
      <div className="assist-recap">
        <span className="assist-tag">{tr("assiststrip.recap")}</span>
        <span className="assist-recap-text">{assist.recap}</span>
        <button className="assist-dismiss" aria-label={tr("assiststrip.dismissRecap")} title={tr("assiststrip.dismiss")} onClick={dismiss}>{tr("assiststrip.message")}</button>
      </div>
      {/* A finished task has no honest follow-up. The recap stands alone
          rather than carrying an invented next step. */}
      {assist.suggestion ? (
        <button
          className="assist-chip"
          title={tr("assiststrip.fillTheComposerWithThisSuggestionDoes")}
          onClick={() => { requestComposerInsert(assist.suggestion!); dismiss(); }}
        >
          <span aria-hidden>↳</span> {assist.suggestion}
        </button>
      ) : null}
    </div>
  );
}
