import { useEffect, useMemo, useRef, useState } from "react";
import { api, type GithubIssueDto, type GithubPrDto, type GithubStatusDto } from "../api.ts";
import { requestComposerInsert } from "../composerInsert.ts";
import { Icon } from "../icons.tsx";
import { friendlyError } from "../settings.ts";
import { setActiveView, startNewSession, useStore } from "../store.ts";
import { useDismissibleMenu } from "./a11y/Menu.ts";
import EmptyState from "./EmptyState.tsx";
import IssueDetailView from "./IssueDetailView.tsx";
import PullRequestView from "./PullRequestView.tsx";
import { formatRelativeTime, tr } from "../i18n/index.ts";

type Tab = "issues" | "prs";
type Filter = "all" | "open" | "closed" | "draft" | "ready";

const relativeDate = (raw: string): string => {
  const time = new Date(raw).getTime();
  if (!Number.isFinite(time)) return "";
  const delta = Math.max(0, Date.now() - time);
  const days = Math.floor(delta / 86_400_000);
  if (days > 0) return formatRelativeTime(-days, "day");
  const hours = Math.floor(delta / 3_600_000);
  if (hours > 0) return formatRelativeTime(-hours, "hour");
  return formatRelativeTime(-Math.max(1, Math.floor(delta / 60_000)), "minute");
};

function GithubCard({ item, kind, onOpen, onStartSession }: {
  item: GithubIssueDto | GithubPrDto;
  kind: Tab;
  onOpen: (number: number) => void;
  onStartSession: (item: GithubIssueDto | GithubPrDto, kind: Tab) => void;
}) {
  const pr = kind === "prs" ? item as GithubPrDto : null;
  const typeLabel = kind === "prs" ? tr("githubview.pr") : tr("githubview.issue");
  const ref = `${typeLabel} #${item.number}`;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const onMenuKeyDown = useDismissibleMenu({
    open: menuOpen,
    menuRef,
    triggerRef,
    onClose: () => setMenuOpen(false),
  });
  const askInChat = () => {
    requestComposerInsert(tr("githubview.lookAtGithubValue", { ref, title: item.title, url: item.url }));
    setActiveView("session");
  };
  const runMenuAction = (action: () => void) => {
    setMenuOpen(false);
    action();
  };
  return (
    <article className="gh-card">
      <div className="gh-card-main">
        <div className="gh-card-kicker">
          <span className={`gh-state ${item.state.toLowerCase()}${pr?.isDraft ? " draft" : ""}`}>{pr?.isDraft ? tr("githubview.draft") : item.state.toLowerCase()}</span>
          <span className="gh-number mono">#{item.number}</span>
          <span className="gh-meta">{tr("githubview.updatedValue", { value: relativeDate(item.updatedAt) })}</span>
        </div>
        <button className="gh-card-title" onClick={() => onOpen(item.number)}>
          <span>{item.title}</span>
        </button>
        <div className="gh-card-meta">
          <span>{tr("githubview.byValue", { author: item.author })}</span>
          {pr && <span className="gh-branch mono" title={pr.headRefName}><Icon.branch /><span>{pr.headRefName}</span></span>}
        </div>
      </div>
      <div className="gh-card-actions">
        <button className="primary-btn gh-card-primary" onClick={() => onOpen(item.number)}>{tr("githubview.details")}</button>
        <button className="small-btn gh-action-secondary" title={tr("githubview.startASessionForThisValue", { ref })} onClick={() => onStartSession(item, kind)}><Icon.session /> {tr("githubview.newSession")}</button>
        <button className="small-btn gh-action-secondary" title={tr("githubview.addThisContextToChat")} onClick={askInChat}><Icon.chat /> {tr("githubview.askInChat")}</button>
        <div className="gh-card-overflow">
          <button
            ref={triggerRef}
            className="small-btn icon-only"
            aria-label={tr("githubview.moreActionsForValue", { ref })}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          ><Icon.more /></button>
          {menuOpen && (
            <div ref={menuRef} className="gh-card-menu" role="menu" onKeyDown={onMenuKeyDown}>
              <button role="menuitem" onClick={() => runMenuAction(() => onStartSession(item, kind))}><Icon.session /> {tr("githubview.newSession")}</button>
              <button role="menuitem" onClick={() => runMenuAction(askInChat)}><Icon.chat /> {tr("githubview.askInChat")}</button>
              <a role="menuitem" href={item.url} target="_blank" rel="noreferrer"><Icon.external /> {tr("githubview.openOnGithub")}</a>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

export default function GithubView() {
  const projectId = useStore((state) => state.activeProjectId);
  const [status, setStatus] = useState<GithubStatusDto | null>(null);
  const [tab, setTab] = useState<Tab>("issues");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [issues, setIssues] = useState<GithubIssueDto[]>([]);
  const [prs, setPrs] = useState<GithubPrDto[]>([]);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [openItem, setOpenItem] = useState<{ kind: Tab; number: number } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!projectId) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setReason("");
    setStatus(null);
    setIssues([]);
    setPrs([]);
    void (async () => {
      try {
        const nextStatus = await api.githubStatus(projectId);
        if (!active) return;
        setStatus(nextStatus);
        if (!nextStatus.repo) {
          setReason(nextStatus.reason ?? tr("githubview.noGithubRepositoryDetected"));
          return;
        }
        if (!nextStatus.authenticated) {
          setReason(nextStatus.reason ?? tr("githubview.signInWithGithubCliTo"));
          return;
        }
        const [issueResult, prResult] = await Promise.all([api.githubIssues(projectId), api.githubPrs(projectId)]);
        if (!active) return;
        if (issueResult.ok) setIssues(issueResult.data); else setReason(issueResult.reason);
        if (prResult.ok) setPrs(prResult.data); else setReason(prResult.reason);
      } catch (cause) {
        if (active) setReason(friendlyError(tr("githubview.couldnTLoadGithubData"), cause));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [projectId, reloadKey]);

  // F7 / OC-15-002/003: bootstrap a session from an issue or PR. The context
  // lands as the composer draft (saved before the session opens so the
  // composer restores it) — nothing is sent until the user does.
  const startSession = (item: GithubIssueDto | GithubPrDto, kind: Tab) => {
    if (!projectId) return;
    const label = kind === "prs" ? tr("githubview.pr") : tr("githubview.issue");
    startNewSession(projectId, {
      title: `${label} #${item.number}: ${item.title}`.slice(0, 80),
      draft: [
        tr("githubview.workOnGithubValue", {
          label,
          number: item.number,
          title: item.title,
          url: item.url,
        }),
        ...(kind === "prs"
          ? [tr("githubview.headBranchValue", { branch: (item as GithubPrDto).headRefName })]
          : []),
        tr("githubview.startByReadingValue", { label }),
      ].join("\n"),
    });
  };

  const items = useMemo(() => {
    const source: Array<GithubIssueDto | GithubPrDto> = tab === "issues" ? issues : prs;
    const normalized = query.trim().toLowerCase();
    return source.filter((item) => {
      const pr = tab === "prs" ? item as GithubPrDto : null;
      const matchesQuery = !normalized || [item.title, item.author, String(item.number), pr?.headRefName ?? ""].some((value) => value.toLowerCase().includes(normalized));
      const state = item.state.toLowerCase();
      const matchesFilter = filter === "all"
        || (filter === "draft" && pr?.isDraft)
        || (filter === "ready" && pr && !pr.isDraft && state === "open")
        || filter === state;
      return matchesQuery && matchesFilter;
    });
  }, [filter, issues, prs, query, tab]);

  if (!projectId) return <EmptyState title={tr("githubview.noProjectSelected")} description={tr("githubview.openAProjectToBrowseItsGithub")} />;

  if (openItem !== null) {
    return (
      <div className="view-page github-page">
        {openItem.kind === "prs"
          ? <PullRequestView number={openItem.number} onClose={() => setOpenItem(null)} />
          : <IssueDetailView number={openItem.number} onClose={() => setOpenItem(null)} />}
      </div>
    );
  }

  const filters: Array<{ id: Filter; label: string }> = tab === "prs"
    ? [{ id: "all", label: tr("githubview.all") }, { id: "ready", label: tr("githubview.ready") }, { id: "draft", label: tr("githubview.drafts") }]
    : [{ id: "all", label: tr("githubview.all") }, { id: "open", label: tr("githubview.open") }, { id: "closed", label: tr("githubview.closed") }];

  return (
    <div className="view-page github-page">
      <header className="github-head">
        <div>
          <h1 className="view-title">{tr("githubview.github")}</h1>
          <p className="view-sub">{tr("githubview.issuesAndPullRequestsFor")}</p>
        </div>
        <button className="small-btn" disabled={loading} onClick={() => setReloadKey((key) => key + 1)}><Icon.refresh /> {tr("common.refresh")}</button>
      </header>

      {loading && !status && (
        <div className="gh-skeleton-list" aria-label={tr("githubview.loadingGithubActivity")} aria-busy="true">
          <div className="source-skeleton gh-skeleton" /><div className="source-skeleton gh-skeleton" /><div className="source-skeleton gh-skeleton" />
        </div>
      )}

      {!loading && !status && reason && <EmptyState title={tr("githubview.couldnTLoadGithub")} description={reason} actionLabel={tr("common.retry")} onAction={() => setReloadKey((key) => key + 1)} />}

      {status && !status.installed && (
        <EmptyState
          title={tr("githubview.githubCliIsnTInstalled")}
          description={tr("githubview.installTheGithubCliFrom")}
          actionLabel={tr("githubview.checkAgain")}
          onAction={() => setReloadKey((key) => key + 1)}
        />
      )}

      {status?.installed && !status.repo && (
        <EmptyState
          title={tr("githubview.noGithubRepositoryFound")}
          description={reason || tr("githubview.addAGithubRemoteTo")}
          actionLabel={tr("githubview.checkAgain")}
          onAction={() => setReloadKey((key) => key + 1)}
        />
      )}

      {status?.repo && !status.authenticated && (
        <div className="gh-connect-state">
          <span className="gh-connect-icon"><Icon.github /></span>
          <div>
            <h2>{tr("githubview.connectGithubCli")}</h2>
            <p>{reason || tr("githubview.runGhAuthLoginIn")}</p>
            <code>gh auth login</code>
          </div>
          <button className="primary-btn" onClick={() => setReloadKey((key) => key + 1)}>{tr("githubview.iVeSignedIn")}</button>
        </div>
      )}

      {status?.repo && status.authenticated && (
        <>
          <section className="gh-repo-card">
            <span className="gh-repo-icon"><Icon.github /></span>
            <div className="gh-repo-copy">
              <a className="gh-repo-name" href={status.repo.url} target="_blank" rel="noreferrer" title={`${status.repo.owner}/${status.repo.name}`}>
                <span>{status.repo.owner}/{status.repo.name}</span><Icon.external /><span className="sr-only">(opens on GitHub)</span>
              </a>
              <span className="muted" title={status.repo.description || tr("githubview.githubRepository")}>{status.repo.description || tr("githubview.githubRepository")}</span>
            </div>
            <div className="gh-repo-meta">
              <span className="tag">{status.repo.isPrivate ? tr("githubview.private") : tr("githubview.public")}</span>
              <span className="tag mono gh-default-branch" title={status.repo.defaultBranch}><Icon.branch /><span>{status.repo.defaultBranch}</span></span>
            </div>
          </section>

          <div className="gh-list-controls">
            <div className="source-tabs gh-tabs" aria-label={tr("githubview.githubResourceType")}>
              <button className={tab === "issues" ? "active" : ""} aria-current={tab === "issues" ? "page" : undefined} onClick={() => { setTab("issues"); setFilter("all"); }}>{tr("githubview.issuesHeading")} <span>{issues.length}</span></button>
              <button className={tab === "prs" ? "active" : ""} aria-current={tab === "prs" ? "page" : undefined} onClick={() => { setTab("prs"); setFilter("all"); }}>{tr("githubview.pullRequestsHeading")} <span>{prs.length}</span></button>
            </div>
            <div className="source-search gh-search">
              <Icon.search />
              <input value={query} placeholder={tr("githubview.searchValue", { value: tab === "issues" ? tr("githubview.issuesLabel") : tr("githubview.pullRequestsLabel") })} aria-label={tr("githubview.searchValue", { value: tab === "issues" ? tr("githubview.issuesLabel") : tr("githubview.pullRequestsLabel") })} onChange={(event) => setQuery(event.target.value)} />
              {query && <button className="source-search-clear" aria-label={tr("githubview.clearSearch")} onClick={() => setQuery("")}>×</button>}
            </div>
            <div className="gh-filter-chips" aria-label={tr("githubview.filterList")}>
              {filters.map((item) => <button key={item.id} className={filter === item.id ? "active" : ""} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}
            </div>
          </div>

          {loading && <div className="gh-skeleton-list" aria-label={tr("githubview.loadingRepositoryActivity")} aria-busy="true"><div className="source-skeleton gh-skeleton" /><div className="source-skeleton gh-skeleton" /></div>}
          {!loading && reason && (tab === "issues" ? issues : prs).length === 0 && <EmptyState title={tr("githubview.couldnTLoadRepositoryActivity")} description={reason} actionLabel={tr("common.retry")} onAction={() => setReloadKey((key) => key + 1)} />}
          {!loading && !reason && items.length === 0 && (
            <EmptyState
              title={query || filter !== "all" ? tr("githubview.noMatchingResults") : tr("githubview.noValue", { value: tab === "issues" ? tr("githubview.issuesLabel") : tr("githubview.pullRequestsLabel") })}
              description={query || filter !== "all" ? tr("githubview.tryADifferentSearchOr") : tr("githubview.newRepositoryActivityWillAppearHere")}
              {...(query || filter !== "all" ? { actionLabel: tr("githubview.clearFilters"), onAction: () => { setQuery(""); setFilter("all"); } } : {})}
            />
          )}
          <div className="gh-list">
            {items.map((item) => (
              <GithubCard
                key={`${tab}-${item.number}`}
                item={item}
                kind={tab}
                onStartSession={startSession}
                onOpen={(number) => setOpenItem({ kind: tab, number })}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
