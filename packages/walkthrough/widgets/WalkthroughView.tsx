import { useEffect, useState } from "react";
import type { WalkthroughStepDto } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { useStore } from "../../../apps/web/src/store.ts";
import { parseDiffLines } from "../../../apps/web/src/utils.ts";
import GeneratedWalkthrough from "./GeneratedWalkthrough.tsx";
import EmptyState from "../../../apps/web/src/components/EmptyState.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, Tabs } from "../../../apps/web/src/components/ui/index.ts";

export default function WalkthroughView() {
  const sessionId = useStore((s) => s.activeSessionId);
  const events = useStore((s) => (s.activeSessionId ? s.events[s.activeSessionId] : undefined));
  const [steps, setSteps] = useState<WalkthroughStepDto[]>([]);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"session" | "generated">("session");

  const refresh = async () => {
    if (!sessionId) { setSteps([]); return; }
    const got = await api.getWalkthrough(sessionId);
    setSteps(got.steps);
  };

  useEffect(() => { void refresh(); }, [sessionId]);
  useEffect(() => {
    const last = events?.[events.length - 1];
    if (last && (last.type.startsWith("walkthrough/") || last.type.startsWith("tool/"))) void refresh();
  }, [events]);

  useEffect(() => {
    if (index >= steps.length) setIndex(Math.max(0, steps.length - 1));
  }, [steps.length, index]);

  const step = steps[index];
  const approved = steps.filter((s) => s.status === "approved").length;
  const rejected = steps.filter((s) => s.status === "rejected").length;
  const pending = steps.length - approved - rejected;
  const decide = async (decision: "approve" | "reject") => {
    if (!sessionId || !step) return;
    setBusy(true);
    await api.walkthroughDecide(sessionId, index, decision).catch(() => {});
    await refresh();
    if (index < steps.length - 1) setIndex((i) => i + 1);
    setBusy(false);
  };

  return (
    <div className="view-page walkthrough-page">
      <div className="wt-header">
        <div>
          <h1 className="view-title">{tr("walkthroughview.guidedChangesWalkthrough")}</h1>
          <p className="view-sub">{tr("walkthroughview.reviewEachFileEditInOrderApprove")}</p>
        </div>
        <Tabs
          className="wt-mode-tabs"
          size="sm"
          label={tr("walkthroughview.guidedChangesWalkthrough")}
          value={mode}
          tabs={[
            { id: "session", label: tr("walkthroughview.sessionSteps") },
            { id: "generated", label: tr("walkthroughview.generate") },
          ]}
          onChange={(value) => setMode(value as typeof mode)}
        />
        <span className="header-spacer" />
        {mode === "session" && steps.length > 0 && (
          <span className="muted" style={{ fontSize: "calc(12px * var(--ui-font-scale, 1))", marginRight: 8, whiteSpace: "nowrap" }}>
            {tr("walkthroughview.step")}{" "}{index + 1}/{steps.length} · {approved} ✓ · {rejected} ✕
          </span>
        )}
        {mode === "session" && (
          <div className="step-dots">
            {steps.map((s, i) => (
              <button
                key={i}
                className={`step-dot ${i === index ? "current" : ""} ${s.status}`}
                title={`${s.file} (${s.status})`}
                onClick={() => setIndex(i)}
              />
            ))}
          </div>
        )}
      </div>

      {mode === "generated" && <GeneratedWalkthrough />}

      {mode === "session" && !sessionId && <EmptyState title={tr("walkthroughview.noSessionOpen")} description={tr("walkthroughview.openASessionToReviewItsFile")} />}
      {mode === "session" && sessionId && steps.length === 0 && (
        <EmptyState title={tr("walkthroughview.noFileEditsYet")} description={tr("walkthroughview.writeOrPatchAFileInThis")} />
      )}

      {mode === "session" && steps.length > 0 && pending === 0 && (
        <div className="prompt-echo">
          {tr("walkthroughview.reviewed")}{" "}{steps.length} {steps.length === 1 ? tr("walkthroughview.change") : tr("walkthroughview.changes")} · {approved} {tr("walkthroughview.approved2")}{" "}{rejected} {tr("walkthroughview.rejectedContinueInGitToCommit")}</div>
      )}

      {mode === "session" && step && (
        <>
          <div className="wt-card">
            <div className="wt-file" title={step.file}>
              {step.file}
              <span className="ctx-badge" style={{ marginLeft: 8 }}>{step.status}</span>
            </div>
            <pre className="wt-diff">
              {parseDiffLines(step.diff).map((line, i) => (
                <div key={i} className={`wt-diff-line ${line.kind}`}>
                  <span className="git-diff-ln">{i + 1}</span>
                  <span>{line.text || " "}</span>
                </div>
              ))}
            </pre>
          </div>
          <div className="wt-explain">{step.explanation || tr("walkthroughview.noExplanation")}</div>
          <div className="wt-footer">
            <Button size="sm" disabled={index === 0} onClick={() => setIndex((i) => i - 1)}>{tr("walkthroughview.prev")}</Button>
            <div className="wt-footer-mid">
              <Button size="sm" variant="danger" disabled={busy || step.status !== "pending"} onClick={() => void decide("reject")}>{tr("walkthroughview.reject")}</Button>
              <Button size="sm" disabled={index >= steps.length - 1} onClick={() => setIndex((i) => i + 1)}>{tr("common.skip")}</Button>
              <Button size="sm" variant="primary" className="wt-approve" busy={busy} disabled={step.status !== "pending"} onClick={() => void decide("approve")}>
                {step.status === "pending" ? tr("walkthroughview.approve") : step.status === "approved" ? tr("walkthroughview.approved") : tr("walkthroughview.rejected")}
              </Button>
            </div>
            <Button size="sm" disabled={index >= steps.length - 1} onClick={() => setIndex((i) => i + 1)}>{tr("walkthroughview.next")}</Button>
          </div>
        </>
      )}
    </div>
  );
}
