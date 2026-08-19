import { useEffect, useState } from "react";
import type { WalkthroughStepDto } from "@polyth/contracts";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { parseDiffLines } from "../utils.ts";

export default function WalkthroughView() {
  const sessionId = useStore((s) => s.activeSessionId);
  const events = useStore((s) => (s.activeSessionId ? s.events[s.activeSessionId] : undefined));
  const [steps, setSteps] = useState<WalkthroughStepDto[]>([]);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);

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
          <h1 className="view-title">Guided Changes Walkthrough</h1>
          <p className="view-sub">
            {steps.length ? `Step ${index + 1} of ${steps.length}` : "No file edits in this session yet"}
          </p>
        </div>
        <span className="header-spacer" />
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
      </div>

      {!sessionId && <div className="view-empty">Open a session to review file edits.</div>}
      {sessionId && steps.length === 0 && (
        <div className="view-empty">Write or patch a file in this session to generate walkthrough steps.</div>
      )}

      {step && (
        <>
          <div className="wt-card">
            <div className="wt-file" title={step.file}>{step.file}</div>
            <pre className="wt-diff">
              {parseDiffLines(step.diff).map((line, i) => (
                <div key={i} className={`wt-diff-line ${line.kind}`}>
                  <span className="git-diff-ln">{i + 1}</span>
                  <span>{line.text || " "}</span>
                </div>
              ))}
            </pre>
          </div>
          <div className="wt-explain">{step.explanation || "No explanation attached to this step."}</div>
          <div className="wt-footer">
            <button className="small-btn" disabled={index === 0} onClick={() => setIndex((i) => i - 1)}>← Prev</button>
            <div className="wt-footer-mid">
              <button className="small-btn danger-btn" disabled={busy || step.status !== "pending"} onClick={() => void decide("reject")}>Reject</button>
              <button className="small-btn" disabled={index >= steps.length - 1} onClick={() => setIndex((i) => i + 1)}>Skip</button>
              <button className="primary-btn wt-approve" disabled={busy || step.status !== "pending"} onClick={() => void decide("approve")}>
                {step.status === "pending" ? "Approve" : step.status === "approved" ? "Approved ✓" : "Rejected"}
              </button>
            </div>
            <button className="small-btn" disabled={index >= steps.length - 1} onClick={() => setIndex((i) => i + 1)}>Next →</button>
          </div>
        </>
      )}
    </div>
  );
}
