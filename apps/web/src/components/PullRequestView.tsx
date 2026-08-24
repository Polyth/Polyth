import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api, type ChecksSummaryDto, type PrCheckDto, type PrCommentDto,
  type PrDetailDto, type PrFileDto,
} from "../api.ts";
import { highlight, langOf } from "../highlight.ts";
import { Icon } from "../icons.tsx";
import { MarkdownDoc } from "../markdown.tsx";
import { splitPrDiff } from "../prDiff.ts";
import { friendlyError } from "../settings.ts";
import { useStore } from "../store.ts";
import EmptyState from "./EmptyState.tsx";

type Tab = "overview" | "files" | "checks" | "comments";
type PrSection = "detail" | "files" | "diff" | "checks" | "comments";

/** GitHub descriptions may contain hidden Cursor coordination comments.
 * Markdown parsers intentionally do not execute HTML, but those comments
 * should remain hidden rather than appearing as literal marker text. */
export function stripCursorMarkers(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*(?:(?:begin|end|start|stop)[_\s-]+cursor(?:[_\s:-].*)?|cursor(?:_[a-z0-9-]+)+)\s*$/gim, "")
    .trim();
}

function ChecksRing({ summary }: { summary: ChecksSummaryDto }) {
  const passing = summary.counts.success ?? 0;
  const failing = (summary.counts.failure ?? 0) + (summary.counts.action_required ?? 0) + (summary.counts.timed_out ?? 0);
  const running = (summary.counts.queued ?? 0) + (summary.counts.in_progress ?? 0);
  const total = Math.max(1, summary.total);
  const segment = (count: number) => (count / total) * 360;
  const gradient = `conic-gradient(var(--red) 0deg ${segment(failing)}deg, var(--amber) ${segment(failing)}deg ${segment(failing + running)}deg, var(--green) ${segment(failing + running)}deg ${segment(failing + running + passing)}deg, var(--border) ${segment(failing + running + passing)}deg 360deg)`;
  return <span className="checks-ring" role="img" aria-label={`${summary.headline}: ${failing} failing, ${running} running, ${passing} passing`} style={{ background: gradient }} />;
}

function CheckRow({ check }: { check: PrCheckDto }) {
  return (
    <article className="check-row">
      <span className={`check-dot st-${check.status}`} />
      <div className="check-copy">
        <strong className="check-name">{check.name}</strong>
        {check.workflow && <span className="muted">{check.workflow}</span>}
      </div>
      <span className="check-status">{check.status.replace(/_/g, " ")}</span>
      {check.url && <a className="small-btn" href={check.url} target="_blank" rel="noreferrer">View logs</a>}
    </article>
  );
}

function DiffLines({ diff, path }: { diff: string; path: string }) {
  let oldLine = 0;
  let newLine = 0;
  return (
    <div className="git-diff pr-diff" role="table" aria-label={`Patch for ${path}`}>
      {diff.split("\n").map((line, index) => {
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hunk) {
          oldLine = Number(hunk[1]);
          newLine = Number(hunk[2]);
          return <div key={index} className="git-diff-line diff-hunk" role="row" aria-label={line}><span className="pr-diff-ln" aria-hidden="true" /><code role="cell">{line}</code></div>;
        }
        const metadata = line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("new file ") || line.startsWith("deleted file ") || line.startsWith("similarity ");
        let oldShown = "";
        let newShown = "";
        let className = metadata ? "diff-meta" : "";
        if (!metadata && line.startsWith("+")) {
          newShown = String(newLine++);
          className = "diff-add";
        } else if (!metadata && line.startsWith("-")) {
          oldShown = String(oldLine++);
          className = "diff-del";
        } else if (!metadata && line !== "\\ No newline at end of file") {
          oldShown = String(oldLine++);
          newShown = String(newLine++);
        }
        const lineLabel = oldShown && newShown
          ? `old line ${oldShown}, new line ${newShown}`
          : oldShown ? `old line ${oldShown}` : newShown ? `new line ${newShown}` : "diff metadata";
        return (
          <div key={index} className={`git-diff-line ${className}`} role="row" aria-label={lineLabel}>
            <span className="pr-diff-ln" aria-hidden="true"><i>{oldShown}</i><i>{newShown}</i></span>
            <code role="cell" dangerouslySetInnerHTML={{ __html: highlight(line, langOf(path)) }} />
          </div>
        );
      })}
    </div>
  );
}

const initials = (name: string): string => name.split(/[\s-]+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";

export default function PullRequestView({ number, onClose }: { number: number; onClose: () => void }) {
  const projectId = useStore((state) => state.activeProjectId);
  const sessionId = useStore((state) => state.activeSessionId);
  const [tab, setTab] = useState<Tab>("overview");
  const [detail, setDetail] = useState<PrDetailDto | null>(null);
  const [files, setFiles] = useState<PrFileDto[]>([]);
  const [rawDiff, setRawDiff] = useState("");
  const [diffReason, setDiffReason] = useState("");
  const [expandedFiles, setExpandedFiles] = useState<ReadonlySet<string>>(new Set());
  const [checks, setChecks] = useState<{ checks: PrCheckDto[]; summary: ChecksSummaryDto } | null>(null);
  const [comments, setComments] = useState<PrCommentDto[]>([]);
  const [reason, setReason] = useState("");
  const [sectionErrors, setSectionErrors] = useState<Partial<Record<PrSection, string>>>({});
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [reviewBody, setReviewBody] = useState("");
  const [reviewEvent, setReviewEvent] = useState<"COMMENT" | "APPROVE" | "REQUEST_CHANGES">("COMMENT");
  const [confirmWrite, setConfirmWrite] = useState(false);
  const [writeMsg, setWriteMsg] = useState("");
  const [mergeStrategy, setMergeStrategy] = useState<"squash" | "merge" | "rebase">("squash");
  const [mergeConfirm, setMergeConfirm] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeMsg, setMergeMsg] = useState("");
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);

  const loadChecks = useCallback(async () => {
    if (!projectId) return Promise.resolve();
    try {
      const result = await api.githubPrChecks(projectId, number);
      if (result.ok) {
        setChecks(result.data);
        setSectionErrors((current) => {
          const { checks: _checks, ...rest } = current;
          return rest;
        });
      } else {
        setSectionErrors((current) => ({ ...current, checks: result.reason }));
      }
    } catch (cause) {
      setSectionErrors((current) => ({ ...current, checks: friendlyError("Couldn’t load checks", cause) }));
    }
  }, [projectId, number]);

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    setLoading(true);
    setReason("");
    setDiffReason("");
    setSectionErrors({});
    const recordError = (section: PrSection, message: string) => {
      if (active) setSectionErrors((current) => ({ ...current, [section]: message }));
    };
    const tasks = [
      (async () => {
        try {
          const result = await api.githubPrDetail(projectId, number);
          if (!active) return;
          if (result.ok) setDetail(result.data);
          else {
            setReason(result.reason);
            recordError("detail", result.reason);
          }
        } catch (cause) {
          const message = friendlyError("Couldn’t load pull request details", cause);
          if (active) setReason(message);
          recordError("detail", message);
        }
      })(),
      (async () => {
        try {
          const result = await api.githubPrFiles(projectId, number);
          if (!active) return;
          if (result.ok) setFiles(result.data); else recordError("files", result.reason);
        } catch (cause) {
          recordError("files", friendlyError("Couldn’t load changed files", cause));
        }
      })(),
      (async () => {
        try {
          const result = await api.githubPrComments(projectId, number);
          if (!active) return;
          if (result.ok) setComments(result.data); else recordError("comments", result.reason);
        } catch (cause) {
          recordError("comments", friendlyError("Couldn’t load comments", cause));
        }
      })(),
      (async () => {
        try {
          const result = await api.githubPrDiff(projectId, number);
          if (!active) return;
          if (result.ok) setRawDiff(result.data);
          else {
            setDiffReason(result.reason);
            recordError("diff", result.reason);
          }
        } catch (cause) {
          const message = friendlyError("Couldn’t load the pull request patch", cause);
          if (active) setDiffReason(message);
          recordError("diff", message);
        }
      })(),
      loadChecks(),
    ];
    void Promise.allSettled(tasks).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId, number, loadChecks, reloadKey]);

  useEffect(() => {
    const pending = checks?.checks.some((check) => check.status === "queued" || check.status === "in_progress") ?? false;
    if (!pending) return;
    const timer = setInterval(() => void loadChecks(), 10_000);
    return () => clearInterval(timer);
  }, [checks, loadChecks]);

  const diffFiles = useMemo(() => splitPrDiff(rawDiff), [rawDiff]);
  const fileStats = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);

  useEffect(() => {
    if (diffFiles[0]) setExpandedFiles(new Set([diffFiles[0].path]));
  }, [rawDiff]);

  if (!projectId) return null;

  const reloadDetail = () => {
    void api.githubPrDetail(projectId, number).then((result) => { if (result.ok) setDetail(result.data); });
  };

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
    const result = await api.githubPrMerge({
      projectId,
      number,
      strategy: mergeStrategy,
      ...(sessionId ? { sessionId } : {}),
    }).catch((cause: unknown) => ({ ok: false as const, reason: cause instanceof Error ? cause.message : String(cause) }));
    setMergeBusy(false);
    setMergeConfirm(false);
    if (result.ok) {
      setMergeMsg(`Merged via GitHub using ${mergeStrategy}.`);
      reloadDetail();
    } else {
      setMergeMsg(`Merge failed: ${result.reason}`);
    }
  };

  const saveEdit = async () => {
    if (!detail) return;
    if (editTitle.trim() === detail.title && editBody === detail.body) {
      setEditing(false);
      return;
    }
    setEditBusy(true);
    const result = await api.githubPrUpdate({
      projectId,
      number,
      ...(editTitle.trim() !== detail.title ? { title: editTitle.trim() } : {}),
      ...(editBody !== detail.body ? { body: editBody } : {}),
      ...(sessionId ? { sessionId } : {}),
    }).catch((cause: unknown) => ({ ok: false as const, reason: cause instanceof Error ? cause.message : String(cause) }));
    setEditBusy(false);
    if (result.ok) {
      setEditing(false);
      reloadDetail();
    } else {
      setMergeMsg(`Update failed: ${result.reason}`);
    }
  };

  const submitReview = async () => {
    if (reviewBusy) return;
    setWriteMsg("");
    const needsConfirm = reviewEvent !== "COMMENT";
    if (needsConfirm && !confirmWrite) {
      setWriteMsg("Confirm the approval or change request before submitting.");
      return;
    }
    setReviewBusy(true);
    const result = await api.githubSubmitReview(number, {
      projectId,
      event: reviewEvent,
      body: reviewBody,
      ...(detail?.headRefOid ? { commitSha: detail.headRefOid } : {}),
      ...(needsConfirm ? { confirm: true } : {}),
      ...(sessionId ? { sessionId } : {}),
    }).catch((cause: unknown) => ({ ok: false as const, reason: cause instanceof Error ? cause.message : String(cause) }));
    setReviewBusy(false);
    if (result.ok) {
      setWriteMsg(`Review submitted (${reviewEvent.toLowerCase().replace("_", " ")}).`);
      setReviewBody("");
      setConfirmWrite(false);
      void api.githubPrComments(projectId, number).then((next) => { if (next.ok) setComments(next.data); });
    } else {
      setWriteMsg(`Submit failed: ${result.reason}`);
    }
  };

  const toggleFile = (path: string) => {
    setExpandedFiles((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const passing = checks?.summary.counts.success ?? 0;
  const failing = (checks?.summary.counts.failure ?? 0) + (checks?.summary.counts.action_required ?? 0) + (checks?.summary.counts.timed_out ?? 0);
  const pending = (checks?.summary.counts.queued ?? 0) + (checks?.summary.counts.in_progress ?? 0);

  if (loading && !detail) {
    return (
      <div className="pr-surface" aria-busy="true" aria-label="Loading pull request">
        <div className="source-skeleton skeleton-title" />
        <div className="source-skeleton skeleton-tabs" />
        <div className="source-skeleton skeleton-panel" />
      </div>
    );
  }

  return (
    <div className="pr-surface">
      <header className="pr-head">
        <button className="small-btn pr-back" onClick={onClose}><Icon.back /> Pull requests</button>
        {detail && (
          <div className="pr-title-block">
            <div className="pr-title-meta">
              <span className={`gh-state ${detail.state.toLowerCase()}${detail.isDraft ? " draft" : ""}`}>{detail.isDraft ? "draft" : detail.state.toLowerCase()}</span>
              <span className="gh-number mono">#{detail.number}</span>
            </div>
            <h1><a href={detail.url} target="_blank" rel="noreferrer">{detail.title} <Icon.external /><span className="sr-only">(opens on GitHub)</span></a></h1>
            <span className="muted">{detail.author} wants to merge <span className="mono">{detail.headRefName}</span> into <span className="mono">{detail.baseRefName}</span></span>
          </div>
        )}
        {checks && <div className="pr-check-pill"><ChecksRing summary={checks.summary} /><span className={`checks-headline hl-${checks.summary.state}`}>{checks.summary.headline}</span></div>}
      </header>

      {reason && !detail && <EmptyState title="Couldn’t load pull request" description={reason} actionLabel="Retry" onAction={() => setReloadKey((key) => key + 1)} />}

      {detail && (
        <>
          <nav className="pr-tabbar" aria-label="Pull request sections">
            {([
              ["overview", "Overview", null],
              ["files", "Files", detail.changedFiles],
              ["checks", "Checks", checks?.summary.total ?? 0],
              ["comments", "Comments", comments.length],
            ] as const).map(([id, label, count]) => (
              <button key={id} className={tab === id ? "active" : ""} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>
                {label}{count !== null && <span>{count}</span>}
              </button>
            ))}
          </nav>

          {tab === "overview" && (
            <div className="pr-overview">
              <section className="pr-summary-cards">
                <div><span>Changed files</span><strong>{detail.changedFiles}</strong></div>
                <div><span>Lines added</span><strong className="positive">+{detail.additions}</strong></div>
                <div><span>Lines removed</span><strong className="negative">−{detail.deletions}</strong></div>
                <div>
                  <span>Merge status</span>
                  <strong className={`merge-status-badge st-${detail.mergeable.toLowerCase()}`}>
                    {detail.mergeable === "MERGEABLE" ? "Ready" : detail.mergeable === "CONFLICTING" ? "Conflicts" : "Checking"}
                  </strong>
                </div>
              </section>
              <div className="pr-overview-head">
                <div>
                  <h2>Description</h2>
                  <span className="muted">Updated {new Date(detail.updatedAt).toLocaleString()}</span>
                </div>
                {detail.state === "OPEN" && !editing && <button className="small-btn" onClick={() => {
                  setEditTitle(detail.title);
                  setEditBody(detail.body);
                  setEditing(true);
                }}><Icon.pencil /> Edit</button>}
              </div>

              {editing ? (
                <div className="pr-edit-form">
                  <label>Title<input value={editTitle} placeholder="Title…" onChange={(event) => setEditTitle(event.target.value)} /></label>
                  <label>Description<textarea rows={7} placeholder="Description…" value={editBody} onChange={(event) => setEditBody(event.target.value)} /></label>
                  <div className="view-toolbar-row">
                    <span className="header-spacer" />
                    <button className="small-btn" disabled={editBusy} onClick={() => setEditing(false)}>Cancel</button>
                    <button className="primary-btn" disabled={editBusy || !editTitle.trim()} onClick={() => void saveEdit()}>{editBusy ? "Saving…" : "Save changes"}</button>
                  </div>
                </div>
              ) : (
                <div className="pr-body markdown-body">
                  {detail.body ? <MarkdownDoc text={stripCursorMarkers(detail.body)} keyBase={`pr-${detail.number}-body`} /> : <p>No description was provided.</p>}
                </div>
              )}

              {detail.state === "OPEN" && (
                <section className="pr-merge-area">
                  <div>
                    <strong>Merge pull request</strong>
                    <span className="muted">{mergeBlock ? `Unavailable: ${mergeBlock}.` : "This updates the repository on GitHub."}</span>
                  </div>
                  <div className="pr-merge-controls">
                    <select value={mergeStrategy} disabled={!!mergeBlock || mergeBusy} aria-label="Merge strategy" onChange={(event) => setMergeStrategy(event.target.value as typeof mergeStrategy)}>
                      <option value="squash">Squash and merge</option>
                      <option value="merge">Create merge commit</option>
                      <option value="rebase">Rebase and merge</option>
                    </select>
                    {!mergeBlock && <label className="source-confirm"><input type="checkbox" checked={mergeConfirm} onChange={(event) => setMergeConfirm(event.target.checked)} /> I confirm this merge</label>}
                    <button className="primary-btn" disabled={!!mergeBlock || !mergeConfirm || mergeBusy} title={mergeBlock ?? `Merge #${number}`} onClick={() => void doMerge()}>
                      {mergeBusy ? "Merging…" : "Merge pull request"}
                    </button>
                  </div>
                </section>
              )}
              {mergeMsg && <div className={/failed/.test(mergeMsg) ? "form-error" : "knowledge-notice"} role="status">{mergeMsg}</div>}
            </div>
          )}

          {tab === "files" && (
            <div className="pr-files">
              <div className="pr-files-toolbar">
                <div>
                  <strong>{detail.changedFiles} changed {detail.changedFiles === 1 ? "file" : "files"}</strong>
                  <span><span className="positive">+{detail.additions}</span> <span className="negative">−{detail.deletions}</span></span>
                </div>
                <span className="header-spacer" />
                <button className="small-btn" disabled={diffFiles.length === 0} onClick={() => setExpandedFiles(new Set(diffFiles.map((file) => file.path)))}>Expand all</button>
                <button className="small-btn" disabled={expandedFiles.size === 0} onClick={() => setExpandedFiles(new Set())}>Collapse all</button>
              </div>
              {sectionErrors.files && (
                <div className="source-inline-status error" role="alert">
                  <span>Changed-file metadata could not be loaded: {sectionErrors.files}</span>
                  <button className="small-btn" onClick={() => setReloadKey((key) => key + 1)}>Retry</button>
                </div>
              )}
              {diffReason && (
                <div className="source-inline-status error" role="alert">
                  <span>The patch could not be loaded: {diffReason}</span>
                  <button className="small-btn" onClick={() => setReloadKey((key) => key + 1)}>Retry</button>
                </div>
              )}
              {files.length === 0 && diffFiles.length === 0 && <EmptyState title="No changed files" description="No file changes are available for this pull request." />}
              {diffFiles.map((file) => {
                const stat = fileStats.get(file.path);
                const expanded = expandedFiles.has(file.path);
                return (
                  <article key={file.path} className={`pr-file-card ${expanded ? "expanded" : ""}`}>
                    <button className="pr-file-head" aria-expanded={expanded} onClick={() => toggleFile(file.path)}>
                      <span className={`git-folder-chevron${expanded ? " expanded" : ""}`} aria-hidden="true"><Icon.chevronRight /></span>
                      <span className="mono pr-file-path" title={file.path}>
                        {file.previousPath && <span className="muted">{file.previousPath} → </span>}{file.path}
                      </span>
                      {stat && <span className="pr-file-stat"><span className="positive">+{stat.additions}</span><span className="negative">−{stat.deletions}</span></span>}
                    </button>
                    {expanded && <DiffLines diff={file.diff} path={file.path} />}
                  </article>
                );
              })}
              {diffFiles.length === 0 && files.map((file) => (
                <article key={file.path} className="pr-file-card">
                  <div className="pr-file-head static"><span className="mono pr-file-path">{file.path}</span><span className="pr-file-stat"><span className="positive">+{file.additions}</span><span className="negative">−{file.deletions}</span></span></div>
                </article>
              ))}
            </div>
          )}

          {tab === "checks" && (
            <div className="checks-summary">
              {!checks && !sectionErrors.checks && <div className="source-skeleton skeleton-panel" />}
              {sectionErrors.checks && (
                <div className="source-inline-status error" role="alert">
                  <span>Checks could not be loaded: {sectionErrors.checks}</span>
                  <button className="small-btn" onClick={() => void loadChecks()}>Retry</button>
                </div>
              )}
              {checks && checks.summary.total > 0 && (
                <section className="check-summary-cards">
                  <div className="success"><span>Passing</span><strong>{passing}</strong></div>
                  <div className="failure"><span>Failing</span><strong>{failing}</strong></div>
                  <div className="pending"><span>In progress</span><strong>{pending}</strong></div>
                  <div><span>Total</span><strong>{checks.summary.total}</strong></div>
                </section>
              )}
              {checks && checks.summary.total === 0 && <EmptyState title="No checks" description="No checks were reported for this commit." />}
              {checks?.summary.groups.map((group) => (
                <section key={group.id} className="checks-group">
                  <div className="checks-group-head"><strong>{group.label}</strong><span>{group.checks.length}</span></div>
                  {group.checks.map((check) => <CheckRow key={check.id} check={check} />)}
                </section>
              ))}
            </div>
          )}

          {tab === "comments" && (
            <div className="pr-comments">
              {sectionErrors.comments && (
                <div className="source-inline-status error" role="alert">
                  <span>Conversation could not be loaded: {sectionErrors.comments}</span>
                  <button className="small-btn" onClick={() => setReloadKey((key) => key + 1)}>Retry</button>
                </div>
              )}
              {!sectionErrors.comments && comments.length === 0 && <EmptyState title="No conversation yet" description="Reviews and comments on this pull request will appear here." />}
              <div className="pr-thread">
                {comments.map((comment) => (
                  <article key={comment.id} className="pr-comment">
                    <span className="pr-comment-avatar" aria-hidden="true">{initials(comment.author)}</span>
                    <div className="pr-comment-card">
                      <header className="pr-comment-head">
                        <strong>{comment.author}</strong>
                        {comment.reviewState && <span className="tag">{comment.reviewState.toLowerCase().replace(/_/g, " ")}</span>}
                        {comment.outdated && <span className="tag">outdated</span>}
                        <a href={comment.url} target="_blank" rel="noreferrer" className="muted">{comment.createdAt ? new Date(comment.createdAt).toLocaleString() : ""}</a>
                      </header>
                      {comment.path && <div className="pr-comment-location mono">{comment.path}{comment.line ? `:${comment.line}` : ""}</div>}
                      <div className="pr-comment-body markdown-body"><MarkdownDoc text={stripCursorMarkers(comment.body)} keyBase={`pr-comment-${comment.id}`} /></div>
                    </div>
                  </article>
                ))}
              </div>
              <section className="pr-review-form">
                <div>
                  <strong>Submit a review</strong>
                  <span className="muted">This posts directly to GitHub.</span>
                </div>
                <textarea rows={4} placeholder="Leave a thoughtful review…" value={reviewBody} onChange={(event) => setReviewBody(event.target.value)} />
                <div className="pr-review-actions">
                  <label className="pr-review-kind">
                    <span>Review type</span>
                    <select aria-label="Review type" value={reviewEvent} disabled={reviewBusy} onChange={(event) => {
                      setReviewEvent(event.target.value as typeof reviewEvent);
                      setConfirmWrite(false);
                    }}>
                      <option value="COMMENT">Comment</option>
                      <option value="APPROVE">Approve</option>
                      <option value="REQUEST_CHANGES">Request changes</option>
                    </select>
                  </label>
                  {reviewEvent !== "COMMENT" && <label className="source-confirm"><input type="checkbox" checked={confirmWrite} onChange={(event) => setConfirmWrite(event.target.checked)} /> Confirm {reviewEvent === "APPROVE" ? "approval" : "change request"}</label>}
                  <span className="header-spacer" />
                  <button className="primary-btn" disabled={reviewBusy || (!reviewBody.trim() && reviewEvent !== "APPROVE")} onClick={() => void submitReview()}>{reviewBusy ? "Submitting…" : "Submit review"}</button>
                </div>
                {writeMsg && <div className={writeMsg.startsWith("Submit failed") ? "form-error" : "knowledge-notice"} role="status">{writeMsg}</div>}
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
}
