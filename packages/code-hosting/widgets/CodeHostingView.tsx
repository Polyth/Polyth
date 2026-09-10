import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from "react";
import type { ChangeRequest, HostingIssue, HostingStatus } from "@polyth/code-hosting";
import { useCodeHosting, useCodeHostingStore, type CodeHostingTab } from "./context.tsx";

type Filter = "all" | "open" | "closed" | "merged" | "draft" | "ready";
type Item = HostingIssue | ChangeRequest;

const relativeDate = (raw: string, locale: string): string => {
  const time = new Date(raw).getTime();
  if (!Number.isFinite(time)) return "";
  const delta = Math.max(0, Date.now() - time);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (delta >= 86_400_000) return formatter.format(-Math.floor(delta / 86_400_000), "day");
  if (delta >= 3_600_000) return formatter.format(-Math.floor(delta / 3_600_000), "hour");
  return formatter.format(-Math.max(1, Math.floor(delta / 60_000)), "minute");
};

export function CodeHostingView({ renderDetail }: {
  renderDetail: (item: { kind: CodeHostingTab; number: number; close: () => void }) => ReactNode;
}) {
  const { host, provider, client } = useCodeHosting();
  const snapshot = useCodeHostingStore();
  const { Button, EmptyState, IconButton, Menu, Tabs, TextInput } = host.ui.components;
  const projectId = snapshot.activeProjectId;
  const [status, setStatus] = useState<HostingStatus | null>(null);
  const [tab, setTab] = useState<CodeHostingTab>("issues");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [issues, setIssues] = useState<HostingIssue[]>([]);
  const [changes, setChanges] = useState<ChangeRequest[]>([]);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [openItem, setOpenItem] = useState<{ kind: CodeHostingTab; number: number; projectId: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const t = provider.t;

  useEffect(() => {
    setOpenItem(null);
  }, [projectId]);

  useEffect(() => {
    if (!projectId) { setLoading(false); return; }
    let active = true;
    setLoading(true); setReason(""); setStatus(null); setIssues([]); setChanges([]);
    void (async () => {
      try {
        const nextStatus = await client.status(projectId);
        if (!active) return;
        setStatus(nextStatus);
        if (!nextStatus.repo) { setReason(nextStatus.reason ?? t("githubview.noGithubRepositoryDetected")); return; }
        if (!nextStatus.authenticated) { setReason(nextStatus.reason ?? t("githubview.signInWithGithubCliTo")); return; }
        const filters = {
          ...(query.trim() ? { search: query.trim() } : {}),
          state: filter === "ready" || filter === "draft" ? "open" : filter,
        };
        const [issueResult, changeResult] = await Promise.all([
          client.issues(projectId, 30, tab === "issues" ? filters : undefined),
          client.changes(projectId, 30, tab === "changes" ? filters : undefined),
        ]);
        if (!active) return;
        if (issueResult.ok) setIssues(issueResult.data); else setReason(issueResult.reason);
        if (changeResult.ok) setChanges(changeResult.data); else setReason(changeResult.reason);
      } catch (cause) {
        if (active) setReason(host.errors.friendly(t("githubview.couldnTLoadGithubData"), cause));
      } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [client, filter, host.errors, projectId, query, reloadKey, t, tab]);

  const startSession = (item: Item, kind: CodeHostingTab) => {
    if (!projectId) return;
    const label = kind === "changes" ? provider.presentation.changeLabel : provider.presentation.issueLabel;
    const numberPrefix = kind === "changes" ? provider.presentation.changeNumberPrefix : "#";
    host.conversation.startNewSession(projectId, {
      title: `${label} ${numberPrefix}${item.number}: ${item.title}`.slice(0, 80),
      draft: [
        t("githubview.workOnGithubValue", { label, number: item.number, title: item.title, url: item.url }),
        ...(kind === "changes" ? [t("githubview.headBranchValue", { branch: (item as ChangeRequest).headRefName })] : []),
        t("githubview.startByReadingValue", { label }),
      ].join("\n"),
    });
  };
  const visibleItems = useMemo(() => {
    const source: Item[] = tab === "issues" ? issues : changes;
    return source.filter((item) => {
      const change = tab === "changes" ? item as ChangeRequest : null;
      const state = item.state.toLowerCase();
      return filter === "all" || filter === state || (filter === "draft" && change?.isDraft) || (filter === "ready" && change && !change.isDraft && state === "open");
    });
  }, [changes, filter, issues, tab]);

  if (!projectId) return <EmptyState title={t("githubview.noProjectSelected")} description={t("githubview.openAProjectToBrowseItsGithub")} />;
  if (openItem && openItem.projectId === projectId) return <div className="github-page">{renderDetail({ ...openItem, close: () => setOpenItem(null) })}</div>;
  const source = tab === "issues" ? issues : changes;
  const filters: Array<{ id: Filter; label: string }> = tab === "changes"
    ? [{ id: "all", label: t("githubview.all") }, { id: "open", label: t("githubview.open") }, { id: "merged", label: t("githubview.merged") }, { id: "closed", label: t("githubview.closed") }, { id: "ready", label: t("githubview.ready") }, { id: "draft", label: t("githubview.drafts") }]
    : [{ id: "all", label: t("githubview.all") }, { id: "open", label: t("githubview.open") }, { id: "closed", label: t("githubview.closed") }];
  const Icon = host.ui.icons;

  return <div className="github-page">
    <header className="github-head"><span className="header-spacer" /><Button size="sm" iconStart={Icon.refresh} busy={loading} onClick={() => setReloadKey((key) => key + 1)}>{t("common.refresh")}</Button></header>
    {loading && !status && <div className="gh-skeleton-list" aria-label={t("githubview.loadingGithubActivity")} aria-busy="true"><div className="source-skeleton gh-skeleton" /><div className="source-skeleton gh-skeleton" /><div className="source-skeleton gh-skeleton" /></div>}
    {!loading && !status && reason && <EmptyState title={t("githubview.couldnTLoadGithub")} description={reason} actionLabel={t("common.retry")} onAction={() => setReloadKey((key) => key + 1)} />}
    {status && !status.installed && <EmptyState title={t("githubview.githubCliIsnTInstalled")} description={t("githubview.installTheGithubCliFrom")} actionLabel={t("githubview.checkAgain")} onAction={() => setReloadKey((key) => key + 1)} />}
    {status?.installed && !status.repo && <EmptyState title={reason ? t("githubview.couldnTLoadGithub") : t("githubview.noGithubRepositoryFound")} description={reason || t("githubview.addAGithubRemoteTo")} actionLabel={t("githubview.checkAgain")} onAction={() => setReloadKey((key) => key + 1)} />}
    {status?.repo && !status.authenticated && <div className="gh-connect-state"><span className="gh-connect-icon">{provider.presentation.icon()}</span><div><h2>{t("githubview.connectGithubCli")}</h2><p>{reason || t("githubview.runGhAuthLoginIn")}</p><code>{provider.presentation.command} auth login</code></div><Button variant="primary" onClick={() => setReloadKey((key) => key + 1)}>{t("githubview.iVeSignedIn")}</Button></div>}
    {status?.repo && status.authenticated && <>
      <section className="gh-repo-card"><span className="gh-repo-icon">{provider.presentation.icon()}</span><div className="gh-repo-copy"><a className="gh-repo-name" href={status.repo.url} target="_blank" rel="noreferrer" title={`${status.repo.owner}/${status.repo.name}`}><span>{status.repo.owner}/{status.repo.name}</span>{Icon.external?.()}<span className="sr-only">{t("githubview.openOnGithub")}</span></a><span className="muted" title={status.repo.description || provider.presentation.serviceName}>{status.repo.description || provider.presentation.serviceName}</span></div><div className="gh-repo-meta"><span className="tag">{status.repo.visibility === "internal" ? t("hosting.internal") : status.repo.isPrivate ? t("githubview.private") : t("githubview.public")}</span><span className="tag mono gh-default-branch" title={status.repo.defaultBranch}>{Icon.branch?.()}<span>{status.repo.defaultBranch}</span></span></div></section>
      {status.access && <details className="hosting-access"><summary>{t("hosting.access")}</summary><dl>{Object.entries(status.access).map(([operation, access]) => <div key={operation}><dt>{t(`hosting.${operation}`)}</dt><dd>{t(`hosting.${access}`)}</dd></div>)}</dl></details>}
      <div className="gh-list-controls"><Tabs className="gh-tabs" size="sm" label={provider.presentation.serviceName} value={tab} tabs={[{ id: "issues", label: <>{provider.presentation.issueLabel} <span>{issues.length}</span></> }, { id: "changes", label: <>{provider.presentation.changePlural} <span>{changes.length}</span></> }]} onChange={(value: string) => { setTab(value as CodeHostingTab); setFilter("all"); }} /><div className="source-search gh-search">{Icon.search?.()}<TextInput value={query} placeholder={t("githubview.searchValue", { value: tab === "issues" ? provider.presentation.issueLabel : provider.presentation.changePlural })} aria-label={t("githubview.searchValue", { value: tab === "issues" ? provider.presentation.issueLabel : provider.presentation.changePlural })} onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)} />{query && <IconButton className="source-search-clear" icon={Icon.close} label={t("githubview.clearSearch")} onClick={() => setQuery("")} />}</div><div className="gh-filter-chips ui-scroll-tabs" aria-label={t("githubview.filterList")}>{filters.map((item) => <Button size="sm" variant="ghost" key={item.id} className={filter === item.id ? "active" : ""} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</Button>)}</div></div>
      {loading && <div className="gh-skeleton-list" aria-label={t("githubview.loadingRepositoryActivity")} aria-busy="true"><div className="source-skeleton gh-skeleton" /><div className="source-skeleton gh-skeleton" /></div>}
      {!loading && reason && source.length === 0 && <EmptyState title={t("githubview.couldnTLoadRepositoryActivity")} description={reason} actionLabel={t("common.retry")} onAction={() => setReloadKey((key) => key + 1)} />}
      {!loading && !reason && visibleItems.length === 0 && <EmptyState title={query || filter !== "all" ? t("githubview.noMatchingResults") : t("githubview.noValue", { value: tab === "issues" ? provider.presentation.issueLabel : provider.presentation.changePlural })} description={query || filter !== "all" ? t("githubview.tryADifferentSearchOr") : t("githubview.newRepositoryActivityWillAppearHere")} {...(query || filter !== "all" ? { actionLabel: t("githubview.clearFilters"), onAction: () => { setQuery(""); setFilter("all"); } } : {})} />}
      <div className="gh-list">{visibleItems.map((item) => <CodeHostingCard key={`${tab}-${item.number}`} item={item} kind={tab} onOpen={(number) => setOpenItem({ kind: tab, number, projectId })} onStartSession={startSession} />)}</div>
    </>}
  </div>;
}

function CodeHostingCard({ item, kind, onOpen, onStartSession }: { item: Item; kind: CodeHostingTab; onOpen(number: number): void; onStartSession(item: Item, kind: CodeHostingTab): void }) {
  const { host, provider } = useCodeHosting();
  const { Button, IconButton, Menu } = host.ui.components;
  const Icon = host.ui.icons;
  const change = kind === "changes" ? item as ChangeRequest : null;
  const label = kind === "changes" ? provider.presentation.changeLabel : provider.presentation.issueLabel;
  const numberPrefix = kind === "changes" ? provider.presentation.changeNumberPrefix : "#";
  const ref = `${label} ${numberPrefix}${item.number}`;
  const askInChat = () => host.conversation.insert(provider.t("githubview.lookAtGithubValue", { ref, title: item.title, url: item.url }));
  return <article className="gh-card"><div className="gh-card-main"><div className="gh-card-kicker"><span className={`gh-state ${item.state.toLowerCase()}${change?.isDraft ? " draft" : ""}`}>{change?.isDraft ? provider.t("githubview.draft") : item.state.toLowerCase()}</span><span className="gh-number mono">{numberPrefix}{item.number}</span><span className="gh-meta">{provider.t("githubview.updatedValue", { value: relativeDate(item.updatedAt, host.ui.locale.get()) })}</span></div><button className="gh-card-title" onClick={() => onOpen(item.number)}><span>{item.title}</span></button><div className="gh-card-meta"><span>{provider.t("githubview.byValue", { author: item.author })}</span>{change && <span className="gh-branch mono" title={change.headRefName}>{Icon.branch?.()}<span>{change.headRefName}</span></span>}</div></div><div className="gh-card-actions"><Button size="sm" variant="primary" className="gh-card-primary" onClick={() => onOpen(item.number)}>{provider.t("githubview.details")}</Button><Button size="sm" className="gh-action-secondary" iconStart={Icon.newSession} title={provider.t("githubview.startASessionForThisValue", { ref })} onClick={() => onStartSession(item, kind)}>{provider.t("githubview.newSession")}</Button><Button size="sm" className="gh-action-secondary" iconStart={Icon.chat} title={provider.t("githubview.addThisContextToChat")} onClick={askInChat}>{provider.t("githubview.askInChat")}</Button><Menu label={provider.t("githubview.moreActionsForValue", { ref })} align="end" entries={[{ id: "session", label: provider.t("githubview.newSession"), icon: Icon.newSession, onSelect: () => onStartSession(item, kind) }, { id: "chat", label: provider.t("githubview.askInChat"), icon: Icon.chat, onSelect: askInChat }, { id: "external", label: provider.t("githubview.openOnGithub"), icon: Icon.external, onSelect: () => window.open(item.url, "_blank", "noopener,noreferrer") }]}>{(trigger: Record<string, unknown>) => <IconButton {...trigger} className="gh-card-overflow" icon={Icon.more} label={provider.t("githubview.moreActionsForValue", { ref })} />}</Menu></div></article>;
}
