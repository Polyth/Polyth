import { useEffect, useState } from "react";
import type { SessionEvent } from "@polyth/contracts";
import type { CoachApi, CoachProposalApplicationDto, CoachProposalDto } from "./api.ts";
import { formatClock, formatWhen, type CoachUi } from "./parts.tsx";
import type { CoachClient } from "./store.ts";

interface ProposalEventData { proposalId?: unknown; proposalType?: unknown; summary?: unknown }

const typeLabel = (type: string): string =>
  type === "goal" ? "Goal"
    : type === "commitment" ? "Action"
      : type === "routine" ? "Routine"
        : "Change";

export function proposalStatusLabel(status: CoachProposalDto["status"]): string {
  if (status === "accepted") return "Applied";
  if (status === "rejected") return "Ignored";
  if (status === "expired") return "Expired";
  return "Needs review";
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function cadenceLabel(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const cadence = value as { kind?: unknown; days?: unknown; everyDays?: unknown };
  if (cadence.kind === "daily") return "Every day";
  if (cadence.kind === "interval" && typeof cadence.everyDays === "number") {
    return cadence.everyDays === 1 ? "Every day" : `Every ${cadence.everyDays} days`;
  }
  if (cadence.kind === "weekly" && Array.isArray(cadence.days)) {
    const days = cadence.days.filter((day): day is number => typeof day === "number" && day >= 0 && day <= 6);
    if (days.length === 7) return "Every day";
    if (days.length === 5 && [1, 2, 3, 4, 5].every((day) => days.includes(day))) return "Weekdays";
    return days.map((day) => DAY_NAMES[day]).join(", ");
  }
  return null;
}

/**
 * Plain language for what will actually change if this is applied. The raw
 * payload is never rendered: an opaque JSON patch is not informed consent.
 */
function changeLines(proposal: CoachProposalDto, timeZone?: string): string[] {
  const payload = proposal.payload;
  const lines: string[] = [];
  const text = (key: string): string | undefined =>
    typeof payload[key] === "string" && payload[key].trim() ? (payload[key] as string).trim() : undefined;
  const num = (key: string): number | undefined =>
    typeof payload[key] === "number" ? payload[key] as number : undefined;

  if (proposal.type === "routine") {
    const cadence = cadenceLabel(payload.cadence);
    const at = formatClock(num("preferredMinuteOfDay"));
    lines.push(`Adds a routine${cadence ? ` — ${cadence}` : ""}${at ? ` at ${at}` : ""}`);
  }
  if (proposal.type === "commitment") {
    const when = formatWhen(num("dueAt") ?? num("plannedFor"), timeZone);
    const estimate = num("estimateMinutes");
    lines.push(`Adds an action${when ? ` for ${when}` : " with no date yet"}${estimate ? ` · ~${estimate} min` : ""}`);
  }
  if (proposal.type === "goal") {
    lines.push("Adds a goal");
    const outcome = text("desiredOutcome");
    if (outcome) lines.push(outcome);
  }
  if (proposal.type === "plan-change") {
    // Legacy shape from an earlier Coach version. Show its own summary rather
    // than the structured patch it carries.
    const summary = text("summary");
    if (summary) lines.push(summary);
  }
  return lines;
}

export default function ProposalCard({ event, proposalId: suppliedId, api, client, ui, friendlyError }: {
  event?: SessionEvent;
  proposalId?: string;
  api: CoachApi;
  client: CoachClient;
  ui: CoachUi;
  friendlyError(action: string, cause: unknown): string;
}) {
  const { Button } = ui;
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
  const timeZone = client.getSnapshot().home?.profile.timeZone;
  const changes = proposal ? changeLines(proposal, timeZone) : [];
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
    <div className="coach-proposal-head">
      <span className="coach-proposal-kind">{typeLabel(type)}</span>
      <span className={`coach-proposal-status is-${status}`} role="status">{proposalStatusLabel(status)}</span>
    </div>
    <strong className="coach-proposal-title">{summary}</strong>
    {proposal?.reason && <p className="coach-proposal-detail">{proposal.reason}</p>}
    {changes.length > 0 && (
      <ul className="coach-proposal-changes">
        {changes.map((line) => <li key={line}>{line}</li>)}
      </ul>
    )}
    {application && <span className="coach-proposal-loading">Applied to {application.type}</span>}
    {error && <p className="coach-proposal-error" role="alert">{error}</p>}
    {!proposal && (error
      ? <Button size="sm" variant="ghost" onClick={() => setRetry((n) => n + 1)}>Retry</Button>
      : <span className="coach-proposal-loading" role="status">Loading proposal…</span>)}
    {proposal?.status === "pending" && <div className="coach-proposal-actions">
      <Button size="sm" variant="primary" busy={busy === "accept"} disabled={busy !== null} onClick={() => void act("accept")}>Apply</Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy !== null}
        onClick={() => void client.talk(
          `Let's talk about your suggestion ${proposal.id}: ${summary}. Read the proposal and the state it would change before answering. Do not apply it.`,
        )}
      >Discuss</Button>
      <Button size="sm" variant="ghost" busy={busy === "reject"} disabled={busy !== null} onClick={() => void act("reject")}>Not now</Button>
    </div>}
  </article>;
}
