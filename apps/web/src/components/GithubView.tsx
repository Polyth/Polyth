// GitHub view: repo card + issues/PRs lists over the gh CLI. Fails soft with
// the reason (gh missing, signed out, no GitHub remote). Selecting a PR opens
// the detail surface (overview/files/checks/comments).
import { useEffect, useState } from "react";
import { api, type GithubIssueDto, type GithubPrDto, type GithubStatusDto } from "../api.ts";
import { setActiveView, setUiError, startNewSession, useStore } from "../store.ts";
import { requestComposerInsert } from "../composerInsert.ts";
import { friendlyError } from "../settings.ts";
import PullRequestView from "./PullRequestView.tsx";
import EmptyState from "./EmptyState.tsx";

type Tab = "issues" | "prs";

function ItemRow({ item, kind, onOpen, onStartSession }: {
  item: GithubIssueDto | GithubPrDto;
  kind: Tab;
  onOpen?: (n: number) => void;
  onStartSession: (item: GithubIssueDto | GithubPrDto, kind: Tab) => void;
}) {
  const pr = kind === "prs" ? (item as GithubPrDto) : null;
  const ref = `${kind === "prs" ? "PR" : "issue"} #${item.number}`;
  return (
    <div className="gh-row">
      <span className={`gh-state ${item.state.toLowerCase()}${pr?.isDraft ? " draft" : ""}`}>
        {pr?.isDraft ? "draft" : item.state.toLowerCase()}
      </span>
      <a className="gh-title" href={item.url} target="_blank" rel="noreferrer" title={item.title}>
        <span className="gh-number mono">#{item.number}</span> {item.title}
      </a>
      {pr && <span className="gh-branch mono">{pr.headRefName}</span>}
      <span className="gh-meta">{item.author}{item.updatedAt ? ` · ${new Date(item.updatedAt).toLocaleDateString()}` : ""}</span>
      {pr && onOpen && (
        <button className="small-btn" title="Open PR details, checks, and comments" onClick={() => onOpen(item.number)}>Details</button>
      )}
      <button
        className="small-btn"
        title={`Start a new session with this ${kind === "prs" ? "PR" : "issue"} as the first draft`}
        onClick={() => onStartSession(item, kind)}
      >+ session</button>
      <button
        className="small-btn"
        title="Ask about this in the session composer"
        onClick={() => {
          requestComposerInsert(`Look at GitHub ${ref}: "${item.title}" (${item.url}).`);
          setActiveView("session");
        }}
      >→ chat</button>
    </div>
  );
}

export default function GithubView() {
  const projectId = useStore((s) => s.activeProjectId);
  const [status, setStatus] = useState<GithubStatusDto | null>(null);
  const [tab, setTab] = useState<Tab>("issues");
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
        const st = await api.githubStatus(projectId);
        if (!active) return;
        setStatus(st);
        if (!st.repo) {
          setReason(st.reason ?? "No GitHub repository detected.");
          return;
        }
        const [i, p] = await Promise.all([api.githubIssues(projectId), api.githubPrs(projectId)]);
        if (!active) return;
        if (i.ok) setIssues(i.data); else setReason(i.reason);
        if (p.ok) setPrs(p.data); else setReason(p.reason);
      } catch (cause) {
        if (active) setReason(friendlyError("Couldn’t load GitHub data", cause));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [projectId, reloadKey]);

  if (!projectId) return <EmptyState title="No project selected" description="Open a project to browse its GitHub repository." />;

  // F7 / OC-15-002/003: bootstrap a session from an issue or PR. The context
  // lands as the composer draft (saved before the session opens so the
  // composer restores it) — nothing is sent until the user does.
  const startSession = (item: GithubIssueDto | GithubPrDto, kind: Tab) => {
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

  if (openPr !== null) {
    return (
      <div className="view-page">
        <PullRequestView number={openPr} onClose={() => setOpenPr(null)} />
      </div>
    );
  }

  const items = tab === "issues" ? issues : prs;

  return (
    <div className="view-page">
      <div>
        <h2 className="view-title">GitHub</h2>
        <p className="view-sub">Repo, issues and pull requests via the local gh CLI — Polyth stores no tokens.</p>
      </div>

      {loading && !status && <div className="set-muted" role="status">Loading repository activity…</div>}
      {!loading && !status && reason && (
        <EmptyState
          title="Couldn’t load GitHub data"
          description={reason}
          actionLabel="Retry"
          onAction={() => setReloadKey((key) => key + 1)}
        />
      )}
      {status && !status.installed && (
        <EmptyState title="GitHub CLI not found" description="Install gh from cli.github.com, then authenticate with gh auth login." />
      )}
      {status && status.installed && !status.repo && (
        <EmptyState title="No GitHub repository" description={reason || "No GitHub repository was detected for this project."} />
      )}

      {status?.repo && (
        <>
          <div className="gh-repo-card">
            <div>
              <a className="gh-repo-name" href={status.repo.url} target="_blank" rel="noreferrer">
                {status.repo.owner}/{status.repo.name}
              </a>
              {status.repo.description && <div className="muted">{status.repo.description}</div>}
            </div>
            <div className="gh-repo-meta">
              <span className="tag">{status.repo.isPrivate ? "private" : "public"}</span>
              <span className="tag mono">{status.repo.defaultBranch}</span>
              {!status.authenticated && <span className="tag">signed out</span>}
            </div>
          </div>

          <div className="seg">
            <button className={tab === "issues" ? "on" : ""} onClick={() => setTab("issues")}>Issues ({issues.length})</button>
            <button className={tab === "prs" ? "on" : ""} onClick={() => setTab("prs")}>Pull requests ({prs.length})</button>
          </div>

          {loading && <div className="set-muted">Loading repository activity…</div>}
          {!loading && reason && items.length === 0 && (
            <EmptyState
              title="Couldn’t load GitHub data"
              description={reason}
              actionLabel="Retry"
              onAction={() => setReloadKey((key) => key + 1)}
            />
          )}
          {!loading && !reason && items.length === 0 && (
            <EmptyState title={`No open ${tab === "issues" ? "issues" : "pull requests"}`} description="New repository activity will appear here." />
          )}
          <div className="gh-list">
            {items.map((it) => (
              <ItemRow key={`${tab}-${it.number}`} item={it} kind={tab}
          onStartSession={startSession}
                {...(tab === "prs" ? { onOpen: setOpenPr } : {})} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
