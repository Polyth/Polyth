import { useCallback, useEffect, useState } from "react";
import {
  api,
  type GithubIssueCommentDto,
  type GithubIssueDetailDto,
} from "../api.ts";
import { getLocale, tr } from "../i18n/index.ts";
import { Icon } from "../icons.tsx";
import { MarkdownDoc } from "../markdown.tsx";
import { friendlyError } from "../settings.ts";
import { useStore } from "../store.ts";
import EmptyState from "./EmptyState.tsx";
import GithubReplyPanel from "./GithubReplyPanel.tsx";

const initials = (name: string): string =>
  name.split(/[\s-]+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";

export default function IssueDetailView({ number, onClose }: { number: number; onClose: () => void }) {
  const projectId = useStore((state) => state.activeProjectId);
  const [detail, setDetail] = useState<GithubIssueDetailDto | null>(null);
  const [comments, setComments] = useState<GithubIssueCommentDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [reason, setReason] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const reloadComments = useCallback(async () => {
    if (!projectId) return;
    const result = await api.githubIssueComments(projectId, number);
    if (result.ok) setComments(result.data);
    else throw new Error(result.reason);
  }, [number, projectId]);

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    setLoading(true);
    setReason("");
    void Promise.all([
      api.githubIssueDetail(projectId, number),
      api.githubIssueComments(projectId, number),
    ]).then(([detailResult, commentsResult]) => {
      if (!active) return;
      if (detailResult.ok) setDetail(detailResult.data);
      else setReason(detailResult.reason);
      if (commentsResult.ok) setComments(commentsResult.data);
      else if (detailResult.ok) setReason(commentsResult.reason);
    }).catch((cause: unknown) => {
      if (active) setReason(friendlyError(tr("issuedetail.couldntLoadIssue"), cause));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [number, projectId, reloadKey]);

  if (!projectId) return null;
  if (loading && !detail) {
    return (
      <div className="pr-surface issue-surface" aria-busy="true" aria-label={tr("issuedetail.loadingIssue")}>
        <div className="source-skeleton skeleton-title" />
        <div className="source-skeleton skeleton-panel" />
      </div>
    );
  }

  return (
    <div className="pr-surface issue-surface">
      <header className="pr-head">
        <button className="small-btn pr-back" onClick={onClose}><Icon.back /> {tr("issuedetail.issues")}</button>
        {detail && (
          <div className="pr-title-block">
            <div className="pr-title-meta">
              <span className={`gh-state ${detail.state.toLowerCase()}`}>{detail.state.toLowerCase()}</span>
              <span className="gh-number mono">#{detail.number}</span>
            </div>
            <h1>{detail.title}</h1>
            <span className="muted">
              {tr("issuedetail.openedByValue", { author: detail.author })}
              {detail.createdAt ? ` · ${new Date(detail.createdAt).toLocaleString(getLocale())}` : ""}
            </span>
          </div>
        )}
        {detail && (
          <a className="small-btn pr-external-link" href={detail.url} target="_blank" rel="noreferrer">
            <Icon.external /> {tr("githubview.openOnGithub")}
          </a>
        )}
      </header>

      {reason && !detail && (
        <EmptyState
          title={tr("issuedetail.couldntLoadIssue")}
          description={reason}
          actionLabel={tr("common.retry")}
          onAction={() => setReloadKey((key) => key + 1)}
        />
      )}

      {detail && (
        <div className="issue-detail-layout">
          <section className="issue-description-card">
            <header>
              <div>
                <h2>{tr("issuedetail.description")}</h2>
                <span className="muted">
                  {tr("issuedetail.updatedValue", { date: new Date(detail.updatedAt).toLocaleString(getLocale()) })}
                </span>
              </div>
            </header>
            <div className="pr-body markdown-body">
              {detail.body
                ? <MarkdownDoc text={detail.body} keyBase={`issue-${detail.number}-body`} />
                : <p>{tr("issuedetail.noDescription")}</p>}
            </div>
          </section>

          <section className="issue-conversation">
            <div className="issue-section-heading">
              <div>
                <h2>{tr("issuedetail.conversation")}</h2>
                <span className="muted">{tr("issuedetail.commentCount", { count: comments.length })}</span>
              </div>
            </div>
            {reason && <div className="source-inline-status error" role="alert">{reason}</div>}
            {!reason && comments.length === 0 && (
              <EmptyState title={tr("issuedetail.noComments")} description={tr("issuedetail.startTheConversation")} />
            )}
            <div className="pr-thread">
              {comments.map((comment) => (
                <article key={comment.id} className="pr-comment">
                  <span className="pr-comment-avatar" aria-hidden="true">{initials(comment.author)}</span>
                  <div className="pr-comment-card">
                    <header className="pr-comment-head">
                      <strong>{comment.author}</strong>
                      <a href={comment.url} target="_blank" rel="noreferrer" className="muted">
                        {comment.createdAt ? new Date(comment.createdAt).toLocaleString(getLocale()) : ""}
                      </a>
                    </header>
                    <div className="pr-comment-body markdown-body">
                      <MarkdownDoc text={comment.body} keyBase={`issue-comment-${comment.id}`} />
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <GithubReplyPanel
            projectId={projectId}
            context={{
              kind: "issue",
              number: detail.number,
              title: detail.title,
              body: detail.body,
              url: detail.url,
              comments,
            }}
            onPublished={reloadComments}
          />
        </div>
      )}
    </div>
  );
}
