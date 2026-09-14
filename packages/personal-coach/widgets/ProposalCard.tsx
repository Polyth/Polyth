import { useEffect, useState } from "react";
import type { SessionEvent } from "@polyth/contracts";
import type { CoachApi, CoachProposalApplicationDto, CoachProposalDto } from "./api.ts";
import { formatClock, formatEstimate, formatWhen, type CoachUi } from "./parts.tsx";
import type { CoachClient } from "./store.ts";
import { t } from "./strings.ts";

interface ProposalEventData { proposalId?: unknown; proposalType?: unknown; summary?: unknown }

const typeLabel = (type: string): string =>
  type === "goal" ? t("coach.proposal.type.goal")
    : type === "commitment" ? t("coach.proposal.type.commitment")
      : type === "routine" ? t("coach.proposal.type.routine")
        : type === "plan" ? t("coach.proposal.type.plan")
          : t("coach.proposal.type.change");

export function proposalStatusLabel(status: CoachProposalDto["status"]): string {
  if (status === "accepted") return t("coach.proposal.status.accepted");
  if (status === "rejected") return t("coach.proposal.status.rejected");
  if (status === "expired") return t("coach.proposal.status.expired");
  return t("coach.proposal.status.pending");
}

const DAY_NAMES = [
  "coach.proposal.day.sun",
  "coach.proposal.day.mon",
  "coach.proposal.day.tue",
  "coach.proposal.day.wed",
  "coach.proposal.day.thu",
  "coach.proposal.day.fri",
  "coach.proposal.day.sat",
] as const;

function cadenceLabel(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const cadence = value as { kind?: unknown; days?: unknown; everyDays?: unknown };
  if (cadence.kind === "daily") return t("coach.proposal.cadence.daily");
  if (cadence.kind === "interval" && typeof cadence.everyDays === "number") {
    return cadence.everyDays === 1
      ? t("coach.proposal.cadence.daily")
      : t("coach.proposal.cadence.everyDays", { count: cadence.everyDays });
  }
  if (cadence.kind === "weekly" && Array.isArray(cadence.days)) {
    const days = cadence.days.filter((day): day is number => typeof day === "number" && day >= 0 && day <= 6);
    if (days.length === 7) return t("coach.proposal.cadence.daily");
    if (days.length === 5 && [1, 2, 3, 4, 5].every((day) => days.includes(day))) {
      return t("coach.proposal.cadence.weekdays");
    }
    return days.map((day) => t(DAY_NAMES[day]!)).join(", ");
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
    lines.push([t("coach.proposal.change.routine"), cadence, at].filter(Boolean).join(" · "));
  }
  if (proposal.type === "commitment") {
    const when = formatWhen(num("dueAt") ?? num("plannedFor"), timeZone);
    const estimate = formatEstimate(num("estimateMinutes"));
    const timing = when
      ? t("coach.proposal.change.forWhen", { when })
      : t("coach.proposal.change.unscheduled");
    lines.push([`${t("coach.proposal.change.action")} ${timing}`, estimate].filter(Boolean).join(" · "));
  }
  if (proposal.type === "goal") {
    lines.push(t("coach.proposal.change.goal"));
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
      .catch((cause) => { if (live) setError(friendlyError(t("coach.error.loadProposal"), cause)); });
    return () => { live = false; };
  }, [api, friendlyError, proposalId, retry]);
  if (!proposalId) return null;
  const type = proposal?.type ?? (typeof data.proposalType === "string" ? data.proposalType : "plan-change");
  const value = proposal?.payload[type === "plan-change" ? "summary" : "title"];
  const summary = typeof value === "string" && value.trim() ? value.trim()
    : typeof data.summary === "string" ? data.summary : t("coach.proposal.fallback");
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
    } catch (cause) {
      setError(friendlyError(
        action === "accept" ? t("coach.error.applyProposal") : t("coach.error.ignoreProposal"),
        cause,
      ));
    } finally { setBusy(null); }
  };
  return <article className="coach-proposal-card" aria-label={t("coach.proposal.aria", { type: typeLabel(type) })}>
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
    {application && <span className="coach-proposal-loading">
      {t("coach.proposal.appliedTo", { type: typeLabel(application.type) })}
    </span>}
    {error && <p className="coach-proposal-error" role="alert">{error}</p>}
    {!proposal && (error
      ? <Button size="sm" variant="ghost" onClick={() => setRetry((n) => n + 1)}>{t("coach.proposal.retry")}</Button>
      : <span className="coach-proposal-loading" role="status">{t("coach.proposal.loading")}</span>)}
    {proposal?.status === "pending" && <div className="coach-proposal-actions">
      <Button size="sm" variant="primary" busy={busy === "accept"} disabled={busy !== null} onClick={() => void act("accept")}>
        {t("coach.proposal.apply")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy !== null}
        onClick={() => void client.talk(
          `Let's talk about your suggestion ${proposal.id}: ${summary}. Read the proposal and the state it would change before answering. Do not apply it.`,
        )}
      >{t("coach.proposal.discuss")}</Button>
      <Button size="sm" variant="ghost" busy={busy === "reject"} disabled={busy !== null} onClick={() => void act("reject")}>
        {t("coach.proposal.notNow")}
      </Button>
    </div>}
  </article>;
}
