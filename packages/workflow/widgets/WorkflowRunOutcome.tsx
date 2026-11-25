import { useState } from "react";
import type { WorkflowRunDto, WorkflowRunOutcomeDto } from "@polyth/contracts";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Button } from "../../../apps/web/src/components/ui/index.ts";
import { workflowOutcomeApi } from "./workflowOutcome.ts";
import { publishWorkflowRun } from "./workflowMonitor.ts";

const VALUES = ["accepted", "reworked", "discarded"] as const;
const LABEL = {
  accepted: "workflowview.outcomeAccepted",
  reworked: "workflowview.outcomeReworked",
  discarded: "workflowview.outcomeDiscarded",
} as const;
const TIP = {
  accepted: "workflowview.outcomeAcceptedTip",
  reworked: "workflowview.outcomeReworkedTip",
  discarded: "workflowview.outcomeDiscardedTip",
} as const;

/** One quiet inline row under a settled run's header: how its result was used.
 * Nothing while the run is still going. A record reads as a sentence with a
 * Change action that brings the three choices back; `readOnly` shows the
 * record alone (a folded card whose agent recorded it). */
export function WorkflowRunOutcome({ run, readOnly = false }: { run: WorkflowRunDto; readOnly?: boolean }) {
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (run.status === "running") return null;
  const recorded: WorkflowRunOutcomeDto | undefined = run.outcome;
  const record = async (value: (typeof VALUES)[number]) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      publishWorkflowRun(await workflowOutcomeApi.record(run.id, { value }));
      setChanging(false);
    } catch (cause) {
      setError(friendlyError(tr("workflowview.outcomeFailed"), cause));
    } finally {
      setBusy(false);
    }
  };
  const choosing = !recorded || changing;
  return (
    <div className="workflow-run-usage">
      <div className="workflow-run-usage-row">
        {choosing ? (
          <>
            <span className="workflow-run-usage-text">{tr("workflowview.outcomeQuestion")}</span>
            {VALUES.map((value) => (
              <Button
                key={value}
                size="sm"
                variant="ghost"
                title={tr(TIP[value])}
                disabled={busy}
                onClick={() => void record(value)}
              >
                {tr(LABEL[value])}
              </Button>
            ))}
          </>
        ) : (
          <>
            <span className="workflow-run-usage-text">
              {tr("workflowview.outcomeResult", { value: tr(LABEL[recorded.value]) })}
              {" · "}
              {tr(recorded.by === "person" ? "workflowview.outcomeByPerson" : "workflowview.outcomeByAgent")}
              {recorded.note ? ` · ${recorded.note}` : ""}
            </span>
            {!readOnly && (
              <Button size="sm" variant="ghost" onClick={() => setChanging(true)}>
                {tr("workflowview.outcomeChange")}
              </Button>
            )}
          </>
        )}
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}
    </div>
  );
}
