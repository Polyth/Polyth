import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react";
import type { PrCheck } from "@polyth/contracts";
import type { ChecksSummary } from "@polyth/code-hosting/checks";
import type { ChangeRequestComment, ChangeRequestDetail, ChangeRequestFile } from "@polyth/code-hosting";
import type { HostingStatus } from "@polyth/code-hosting";
import { parsePrDiffLines, splitPrDiff } from "@polyth/git/diff";
import { supportedMergeStrategies, supportedReviewEvents, useCodeHosting, useCodeHostingStore } from "./context.tsx";
import ReplyPanel from "./ReplyPanel.tsx";

type Translator = (key: string, values?: Record<string, string | number>) => string;

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

function ChecksRing({ summary, t }: { summary: ChecksSummary; t: Translator }) {
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
      aria-label={t("pullrequestview.valueValueFailingValueRunningValuePassing", { headline: summary.headline, failed: failing, running: running, ok: passing, total: summary.total })}
      style={{ background: gradient }}
    />
  );
}

function CheckRow({ check, t }: { check: PrCheck; t: Translator }) {
  return (
    <article className="check-row">
      <span className={`check-dot st-${check.status}`} />
      <div className="check-copy">
        <strong className="check-name">{check.name}</strong>
        {check.workflow && <span className="muted">{check.workflow}</span>}
      </div>
      <span className="check-status">{check.status.replace(/_/g, " ")}</span>
      {check.url && <a className="ui-btn ui-btn--quiet ui-btn--sm" href={check.url} target="_blank" rel="noreferrer">{t("pullrequestview.viewLogs")}</a>}
    </article>
  );
}

function DiffLines({ diff, path, t }: { diff: string; path: string; t: Translator }) {
  const { host } = useCodeHosting();
  return (
    <div className="git-diff pr-diff" role="table" aria-label={t("pullrequestview.patchForValue", { path: path })}>
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
          ? t("pullrequestview.oldLineNewLineValue", { old: oldShown, new: newShown })
          : oldShown ? t("pullrequestview.oldLineValue", { old: oldShown }) : newShown ? t("pullrequestview.newLineValue", { new: newShown }) : t("pullrequestview.diffMetadata");
        return (
          <div key={index} className={`git-diff-line pr-diff-line ${className}`} role="row" aria-label={lineLabel}>
            <span className="pr-diff-ln" aria-hidden="true"><i>{oldShown}</i><i>{newShown}</i></span>
            <code role="cell" dangerouslySetInnerHTML={{ __html: host.ui.syntax.highlight(row.text, host.ui.syntax.languageForPath(path)) }} />
          </div>
        );
      })}
    </div>
  );
}

const initials = (name: string): string => name.split(/[\s-]+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";

export default function ChangeRequestView(props: { number: number; onClose: () => void }) {
  const { provider } = useCodeHosting();
  const projectId = useCodeHostingStore().activeProjectId;
  return <ChangeRequestDetailView key={`${provider.id}:${provider.apiBase}:${projectId}:${props.number}`} {...props} />;
}

function ChangeRequestDetailView({ number, onClose }: { number: number; onClose: () => void }) {
  const { client, host, provider } = useCodeHosting();
  const { Button, Checkbox, Select, Tabs, Textarea, TextInput, EmptyState, MarkdownDoc } = host.ui.components;
  const Icon = host.ui.icons;
  const t = provider.t;
  const getLocale = host.ui.locale.get;
  const friendlyError = host.errors.friendly;
  const snapshot = useCodeHostingStore();
  const projectId = snapshot.activeProjectId;
  const sessionId = snapshot.activeSessionId;
  const settings = snapshot.settings;
  const [tab, setTab] = useState<Tab>("overview");
  const [detail, setDetail] = useState<ChangeRequestDetail | null>(null);
  const [files, setFiles] = useState<ChangeRequestFile[]>([]);
  const [rawDiff, setRawDiff] = useState("");
  const [diffReason, setDiffReason] = useState("");
  const [expandedFiles, setExpandedFiles] = useState<ReadonlySet<string>>(new Set());
  const [checks, setChecks] = useState<{ checks: PrCheck[]; summary: ChecksSummary } | null>(null);
  const [comments, setComments] = useState<ChangeRequestComment[]>([]);
  const [discussions, setDiscussions] = useState<Array<{ id: string; resolved: boolean; resolvable: boolean; comments: ChangeRequestComment[] }>>([]);
  const [discussionDrafts, setDiscussionDrafts] = useState<Record<string, string>>({});
  const [discussionBusy, setDiscussionBusy] = useState<string | null>(null);
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
  const [conflictAgentBusy, setConflictAgentBusy] = useState(false);
  const [conflictAgentMsg, setConflictAgentMsg] = useState("");
  const [conflictAgentFailed, setConflictAgentFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editBase, setEditBase] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [lineComment, setLineComment] = useState({ path: "", line: "", side: "RIGHT" as "LEFT" | "RIGHT", body: "" });
  const [providerActionBusy, setProviderActionBusy] = useState<"ready" | "unapprove" | null>(null);
  const [status, setStatus] = useState<HostingStatus | null>(null);

  const loadChecks = useCallback(async () => {
    if (!projectId) return Promise.resolve();
    try {
      const result = await client.checks(projectId, number);
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
      setSectionErrors((current) => ({ ...current, checks: friendlyError(t("pullrequestview.couldntLoadChecks"), cause) }));
    }
  }, [client, projectId, number]);

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
      (async () => { try { const nextStatus = await client.status(projectId); if (active) setStatus(nextStatus); } catch { /* Detail remains usable when status is unavailable. */ } })(),
      (async () => {
        try {
          const result = await client.change(projectId, number);
          if (!active) return;
          if (result.ok) setDetail(result.data);
          else {
            setReason(result.reason);
            recordError("detail", result.reason);
          }
        } catch (cause) {
          const message = friendlyError(t("pullrequestview.couldntLoadPullRequestDetails"), cause);
          if (active) setReason(message);
          recordError("detail", message);
        }
      })(),
      (async () => {
        try {
          const result = await client.changeFiles(projectId, number);
          if (!active) return;
          if (result.ok) setFiles(result.data); else recordError("files", result.reason);
        } catch (cause) {
          recordError("files", friendlyError(t("pullrequestview.couldntLoadChangedFiles"), cause));
        }
      })(),
      (async () => {
        try {
          const result = await client.changeComments(projectId, number);
          if (!active) return;
          if (result.ok) setComments(result.data); else recordError("comments", result.reason);
        } catch (cause) {
          recordError("comments", friendlyError(t("pullrequestview.couldntLoadComments"), cause));
        }
      })(),
      (async () => {
        try {
          const result = await client.changeDiff(projectId, number);
          if (!active) return;
          if (result.ok) setRawDiff(result.data);
          else {
            setDiffReason(result.reason);
            recordError("diff", result.reason);
          }
        } catch (cause) {
          const message = friendlyError(t("pullrequestview.couldntLoadThePullRequestPatch"), cause);
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

  useEffect(() => {
    if (!projectId || !status?.capabilities?.discussions) return;
    let active = true;
    void client.discussions(projectId, number).then(result => {
      if (active && result.ok) setDiscussions(result.data);
      else if (active && !result.ok) setSectionErrors(current => ({ ...current, comments: result.reason }));
    }).catch(cause => { if (active) setSectionErrors(current => ({ ...current, comments: friendlyError(t("pullrequestview.couldntLoadComments"), cause) })); });
    return () => { active = false; };
  }, [client, number, projectId, status?.capabilities?.discussions]);

  const diffFiles = useMemo(() => splitPrDiff(rawDiff), [rawDiff]);
  const fileStats = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);

  useEffect(() => {
    if (diffFiles[0]) setExpandedFiles(new Set([diffFiles[0].path]));
  }, [rawDiff]);

  if (!projectId) return null;

  const reloadDetail = () => {
    void client.change(projectId, number).then(result => { if (result.ok) setDetail(result.data); else setReason(result.reason); }).catch(cause => setReason(friendlyError(t("pullrequestview.couldntLoadPullRequestDetails"), cause)));
  };

  // Merge stays disabled with the reason until GitHub reports MERGEABLE.
  const mergeBlock = !detail ? t("common.loading")
    : detail.state !== "OPEN" ? t("pullrequestview.pullRequestStateValue", { value: detail.state.toLowerCase() })
    : detail.isDraft ? t("pullrequestview.draftCannotMerge")
    : detail.mergeable === "CONFLICTING" ? t("pullrequestview.baseBranchConflicts")
    : detail.mergeable !== "MERGEABLE" ? t("pullrequestview.mergeabilityUnknown")
    : null;

  const doMerge = async () => {
    if (mergeBlock || !mergeConfirm) return;
    setMergeBusy(true);
    setMergeMsg("");
    setMergeFailed(false);
    const result = await client.merge({
      projectId,
      number,
      strategy: mergeStrategy,
      ...(detail?.headRefOid ? { headSha: detail.headRefOid } : {}),
      ...(sessionId ? { sessionId } : {}),
    }).catch((cause: unknown) => ({ ok: false as const, reason: cause instanceof Error ? cause.message : String(cause) }));
    setMergeBusy(false);
    setMergeConfirm(false);
    if (result.ok) {
      // remote merge via GitHub — distinct from a local `git merge`
      setMergeMsg(t("pullrequestview.mergedViaGithub", { strategy: mergeStrategy }));
      reloadDetail();
    } else {
      setMergeFailed(true);
      setMergeMsg(t("pullrequestview.mergeFailedValue", { reason: result.reason }));
    }
  };

  const startConflictAgent = async () => {
    if (conflictAgentBusy) return;
    if (settings.conflictAgentTarget === "current-session" && !sessionId) {
      setConflictAgentFailed(true);
      setConflictAgentMsg(t("pullrequestview.conflictAgentNeedsCurrentSession"));
      return;
    }
    setConflictAgentBusy(true);
    setConflictAgentMsg("");
    setConflictAgentFailed(false);
    try {
      const result = await client.conflictAgent({
        projectId,
        number,
        prompt: String(settings.conflictAgentPrompt ?? ""),
        target: settings.conflictAgentTarget === "current-session" ? "current-session" : "new-session",
        ...(settings.conflictAgentTarget === "current-session" && sessionId ? { sessionId } : {}),
      });
      if (!result.ok) {
        setConflictAgentFailed(true);
        setConflictAgentMsg(result.reason);
        return;
      }
      if (
        settings.conflictAgentTarget === "new-session"
        || result.data.sessionId !== sessionId
      ) {
        await host.conversation.openSession(result.data.sessionId);
      }
      setConflictAgentMsg(t("pullrequestview.conflictAgentStarted"));
    } catch (cause) {
      setConflictAgentFailed(true);
      setConflictAgentMsg(friendlyError(t("pullrequestview.conflictAgentFailed"), cause));
    } finally {
      setConflictAgentBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!detail) return;
    if (editTitle.trim() === detail.title && editBody === detail.body && editBase === detail.baseRefName) {
      setEditing(false);
      return;
    }
    setEditBusy(true);
    const result = await client.update({
      projectId,
      number,
      ...(editTitle.trim() !== detail.title ? { title: editTitle.trim() } : {}),
      ...(editBody !== detail.body ? { body: editBody } : {}),
      ...(editBase !== detail.baseRefName ? { base: editBase } : {}),
      ...(sessionId ? { sessionId } : {}),
    }).catch((cause: unknown) => ({ ok: false as const, reason: cause instanceof Error ? cause.message : String(cause) }));
    setEditBusy(false);
    if (result.ok) {
      setEditing(false);
      reloadDetail();
    } else {
      setMergeFailed(true);
      setMergeMsg(t("pullrequestview.updateFailedValue", { reason: result.reason }));
    }
  };

  const submitReview = async () => {
    if (reviewBusy) return;
    setWriteMsg("");
    setWriteTone("success");
    const needsConfirm = reviewEvent !== "COMMENT";
    if (needsConfirm && !confirmWrite) {
      setWriteTone("warning");
      setWriteMsg(t("pullrequestview.confirmReviewAction"));
      return;
    }
    setReviewBusy(true);
    const result = await client.submitReview({
      number,
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
      setWriteMsg(t("pullrequestview.reviewSubmittedValue", {
        event: reviewEvent.toLowerCase().replaceAll("_", " "),
      }));
      setReviewBody("");
      setConfirmWrite(false);
      void client.changeComments(projectId, number).then((next) => { if (next.ok) setComments(next.data); });
    } else {
      setWriteTone("error");
      setWriteMsg(t("pullrequestview.submitFailedValue", { reason: result.reason }));
    }
  };

  const submitLineComment = async () => {
    const line = Number(lineComment.line);
    if (reviewBusy || !lineComment.path || !Number.isInteger(line) || line < 1 || !lineComment.body.trim()) return;
    setReviewBusy(true); setWriteMsg("");
    const result = await client.submitReview({ projectId, number, event: "COMMENT", body: "", comments: [{ path: lineComment.path, line, side: lineComment.side, body: lineComment.body.trim() }], ...(detail?.headRefOid ? { commitSha: detail.headRefOid } : {}), ...(sessionId ? { sessionId } : {}) }).catch((cause: unknown) => ({ ok: false as const, reason: cause instanceof Error ? cause.message : String(cause) }));
    setReviewBusy(false);
    if (result.ok) { setLineComment({ path: "", line: "", side: "RIGHT", body: "" }); void client.changeComments(projectId, number).then((next) => { if (next.ok) setComments(next.data); }); }
    else { setWriteTone("error"); setWriteMsg(result.reason); }
  };

  const providerAction = async (action: "ready" | "unapprove") => {
    if (providerActionBusy) return;
    setProviderActionBusy(action);
    setMergeMsg(""); setMergeFailed(false);
    const result = await (action === "ready"
      ? client.ready({ projectId, number })
      : client.unapprove({ projectId, number })
    ).catch((cause: unknown) => ({ ok: false as const, reason: cause instanceof Error ? cause.message : String(cause) }));
    setProviderActionBusy(null);
    if (result.ok) reloadDetail();
    else { setMergeFailed(true); setMergeMsg(result.reason); }
  };

  const reloadDiscussions = async () => {
    try {
      const result = await client.discussions(projectId, number);
      if (result.ok) setDiscussions(result.data);
      else setSectionErrors(current => ({ ...current, comments: result.reason }));
    } catch (cause) { setSectionErrors(current => ({ ...current, comments: friendlyError(t("pullrequestview.couldntLoadComments"), cause) })); }
  };
  const replyToDiscussion = async (discussionId: string) => {
    const body = discussionDrafts[discussionId]?.trim();
    if (!body || discussionBusy) return;
    setDiscussionBusy(discussionId);
    const result = await client.reply({ projectId, number, discussionId, body }).catch((cause: unknown) => ({ ok: false as const, reason: cause instanceof Error ? cause.message : String(cause) }));
    setDiscussionBusy(null);
    if (result.ok) { setDiscussionDrafts((drafts) => ({ ...drafts, [discussionId]: "" })); void reloadDiscussions(); }
    else { setWriteTone("error"); setWriteMsg(result.reason); }
  };
  const setDiscussionResolved = async (discussionId: string, resolved: boolean) => {
    if (discussionBusy) return;
    setDiscussionBusy(discussionId);
    const result = await client.resolve({ projectId, number, discussionId, resolved }).catch((cause: unknown) => ({ ok: false as const, reason: cause instanceof Error ? cause.message : String(cause) }));
    setDiscussionBusy(null);
    if (result.ok) void reloadDiscussions(); else { setWriteTone("error"); setWriteMsg(result.reason); }
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
  const agentContext = detail ? `${provider.presentation.changeLabel} ${provider.presentation.changeNumberPrefix}${detail.number}: ${detail.title}\n${detail.url}\n${detail.headRefName} → ${detail.baseRefName} (head ${detail.headRefOid})\nInspect the repository and this request. Do not push or merge without explicit approval.` : "";
  const mergeStrategies = supportedMergeStrategies(status);
  const reviewEvents = supportedReviewEvents(status);

  if (loading && !detail) {
    return (
      <div className="pr-surface" aria-busy="true" aria-label={t("pullrequestview.loadingPullRequest")}>
        <div className="source-skeleton skeleton-title" />
        <div className="source-skeleton skeleton-tabs" />
        <div className="source-skeleton skeleton-panel" />
      </div>
    );
  }

  return (
    <div className="pr-surface">
      <header className="pr-head">
        <Button size="sm" className="pr-back" iconStart={undefined} onClick={onClose}>{t("pullrequestview.pullRequests")}</Button>
        {detail && (
          <div className="pr-title-block">
            <div className="pr-title-meta">
              <span className={`gh-state ${detail.state.toLowerCase()}${detail.isDraft ? " draft" : ""}`}>{detail.isDraft ? t("pullrequestview.draft") : detail.state.toLowerCase()}</span>
              <span className="gh-number mono">{provider.presentation.changeNumberPrefix}{detail.number}</span>
            </div>
            <h1><a href={detail.url} target="_blank" rel="noreferrer">{detail.title} {Icon.external?.()}<span className="sr-only">{t("pullrequestview.opensOnGithub")}</span></a></h1>
            <span className="muted">{detail.author} {t("pullrequestview.wantsToMerge")} <span className="mono">{detail.headRefName}</span> {t("pullrequestview.into")} <span className="mono">{detail.baseRefName}</span></span>
          </div>
        )}
        {checks && <div className="pr-check-pill"><ChecksRing summary={checks.summary} t={t} /><span className={`checks-headline hl-${checks.summary.state}`}>{checks.summary.headline}</span></div>}
      </header>

      {detail && <div className="pr-review-actions">
        <Button size="sm" onClick={() => host.conversation.insert(`Review ${agentContext}`)}>{t("hosting.askAgent")}</Button>
        <Button size="sm" onClick={() => host.conversation.startNewSession(projectId, { title: `${provider.presentation.changeLabel} ${detail.number}: ${detail.title}`.slice(0, 80), draft: agentContext })}>{t("githubview.newSession")}</Button>
      </div>}
      {reason && !detail && <EmptyState title={t("pullrequestview.couldnTLoadPullRequest")} description={reason} actionLabel={t("common.retry")} onAction={() => setReloadKey((key) => key + 1)} />}

      {detail && (
        <>
          <Tabs
            className="pr-tabbar ui-scroll-tabs"
            label={t("pullrequestview.pullRequestSections")}
            value={tab}
            tabs={([
              ["overview", t("pullrequestview.overview"), null],
              ["files", t("pullrequestview.filesTab"), detail.changedFiles],
              ["checks", t("pullrequestview.checksTab"), checks?.summary.total ?? 0],
              ["comments", t("pullrequestview.commentsTab"), comments.length],
            ] as const).map(([id, label, count]) => ({
              id,
              label: <>{label}{count !== null && <span>{count}</span>}</>,
            }))}
            onChange={(value: string) => setTab(value as Tab)}
          />

          {tab === "overview" && (
            <div className="pr-overview">
              <section className="pr-summary-cards">
                <div><span>{t("pullrequestview.changedFiles")}</span><strong>{detail.changedFiles}</strong></div>
                <div><span>{t("pullrequestview.linesAdded")}</span><strong className="positive">+{detail.additions}</strong></div>
                <div><span>{t("pullrequestview.linesRemoved")}</span><strong className="negative">−{detail.deletions}</strong></div>
                <div>
                  <span>{t("pullrequestview.mergeStatus")}</span>
                  <strong className={`merge-status-badge st-${detail.mergeable.toLowerCase()}`}>
                    {detail.mergeable === "MERGEABLE" ? t("pullrequestview.ready") : detail.mergeable === "CONFLICTING" ? t("pullrequestview.conflicts") : t("pullrequestview.checking")}
                  </strong>
                </div>
              </section>
              <div className="pr-overview-head">
                <div>
                  <h2>{t("pullrequestview.descriptionHeading")}</h2>
                  <span className="muted">{t("pullrequestview.updatedValue", { date: new Date(detail.updatedAt).toLocaleString(getLocale()) })}</span>
                </div>
                {detail.state === "OPEN" && !editing && <Button size="sm" iconStart={undefined} onClick={() => {
                  setEditTitle(detail.title);
                  setEditBody(detail.body);
                  setEditBase(detail.baseRefName);
                  setEditing(true);
                }}>{t("common.edit")}</Button>}
              </div>

              {editing ? (
                <div className="pr-edit-form">
                  <label>{t("pullrequestview.titleLabel")}<TextInput value={editTitle} placeholder={t("pullrequestview.title")} onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setEditTitle(event.target.value)} /></label>
                  <label>{t("prcreatepanel.baseBranch")}<TextInput value={editBase} onChange={(event: ChangeEvent<HTMLInputElement>) => setEditBase(event.target.value)} /></label>
                  <label>{t("pullrequestview.descriptionHeading")}<Textarea rows={7} placeholder={t("pullrequestview.description")} value={editBody} onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setEditBody(event.target.value)} /></label>
                  <div className="view-toolbar-row">
                    <span className="header-spacer" />
                    <Button size="sm" disabled={editBusy} onClick={() => setEditing(false)}>{t("common.cancel")}</Button>
                    <Button size="sm" variant="primary" busy={editBusy} disabled={!editTitle.trim()} onClick={() => void saveEdit()}>{editBusy ? t("common.saving") : t("pullrequestview.saveChanges")}</Button>
                  </div>
                </div>
              ) : (
                <div className="pr-body markdown-body">
                  {detail.body ? <MarkdownDoc text={stripCursorMarkers(detail.body)} keyBase={`pr-${detail.number}-body`} /> : <p>{t("pullrequestview.noDescriptionWasProvided")}</p>}
                </div>
              )}

              {detail.state === "OPEN" && detail.mergeable === "CONFLICTING" && (
                <section className="pr-conflict-agent-area">
                  <div>
                    <strong>{t("pullrequestview.fixConflictsWithAgent")}</strong>
                    <span className="muted">
                      {t("settings.pages.conflictAgentTarget")}:{" "}
                      {settings.conflictAgentTarget === "new-session"
                        ? t("settings.pages.newSession")
                        : t("settings.pages.currentSession")}
                    </span>
                  </div>
                  <Button
                    variant="primary"
                    busy={conflictAgentBusy}
                    iconStart={undefined}
                    onClick={() => void startConflictAgent()}
                  >
                    {t("pullrequestview.fixConflictsWithAgent")}
                  </Button>
                  {conflictAgentMsg && (
                    <div
                      className={conflictAgentFailed ? "form-error" : "form-success"}
                      role={conflictAgentFailed ? "alert" : "status"}
                    >
                      {conflictAgentMsg}
                    </div>
                  )}
                </section>
              )}

              {detail.state === "OPEN" && (
                <section className="pr-merge-area">
                  <div>
                    <strong>{t("pullrequestview.mergePullRequest")}</strong>
                    <span className="muted">{mergeBlock ? t("pullrequestview.unavailableValue", { reason: mergeBlock }) : t("pullrequestview.thisUpdatesTheRepositoryOnGithub")}</span>
                  </div>
                  <div className="pr-merge-controls">
                    {status?.capabilities?.ready && detail.isDraft && <Button size="sm" busy={providerActionBusy === "ready"} onClick={() => void providerAction("ready")}>{t("hosting.ready")}</Button>}
                    {status?.capabilities?.unapprove && <Button size="sm" busy={providerActionBusy === "unapprove"} onClick={() => void providerAction("unapprove")}>{t("hosting.unapprove")}</Button>}
                    <Select
                      value={mergeStrategy}
                      label={mergeStrategy === "squash" ? t("pullrequestview.squashAndMerge") : mergeStrategy === "merge" ? t("pullrequestview.createMergeCommit") : t("pullrequestview.rebaseAndMerge")}
                      disabled={!!mergeBlock || mergeBusy}
                      ariaLabel={t("pullrequestview.mergeStrategy")}
                      options={mergeStrategies.map((strategy) => ({
                        value: strategy,
                        label: strategy === "squash" ? t("pullrequestview.squashAndMerge") : strategy === "merge" ? t("pullrequestview.createMergeCommit") : t("pullrequestview.rebaseAndMerge"),
                      }))}
                      onChange={(value: string) => setMergeStrategy(value as typeof mergeStrategy)}
                    />
                    {!mergeBlock && <Checkbox className="source-confirm" checked={mergeConfirm} onChange={setMergeConfirm} label={t("pullrequestview.iConfirmThisMerge")} />}
                    <Button variant="primary" busy={mergeBusy} disabled={!!mergeBlock || !mergeConfirm} title={mergeBlock ?? t("pullrequestview.mergeNumberValue", { number: number })} onClick={() => void doMerge()}>
                      {mergeBusy ? t("pullrequestview.merging") : t("pullrequestview.mergePullRequest")}
                    </Button>
                  </div>
                </section>
              )}
              {mergeMsg && <div className={mergeFailed ? "form-error" : "form-success"} role="status">{mergeMsg}</div>}
            </div>
          )}

          {tab === "files" && (
            <div className="pr-files">
              {supportedReviewEvents(status).includes("COMMENT") && <details className="pr-review-form"><summary>{t("hosting.lineHeading")}</summary><TextInput value={lineComment.path} aria-label={t("hosting.file")} placeholder={t("hosting.file")} onChange={(event: ChangeEvent<HTMLInputElement>) => setLineComment((current) => ({ ...current, path: event.target.value }))} /><TextInput value={lineComment.line} aria-label={t("hosting.line")} placeholder={t("hosting.line")} onChange={(event: ChangeEvent<HTMLInputElement>) => setLineComment((current) => ({ ...current, line: event.target.value }))} /><Select value={lineComment.side} label={lineComment.side} options={[{ value: "RIGHT", label: t("hosting.right") }, { value: "LEFT", label: t("hosting.left") }]} onChange={(value: string) => setLineComment((current) => ({ ...current, side: value as "LEFT" | "RIGHT" }))} /><Textarea rows={2} value={lineComment.body} aria-label={t("hosting.lineComment")} placeholder={t("hosting.lineComment")} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setLineComment((current) => ({ ...current, body: event.target.value }))} /><Button size="sm" busy={reviewBusy} disabled={!lineComment.path || !lineComment.line || !lineComment.body.trim()} onClick={() => void submitLineComment()}>{t("hosting.addLineComment")}</Button></details>}
              <div className="pr-files-toolbar">
                <div>
                  <strong>{detail.changedFiles === 1 ? t("pullrequestview.oneChangedFile") : t("pullrequestview.changedFilesValue", { count: detail.changedFiles })}</strong>
                  <span><span className="positive">+{detail.additions}</span> <span className="negative">−{detail.deletions}</span></span>
                </div>
                <span className="header-spacer" />
                <Button size="sm" disabled={diffFiles.length === 0} onClick={() => setExpandedFiles(new Set(diffFiles.map((file) => file.path)))}>{t("pullrequestview.expandAll")}</Button>
                <Button size="sm" disabled={expandedFiles.size === 0} onClick={() => setExpandedFiles(new Set())}>{t("pullrequestview.collapseAll")}</Button>
              </div>
              {sectionErrors.files && (
                <div className="source-inline-status error" role="alert">
                  <span>{t("pullrequestview.changedFileMetadataCouldNotBe", { reason: sectionErrors.files })}</span>
                  <Button size="sm" onClick={() => setReloadKey((key) => key + 1)}>{t("common.retry")}</Button>
                </div>
              )}
              {diffReason && (
                <div className="source-inline-status error" role="alert">
                  <span>{t("pullrequestview.thePatchCouldNotBeLoaded", { reason: diffReason })}</span>
                  <Button size="sm" onClick={() => setReloadKey((key) => key + 1)}>{t("common.retry")}</Button>
                </div>
              )}
              {files.length === 0 && diffFiles.length === 0 && <EmptyState title={t("pullrequestview.noChangedFiles")} description={t("pullrequestview.noFileListIsAvailableForThis")} />}
              {diffFiles.map((file) => {
                const stat = fileStats.get(file.path);
                const expanded = expandedFiles.has(file.path);
                return (
                  <article key={file.path} className={`pr-file-card ${expanded ? "expanded" : ""}`}>
                    <button className="pr-file-head" aria-expanded={expanded} onClick={() => toggleFile(file.path)}>
                      <span className={`git-folder-chevron${expanded ? " expanded" : ""}`} aria-hidden="true">{Icon.chevronRight?.()}</span>
                      <span className="mono pr-file-path" title={file.path}>
                        {file.previousPath && <span className="muted">{file.previousPath} → </span>}{file.path}
                      </span>
                      {stat && <span className="pr-file-stat"><span className="positive">+{stat.additions}</span><span className="negative">−{stat.deletions}</span></span>}
                    </button>
                    {expanded && <DiffLines diff={file.diff} path={file.path} t={t} />}
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
              {failing > 0 && <Button size="sm" onClick={() => host.conversation.insert(`Investigate failed checks for ${agentContext}\n${checks?.checks.filter(check => ["failure", "timed_out", "action_required"].includes(check.status)).map(check => `${check.name}: ${check.summary ?? check.status} ${check.url ?? ""}`).join("\n")}`)}>{t("hosting.investigate")}</Button>}
              {!checks && !sectionErrors.checks && <div className="source-skeleton skeleton-panel" />}
              {sectionErrors.checks && (
                <div className="source-inline-status error" role="alert">
                  <span>{t("pullrequestview.checksCouldNotBeLoaded", { reason: sectionErrors.checks })}</span>
                  <Button size="sm" onClick={() => void loadChecks()}>{t("common.retry")}</Button>
                </div>
              )}
              {checks && checks.summary.total > 0 && (
                <section className="check-summary-cards">
                  <div className="success"><span>{t("pullrequestview.passing")}</span><strong>{passing}</strong></div>
                  <div className="failure"><span>{t("pullrequestview.failing")}</span><strong>{failing}</strong></div>
                  <div className="pending"><span>{t("pullrequestview.inProgress")}</span><strong>{pending}</strong></div>
                  <div><span>{t("pullrequestview.total")}</span><strong>{checks.summary.total}</strong></div>
                </section>
              )}
              {checks && checks.summary.total === 0 && <EmptyState title={t("pullrequestview.noChecks")} description={t("pullrequestview.noChecksWereReportedForThisCommit")} />}
              {checks?.summary.groups.map((group) => (
                <section key={group.id} className="checks-group">
                  <div className="checks-group-head"><strong>{group.label}</strong><span>{group.checks.length}</span></div>
                    {group.checks.map((check) => <CheckRow key={check.id} check={check} t={t} />)}
                </section>
              ))}
            </div>
          )}

          {tab === "comments" && (
            <div className="pr-comments">
              {sectionErrors.comments && (
                <div className="source-inline-status error" role="alert">
                  <span>{t("pullrequestview.conversationCouldNotBeLoaded", { reason: sectionErrors.comments })}</span>
                  <Button size="sm" onClick={() => setReloadKey((key) => key + 1)}>{t("common.retry")}</Button>
                </div>
              )}
              {!sectionErrors.comments && comments.length === 0 && discussions.length === 0 && <EmptyState title={t("pullrequestview.noConversationYet")} description={t("pullrequestview.reviewsAndCommentsWillAppearHere")} />}
              <div className="pr-thread">
                {comments.filter(comment => !comment.threadId || !discussions.some(thread => thread.id === comment.threadId)).map((comment) => (
                  <article key={comment.id} className="pr-comment">
                    <span className="pr-comment-avatar" aria-hidden="true">{initials(comment.author)}</span>
                    <div className="pr-comment-card">
                      <header className="pr-comment-head">
                        <strong>{comment.author}</strong>
                        {comment.reviewState && <span className="tag">{comment.reviewState.toLowerCase().replace(/_/g, " ")}</span>}
                        {comment.outdated && <span className="tag">{t("pullrequestview.outdated")}</span>}
                        <a href={comment.url} target="_blank" rel="noreferrer" className="muted">{comment.createdAt ? new Date(comment.createdAt).toLocaleString(getLocale()) : ""}</a>
                      </header>
                      {comment.path && <div className="pr-comment-location mono">{comment.path}{comment.line ? `:${comment.line}` : ""}</div>}
                      <div className="pr-comment-body markdown-body"><MarkdownDoc text={stripCursorMarkers(comment.body)} keyBase={`pr-comment-${comment.id}`} /></div>
                    </div>
                  </article>
                ))}
              </div>
              {status?.capabilities?.discussions && discussions.map((discussion) => (
                <section key={discussion.id} className="pr-review-form pr-discussion">
                  <strong>{t("hosting.threads")}{discussion.resolved ? ` · ${t("hosting.resolve")}` : ""}</strong>
                  {discussion.comments.map(comment => <div key={comment.id}><strong>{comment.author}</strong>{comment.path && <span className="muted mono"> {comment.path}:{comment.line}</span>}<MarkdownDoc text={comment.body} keyBase={`thread-${discussion.id}-${comment.id}`} /></div>)}
                  <Textarea rows={2} value={discussionDrafts[discussion.id] ?? ""} aria-label={t("hosting.replyPlaceholder")} placeholder={t("hosting.replyPlaceholder")} onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDiscussionDrafts((drafts) => ({ ...drafts, [discussion.id]: event.target.value }))} />
                  <div className="pr-review-actions">
                    {status.capabilities?.reply && <Button size="sm" busy={discussionBusy === discussion.id} onClick={() => void replyToDiscussion(discussion.id)}>{t("hosting.reply")}</Button>}
                    {status.capabilities?.resolve && discussion.resolvable && <Button size="sm" busy={discussionBusy === discussion.id} onClick={() => void setDiscussionResolved(discussion.id, !discussion.resolved)}>{discussion.resolved ? t("hosting.reopen") : t("hosting.resolve")}</Button>}
                  </div>
                </section>
              ))}
              <ReplyPanel
                projectId={projectId}
                context={{
                  kind: "pr",
                  number: detail.number,
                  title: detail.title,
                  body: detail.body,
                  url: detail.url,
                  comments,
                }}
                onPublished={async () => {
                  const next = await client.changeComments(projectId, number);
                  if (next.ok) setComments(next.data);
                }}
              />
              <section className="pr-review-form">
                <div>
                  <strong>{t("pullrequestview.submitAReview")}</strong>
                  <span className="muted">{t("pullrequestview.thisPostsDirectlyToGithub")}</span>
                </div>
                <Textarea rows={4} placeholder={t("pullrequestview.leaveAThoughtfulReview")} value={reviewBody} onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setReviewBody(event.target.value)} />
                <div className="pr-review-actions">
                  <div className="pr-review-kind">
                    <span>{t("pullrequestview.reviewType")}</span>
                    <Select
                      ariaLabel={t("pullrequestview.reviewType")}
                      label={reviewEvent === "COMMENT" ? t("pullrequestview.comment") : reviewEvent === "APPROVE" ? t("pullrequestview.approve") : t("pullrequestview.requestChanges")}
                      value={reviewEvent}
                      disabled={reviewBusy}
                      options={reviewEvents.map((event) => ({
                        value: event,
                        label: event === "COMMENT" ? t("pullrequestview.comment") : event === "APPROVE" ? t("pullrequestview.approve") : t("pullrequestview.requestChanges"),
                      }))}
                      onChange={(value: string) => {
                      setReviewEvent(value as typeof reviewEvent);
                      setConfirmWrite(false);
                      }}
                    />
                  </div>
                  {reviewEvent !== "COMMENT" && <Checkbox className="source-confirm" checked={confirmWrite} onChange={setConfirmWrite} label={t("pullrequestview.confirmValue", { value: reviewEvent === "APPROVE" ? t("pullrequestview.approval") : t("pullrequestview.changeRequest") })} />}
                  <span className="header-spacer" />
                  <Button variant="primary" busy={reviewBusy} disabled={!reviewBody.trim() && reviewEvent !== "APPROVE"} onClick={() => void submitReview()}>{reviewBusy ? t("pullrequestview.submitting") : t("pullrequestview.submitReview")}</Button>
                </div>
                {writeMsg && (
                  <div
                    className={writeTone === "error" ? "form-error" : writeTone === "warning" ? "form-warning" : "form-success"}
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
