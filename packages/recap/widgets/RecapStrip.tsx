import { useState, useSyncExternalStore } from "react";
import { assistFreshnessSeq } from "@polyth/session/next-action";
import type { WebPackageHost } from "@polyth/web-sdk";

const dismissed = new Set<string>();

const snapshotKey = (host: WebPackageHost, sessionId: string): string => {
  const assist = host.sessions.get(sessionId)?.assist;
  const freshnessSeq = assistFreshnessSeq(host.sessions.events(sessionId));
  return `${assist?.generatedAt ?? 0}:${assist?.atSeq ?? 0}:${freshnessSeq}`;
};

export default function RecapStrip({
  host,
  sessionId,
}: {
  host: WebPackageHost;
  sessionId: string;
}) {
  useSyncExternalStore(
    host.sessions.subscribe,
    () => snapshotKey(host, sessionId),
    () => snapshotKey(host, sessionId),
  );
  const [, bump] = useState(0);
  const assist = host.sessions.get(sessionId)?.assist;
  const freshnessSeq = assistFreshnessSeq(host.sessions.events(sessionId));
  const tr = host.ui.locale.translate;

  if (!assist || freshnessSeq > assist.atSeq) return null;
  const key = `${sessionId}:${assist.atSeq}`;
  if (dismissed.has(key)) return null;

  const dismiss = () => {
    dismissed.add(key);
    bump((value) => value + 1);
  };

  return (
    <div className="assist-strip recap-strip" role="note" aria-label={tr("assiststrip.sessionRecapAndSuggestion")}>
      <div className="assist-recap">
        <span className="assist-tag">{tr("assiststrip.recap")}</span>
        <span className="assist-recap-text">{assist.recap}</span>
        <button
          className="assist-dismiss"
          aria-label={tr("assiststrip.dismissRecap")}
          title={tr("assiststrip.dismiss")}
          onClick={dismiss}
        >
          {tr("assiststrip.message")}
        </button>
      </div>
      {assist.suggestion ? (
        <button
          className="assist-chip"
          title={tr("assiststrip.fillTheComposerWithThisSuggestionDoes")}
          onClick={() => {
            host.conversation.insert(assist.suggestion!);
            dismiss();
          }}
        >
          <span aria-hidden>↳</span> {assist.suggestion}
        </button>
      ) : null}
    </div>
  );
}
