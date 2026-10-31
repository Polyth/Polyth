import { useEffect, useId, useRef, useState } from "react";
import type { WalkthroughStepDto } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { setUiError, useStore } from "../../../apps/web/src/store.ts";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { parseDiffLines } from "../../../apps/web/src/utils.ts";
import GeneratedWalkthrough from "./GeneratedWalkthrough.tsx";
import ReplayTheater, { type ReplayHost } from "./ReplayTheater.tsx";
import EmptyState from "../../../apps/web/src/components/EmptyState.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, TabPanel, Tabs, tabId, tabPanelId } from "../../../apps/web/src/components/ui/index.ts";

export default function WalkthroughView({ host }: { host?: ReplayHost }) {
  const tabsId = `walkthrough-mode-${useId()}`;
  const sessionId = useStore((s) => s.activeSessionId);
  const events = useStore((s) => (s.activeSessionId ? s.events[s.activeSessionId] : undefined));
  const [steps, setSteps] = useState<WalkthroughStepDto[]>([]);
  const [index, setIndex] = useState(0);
  /** Decisions sent but not yet in the session's history, by step index. */
  const deciding = useRef(new Map<string, WalkthroughStepDto["status"]>());
  const [mode, setMode] = useState<"session" | "generated" | "replay">("session");

  const refresh = async () => {
    if (!sessionId) { setSteps([]); return; }
    const got = await api.getWalkthrough(sessionId);
    // A read that predates a decision's event keeps showing the decision.
    setSteps(got.steps.map((item, at) => {
      const decided = deciding.current.get(`${sessionId}:${at}`);
      return decided && item.status === "pending" ? { ...item, status: decided } : item;
    }));
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
  // The decision shows and the review moves on at once; the session event
  // stays the record. A rejection puts the step back to pending and reports.
  // Sent once.
  const decide = (decision: "approve" | "reject") => {
    if (!sessionId || !step || step.status !== "pending") return;
    const at = index;
    const key = `${sessionId}:${at}`;
    const status: WalkthroughStepDto["status"] = decision === "approve" ? "approved" : "rejected";
    deciding.current.set(key, status);
    setSteps((current) => current.map((item, i) => i === at ? { ...item, status } : item));
    if (at < steps.length - 1) setIndex(at + 1);
    void api.walkthroughDecide(sessionId, at, decision)
      .catch((cause) => {
        deciding.current.delete(key);
        setSteps((current) => current.map((item, i) => i === at && item.status === status ? { ...item, status: "pending" } : item));
        setUiError(friendlyError(tr("common.error"), cause));
      })
      .finally(() => {
        deciding.current.delete(key);
        void refresh();
      });
  };

  return (
    <div className="walkthrough-page">
      <div className="wt-header">
        {/* Title + description + close come from the shared ModuleView frame. */}
        <Tabs
          className="wt-mode-tabs"
          size="sm"
          label={tr("walkthroughview.guidedChangesWalkthrough")}
          idBase={tabsId}
          value={mode}
          tabs={[
            { id: "session", label: tr("walkthroughview.sessionSteps") },
            { id: "replay", label: tr("walkthroughview.replayTheater") },
            { id: "generated", label: tr("walkthroughview.generate") },
          ]}
          onChange={(value) => setMode(value as typeof mode)}
        />
        <span className="header-spacer" />
        {mode === "session" && steps.length > 0 && (
          <span className="muted wt-progress">
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

      <TabPanel idBase={tabsId} tabId="session" active={mode === "session"} className="wt-mode-panel">
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
                <span className="ctx-badge wt-status-badge">{step.status}</span>
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
                <Button size="sm" variant="danger" disabled={step.status !== "pending"} onClick={() => decide("reject")}>{tr("walkthroughview.reject")}</Button>
                <Button size="sm" disabled={index >= steps.length - 1} onClick={() => setIndex((i) => i + 1)}>{tr("common.skip")}</Button>
                <Button size="sm" variant="primary" className="wt-approve" disabled={step.status !== "pending"} onClick={() => decide("approve")}>
                  {step.status === "pending" ? tr("walkthroughview.approve") : step.status === "approved" ? tr("walkthroughview.approved") : tr("walkthroughview.rejected")}
                </Button>
              </div>
              <Button size="sm" disabled={index >= steps.length - 1} onClick={() => setIndex((i) => i + 1)}>{tr("walkthroughview.next")}</Button>
            </div>
          </>
        )}
      </TabPanel>
      {mode === "replay" && (
        <ReplayTheater host={host} panel={{ id: tabPanelId(tabsId, "replay"), labelledBy: tabId(tabsId, "replay") }} />
      )}
      <TabPanel idBase={tabsId} tabId="generated" active={mode === "generated"} className="wt-mode-panel">
        <GeneratedWalkthrough />
      </TabPanel>
    </div>
  );
}
