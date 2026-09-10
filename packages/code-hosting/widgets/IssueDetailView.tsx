import { useCallback, useEffect, useState } from "react";
import { api } from "@polyth/session/web-api";
import type { HostingIssueComment, HostingIssueDetail } from "@polyth/code-hosting";
import { useCodeHosting, useCodeHostingStore } from "./context.tsx";
import ReplyPanel from "./ReplyPanel.tsx";

const initials = (name: string): string =>
  name.split(/[\s-]+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";

export default function IssueDetailView({ number, onClose }: { number: number; onClose: () => void }) {
  const { client, host, provider } = useCodeHosting();
  const { Button, EmptyState, MarkdownDoc } = host.ui.components;
  const Icon = host.ui.icons;
  const t = provider.t;
  const projectId = useCodeHostingStore().activeProjectId;
  const [detail, setDetail] = useState<HostingIssueDetail | null>(null);
  const [comments, setComments] = useState<HostingIssueComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [reason, setReason] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const reloadComments = useCallback(async () => {
    if (!projectId) return;
    const result = await client.issueComments(projectId, number);
    if (result.ok) setComments(result.data);
    else throw new Error(result.reason);
  }, [number, projectId]);

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    setLoading(true);
    setReason("");
    void Promise.all([
      client.issue(projectId, number),
      client.issueComments(projectId, number),
    ]).then(([detailResult, commentsResult]) => {
      if (!active) return;
      if (detailResult.ok) setDetail(detailResult.data);
      else setReason(detailResult.reason);
      if (commentsResult.ok) setComments(commentsResult.data);
      else if (detailResult.ok) setReason(commentsResult.reason);
    }).catch((cause: unknown) => {
      if (active) setReason(host.errors.friendly(t("issuedetail.couldntLoadIssue"), cause));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [client, host.errors, number, projectId, reloadKey, t]);

  if (!projectId) return null;
  if (loading && !detail) {
    return (
      <div className="pr-surface issue-surface" aria-busy="true" aria-label={t("issuedetail.loadingIssue")}>
        <div className="source-skeleton skeleton-title" />
        <div className="source-skeleton skeleton-panel" />
      </div>
    );
  }

  return (
    <div className="pr-surface issue-surface">
      <header className="pr-head">
        <Button size="sm" className="pr-back" onClick={onClose}>{t("issuedetail.issues")}</Button>
        {detail && (
          <div className="pr-title-block">
            <div className="pr-title-meta">
              <span className={`gh-state ${detail.state.toLowerCase()}`}>{detail.state.toLowerCase()}</span>
              <span className="gh-number mono">#{detail.number}</span>
            </div>
            <h1>{detail.title}</h1>
            <span className="muted">
              {t("issuedetail.openedByValue", { author: detail.author })}
              {detail.createdAt ? ` · ${new Date(detail.createdAt).toLocaleString(host.ui.locale.get())}` : ""}
            </span>
          </div>
        )}
        {detail && (
          <a className="ui-btn ui-btn--quiet ui-btn--sm pr-external-link" href={detail.url} target="_blank" rel="noreferrer">
            {Icon.external?.()} {t("githubview.openOnGithub")}
          </a>
        )}
      </header>

      {reason && !detail && (
        <EmptyState
          title={t("issuedetail.couldntLoadIssue")}
          description={reason}
          actionLabel={t("common.retry")}
          onAction={() => setReloadKey((key) => key + 1)}
        />
      )}

      {detail && (
        <div className="issue-detail-layout">
          <div className="pr-review-actions">
            <Button size="sm" onClick={() => host.conversation.insert(`${provider.presentation.issueLabel} #${detail.number}: ${detail.title}\n${detail.url}\n${detail.body}`)}>{t("githubview.askInChat")}</Button>
            <Button size="sm" onClick={() => host.conversation.startNewSession(projectId!, { title: detail.title, draft: `${provider.presentation.issueLabel} #${detail.number}: ${detail.title}\n${detail.url}\n${detail.body}` })}>{t("githubview.newSession")}</Button>
            {detail.labels?.map(label => <span key={label} className="tag">{label}</span>)}
            {detail.assignees?.map(user => <span key={user} className="tag">@{user}</span>)}
          </div>
          <section className="issue-description-card">
            <header>
              <div>
                <h2>{t("issuedetail.description")}</h2>
                <span className="muted">
                  {t("issuedetail.updatedValue", { date: new Date(detail.updatedAt).toLocaleString(host.ui.locale.get()) })}
                </span>
              </div>
            </header>
            <div className="pr-body markdown-body">
              {detail.body
                ? <MarkdownDoc text={detail.body} keyBase={`issue-${detail.number}-body`} />
                : <p>{t("issuedetail.noDescription")}</p>}
            </div>
          </section>

          <section className="issue-conversation">
            <div className="issue-section-heading">
              <div>
                <h2>{t("issuedetail.conversation")}</h2>
                <span className="muted">{t("issuedetail.commentCount", { count: comments.length })}</span>
              </div>
            </div>
            {reason && <div className="source-inline-status error" role="alert">{reason}</div>}
            {!reason && comments.length === 0 && (
              <EmptyState title={t("issuedetail.noComments")} description={t("issuedetail.startTheConversation")} />
            )}
            <div className="pr-thread">
              {comments.map((comment) => (
                <article key={comment.id} className="pr-comment">
                  <span className="pr-comment-avatar" aria-hidden="true">{initials(comment.author)}</span>
                  <div className="pr-comment-card">
                    <header className="pr-comment-head">
                      <strong>{comment.author}</strong>
                      <a href={comment.url} target="_blank" rel="noreferrer" className="muted">
                        {comment.createdAt ? new Date(comment.createdAt).toLocaleString(host.ui.locale.get()) : ""}
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

          <ReplyPanel
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
