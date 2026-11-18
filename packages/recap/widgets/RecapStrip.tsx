import { useEffect, useSyncExternalStore } from "react";
import type { SessionAssist, SessionEvent, SessionProjection } from "@polyth/contracts";
import { assistFreshnessSeq } from "@polyth/session/next-action";
import type { WebPackageHost } from "@polyth/web-sdk";
import { CloseIcon, IconButton } from "../../../apps/web/src/components/ui/index.ts";
import { assistSettings, loadAssistSettings, subscribeAssistSettings } from "./assistSettings.ts";
import { dismissRecap, recapDismissed, subscribeDismissed } from "./calloutDismissals.ts";

/** The recap to draw for a session, or null. A recap is shown only while it
 *  is the latest word on an idle chat:
 *  - no conversation activity after it (`assistFreshnessSeq`);
 *  - it belongs to this log: one pinned past the loaded log's last event came
 *    with a copied projection (an older fork) and describes another chat;
 *  - no turn is running.
 *  Exported for tests. */
export function visibleRecap(
  session: Pick<SessionProjection, "status" | "assist"> | undefined,
  events: readonly SessionEvent[],
): SessionAssist | null {
  const assist = session?.assist;
  if (!assist || !assist.recap.trim()) return null;
  if (session.status === "working" || session.status === "waiting") return null;
  const lastSeq = events.at(-1)?.seq ?? 0;
  if (assist.atSeq > lastSeq) return null;
  if (assistFreshnessSeq(events) > assist.atSeq) return null;
  return assist;
}

export default function RecapStrip({
  host,
  sessionId,
}: {
  host: WebPackageHost;
  sessionId: string;
}) {
  const snapshot = () => {
    const assist = visibleRecap(host.sessions.get(sessionId), host.sessions.events(sessionId));
    return assist ? `${assist.generatedAt}:${assist.atSeq}` : "";
  };
  const key = useSyncExternalStore(host.sessions.subscribe, snapshot, snapshot);
  const settings = useSyncExternalStore(subscribeAssistSettings, assistSettings, assistSettings);
  useSyncExternalStore(subscribeDismissed, () => key && recapDismissed(sessionId, Number(key.split(":")[1])));
  useEffect(() => {
    if (!assistSettings()) void loadAssistSettings().catch(() => {});
  }, []);
  const tr = host.ui.locale.translate;

  const assist = key ? visibleRecap(host.sessions.get(sessionId), host.sessions.events(sessionId)) : null;
  if (!assist || settings?.showRecap === false || recapDismissed(sessionId, assist.atSeq)) return null;

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
            onClick={() => dismissRecap(sessionId, assist.atSeq)}
          />
        </span>
      </p>
    </div>
  );
}
