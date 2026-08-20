// Explicit walkthrough generation over a stable Git snapshot (WP11), plus the
// structured review (risk/confidence) and the opt-in bounded auto-review loop.
// A stale banner appears when the working tree diverges from the captured
// digest; cached results stay reviewable against their snapshot.
import { useCallback, useEffect, useState } from "react";
import {
  api, type GeneratedWalkthroughDto, type ReviewResultDto,
  type ReviewFlowStateDto, type WalkthroughSourceDto,
} from "../api.ts";
import { useStore } from "../store.ts";
import { parseDiffLines } from "../utils.ts";
import EmptyState from "./EmptyState.tsx";

type SourceKind = WalkthroughSourceDto["kind"];

function DiffBlock({ diff }: { diff: string }) {
  return (
    <pre className="wt-diff">
      {parseDiffLines(diff).map((line, i) => (
        <div key={i} className={`wt-diff-line ${line.kind}`}>
          <span className="git-diff-ln">{i + 1}</span>
          <span>{line.text || " "}</span>
        </div>
      ))}
    </pre>
  );
}

function AutoReviewBanner({ sessionId }: { sessionId: string }) {
  const [flow, setFlow] = useState<ReviewFlowStateDto | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void api.reviewFlowGet(sessionId).then(setFlow);
  }, [sessionId]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5_000);
    return () => clearInterval(t);
  }, [refresh]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    await fn().catch(() => {});
    refresh();
    setBusy(false);
  };

  if (!flow) {
    return (
      <div className="auto-review-banner idle">
        <span>Auto-review loop (opt-in): a reviewer model checks the working tree after each turn and hands findings back, bounded to a few iterations. It never merges, pushes, or publishes.</span>
        <button className="small-btn" disabled={busy} onClick={() => void act(() => api.reviewFlowCreate(sessionId, 3))}>
          Start auto-review
        </button>
      </div>
    );
  }
  const active = ["implementing", "awaiting-review", "reviewing", "changes-requested"].includes(flow.status);
  return (
    <div className={`auto-review-banner ${flow.status}`}>
      <span className="tag">{flow.status}</span>
      <span>Iteration {flow.iteration}/{flow.maxIterations}</span>
      {flow.baseDigest && <span className="mono muted" title="reviewed source digest">{flow.baseDigest.slice(0, 8)}</span>}
      {flow.stoppedReason && <span className="muted">{flow.stoppedReason}</span>}
      <span className="header-spacer" />
      {flow.status === "paused" && <button className="small-btn" disabled={busy} onClick={() => void act(() => api.reviewFlowAction(sessionId, "resume"))}>Resume</button>}
      {active && <button className="small-btn" disabled={busy} onClick={() => void act(() => api.reviewFlowAction(sessionId, "pause"))}>Pause</button>}
      {(active || flow.status === "paused") && (
        <button className="small-btn danger-btn" disabled={busy} onClick={() => void act(() => api.reviewFlowAction(sessionId, "stop"))}>Stop</button>
      )}
      {!active && flow.status !== "paused" && (
        <button className="small-btn" disabled={busy} onClick={() => void act(() => api.reviewFlowCreate(sessionId, 3))}>Restart</button>
      )}
    </div>
  );
}

export default function GeneratedWalkthrough() {
  const projectId = useStore((s) => s.activeProjectId);
  const sessionId = useStore((s) => s.activeSessionId);

  const [kind, setKind] = useState<SourceKind>("working-tree");
  const [base, setBase] = useState("");
  const [head, setHead] = useState("HEAD");
  const [prNumber, setPrNumber] = useState("");
  const [job, setJob] = useState<GeneratedWalkthroughDto | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  const [review, setReview] = useState<ReviewResultDto | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [labelMsg, setLabelMsg] = useState("");

  const sourceOf = (): WalkthroughSourceDto | null => {
    if (!projectId) return null;
    if (kind === "working-tree") return { kind, projectId };
    if (kind === "range") return base && head ? { kind, projectId, base, head } : null;
    const n = Number(prNumber);
    return Number.isInteger(n) && n > 0 ? { kind: "pull-request", projectId, number: n } : null;
  };

  // poll the job while queued/running; poll staleness while ready
  useEffect(() => {
    if (!job) return;
    if (job.status === "queued" || job.status === "running") {
      const t = setInterval(() => void api.walkthroughJob(job.id).then(setJob).catch(() => {}), 1_500);
      return () => clearInterval(t);
    }
    if (job.status === "ready") {
      const check = () => void api.walkthroughSourceStatus(job.id).then((s) => setStale(s.stale)).catch(() => {});
      check();
      const t = setInterval(check, 10_000);
      return () => clearInterval(t);
    }
  }, [job]);

  if (!projectId) return <EmptyState title="No project selected" description="Open a project to generate a walkthrough." />;

  const generate = async () => {
    const source = sourceOf();
    if (!source) { setError("Pick a valid source first."); return; }
    setError("");
    setStale(false);
    setReview(null);
    const created = await api.walkthroughGenerate(source, sessionId ?? undefined)
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); return null; });
    if (created) setJob(created);
  };

  const generateReview = async () => {
    const source = sourceOf();
    if (!source || !sessionId) return;
    setReviewBusy(true);
    setLabelMsg("");
    const r = await api.reviewGenerate(sessionId, source)
      .catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e) }));
    setReview(r);
    setReviewBusy(false);
  };

  const publishLabels = async () => {
    if (!review?.ok || kind !== "pull-request") return;
    const n = Number(prNumber);
    const r = await api.githubAddLabels(n, projectId, [
      `risk:${review.assessment.riskScore}`, `confidence:${review.assessment.confidenceScore}`,
    ]).catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e) }));
    setLabelMsg(r.ok ? "Labels published." : `Label publish failed (review stays usable): ${r.reason}`);
  };

  return (
    <div className="walkthrough-generated">
      {sessionId && <AutoReviewBanner sessionId={sessionId} />}

      <div className="walkthrough-source">
        <div className="seg">
          <button className={kind === "working-tree" ? "on" : ""} onClick={() => setKind("working-tree")}>Working tree</button>
          <button className={kind === "range" ? "on" : ""} onClick={() => setKind("range")}>Commit range</button>
          <button className={kind === "pull-request" ? "on" : ""} onClick={() => setKind("pull-request")}>Pull request</button>
        </div>
        {kind === "range" && (
          <>
            <input className="mono" style={{ width: 130 }} placeholder="base (e.g. main)" value={base} onChange={(e) => setBase(e.target.value)} />
            <input className="mono" style={{ width: 130 }} placeholder="head" value={head} onChange={(e) => setHead(e.target.value)} />
          </>
        )}
        {kind === "pull-request" && (
          <input className="mono" style={{ width: 90 }} placeholder="PR #" value={prNumber} onChange={(e) => setPrNumber(e.target.value)} />
        )}
        <span className="header-spacer" />
        {sessionId && (
          <button className="small-btn" disabled={reviewBusy} onClick={() => void generateReview()}>
            {reviewBusy ? "Reviewing…" : "Generate review"}
          </button>
        )}
        <button className="primary-btn" onClick={() => void generate()}>Generate walkthrough</button>
      </div>
      {error && <div className="form-error">{error}</div>}

      {review && !review.ok && <div className="form-error">Review failed: {review.reason}</div>}
      {review?.ok && (
        <div className="review-card">
          <div className="view-toolbar-row">
            <span className={`risk-badge risk-${review.assessment.riskScore}`}>risk {review.assessment.riskScore}/5</span>
            <span className="tag">confidence {review.assessment.confidenceScore}/5</span>
            <span className="mono muted" title="reviewed source digest">{review.sourceDigest.slice(0, 8)}</span>
            <span className="header-spacer" />
            {kind === "pull-request" && (
              <button className="small-btn" title="Publish risk/confidence labels to the PR (external write)" onClick={() => void publishLabels()}>
                Publish labels
              </button>
            )}
          </div>
          <div className="review-summary">{review.assessment.summary}</div>
          {review.assessment.findings.map((f, i) => (
            <div key={i} className={`review-finding sev-${f.severity}`}>
              <span className="tag">{f.severity}</span>
              {f.path && <span className="mono">{f.path}{f.line ? `:${f.line}` : ""}</span>}
              <span>{f.body}</span>
              <span className="muted">({Math.round(f.confidence * 100)}%)</span>
            </div>
          ))}
          {labelMsg && <div className={labelMsg.includes("failed") ? "form-error" : "knowledge-notice"}>{labelMsg}</div>}
        </div>
      )}

      {job && (job.status === "queued" || job.status === "running") && (
        <div className="view-toolbar-row">
          <span className="muted">Generating walkthrough…</span>
          <button className="small-btn" onClick={() => void api.walkthroughCancel(job.id).then(setJob)}>Cancel</button>
        </div>
      )}
      {job?.status === "failed" && <div className="form-error">Walkthrough failed: {job.error}</div>}

      {job?.status === "ready" && (
        <>
          {stale && (
            <div className="walkthrough-stale">
              The source changed since this walkthrough was generated (digest {job.sourceDigest.slice(0, 8)}).
              It stays reviewable against its snapshot — regenerate for the current state.
            </div>
          )}
          {job.stages.map((stage) => (
            <div key={stage.id} className="walkthrough-stage">
              <div className="walkthrough-stage-title">{stage.title}</div>
              {stage.explanation && <div className="wt-explain">{stage.explanation}</div>}
              {stage.stops.map((stop) => (
                <div key={stop.id} className="walkthrough-stop">
                  <div className="wt-file">{stop.path}</div>
                  {stop.explanation && <div className="walkthrough-stop-explain">{stop.explanation}</div>}
                  <DiffBlock diff={stop.diff} />
                </div>
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
