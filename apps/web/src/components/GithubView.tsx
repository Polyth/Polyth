// GitHub view: repo card + issues/PRs lists over the gh CLI. Fails soft with
// the reason (gh missing, signed out, no GitHub remote). Selecting a PR opens
// the detail surface (overview/files/checks/comments).
import { useEffect, useState } from "react";
import { api, type GithubIssueDto, type GithubPrDto, type GithubStatusDto } from "../api.ts";
import { useStore } from "../store.ts";
import { requestComposerInsert } from "../composerInsert.ts";
import { setActiveView } from "../store.ts";
import PullRequestView from "./PullRequestView.tsx";
import EmptyState from "./EmptyState.tsx";

type Tab = "issues" | "prs";

function ItemRow({ item, kind, onOpen }: { item: GithubIssueDto | GithubPrDto; kind: Tab; onOpen?: (n: number) => void }) {
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

  useEffect(() => {
    if (!projectId) return;
    let stale = false;
    setLoading(true);
    setReason("");
    void api.githubStatus(projectId).then(async (st) => {
      if (stale) return;
      setStatus(st);
      if (!st.repo) {
        setReason(st.reason ?? "No GitHub repository detected.");
        setLoading(false);
        return;
      }
      const [i, p] = await Promise.all([api.githubIssues(projectId), api.githubPrs(projectId)]);
      if (stale) return;
      if (i.ok) setIssues(i.data); else setReason(i.reason);
      if (p.ok) setPrs(p.data); else setReason(p.reason);
      setLoading(false);
    });
    return () => { stale = true; };
  }, [projectId]);

  if (!projectId) return <EmptyState title="No project selected" description="Open a project to browse its GitHub repository." />;

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
          {!loading && reason && items.length === 0 && <EmptyState title="Couldn’t load GitHub data" description={reason} />}
          {!loading && !reason && items.length === 0 && (
            <EmptyState title={`No open ${tab === "issues" ? "issues" : "pull requests"}`} description="New repository activity will appear here." />
          )}
          <div className="gh-list">
            {items.map((it) => (
              <ItemRow key={`${tab}-${it.number}`} item={it} kind={tab} {...(tab === "prs" ? { onOpen: setOpenPr } : {})} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
