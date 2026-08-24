import { useEffect, useMemo, useRef, useState } from "react";
import { api, type GithubIssueDto, type GithubPrDto, type GithubStatusDto } from "../api.ts";
import { requestComposerInsert } from "../composerInsert.ts";
import { Icon } from "../icons.tsx";
import { friendlyError } from "../settings.ts";
import { setActiveView, startNewSession, useStore } from "../store.ts";
import { useDismissibleMenu } from "./a11y/Menu.ts";
import EmptyState from "./EmptyState.tsx";
import PullRequestView from "./PullRequestView.tsx";

type Tab = "issues" | "prs";
type Filter = "all" | "open" | "closed" | "draft" | "ready";

const relativeDate = (raw: string): string => {
  const time = new Date(raw).getTime();
  if (!Number.isFinite(time)) return "";
  const delta = Math.max(0, Date.now() - time);
  const days = Math.floor(delta / 86_400_000);
  if (days > 0) return `${days}d ago`;
  const hours = Math.floor(delta / 3_600_000);
  if (hours > 0) return `${hours}h ago`;
  return `${Math.max(1, Math.floor(delta / 60_000))}m ago`;
};

function GithubCard({ item, kind, onOpen, onStartSession }: {
  item: GithubIssueDto | GithubPrDto;
  kind: Tab;
  onOpen?: (number: number) => void;
  onStartSession: (item: GithubIssueDto | GithubPrDto, kind: Tab) => void;
}) {
  const pr = kind === "prs" ? item as GithubPrDto : null;
  const ref = `${kind === "prs" ? "PR" : "issue"} #${item.number}`;
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
    requestComposerInsert(`Look at GitHub ${ref}: "${item.title}" (${item.url}).`);
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
          <span className={`gh-state ${item.state.toLowerCase()}${pr?.isDraft ? " draft" : ""}`}>{pr?.isDraft ? "draft" : item.state.toLowerCase()}</span>
          <span className="gh-number mono">#{item.number}</span>
          <span className="gh-meta">updated {relativeDate(item.updatedAt)}</span>
        </div>
        <a className="gh-card-title" href={item.url} target="_blank" rel="noreferrer">
          <span>{item.title}</span><Icon.external /><span className="sr-only">(opens on GitHub)</span>
        </a>
        <div className="gh-card-meta">
          <span>by <strong>{item.author}</strong></span>
          {pr && <span className="gh-branch mono" title={pr.headRefName}><Icon.branch /><span>{pr.headRefName}</span></span>}
        </div>
      </div>
      <div className="gh-card-actions">
        {pr && onOpen
          ? <button className="primary-btn gh-card-primary" onClick={() => onOpen(item.number)}>Review details</button>
          : <button className="primary-btn gh-card-primary" title={`Start a session for this ${ref}`} onClick={() => onStartSession(item, kind)}><Icon.session /> New session</button>}
        {pr && <button className="small-btn gh-action-secondary" title={`Start a session for this ${ref}`} onClick={() => onStartSession(item, kind)}><Icon.session /> New session</button>}
        <button className="small-btn gh-action-secondary" title="Add this context to chat" onClick={askInChat}><Icon.chat /> Ask in chat</button>
        <div className="gh-card-overflow">
          <button
            ref={triggerRef}
            className="small-btn icon-only"
            aria-label={`More actions for ${ref}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          ><Icon.more /></button>
          {menuOpen && (
            <div ref={menuRef} className="gh-card-menu" role="menu" onKeyDown={onMenuKeyDown}>
              {pr && <button role="menuitem" onClick={() => runMenuAction(() => onStartSession(item, kind))}><Icon.session /> New session</button>}
              <button role="menuitem" onClick={() => runMenuAction(askInChat)}><Icon.chat /> Ask in chat</button>
              <a role="menuitem" href={item.url} target="_blank" rel="noreferrer"><Icon.external /> Open on GitHub</a>
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
  const [openPr, setOpenPr] = useState<number | null>(null);
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
          setReason(nextStatus.reason ?? "No GitHub repository detected.");
          return;
        }
        if (!nextStatus.authenticated) {
          setReason(nextStatus.reason ?? "Sign in with GitHub CLI to load repository activity.");
          return;
        }
        const [issueResult, prResult] = await Promise.all([api.githubIssues(projectId), api.githubPrs(projectId)]);
        if (!active) return;
        if (issueResult.ok) setIssues(issueResult.data); else setReason(issueResult.reason);
        if (prResult.ok) setPrs(prResult.data); else setReason(prResult.reason);
      } catch (cause) {
        if (active) setReason(friendlyError("Couldn’t load GitHub data", cause));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [projectId, reloadKey]);

  const startSession = (item: GithubIssueDto | GithubPrDto, kind: Tab) => {
    if (!projectId) return;
    const label = kind === "prs" ? "PR" : "issue";
    startNewSession(projectId, {
      title: `${label} #${item.number}: ${item.title}`.slice(0, 80),
      draft: [
        `Work on GitHub ${label} #${item.number}: "${item.title}" (${item.url}).`,
        ...(kind === "prs" ? [`Head branch: ${(item as GithubPrDto).headRefName}.`] : []),
        `Start by reading the ${label} and summarizing what needs to happen.`,
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

  if (!projectId) return <EmptyState title="No project selected" description="Open a project to browse its GitHub repository." />;

  if (openPr !== null) {
    return <div className="view-page github-page"><PullRequestView number={openPr} onClose={() => setOpenPr(null)} /></div>;
  }

  const filters: Array<{ id: Filter; label: string }> = tab === "prs"
    ? [{ id: "all", label: "All" }, { id: "ready", label: "Ready" }, { id: "draft", label: "Drafts" }]
    : [{ id: "all", label: "All" }, { id: "open", label: "Open" }, { id: "closed", label: "Closed" }];

  return (
    <div className="view-page github-page">
      <header className="github-head">
        <div>
          <h1 className="view-title">GitHub</h1>
          <p className="view-sub">Issues and pull requests for this project.</p>
        </div>
        <button className="small-btn" disabled={loading} onClick={() => setReloadKey((key) => key + 1)}><Icon.refresh /> Refresh</button>
      </header>

      {loading && !status && (
        <div className="gh-skeleton-list" aria-label="Loading GitHub activity" aria-busy="true">
          <div className="source-skeleton gh-skeleton" /><div className="source-skeleton gh-skeleton" /><div className="source-skeleton gh-skeleton" />
        </div>
      )}

      {!loading && !status && reason && <EmptyState title="Couldn’t load GitHub" description={reason} actionLabel="Retry" onAction={() => setReloadKey((key) => key + 1)} />}

      {status && !status.installed && (
        <EmptyState
          title="GitHub CLI isn’t installed"
          description="Install the GitHub CLI from cli.github.com, then run gh auth login. Polyth never stores your GitHub token."
          actionLabel="Check again"
          onAction={() => setReloadKey((key) => key + 1)}
        />
      )}

      {status?.installed && !status.repo && (
        <EmptyState
          title="No GitHub repository found"
          description={reason || "Add a GitHub remote to this repository, then refresh."}
          actionLabel="Check again"
          onAction={() => setReloadKey((key) => key + 1)}
        />
      )}

      {status?.repo && !status.authenticated && (
        <div className="gh-connect-state">
          <span className="gh-connect-icon"><Icon.github /></span>
          <div>
            <h2>Connect GitHub CLI</h2>
            <p>{reason || "Run gh auth login in your terminal, then return here to review issues and pull requests."}</p>
            <code>gh auth login</code>
          </div>
          <button className="primary-btn" onClick={() => setReloadKey((key) => key + 1)}>I’ve signed in</button>
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
              <span className="muted" title={status.repo.description || "GitHub repository"}>{status.repo.description || "GitHub repository"}</span>
            </div>
            <div className="gh-repo-meta">
              <span className="tag">{status.repo.isPrivate ? "Private" : "Public"}</span>
              <span className="tag mono gh-default-branch" title={status.repo.defaultBranch}><Icon.branch /><span>{status.repo.defaultBranch}</span></span>
            </div>
          </section>

          <div className="gh-list-controls">
            <div className="source-tabs gh-tabs" aria-label="GitHub resource type">
              <button className={tab === "issues" ? "active" : ""} aria-current={tab === "issues" ? "page" : undefined} onClick={() => { setTab("issues"); setFilter("all"); }}>Issues <span>{issues.length}</span></button>
              <button className={tab === "prs" ? "active" : ""} aria-current={tab === "prs" ? "page" : undefined} onClick={() => { setTab("prs"); setFilter("all"); }}>Pull requests <span>{prs.length}</span></button>
            </div>
            <div className="source-search gh-search">
              <Icon.search />
              <input value={query} placeholder={`Search ${tab === "issues" ? "issues" : "pull requests"}`} aria-label={`Search ${tab}`} onChange={(event) => setQuery(event.target.value)} />
              {query && <button className="source-search-clear" aria-label="Clear search" onClick={() => setQuery("")}>×</button>}
            </div>
            <div className="gh-filter-chips" aria-label="Filter list">
              {filters.map((item) => <button key={item.id} className={filter === item.id ? "active" : ""} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}
            </div>
          </div>

          {loading && <div className="gh-skeleton-list" aria-label="Loading repository activity" aria-busy="true"><div className="source-skeleton gh-skeleton" /><div className="source-skeleton gh-skeleton" /></div>}
          {!loading && reason && (tab === "issues" ? issues : prs).length === 0 && <EmptyState title="Couldn’t load repository activity" description={reason} actionLabel="Retry" onAction={() => setReloadKey((key) => key + 1)} />}
          {!loading && !reason && items.length === 0 && (
            <EmptyState
              title={query || filter !== "all" ? "No matching results" : `No ${tab === "issues" ? "issues" : "pull requests"}`}
              description={query || filter !== "all" ? "Try a different search or clear the active filter." : "New repository activity will appear here."}
              {...(query || filter !== "all" ? { actionLabel: "Clear filters", onAction: () => { setQuery(""); setFilter("all"); } } : {})}
            />
          )}
          <div className="gh-list">
            {items.map((item) => <GithubCard key={`${tab}-${item.number}`} item={item} kind={tab} onStartSession={startSession} {...(tab === "prs" ? { onOpen: setOpenPr } : {})} />)}
          </div>
        </>
      )}
    </div>
  );
}
