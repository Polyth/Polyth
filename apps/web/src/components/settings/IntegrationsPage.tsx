// Integrations settings: GitHub over the gh CLI. Read-only status + counts;
// fails soft with the reason when gh is missing, unauthenticated, or the
// project has no GitHub remote.
import { useEffect, useState } from "react";
import { api, type GithubStatusDto } from "../../api.ts";
import { setActiveView, setOverlay, useStore } from "../../store.ts";
import { pluginOn, togglePlugin } from "../../prefs.ts";
import { EmptyState, PageHead, Row, Toggle } from "./parts.tsx";

export default function IntegrationsPage() {
  const projectId = useStore((s) => s.activeProjectId);
  const [status, setStatus] = useState<GithubStatusDto | null>(null);
  const [counts, setCounts] = useState<{ issues: number; prs: number } | null>(null);
  const githubOn = pluginOn("github");

  useEffect(() => {
    if (!projectId) { setStatus(null); setCounts(null); return; }
    let stale = false;
    void api.githubStatus(projectId).then((st) => {
      if (stale) return;
      setStatus(st);
      if (st.repo) {
        void Promise.all([api.githubIssues(projectId, 100), api.githubPrs(projectId, 100)]).then(([i, p]) => {
          if (!stale) setCounts({ issues: i.ok ? i.data.length : 0, prs: p.ok ? p.data.length : 0 });
        });
      }
    });
    return () => { stale = true; };
  }, [projectId]);

  return (
    <>
      <PageHead title="Integrations" blurb="External services wired through local CLIs — no tokens stored by Polyth." />
      <Row label="GitHub plugin" hint="Adds the GitHub view (repo, issues, pull requests).">
        <Toggle on={githubOn} onChange={() => togglePlugin("github")} label="GitHub plugin" />
      </Row>
      {!projectId && <EmptyState title="No active project" />}
      {projectId && status && (
        <>
          <Row label="GitHub CLI" hint={status.installed ? "gh is installed" : "Install gh from cli.github.com"}>
            <span className={`tag ${status.installed ? "tag-ok" : ""}`}>{status.installed ? "installed" : "missing"}</span>
          </Row>
          <Row label="Authentication" hint={status.authenticated ? "Signed in via gh auth" : "Run `gh auth login` in a terminal"}>
            <span className={`tag ${status.authenticated ? "tag-ok" : ""}`}>{status.authenticated ? "signed in" : "signed out"}</span>
          </Row>
          {status.repo ? (
            <>
              <Row label="Repository" hint={status.repo.description || undefined}>
                <a className="mono" href={status.repo.url} target="_blank" rel="noreferrer">
                  {status.repo.owner}/{status.repo.name}
                </a>
              </Row>
              {counts && (
                <Row label="Open items">
                  <span className="mono">{counts.issues} issues · {counts.prs} PRs</span>
                </Row>
              )}
              <Row label="Full view" hint="Browse issues and pull requests.">
                <button className="small-btn" onClick={() => { setOverlay(null); setActiveView("github"); }}>Open GitHub view →</button>
              </Row>
            </>
          ) : (
            <EmptyState title="No GitHub repository detected" body={status.reason ?? "This project has no GitHub remote."} />
          )}
        </>
      )}
    </>
  );
}
