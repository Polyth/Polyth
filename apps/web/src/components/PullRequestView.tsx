// PR detail surface (WP11): overview, changed files, checks grouped
// failure-first with an accessible ring, and review comments. Reads fail soft;
// the two writes (submit review, publish labels) are explicit confirmed
// actions and never happen automatically.
import { useCallback, useEffect, useState } from "react";
import {
  api, type ChecksSummaryDto, type PrCheckDto, type PrCommentDto,
  type PrDetailDto, type PrFileDto,
} from "../api.ts";
import { useStore } from "../store.ts";
import EmptyState from "./EmptyState.tsx";

type Tab = "overview" | "files" | "checks" | "comments";

function ChecksRing({ summary }: { summary: ChecksSummaryDto }) {
  const ok = summary.counts.success ?? 0;
  const failed = (summary.counts.failure ?? 0) + (summary.counts.action_required ?? 0) + (summary.counts.timed_out ?? 0);
  const running = (summary.counts.queued ?? 0) + (summary.counts.in_progress ?? 0);
  const total = Math.max(1, summary.total);
  const seg = (n: number) => (n / total) * 360;
  const gradient = `conic-gradient(var(--red) 0deg ${seg(failed)}deg, var(--amber) ${seg(failed)}deg ${seg(failed + running)}deg, var(--green) ${seg(failed + running)}deg ${seg(failed + running + ok)}deg, var(--border) ${seg(failed + running + ok)}deg 360deg)`;
  return (
    <span
      className="checks-ring"
      role="img"
      aria-label={`${summary.headline}: ${failed} failing, ${running} running, ${ok} passing of ${summary.total}`}
      style={{ background: gradient }}
    />
  );
}

function CheckRow({ check }: { check: PrCheckDto }) {
  return (
    <div className="check-row">
      <span className={`check-dot st-${check.status}`} />
      <span className="check-name">{check.name}</span>
      {check.workflow && <span className="muted">{check.workflow}</span>}
      <span className="check-status">{check.status.replace(/_/g, " ")}</span>
      {check.url && <a className="small-btn" href={check.url} target="_blank" rel="noreferrer">logs</a>}
    </div>
  );
}

export default function PullRequestView({ number, onClose }: { number: number; onClose: () => void }) {
  const projectId = useStore((s) => s.activeProjectId);
  const sessionId = useStore((s) => s.activeSessionId);
  const [tab, setTab] = useState<Tab>("overview");
  const [detail, setDetail] = useState<PrDetailDto | null>(null);
  const [files, setFiles] = useState<PrFileDto[]>([]);
  const [checks, setChecks] = useState<{ checks: PrCheckDto[]; summary: ChecksSummaryDto } | null>(null);
  const [comments, setComments] = useState<PrCommentDto[]>([]);
  const [reason, setReason] = useState("");

  // review submit form
  const [reviewBody, setReviewBody] = useState("");
  const [reviewEvent, setReviewEvent] = useState<"COMMENT" | "APPROVE" | "REQUEST_CHANGES">("COMMENT");
  const [confirmWrite, setConfirmWrite] = useState(false);
  const [writeMsg, setWriteMsg] = useState("");

  // F7: merge (destructive remote write) + title/body edit
  const [mergeStrategy, setMergeStrategy] = useState<"squash" | "merge" | "rebase">("squash");
  const [mergeConfirm, setMergeConfirm] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeMsg, setMergeMsg] = useState("");
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editBusy, setEditBusy] = useState(false);

  const loadChecks = useCallback(() => {
    if (!projectId) return;
    void api.githubPrChecks(projectId, number).then((r) => {
      if (r.ok) setChecks(r.data);
      else setReason(r.reason);
    });
  }, [projectId, number]);

  useEffect(() => {
    if (!projectId) return;
    setReason("");
    void api.githubPrDetail(projectId, number).then((r) => {
      if (r.ok) setDetail(r.data); else setReason(r.reason);
    });
    void api.githubPrFiles(projectId, number).then((r) => { if (r.ok) setFiles(r.data); });
    void api.githubPrComments(projectId, number).then((r) => { if (r.ok) setComments(r.data); });
    loadChecks();
  }, [projectId, number, loadChecks]);

  // poll checks only while some check is nonterminal and the surface is visible
  useEffect(() => {
    const pending = checks?.checks.some((c) => c.status === "queued" || c.status === "in_progress") ?? false;
    if (!pending) return;
    const t = setInterval(loadChecks, 10_000);
    return () => clearInterval(t);
  }, [checks, loadChecks]);

  if (!projectId) return null;

  const reloadDetail = () => {
    void api.githubPrDetail(projectId, number).then((r) => { if (r.ok) setDetail(r.data); });
  };

  // Merge stays disabled with the reason until GitHub reports MERGEABLE.
  const mergeBlock = !detail ? "loading"
    : detail.state !== "OPEN" ? `pull request is ${detail.state.toLowerCase()}`
    : detail.isDraft ? "draft pull requests cannot be merged"
    : detail.mergeable === "CONFLICTING" ? "has conflicts with the base branch"
    : detail.mergeable !== "MERGEABLE" ? "GitHub has not confirmed mergeability yet — refresh"
    : null;

  const doMerge = async () => {
    if (mergeBlock || !mergeConfirm) return;
    setMergeBusy(true);
    setMergeMsg("");
    const r = await api.githubPrMerge({
      projectId, number, strategy: mergeStrategy,
      ...(sessionId ? { sessionId } : {}),
    }).catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e) }));
    setMergeBusy(false);
    setMergeConfirm(false);
    if (r.ok) {
      // remote merge via GitHub — distinct from a local `git merge`
      setMergeMsg(`Merged via GitHub (${mergeStrategy}).`);
      reloadDetail();
    } else {
      setMergeMsg(`Merge failed: ${r.reason}`);
    }
  };

  const saveEdit = async () => {
    if (!detail) return;
    if (editTitle.trim() === detail.title && editBody === detail.body) { setEditing(false); return; }
    setEditBusy(true);
    const r = await api.githubPrUpdate({
      projectId, number,
      ...(editTitle.trim() !== detail.title ? { title: editTitle.trim() } : {}),
      ...(editBody !== detail.body ? { body: editBody } : {}),
      ...(sessionId ? { sessionId } : {}),
    }).catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e) }));
    setEditBusy(false);
    if (r.ok) {
      setEditing(false);
      reloadDetail();
    } else {
      setMergeMsg(`Update failed: ${r.reason}`);
    }
  };

  const submitReview = async () => {
    setWriteMsg("");
    const needsConfirm = reviewEvent !== "COMMENT";
    if (needsConfirm && !confirmWrite) { setWriteMsg("Tick the confirmation box to approve or request changes."); return; }
    const r = await api.githubSubmitReview(number, {
      projectId, event: reviewEvent, body: reviewBody,
      ...(detail?.headRefOid ? { commitSha: detail.headRefOid } : {}),
      ...(needsConfirm ? { confirm: true } : {}),
      ...(sessionId ? { sessionId } : {}),
    }).catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e) }));
    if (r.ok) {
      setWriteMsg(`Review submitted (${reviewEvent.toLowerCase()}).`);
      setReviewBody("");
      setConfirmWrite(false);
      void api.githubPrComments(projectId, number).then((c) => { if (c.ok) setComments(c.data); });
    } else {
      setWriteMsg(`Submit failed: ${r.reason}`);
    }
  };

  return (
    <div className="pr-surface">
      <div className="view-toolbar-row">
        <button className="small-btn" onClick={onClose}>← Back</button>
        {detail && (
          <>
            <span className={`gh-state ${detail.state.toLowerCase()}${detail.isDraft ? " draft" : ""} pr-state`}>
              {detail.isDraft ? "draft" : detail.state.toLowerCase()}
            </span>
            <a className="gh-title" href={detail.url} target="_blank" rel="noreferrer">
              <span className="gh-number mono">#{detail.number}</span> {detail.title}
            </a>
          </>
        )}
        <span className="header-spacer" />
        {checks && <><ChecksRing summary={checks.summary} /><span className={`checks-headline hl-${checks.summary.state}`}>{checks.summary.headline}</span></>}
      </div>

      {reason && !detail && <EmptyState title="Couldn’t load pull request" description={reason} />}

      {detail && (
        <>
          <div className="seg pr-tabbar">
            <button className={tab === "overview" ? "on" : ""} onClick={() => setTab("overview")}>Overview</button>
            <button className={tab === "files" ? "on" : ""} onClick={() => setTab("files")}>Files ({detail.changedFiles})</button>
            <button className={tab === "checks" ? "on" : ""} onClick={() => setTab("checks")}>Checks ({checks?.summary.total ?? 0})</button>
            <button className={tab === "comments" ? "on" : ""} onClick={() => setTab("comments")}>Comments ({comments.length})</button>
          </div>

          {tab === "overview" && (
            <div className="pr-overview">
              <div className="sched-meta">
                <span>{detail.author}</span>
                <span>·</span>
                <span className="mono">{detail.headRefName} → {detail.baseRefName}</span>
                <span>·</span>
                <span className="mono" title="head commit">{detail.headRefOid.slice(0, 8)}</span>
                <span>·</span>
                <span><span className="diff-add">+{detail.additions}</span> <span className="diff-del">−{detail.deletions}</span></span>
                <span>·</span>
                <span>{detail.mergeable.toLowerCase()}</span>
                <span className="header-spacer" />
                {detail.state === "OPEN" && !editing && (
                  <button className="small-btn" onClick={() => { setEditTitle(detail.title); setEditBody(detail.body); setEditing(true); }}>
                    Edit
                  </button>
                )}
              </div>

              {editing ? (
                <div className="pr-edit-form">
                  <input value={editTitle} placeholder="Title…" onChange={(e) => setEditTitle(e.target.value)} />
                  <textarea rows={6} placeholder="Description…" value={editBody} onChange={(e) => setEditBody(e.target.value)} />
                  <div className="view-toolbar-row">
                    <span className="header-spacer" />
                    <button className="small-btn" disabled={editBusy} onClick={() => setEditing(false)}>Cancel</button>
                    <button className="primary-btn" disabled={editBusy || !editTitle.trim()} onClick={() => void saveEdit()}>
                      {editBusy ? "Saving…" : "Save"}
                    </button>
                  </div>
                </div>
              ) : (
                <pre className="pr-body">{detail.body || "No description."}</pre>
              )}

              {/* F7: merge — a destructive remote write, gated on mergeability and
                  an explicit confirmation. Branch deletion is deliberately not here. */}
              {detail.state === "OPEN" && (
                <div className="pr-merge-area">
                  <div className="stat-label">Merge (external write)</div>
                  <div className="view-toolbar-row">
                    <select value={mergeStrategy} disabled={!!mergeBlock || mergeBusy}
                      onChange={(e) => setMergeStrategy(e.target.value as typeof mergeStrategy)}>
                      <option value="squash">Squash and merge</option>
                      <option value="merge">Merge commit</option>
                      <option value="rebase">Rebase and merge</option>
                    </select>
                    {!mergeBlock && (
                      <label className="sched-every">
                        <input type="checkbox" checked={mergeConfirm} onChange={(e) => setMergeConfirm(e.target.checked)} />
                        I confirm this merge
                      </label>
                    )}
                    <span className="header-spacer" />
                    <button className="primary-btn" disabled={!!mergeBlock || !mergeConfirm || mergeBusy}
                      title={mergeBlock ?? `Merge #${number} via GitHub (${mergeStrategy})`}
                      onClick={() => void doMerge()}>
                      {mergeBusy ? "Merging…" : "Merge pull request"}
                    </button>
                  </div>
                  {mergeBlock && <div className="set-muted">Merge unavailable: {mergeBlock}.</div>}
                </div>
              )}
              {mergeMsg && (
                <div className={/failed/.test(mergeMsg) ? "form-error" : "knowledge-notice"} role="status">{mergeMsg}</div>
              )}
            </div>
          )}

          {tab === "files" && (
            <div className="pr-files">
              {files.length === 0 && <EmptyState title="No changed files" description="No file list is available for this pull request." />}
              {files.map((f) => (
                <div key={f.path} className="pr-file-row">
                  <span className="mono pr-file-path">{f.path}</span>
                  <span className="diff-add">+{f.additions}</span>
                  <span className="diff-del">−{f.deletions}</span>
                </div>
              ))}
            </div>
          )}

          {tab === "checks" && (
            <div className="checks-summary">
              {!checks && <div className="set-muted">Loading checks…</div>}
              {checks && checks.summary.total === 0 && <EmptyState title="No checks" description="No checks were reported for this commit." />}
              {checks?.summary.groups.map((g) => (
                <div key={g.id} className="checks-group">
                  <div className="stat-label">{g.label} ({g.checks.length})</div>
                  {g.checks.map((c) => <CheckRow key={c.id} check={c} />)}
                </div>
              ))}
            </div>
          )}

          {tab === "comments" && (
            <div className="pr-comments">
              {comments.length === 0 && <EmptyState title="No comments yet" description="Reviews and comments will appear here." />}
              {comments.map((c) => (
                <div key={c.id} className="pr-comment">
                  <div className="pr-comment-head">
                    <strong>{c.author}</strong>
                    {c.reviewState && <span className="tag">{c.reviewState.toLowerCase().replace(/_/g, " ")}</span>}
                    {c.outdated && <span className="tag">outdated</span>}
                    <span className="muted">{c.createdAt ? new Date(c.createdAt).toLocaleString() : ""}</span>
                  </div>
                  {c.path && <div className="mono muted" style={{ fontSize: "calc(11.5px * var(--ui-font-scale, 1))" }}>{c.path}{c.line ? `:${c.line}` : ""}</div>}
                  <div className="pr-comment-body">{c.body}</div>
                </div>
              ))}

              <div className="pr-review-form">
                <div className="stat-label">Submit a review (external write)</div>
                <textarea rows={3} placeholder="Review comment…" value={reviewBody} onChange={(e) => setReviewBody(e.target.value)} />
                <div className="view-toolbar-row">
                  <select value={reviewEvent} onChange={(e) => setReviewEvent(e.target.value as typeof reviewEvent)}>
                    <option value="COMMENT">Comment</option>
                    <option value="APPROVE">Approve</option>
                    <option value="REQUEST_CHANGES">Request changes</option>
                  </select>
                  {reviewEvent !== "COMMENT" && (
                    <label className="sched-every">
                      <input type="checkbox" checked={confirmWrite} onChange={(e) => setConfirmWrite(e.target.checked)} />
                      I confirm this {reviewEvent === "APPROVE" ? "approval" : "change request"}
                    </label>
                  )}
                  <span className="header-spacer" />
                  <button className="primary-btn" disabled={!reviewBody.trim() && reviewEvent !== "APPROVE"} onClick={() => void submitReview()}>
                    Submit review
                  </button>
                </div>
                {writeMsg && <div className={writeMsg.startsWith("Submit failed") ? "form-error" : "knowledge-notice"}>{writeMsg}</div>}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
