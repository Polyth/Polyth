import { useEffect, useState } from "react";
import type { CoachProposalDto } from "./api.ts";
import { CoachError, type CoachUiProps } from "./parts.tsx";
import ProposalCard from "./ProposalCard.tsx";
import { useCoach } from "./store.ts";
import { t } from "./strings.ts";

/**
 * Review is contextual: it holds what actually needs attention — pending Coach
 * proposals, a due weekly review, an evidence-backed insight. When there is
 * nothing, it says so in one quiet line rather than occupying a permanent empty
 * product area the way the old Plan tab did.
 */
export default function ReviewPanel(props: CoachUiProps) {
  const { api, client, ui, friendlyError } = props;
  const { Button } = ui;
  const snapshot = useCoach(client);
  const [proposals, setProposals] = useState<CoachProposalDto[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setError("");
    void api.proposals()
      .then((value) => { if (live) setProposals(value); })
      .catch((cause) => { if (live) setError(friendlyError(t("coach.error.loadReview"), cause)); });
    return () => { live = false; };
  }, [api, friendlyError, snapshot.home?.revision, attempt]);

  const home = snapshot.home;
  const pending = proposals ?? [];
  const nothing = proposals !== null && pending.length === 0 && !home?.reviewDue && !home?.insight;

  return <div className="coach-stack">
    {error && <CoachError message={error} ui={ui} onRetry={() => setAttempt((n) => n + 1)} />}

    {home?.reviewDue && (
      <section className="coach-panel coach-panel--accent" aria-label={t("coach.review.weeklyTitle")}>
        <header className="coach-panel-head"><h3>{t("coach.review.weeklyTitle")}</h3></header>
        <p className="coach-meta">{t("coach.review.weeklyBody")}</p>
        <Button
          size="sm"
          busy={snapshot.busy.has("talk")}
          onClick={() => void client.talk(
            "Let's do my weekly review. Read my Coach context first, help me reflect on what actually happened, and propose only evidence-backed adjustments.",
          )}
        >{t("coach.review.weeklyAction")}</Button>
      </section>
    )}

    {pending.length > 0 && (
      <section className="coach-panel" aria-label={t("coach.review.suggestions")}>
        <header className="coach-panel-head">
          <h3>{t("coach.review.suggestions")}</h3>
          <span className="coach-badge">{t("coach.review.badge", { count: pending.length })}</span>
        </header>
        <div className="coach-list">
          {pending.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposalId={proposal.id}
              api={api}
              client={client}
              ui={ui}
              friendlyError={friendlyError}
            />
          ))}
        </div>
      </section>
    )}

    {home?.insight && (
      <section className="coach-panel" aria-label={t("coach.review.insight")}>
        <header className="coach-panel-head"><h3>{t("coach.review.insight")}</h3></header>
        <p className="coach-lead">{home.insight.statement}</p>
        <span className="coach-meta">{t("coach.review.confidence", { confidence: home.insight.confidence })}</span>
      </section>
    )}

    {!proposals && !error && <p className="coach-meta" role="status">{t("coach.workspace.loading")}</p>}
    {nothing && (
      <div className="coach-quiet coach-review-empty">
        <p>{t("coach.review.empty")}</p>
        <p className="coach-meta">{t("coach.review.emptyHint")}</p>
      </div>
    )}
  </div>;
}
