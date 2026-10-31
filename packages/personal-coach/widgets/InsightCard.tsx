import { useEffect, useState } from "react";
import type { SessionEvent } from "@polyth/contracts";
import type { CoachApi, CoachInsightDto } from "./api.ts";
import { confidenceLabel, type CoachUi } from "./parts.tsx";
import type { CoachClient } from "./store.ts";
import { t } from "./strings.ts";

interface InsightEventData {
  insightId?: unknown;
  statement?: unknown;
  confidence?: unknown;
  evidenceCount?: unknown;
}

const statusLabel = (status: CoachInsightDto["status"]): string =>
  status === "accepted" ? t("coach.insight.status.useful")
    : status === "rejected" ? t("coach.insight.status.notTrue")
      : status === "expired" ? t("coach.insight.status.forgotten")
        : t("coach.insight.status.hypothesis");

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
  const fallbackStatement = typeof data.statement === "string" ? data.statement : t("coach.insight.fallback");
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
      .catch((cause) => { if (live) setError(friendlyError(t("coach.insight.error.load"), cause)); });
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
      setError(friendlyError(t("coach.insight.error.update"), cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="coach-proposal-card coach-insight-card" aria-label={t("coach.insight.aria")}>
      <div className="coach-proposal-head">
        <span className="coach-proposal-kind">{t("coach.insight.kind")}</span>
        <span className={`coach-proposal-status is-${status}`} role="status">{statusLabel(status)}</span>
      </div>
      <strong className="coach-proposal-title">{statement}</strong>
      <p className="coach-proposal-detail">
        {t("coach.insight.summary", { confidence: confidenceLabel(confidence), count: evidenceCount })}
      </p>
      {error && <p className="coach-proposal-error" role="alert">{error}</p>}
      {!insight && !error && <span className="coach-proposal-loading" role="status">{t("coach.insight.loading")}</span>}
      {insight?.status === "candidate" && (
        <div className="coach-proposal-actions">
          <Button size="sm" variant="primary" busy={busy === "accept"} disabled={busy !== null} onClick={() => void act("accept")}>{t("coach.insight.status.useful")}</Button>
          <Button size="sm" variant="quiet" busy={busy === "reject"} disabled={busy !== null} onClick={() => void act("reject")}>{t("coach.insight.status.notTrue")}</Button>
          <Button size="sm" variant="ghost" busy={busy === "forget"} disabled={busy !== null} onClick={() => void act("forget")}>{t("coach.insight.forget")}</Button>
        </div>
      )}
      {insight?.status === "accepted" && (
        <div className="coach-proposal-actions">
          <Button size="sm" variant="ghost" busy={busy === "forget"} disabled={busy !== null} onClick={() => void act("forget")}>{t("coach.insight.forget")}</Button>
        </div>
      )}
    </article>
  );
}
