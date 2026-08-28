// Explicit walkthrough generation over a stable Git snapshot (WP11), plus the
// structured review (risk/confidence) and the opt-in bounded auto-review loop.
// A stale banner appears when the working tree diverges from the captured
// digest; cached results stay reviewable against their snapshot.
import { useCallback, useEffect, useState } from "react";
import {
  api, type GeneratedWalkthroughDto, type ReviewResultDto,
  type ReviewFlowStateDto, type WalkthroughSourceDto,
} from "@polyth/session/web-api";
import { useStore } from "../../../apps/web/src/store.ts";
import { parseDiffLines } from "../../../apps/web/src/utils.ts";
import EmptyState from "../../../apps/web/src/components/EmptyState.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, Tabs, TextInput } from "../../../apps/web/src/components/ui/index.ts";

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
        <span>{tr("generatedwalkthrough.autoReviewLoopOptInAReviewer")}</span>
        <Button size="sm" busy={busy} onClick={() => void act(() => api.reviewFlowCreate(sessionId, 3))}>
          {tr("generatedwalkthrough.startAutoReview")}</Button>
      </div>
    );
  }
  const active = ["implementing", "awaiting-review", "reviewing", "changes-requested"].includes(flow.status);
  return (
    <div className={`auto-review-banner ${flow.status}`}>
      <span className="tag">{flow.status}</span>
      <span>{tr("generatedwalkthrough.iteration")}{" "}{flow.iteration}/{flow.maxIterations}</span>
      {flow.baseDigest && <span className="mono muted" title={tr("generatedwalkthrough.reviewedSourceDigest")}>{flow.baseDigest.slice(0, 8)}</span>}
      {flow.stoppedReason && <span className="muted">{flow.stoppedReason}</span>}
      <span className="header-spacer" />
      {flow.status === "paused" && <Button size="sm" busy={busy} onClick={() => void act(() => api.reviewFlowAction(sessionId, "resume"))}>{tr("common.resume")}</Button>}
      {active && <Button size="sm" busy={busy} onClick={() => void act(() => api.reviewFlowAction(sessionId, "pause"))}>{tr("common.pause")}</Button>}
      {(active || flow.status === "paused") && (
        <Button size="sm" variant="danger" busy={busy} onClick={() => void act(() => api.reviewFlowAction(sessionId, "stop"))}>{tr("common.stop")}</Button>
      )}
      {!active && flow.status !== "paused" && (
        <Button size="sm" busy={busy} onClick={() => void act(() => api.reviewFlowCreate(sessionId, 3))}>{tr("generatedwalkthrough.restart")}</Button>
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

  if (!projectId) return <EmptyState title={tr("generatedwalkthrough.noProjectSelected")} description={tr("generatedwalkthrough.openAProjectToGenerateAWalkthrough")} />;

  const generate = async () => {
    const source = sourceOf();
    if (!source) { setError(tr("generatedwalkthrough.pickAValidSourceFirst")); return; }
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
      tr("generatedwalkthrough.riskValue", { riskScore: review.assessment.riskScore }), tr("generatedwalkthrough.confidenceValue", { confidenceScore: review.assessment.confidenceScore }),
    ]).catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e) }));
    setLabelMsg(r.ok ? tr("generatedwalkthrough.labelsPublished") : tr("generatedwalkthrough.labelPublishFailedReviewStaysUsableValue", { reason: r.reason }));
  };

  return (
    <div className="walkthrough-generated">
      {sessionId && <AutoReviewBanner sessionId={sessionId} />}

      <div className="walkthrough-source">
        <Tabs
          className="walkthrough-source-tabs"
          size="sm"
          label={tr("generatedwalkthrough.generateWalkthrough")}
          value={kind}
          tabs={[
            { id: "working-tree", label: tr("generatedwalkthrough.workingTree") },
            { id: "range", label: tr("generatedwalkthrough.commitRange") },
            { id: "pull-request", label: tr("generatedwalkthrough.pullRequest") },
          ]}
          onChange={(value) => setKind(value as SourceKind)}
        />
        {kind === "range" && (
          <>
            <TextInput uiSize="sm" className="mono walkthrough-ref-input" placeholder={tr("generatedwalkthrough.baseEGMain")} value={base} onChange={(e) => setBase(e.target.value)} />
            <TextInput uiSize="sm" className="mono walkthrough-ref-input" placeholder={tr("generatedwalkthrough.head")} value={head} onChange={(e) => setHead(e.target.value)} />
          </>
        )}
        {kind === "pull-request" && (
          <TextInput uiSize="sm" className="mono walkthrough-pr-input" placeholder={tr("generatedwalkthrough.pr")} value={prNumber} onChange={(e) => setPrNumber(e.target.value)} />
        )}
        <span className="header-spacer" />
        {sessionId && (
          <Button size="sm" busy={reviewBusy} onClick={() => void generateReview()}>
            {reviewBusy ? tr("generatedwalkthrough.reviewing") : tr("generatedwalkthrough.generateReview")}
          </Button>
        )}
        <Button size="sm" variant="primary" onClick={() => void generate()}>{tr("generatedwalkthrough.generateWalkthrough")}</Button>
      </div>
      {error && <div className="form-error">{error}</div>}

      {review && !review.ok && <div className="form-error">{tr("generatedwalkthrough.reviewFailed")}{" "}{review.reason}</div>}
      {review?.ok && (
        <div className="review-card">
          <div className="view-toolbar-row">
            <span className={`risk-badge risk-${review.assessment.riskScore}`}>{tr("generatedwalkthrough.risk")}{" "}{review.assessment.riskScore}/5</span>
            <span className="tag">{tr("generatedwalkthrough.confidence")}{" "}{review.assessment.confidenceScore}/5</span>
            <span className="mono muted" title={tr("generatedwalkthrough.reviewedSourceDigest")}>{review.sourceDigest.slice(0, 8)}</span>
            <span className="header-spacer" />
            {kind === "pull-request" && (
              <Button size="sm" title={tr("generatedwalkthrough.publishRiskConfidenceLabelsToThePr")} onClick={() => void publishLabels()}>
                {tr("generatedwalkthrough.publishLabels")}</Button>
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
          <span className="muted">{tr("generatedwalkthrough.generatingWalkthrough")}</span>
          <Button size="sm" onClick={() => void api.walkthroughCancel(job.id).then(setJob)}>{tr("common.cancel")}</Button>
        </div>
      )}
      {job?.status === "failed" && <div className="form-error">{tr("generatedwalkthrough.walkthroughFailed")}{" "}{job.error}</div>}

      {job?.status === "ready" && (
        <>
          {stale && (
            <div className="walkthrough-stale">
              {tr("generatedwalkthrough.theSourceChangedSinceThisWalkthroughWas")}{" "}{job.sourceDigest.slice(0, 8)}{tr("generatedwalkthrough.itStaysReviewableAgainstItsSnapshotRegenerate")}</div>
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
