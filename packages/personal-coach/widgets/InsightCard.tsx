import { useEffect, useState } from "react";
import type { SessionEvent } from "@polyth/contracts";
import type { CoachApi, CoachInsightDto } from "./api.ts";
import type { CoachUi } from "./parts.tsx";
import type { CoachClient } from "./store.ts";

interface InsightEventData {
  insightId?: unknown;
  statement?: unknown;
  confidence?: unknown;
  evidenceCount?: unknown;
}

const statusLabel = (status: CoachInsightDto["status"]): string =>
  status === "accepted" ? "Useful"
    : status === "rejected" ? "Not true"
      : status === "expired" ? "Forgotten"
        : "Hypothesis";

export default function InsightCard({
  event,
  api,
  client,
  ui,
  friendlyError,
}: {
  event: SessionEvent;
  api: CoachApi;
  client: CoachClient;
  ui: CoachUi;
  friendlyError(action: string, cause: unknown): string;
}) {
  const { Button } = ui;
  const data = event.data as InsightEventData;
  const insightId = typeof data.insightId === "string" ? data.insightId : "";
  const fallbackStatement = typeof data.statement === "string" ? data.statement : "Coach noticed a possible pattern.";
  const fallbackConfidence = data.confidence === "low" || data.confidence === "medium" || data.confidence === "high"
    ? data.confidence
    : "low";
  const [insight, setInsight] = useState<CoachInsightDto | null>(null);
  const [busy, setBusy] = useState<"accept" | "reject" | "forget" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!insightId) return;
    let live = true;
    void api.insight(insightId)
      .then((value) => { if (live) setInsight(value); })
      .catch((cause) => { if (live) setError(friendlyError("Load Coach insight", cause)); });
    return () => { live = false; };
  }, [api, friendlyError, insightId]);

  if (!insightId) return null;
  const status = insight?.status ?? "candidate";
  const statement = insight?.statement ?? fallbackStatement;
  const confidence = insight?.confidence ?? fallbackConfidence;
  const evidenceCount = insight?.evidence.length
    ?? (typeof data.evidenceCount === "number" ? data.evidenceCount : 0);

  const act = async (action: "accept" | "reject" | "forget") => {
    if (!insight || busy) return;
    setBusy(action);
    setError("");
    try {
      const next = await api.setInsightStatus(insight.id, action);
      setInsight(next);
      await client.refresh();
    } catch (cause) {
      setError(friendlyError("Update Coach insight", cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="coach-proposal-card coach-insight-card" aria-label="Coach insight hypothesis">
      <div className="coach-proposal-head">
        <span className="coach-proposal-kind">Worth noticing</span>
        <span className={`coach-proposal-status is-${status}`} role="status">{statusLabel(status)}</span>
      </div>
      <strong className="coach-proposal-title">{statement}</strong>
      <p className="coach-proposal-detail">
        {confidence} confidence · {evidenceCount} {evidenceCount === 1 ? "recorded event" : "recorded events"}
      </p>
      {error && <p className="coach-proposal-error" role="alert">{error}</p>}
      {!insight && !error && <span className="coach-proposal-loading" role="status">Loading insight…</span>}
      {insight?.status === "candidate" && (
        <div className="coach-proposal-actions">
          <Button size="sm" variant="primary" busy={busy === "accept"} disabled={busy !== null} onClick={() => void act("accept")}>Useful</Button>
          <Button size="sm" variant="quiet" busy={busy === "reject"} disabled={busy !== null} onClick={() => void act("reject")}>Not true</Button>
          <Button size="sm" variant="ghost" busy={busy === "forget"} disabled={busy !== null} onClick={() => void act("forget")}>Forget</Button>
        </div>
      )}
      {insight?.status === "accepted" && (
        <div className="coach-proposal-actions">
          <Button size="sm" variant="ghost" busy={busy === "forget"} disabled={busy !== null} onClick={() => void act("forget")}>Forget</Button>
        </div>
      )}
    </article>
  );
}
