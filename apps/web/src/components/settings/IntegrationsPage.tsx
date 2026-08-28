// Integrations settings: GitHub over the gh CLI. Read-only status + counts;
// fails soft with the reason when gh is missing, unauthenticated, or the
// project has no GitHub remote.
import { useEffect, useState } from "react";
import { api, type GithubStatusDto } from "@polyth/session/web-api";
import { setActiveView, setOverlay, useStore } from "../../store.ts";
import { EmptyState, PageHead, Row } from "./parts.tsx";
import { tr } from "../../i18n/index.ts";
import { Button } from "../ui/index.ts";

export default function IntegrationsPage() {
  const projectId = useStore((s) => s.activeProjectId);
  const [status, setStatus] = useState<GithubStatusDto | null>(null);
  const [counts, setCounts] = useState<{ issues: number; prs: number } | null>(null);

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
      <PageHead title={tr("settings.integrationspage.integrations")} blurb={tr("settings.integrationspage.externalServicesWiredThroughLocalClisNo")} />
      {!projectId && <EmptyState title={tr("settings.integrationspage.noActiveProject")} />}
      {projectId && status && (
        <>
          <Row label={tr("settings.integrationspage.githubCli")} hint={status.installed ? tr("settings.integrationspage.ghIsInstalled") : tr("settings.integrationspage.installGhFromCliGithubCom")}>
            <span className={`tag ${status.installed ? "tag-ok" : ""}`}>{status.installed ? tr("settings.integrationspage.installed") : tr("settings.integrationspage.missing")}</span>
          </Row>
          <Row label={tr("settings.integrationspage.authentication")} hint={status.authenticated ? tr("settings.integrationspage.signedInViaGhAuth") : tr("settings.integrationspage.runGhAuthLoginInATerminal")}>
            <span className={`tag ${status.authenticated ? "tag-ok" : ""}`}>{status.authenticated ? tr("settings.integrationspage.signedIn") : tr("settings.integrationspage.signedOut")}</span>
          </Row>
          {status.repo ? (
            <>
              <Row label={tr("settings.integrationspage.repository")} hint={status.repo.description || undefined}>
                <a className="mono" href={status.repo.url} target="_blank" rel="noreferrer">
                  {status.repo.owner}/{status.repo.name}
                </a>
              </Row>
              {counts && (
                <Row label={tr("settings.integrationspage.openItems")}>
                  <span className="mono">{counts.issues} {tr("settings.integrationspage.issues")}{" "}{counts.prs} {tr("settings.integrationspage.prs")}</span>
                </Row>
              )}
              <Row label={tr("settings.integrationspage.fullView")} hint={tr("settings.integrationspage.browseIssuesAndPullRequests")}>
                <Button size="sm" onClick={() => { setOverlay(null); setActiveView("github"); }}>{tr("settings.integrationspage.openGithubView")}</Button>
              </Row>
            </>
          ) : (
            <EmptyState
              title={tr("settings.integrationspage.noGithubRepositoryDetected")}
              body={status.reason ?? tr("settings.integrationspage.projectHasNoGithubRemote")}
            />
          )}
        </>
      )}
    </>
  );
}
