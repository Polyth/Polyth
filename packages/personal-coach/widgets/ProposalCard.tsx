import { useEffect, useState } from "react";
import type { SessionEvent } from "@polyth/contracts";
import Button from "../../../apps/web/src/components/ui/Button.tsx";
import type { CoachApi, CoachProposalApplicationDto, CoachProposalDto } from "./api.ts";
import type { CoachClient } from "./store.ts";

interface ProposalEventData { proposalId?: unknown; proposalType?: unknown; summary?: unknown }
const typeLabel = (type: string): string => type === "goal" ? "Goal" : type === "commitment" ? "Commitment" : type === "routine" ? "Routine" : "Plan change";
export function proposalStatusLabel(status: CoachProposalDto["status"]): string {
  if (status === "accepted") return "Applied";
  if (status === "rejected") return "Ignored";
  if (status === "expired") return "Expired";
  return "Needs review";
}

export default function ProposalCard({ event, proposalId: suppliedId, api, client, friendlyError }: {
  event?: SessionEvent;
  proposalId?: string;
  api: CoachApi;
  client: CoachClient;
  friendlyError(action: string, cause: unknown): string;
}) {
  const data = (event?.data ?? {}) as ProposalEventData;
  const proposalId = suppliedId ?? (typeof data.proposalId === "string" ? data.proposalId : "");
  const [proposal, setProposal] = useState<CoachProposalDto | null>(null);
  const [application, setApplication] = useState<CoachProposalApplicationDto | null>(null);
  const [busy, setBusy] = useState<"accept" | "reject" | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!proposalId) return;
    let live = true;
    setProposal(null); setApplication(null); setError("");
    void api.proposal(proposalId)
      .then((value) => { if (live) setProposal(value); })
      .catch((cause) => { if (live) setError(friendlyError("Load Coach proposal", cause)); });
    return () => { live = false; };
  }, [api, friendlyError, proposalId, retry]);
  if (!proposalId) return null;
  const type = proposal?.type ?? (typeof data.proposalType === "string" ? data.proposalType : "plan-change");
  const value = proposal?.payload[type === "plan-change" ? "summary" : "title"];
  const summary = typeof value === "string" && value.trim() ? value.trim()
    : typeof data.summary === "string" ? data.summary : "Coach proposal";
  const status = proposal?.status ?? "pending";
  const outcome = proposal?.payload.desiredOutcome;
  const act = async (action: "accept" | "reject") => {
    if (busy || !proposal) return;
    setBusy(action); setError("");
    try {
      const decision = action === "accept" ? await api.acceptProposal(proposal.id) : await api.rejectProposal(proposal.id);
      setProposal(decision.proposal); setApplication(decision.application ?? null);
      await client.refresh();
    } catch (cause) { setError(friendlyError(action === "accept" ? "Apply Coach proposal" : "Ignore Coach proposal", cause)); }
    finally { setBusy(null); }
  };
  return <article className="coach-proposal-card" aria-label={`${typeLabel(type)} proposal`}>
    <div className="coach-proposal-head"><span className="coach-proposal-kind">{typeLabel(type)}</span><span className={`coach-proposal-status is-${status}`} role="status">{proposalStatusLabel(status)}</span></div>
    <strong className="coach-proposal-title">{summary}</strong>
    {typeof outcome === "string" && <p className="coach-proposal-detail">{outcome}</p>}
    {proposal?.reason && proposal.reason !== outcome && <p className="coach-proposal-detail">{proposal.reason}</p>}
    {application && <span className="coach-proposal-loading">Applied to {application.type}</span>}
    {error && <p className="coach-proposal-error" role="alert">{error}</p>}
    {!proposal && (error ? <Button size="sm" variant="ghost" onClick={() => setRetry((n) => n + 1)}>Retry</Button> : <span className="coach-proposal-loading" role="status">Loading proposal…</span>)}
    {proposal?.status === "pending" && <div className="coach-proposal-actions">
      <Button size="sm" variant="primary" busy={busy === "accept"} disabled={busy !== null} onClick={() => void act("accept")}>Apply</Button>
      <Button size="sm" variant="ghost" busy={busy === "reject"} disabled={busy !== null} onClick={() => void act("reject")}>Ignore</Button>
    </div>}
  </article>;
}
