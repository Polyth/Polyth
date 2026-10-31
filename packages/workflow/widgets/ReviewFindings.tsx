import { useId, useRef, useState } from "react";
import type { WorkflowReviewFindingDto, WorkflowRunDto, WorkflowRunNodeDto } from "@polyth/contracts";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, Icon, Textarea, WarningIcon } from "../../../apps/web/src/components/ui/index.ts";
import { workflowDecisionApi } from "./workflowDecision.ts";
import { publishWorkflowRun } from "./workflowMonitor.ts";

const MAX_NOTE = 2_000;
const location = (finding: WorkflowReviewFindingDto): string | undefined =>
  finding.path ? (finding.line ? `${finding.path}:${finding.line}` : finding.path) : undefined;

/** The findings a review listed, blockers first in the report's own order:
 * a severity mark, the location in mono, then what is wrong. */
export function ReviewFindings({ findings }: { findings: readonly WorkflowReviewFindingDto[] }) {
  if (!findings.length) return null;
  return (
    <ul className="workflow-findings" aria-label={tr("workflowview.reviewFindings")}>
      {findings.map((finding, index) => (
        <li key={index} className={`workflow-finding is-${finding.severity}`}>
          <span className="workflow-finding-mark">
            {tr(finding.severity === "blocker" ? "workflowview.reviewBlocker" : "workflowview.reviewNote")}
          </span>
          <span className="workflow-finding-text">
            {location(finding) && <code className="workflow-finding-path">{location(finding)}</code>}
            {finding.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A review the run holds because its rounds are spent: every open blocker
 * beside the builder's reply, and the two ways forward. Wide panels read it
 * as two columns under one header; narrow ones as a thread, the reply
 * indented under the blocker it answers. */
export function ReviewDecision({ run, node }: { run: WorkflowRunDto; node: WorkflowRunNodeDto }) {
  const request = node.needsDecision;
  const titleId = useId();
  const noteId = useId();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const operation = useRef<{ intent: string; id: string } | null>(null);
  if (!request) return null;
  const decide = async (action: "accept" | "another-round") => {
    if (busy) return;
    const text = action === "another-round" ? note.trim() : "";
    const intent = JSON.stringify([run.id, node.id, action, text]);
    if (operation.current?.intent !== intent) operation.current = { intent, id: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const next = await workflowDecisionApi.decide(run.id, {
        nodeId: node.id,
        action,
        clientOperationId: operation.current.id,
        ...(text ? { note: text } : {}),
      });
      operation.current = null;
      publishWorkflowRun(next);
    } catch (cause) {
      setError(friendlyError(tr("workflowview.reviewDecisionFailed"), cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="workflow-dispute" role="group" aria-labelledby={titleId}>
      <div className="workflow-dispute-head">
        <span className="workflow-dispute-mark" aria-hidden="true"><Icon icon={WarningIcon} size="sm" /></span>
        <div className="workflow-dispute-copy">
          <h4 id={titleId} className="workflow-dispute-title">{tr("workflowview.reviewDisputeTitle")}</h4>
          <p className="workflow-dispute-intro">{tr("workflowview.reviewDisputeIntro", { role: node.role })}</p>
        </div>
      </div>
      <div className="workflow-dispute-columns" aria-hidden="true">
        <span>{tr("workflowview.reviewReviewer")}</span>
        <span>{tr("workflowview.reviewBuilder")}</span>
      </div>
      <ol className="workflow-dispute-items">
        {request.items.map((item, index) => (
          <li key={index} className="workflow-dispute-item">
            <div className="workflow-dispute-side is-reviewer">
              <span className="workflow-dispute-label">{tr("workflowview.reviewReviewer")}</span>
              <p className="workflow-dispute-text">
                {location(item.finding) && <code className="workflow-finding-path">{location(item.finding)}</code>}
                {item.finding.message}
              </p>
            </div>
            <div className="workflow-dispute-side is-builder">
              <span className="workflow-dispute-label">{tr("workflowview.reviewBuilder")}</span>
              <p className={`workflow-dispute-text${item.reply ? "" : " is-empty"}`}>
                {item.reply ?? tr("workflowview.reviewNoReply")}
              </p>
            </div>
          </li>
        ))}
      </ol>
      {asking && (
        <div className="workflow-dispute-note">
          <label htmlFor={noteId} className="workflow-dispute-note-label">{tr("workflowview.reviewNoteLabel")}</label>
          <Textarea
            id={noteId}
            minRows={2}
            maxLength={MAX_NOTE}
            value={note}
            placeholder={tr("workflowview.reviewNotePlaceholder")}
            onChange={(event) => setNote(event.target.value)}
            disabled={busy}
          />
        </div>
      )}
      {!request.canAnotherRound && <p className="workflow-dispute-intro">{tr("workflowview.reviewNoMoreRounds")}</p>}
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="workflow-dispute-actions">
        {asking ? (
          <>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void decide("another-round")}>
              {tr("workflowview.reviewStartRound")}
            </Button>
            <Button variant="quiet" size="sm" disabled={busy} onClick={() => { setAsking(false); setNote(""); }}>
              {tr("workflowview.reviewCancel")}
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void decide("accept")}>
              {tr("workflowview.reviewAccept")}
            </Button>
            {request.canAnotherRound && (
              <Button variant="quiet" size="sm" disabled={busy} onClick={() => setAsking(true)}>
                {tr("workflowview.reviewAnotherRound")}
              </Button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
