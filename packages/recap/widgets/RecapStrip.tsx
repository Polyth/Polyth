import { useState, useSyncExternalStore } from "react";
import { assistFreshnessSeq } from "@polyth/session/next-action";
import type { WebPackageHost } from "@polyth/web-sdk";
import { CloseIcon, IconButton } from "../../../apps/web/src/components/ui/index.ts";

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

  // The recap's suggested next prompt is not drawn here: it rides on the
  // composer's one suggestion chip (PromptAssist), where a harness hint wins.
  // The sentence is the whole surface: no glyph or visible label; the note's
  // accessible name says what it is. The dismiss rides inline on the last
  // word, so it never strands on a line of its own or floats off a wrap.
  const text = assist.recap.trim();
  const cut = text.search(/\S*$/);
  return (
    <div className="assist-strip recap-strip" role="note" aria-label={tr("assiststrip.recap")}>
      <p className="assist-recap" dir="auto">
        {text.slice(0, cut)}
        <span className="assist-recap-tail">
          {text.slice(cut)}
          <IconButton
            className="assist-dismiss"
            icon={CloseIcon}
            label={tr("assiststrip.dismissRecap")}
            size="sm"
            variant="ghost"
            onClick={dismiss}
          />
        </span>
      </p>
    </div>
  );
}
