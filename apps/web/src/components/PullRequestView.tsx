import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api, type ChecksSummaryDto, type PrCheckDto, type PrCommentDto,
  type PrDetailDto, type PrFileDto,
} from "../api.ts";
import { highlight, langOf } from "../highlight.ts";
import { getLocale, tr } from "../i18n/index.ts";
import { Icon } from "../icons.tsx";
import { MarkdownDoc } from "../markdown.tsx";
import { parsePrDiffLines, splitPrDiff } from "../prDiff.ts";
import { friendlyError } from "../settings.ts";
import { useStore } from "../store.ts";
import EmptyState from "./EmptyState.tsx";

type Tab = "overview" | "files" | "checks" | "comments";
type PrSection = "detail" | "files" | "diff" | "checks" | "comments";
type MessageTone = "error" | "warning" | "success";

/** Hide HTML comments and Cursor's agent footer without altering fenced examples. */
export function stripCursorMarkers(markdown: string): string {
  const stripOutsideFence = (text: string): string => text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<div\b[^>]*>[\s\S]*?<\/div>/gi, (block) =>
      /(?:cursor_ref=pr_footer|cursor\.com\/(?:agents|background-agent))/i.test(block) ? "" : block)
    .replace(/^\s*(?:(?:begin|end|start|stop)[_\s-]+cursor(?:[_\s:-].*)?|cursor(?:_[a-z0-9-]+)+)\s*$/gim, "");

  const output: string[] = [];
  let outside: string[] = [];
  let fence: { char: string; length: number } | null = null;
  const flushOutside = () => {
    if (outside.length > 0) output.push(stripOutsideFence(outside.join("\n")));
    outside = [];
  };
  for (const line of markdown.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fence && marker) {
      flushOutside();
      fence = { char: marker[0]!, length: marker.length };
      output.push(line);
    } else if (fence) {
      output.push(line);
      if (marker?.[0] === fence.char && marker.length >= fence.length) fence = null;
    } else {
      outside.push(line);
    }
  }
  flushOutside();
  return output.join("\n").trim();
}

export function reviewMessageTone(message: string): MessageTone {
  if (message.startsWith("Submit failed")) return "error";
  if (message.startsWith("Confirm ")) return "warning";
  return "success";
}

function ChecksRing({ summary }: { summary: ChecksSummaryDto }) {
  const passing = summary.counts.success ?? 0;
  const failing = (summary.counts.failure ?? 0) + (summary.counts.action_required ?? 0) + (summary.counts.timed_out ?? 0);
  const running = (summary.counts.queued ?? 0) + (summary.counts.in_progress ?? 0);
  const total = Math.max(1, summary.total);
  const segment = (count: number) => (count / total) * 360;
  const gradient = `conic-gradient(var(--red) 0deg ${segment(failing)}deg, var(--amber) ${segment(failing)}deg ${segment(failing + running)}deg, var(--green) ${segment(failing + running)}deg ${segment(failing + running + passing)}deg, var(--border) ${segment(failing + running + passing)}deg 360deg)`;
  return (
    <span
      className="checks-ring"
      role="img"
      aria-label={tr("pullrequestview.valueValueFailingValueRunningValuePassing", { headline: summary.headline, failed: failing, running: running, ok: passing, total: summary.total })}
      style={{ background: gradient }}
    />
  );
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
      {check.url && <a className="small-btn" href={check.url} target="_blank" rel="noreferrer">{tr("pullrequestview.viewLogs")}</a>}
    </article>
  );
}

function DiffLines({ diff, path }: { diff: string; path: string }) {
  return (
    <div className="git-diff pr-diff" role="table" aria-label={tr("pullrequestview.patchForValue", { path: path })}>
      {parsePrDiffLines(diff).map((row, index) => {
        const oldShown = row.oldLine === undefined ? "" : String(row.oldLine);
        const newShown = row.newLine === undefined ? "" : String(row.newLine);
        const className = row.kind === "hunk"
          ? "diff-hunk"
          : row.kind === "add"
            ? "diff-add"
            : row.kind === "delete"
              ? "diff-del"
              : row.kind === "context" ? "" : "diff-meta";
        const lineLabel = oldShown && newShown
          ? tr("pullrequestview.oldLineNewLineValue", { old: oldShown, new: newShown })
          : oldShown ? tr("pullrequestview.oldLineValue", { old: oldShown }) : newShown ? tr("pullrequestview.newLineValue", { new: newShown }) : tr("pullrequestview.diffMetadata");
        return (
          <div key={index} className={`git-diff-line ${className}`} role="row" aria-label={lineLabel}>
            <span className="pr-diff-ln" aria-hidden="true"><i>{oldShown}</i><i>{newShown}</i></span>
            <code role="cell" dangerouslySetInnerHTML={{ __html: highlight(row.text, langOf(path)) }} />
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
  const [writeTone, setWriteTone] = useState<MessageTone>("success");
  const [mergeStrategy, setMergeStrategy] = useState<"squash" | "merge" | "rebase">("squash");
  const [mergeConfirm, setMergeConfirm] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeMsg, setMergeMsg] = useState("");
  const [mergeFailed, setMergeFailed] = useState(false);
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
      setSectionErrors((current) => ({ ...current, checks: friendlyError(tr("pullrequestview.couldntLoadChecks"), cause) }));
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
          const message = friendlyError(tr("pullrequestview.couldntLoadPullRequestDetails"), cause);
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
          recordError("files", friendlyError(tr("pullrequestview.couldntLoadChangedFiles"), cause));
        }
      })(),
      (async () => {
        try {
          const result = await api.githubPrComments(projectId, number);
          if (!active) return;
          if (result.ok) setComments(result.data); else recordError("comments", result.reason);
        } catch (cause) {
          recordError("comments", friendlyError(tr("pullrequestview.couldntLoadComments"), cause));
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
          const message = friendlyError(tr("pullrequestview.couldntLoadThePullRequestPatch"), cause);
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

  // Merge stays disabled with the reason until GitHub reports MERGEABLE.
  const mergeBlock = !detail ? tr("common.loading")
    : detail.state !== "OPEN" ? tr("pullrequestview.pullRequestStateValue", { value: detail.state.toLowerCase() })
    : detail.isDraft ? tr("pullrequestview.draftCannotMerge")
    : detail.mergeable === "CONFLICTING" ? tr("pullrequestview.baseBranchConflicts")
    : detail.mergeable !== "MERGEABLE" ? tr("pullrequestview.mergeabilityUnknown")
    : null;

  const doMerge = async () => {
    if (mergeBlock || !mergeConfirm) return;
    setMergeBusy(true);
    setMergeMsg("");
    setMergeFailed(false);
    const result = await api.githubPrMerge({
      projectId,
      number,
      strategy: mergeStrategy,
      ...(sessionId ? { sessionId } : {}),
    }).catch((cause: unknown) => ({ ok: false as const, reason: cause instanceof Error ? cause.message : String(cause) }));
    setMergeBusy(false);
    setMergeConfirm(false);
    if (result.ok) {
      // remote merge via GitHub — distinct from a local `git merge`
      setMergeMsg(tr("pullrequestview.mergedViaGithub", { strategy: mergeStrategy }));
      reloadDetail();
    } else {
      setMergeFailed(true);
      setMergeMsg(tr("pullrequestview.mergeFailedValue", { reason: result.reason }));
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
      setMergeFailed(true);
      setMergeMsg(tr("pullrequestview.updateFailedValue", { reason: result.reason }));
    }
  };

  const submitReview = async () => {
    if (reviewBusy) return;
    setWriteMsg("");
    setWriteTone("success");
    const needsConfirm = reviewEvent !== "COMMENT";
    if (needsConfirm && !confirmWrite) {
      setWriteTone("warning");
      setWriteMsg(tr("pullrequestview.confirmReviewAction"));
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
      setWriteTone("success");
      setWriteMsg(tr("pullrequestview.reviewSubmittedValue", {
        event: reviewEvent.toLowerCase().replaceAll("_", " "),
      }));
      setReviewBody("");
      setConfirmWrite(false);
      void api.githubPrComments(projectId, number).then((next) => { if (next.ok) setComments(next.data); });
    } else {
      setWriteTone("error");
      setWriteMsg(tr("pullrequestview.submitFailedValue", { reason: result.reason }));
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
      <div className="pr-surface" aria-busy="true" aria-label={tr("pullrequestview.loadingPullRequest")}>
        <div className="source-skeleton skeleton-title" />
        <div className="source-skeleton skeleton-tabs" />
        <div className="source-skeleton skeleton-panel" />
      </div>
    );
  }

  return (
    <div className="pr-surface">
      <header className="pr-head">
        <button className="small-btn pr-back" onClick={onClose}><Icon.back /> {tr("pullrequestview.pullRequests")}</button>
        {detail && (
          <div className="pr-title-block">
            <div className="pr-title-meta">
              <span className={`gh-state ${detail.state.toLowerCase()}${detail.isDraft ? " draft" : ""}`}>{detail.isDraft ? tr("pullrequestview.draft") : detail.state.toLowerCase()}</span>
              <span className="gh-number mono">#{detail.number}</span>
            </div>
            <h1><a href={detail.url} target="_blank" rel="noreferrer">{detail.title} <Icon.external /><span className="sr-only">{tr("pullrequestview.opensOnGithub")}</span></a></h1>
            <span className="muted">{detail.author} {tr("pullrequestview.wantsToMerge")} <span className="mono">{detail.headRefName}</span> {tr("pullrequestview.into")} <span className="mono">{detail.baseRefName}</span></span>
          </div>
        )}
        {checks && <div className="pr-check-pill"><ChecksRing summary={checks.summary} /><span className={`checks-headline hl-${checks.summary.state}`}>{checks.summary.headline}</span></div>}
      </header>

      {reason && !detail && <EmptyState title={tr("pullrequestview.couldnTLoadPullRequest")} description={reason} actionLabel={tr("common.retry")} onAction={() => setReloadKey((key) => key + 1)} />}

      {detail && (
        <>
          <nav className="pr-tabbar" aria-label={tr("pullrequestview.pullRequestSections")}>
            {([
              ["overview", tr("pullrequestview.overview"), null],
              ["files", tr("pullrequestview.filesTab"), detail.changedFiles],
              ["checks", tr("pullrequestview.checksTab"), checks?.summary.total ?? 0],
              ["comments", tr("pullrequestview.commentsTab"), comments.length],
            ] as const).map(([id, label, count]) => (
              <button key={id} className={tab === id ? "active" : ""} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>
                {label}{count !== null && <span>{count}</span>}
              </button>
            ))}
          </nav>

          {tab === "overview" && (
            <div className="pr-overview">
              <section className="pr-summary-cards">
                <div><span>{tr("pullrequestview.changedFiles")}</span><strong>{detail.changedFiles}</strong></div>
                <div><span>{tr("pullrequestview.linesAdded")}</span><strong className="positive">+{detail.additions}</strong></div>
                <div><span>{tr("pullrequestview.linesRemoved")}</span><strong className="negative">−{detail.deletions}</strong></div>
                <div>
                  <span>{tr("pullrequestview.mergeStatus")}</span>
                  <strong className={`merge-status-badge st-${detail.mergeable.toLowerCase()}`}>
                    {detail.mergeable === "MERGEABLE" ? tr("pullrequestview.ready") : detail.mergeable === "CONFLICTING" ? tr("pullrequestview.conflicts") : tr("pullrequestview.checking")}
                  </strong>
                </div>
              </section>
              <div className="pr-overview-head">
                <div>
                  <h2>{tr("pullrequestview.descriptionHeading")}</h2>
                  <span className="muted">{tr("pullrequestview.updatedValue", { date: new Date(detail.updatedAt).toLocaleString(getLocale()) })}</span>
                </div>
                {detail.state === "OPEN" && !editing && <button className="small-btn" onClick={() => {
                  setEditTitle(detail.title);
                  setEditBody(detail.body);
                  setEditing(true);
                }}><Icon.pencil /> {tr("common.edit")}</button>}
              </div>

              {editing ? (
                <div className="pr-edit-form">
                  <label>{tr("pullrequestview.titleLabel")}<input value={editTitle} placeholder={tr("pullrequestview.title")} onChange={(event) => setEditTitle(event.target.value)} /></label>
                  <label>{tr("pullrequestview.descriptionHeading")}<textarea rows={7} placeholder={tr("pullrequestview.description")} value={editBody} onChange={(event) => setEditBody(event.target.value)} /></label>
                  <div className="view-toolbar-row">
                    <span className="header-spacer" />
                    <button className="small-btn" disabled={editBusy} onClick={() => setEditing(false)}>{tr("common.cancel")}</button>
                    <button className="primary-btn" disabled={editBusy || !editTitle.trim()} onClick={() => void saveEdit()}>{editBusy ? tr("common.saving") : tr("pullrequestview.saveChanges")}</button>
                  </div>
                </div>
              ) : (
                <div className="pr-body markdown-body">
                  {detail.body ? <MarkdownDoc text={stripCursorMarkers(detail.body)} keyBase={`pr-${detail.number}-body`} /> : <p>{tr("pullrequestview.noDescriptionWasProvided")}</p>}
                </div>
              )}

              {detail.state === "OPEN" && (
                <section className="pr-merge-area">
                  <div>
                    <strong>{tr("pullrequestview.mergePullRequest")}</strong>
                    <span className="muted">{mergeBlock ? tr("pullrequestview.unavailableValue", { reason: mergeBlock }) : tr("pullrequestview.thisUpdatesTheRepositoryOnGithub")}</span>
                  </div>
                  <div className="pr-merge-controls">
                    <select value={mergeStrategy} disabled={!!mergeBlock || mergeBusy} aria-label={tr("pullrequestview.mergeStrategy")} onChange={(event) => setMergeStrategy(event.target.value as typeof mergeStrategy)}>
                      <option value="squash">{tr("pullrequestview.squashAndMerge")}</option>
                      <option value="merge">{tr("pullrequestview.createMergeCommit")}</option>
                      <option value="rebase">{tr("pullrequestview.rebaseAndMerge")}</option>
                    </select>
                    {!mergeBlock && <label className="source-confirm"><input type="checkbox" checked={mergeConfirm} onChange={(event) => setMergeConfirm(event.target.checked)} /> {tr("pullrequestview.iConfirmThisMerge")}</label>}
                    <button className="primary-btn" disabled={!!mergeBlock || !mergeConfirm || mergeBusy} title={mergeBlock ?? tr("pullrequestview.mergeNumberValue", { number: number })} onClick={() => void doMerge()}>
                      {mergeBusy ? tr("pullrequestview.merging") : tr("pullrequestview.mergePullRequest")}
                    </button>
                  </div>
                </section>
              )}
              {mergeMsg && <div className={mergeFailed ? "form-error" : "knowledge-notice"} role="status">{mergeMsg}</div>}
            </div>
          )}

          {tab === "files" && (
            <div className="pr-files">
              <div className="pr-files-toolbar">
                <div>
                  <strong>{detail.changedFiles === 1 ? tr("pullrequestview.oneChangedFile") : tr("pullrequestview.changedFilesValue", { count: detail.changedFiles })}</strong>
                  <span><span className="positive">+{detail.additions}</span> <span className="negative">−{detail.deletions}</span></span>
                </div>
                <span className="header-spacer" />
                <button className="small-btn" disabled={diffFiles.length === 0} onClick={() => setExpandedFiles(new Set(diffFiles.map((file) => file.path)))}>{tr("pullrequestview.expandAll")}</button>
                <button className="small-btn" disabled={expandedFiles.size === 0} onClick={() => setExpandedFiles(new Set())}>{tr("pullrequestview.collapseAll")}</button>
              </div>
              {sectionErrors.files && (
                <div className="source-inline-status error" role="alert">
                  <span>{tr("pullrequestview.changedFileMetadataCouldNotBe", { reason: sectionErrors.files })}</span>
                  <button className="small-btn" onClick={() => setReloadKey((key) => key + 1)}>{tr("common.retry")}</button>
                </div>
              )}
              {diffReason && (
                <div className="source-inline-status error" role="alert">
                  <span>{tr("pullrequestview.thePatchCouldNotBeLoaded", { reason: diffReason })}</span>
                  <button className="small-btn" onClick={() => setReloadKey((key) => key + 1)}>{tr("common.retry")}</button>
                </div>
              )}
              {files.length === 0 && diffFiles.length === 0 && <EmptyState title={tr("pullrequestview.noChangedFiles")} description={tr("pullrequestview.noFileListIsAvailableForThis")} />}
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
                  <span>{tr("pullrequestview.checksCouldNotBeLoaded", { reason: sectionErrors.checks })}</span>
                  <button className="small-btn" onClick={() => void loadChecks()}>{tr("common.retry")}</button>
                </div>
              )}
              {checks && checks.summary.total > 0 && (
                <section className="check-summary-cards">
                  <div className="success"><span>{tr("pullrequestview.passing")}</span><strong>{passing}</strong></div>
                  <div className="failure"><span>{tr("pullrequestview.failing")}</span><strong>{failing}</strong></div>
                  <div className="pending"><span>{tr("pullrequestview.inProgress")}</span><strong>{pending}</strong></div>
                  <div><span>{tr("pullrequestview.total")}</span><strong>{checks.summary.total}</strong></div>
                </section>
              )}
              {checks && checks.summary.total === 0 && <EmptyState title={tr("pullrequestview.noChecks")} description={tr("pullrequestview.noChecksWereReportedForThisCommit")} />}
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
                  <span>{tr("pullrequestview.conversationCouldNotBeLoaded", { reason: sectionErrors.comments })}</span>
                  <button className="small-btn" onClick={() => setReloadKey((key) => key + 1)}>{tr("common.retry")}</button>
                </div>
              )}
              {!sectionErrors.comments && comments.length === 0 && <EmptyState title={tr("pullrequestview.noConversationYet")} description={tr("pullrequestview.reviewsAndCommentsWillAppearHere")} />}
              <div className="pr-thread">
                {comments.map((comment) => (
                  <article key={comment.id} className="pr-comment">
                    <span className="pr-comment-avatar" aria-hidden="true">{initials(comment.author)}</span>
                    <div className="pr-comment-card">
                      <header className="pr-comment-head">
                        <strong>{comment.author}</strong>
                        {comment.reviewState && <span className="tag">{comment.reviewState.toLowerCase().replace(/_/g, " ")}</span>}
                        {comment.outdated && <span className="tag">{tr("pullrequestview.outdated")}</span>}
                        <a href={comment.url} target="_blank" rel="noreferrer" className="muted">{comment.createdAt ? new Date(comment.createdAt).toLocaleString(getLocale()) : ""}</a>
                      </header>
                      {comment.path && <div className="pr-comment-location mono">{comment.path}{comment.line ? `:${comment.line}` : ""}</div>}
                      <div className="pr-comment-body markdown-body"><MarkdownDoc text={stripCursorMarkers(comment.body)} keyBase={`pr-comment-${comment.id}`} /></div>
                    </div>
                  </article>
                ))}
              </div>
              <section className="pr-review-form">
                <div>
                  <strong>{tr("pullrequestview.submitAReview")}</strong>
                  <span className="muted">{tr("pullrequestview.thisPostsDirectlyToGithub")}</span>
                </div>
                <textarea rows={4} placeholder={tr("pullrequestview.leaveAThoughtfulReview")} value={reviewBody} onChange={(event) => setReviewBody(event.target.value)} />
                <div className="pr-review-actions">
                  <label className="pr-review-kind">
                    <span>{tr("pullrequestview.reviewType")}</span>
                    <select aria-label={tr("pullrequestview.reviewType")} value={reviewEvent} disabled={reviewBusy} onChange={(event) => {
                      setReviewEvent(event.target.value as typeof reviewEvent);
                      setConfirmWrite(false);
                    }}>
                      <option value="COMMENT">{tr("pullrequestview.comment")}</option>
                      <option value="APPROVE">{tr("pullrequestview.approve")}</option>
                      <option value="REQUEST_CHANGES">{tr("pullrequestview.requestChanges")}</option>
                    </select>
                  </label>
                  {reviewEvent !== "COMMENT" && <label className="source-confirm"><input type="checkbox" checked={confirmWrite} onChange={(event) => setConfirmWrite(event.target.checked)} /> {tr("pullrequestview.confirmValue", { value: reviewEvent === "APPROVE" ? tr("pullrequestview.approval") : tr("pullrequestview.changeRequest") })}</label>}
                  <span className="header-spacer" />
                  <button className="primary-btn" disabled={reviewBusy || (!reviewBody.trim() && reviewEvent !== "APPROVE")} onClick={() => void submitReview()}>{reviewBusy ? tr("pullrequestview.submitting") : tr("pullrequestview.submitReview")}</button>
                </div>
                {writeMsg && (
                  <div
                    className={writeTone === "error" ? "form-error" : writeTone === "warning" ? "form-warning" : "knowledge-notice"}
                    role={writeTone === "success" ? "status" : "alert"}
                  >
                    {writeMsg}
                  </div>
                )}
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
}
