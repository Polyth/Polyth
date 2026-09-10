import { useEffect, useState, useSyncExternalStore } from "react";
import { createApiTransport, type WebPackageHost } from "@polyth/web-sdk";
import type { HostingResult, HostingStatus } from "@polyth/code-hosting/types";
import type { GitRemoteLocation } from "@polyth/code-hosting/remotes";
import { githubProvider } from "./GithubView.tsx";

const api = createApiTransport();
interface Context { remotes: GitRemoteLocation[]; user: HostingStatus["user"] }
function useContext(host: WebPackageHost, explicitProjectId?: string) {
  const state = useSyncExternalStore(host.store.subscribe, host.store.getSnapshot, host.store.getSnapshot);
  const projectId = explicitProjectId ?? state.activeProjectId;
  const [context, setContext] = useState<Context | null>(null);
  useEffect(() => {
    let stale = false; setContext(null);
    if (projectId) void api.get<HostingResult<Context>>(`/api/github/context?projectId=${encodeURIComponent(projectId)}`).then(r => { if (!stale && r.ok) setContext(r.data); }).catch(() => {});
    return () => { stale = true; };
  }, [projectId]);
  return { projectId, context };
}
export function GithubIdentity({ host, projectId }: { host: WebPackageHost; projectId: string }) {
  const { context } = useContext(host, projectId);
  if (!context?.remotes.some(r => r.hostname === "github.com")) return null;
  return <host.ui.components.Button size="sm" variant="ghost" title="GitHub CLI account" onClick={() => host.navigation.openSettingsPage("integrations")}>GitHub · {context.user ? `@${context.user.login}` : "gh"}</host.ui.components.Button>;
}
function GithubIntegration({ host }: { host: WebPackageHost }) {
  const { projectId, context } = useContext(host);
  const t = githubProvider(host).t;
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<HostingStatus | null>(null);
  const [counts, setCounts] = useState<{ issues: number; prs: number } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let stale = false; setStatus(null); setCounts(null); setError("");
    if (open && projectId) void api.get<HostingStatus>(`/api/github/status?projectId=${encodeURIComponent(projectId)}`).then(async next => {
      if (stale) return; setStatus(next);
      if (next.repo) {
        const [i, p] = await Promise.all([api.get<HostingResult<unknown[]>>(`/api/github/issues?projectId=${encodeURIComponent(projectId)}&limit=100`), api.get<HostingResult<unknown[]>>(`/api/github/prs?projectId=${encodeURIComponent(projectId)}&limit=100`)]);
        if (!stale) setCounts({ issues: i.ok ? i.data.length : 0, prs: p.ok ? p.data.length : 0 });
      }
    }).catch(e => { if (!stale) setError(host.errors.friendly("GitHub", e)); });
    return () => { stale = true; };
  }, [projectId, open]);
  return <details className="hosting-integration" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary><strong>GitHub</strong><span>{context?.user ? `@${context.user.login}` : "gh"}</span></summary>
    {!projectId ? <p>{t("githubview.noProjectSelected")}</p> : status ? <>
      <p>{status.authenticated ? t("settings.integrationspage.signedIn") : t("settings.integrationspage.runGhAuthLoginInATerminal")}</p>
      <p>{status.installed ? t("settings.integrationspage.ghIsInstalled") : t("settings.integrationspage.installGhFromCliGithubCom")}</p>
      {status.repo && <a href={status.repo.url} target="_blank" rel="noreferrer">{status.repo.owner}/{status.repo.name}</a>}
      {status.reason && <p role="status">{status.reason}</p>}
      {counts && <p>{counts.issues} {t("settings.integrationspage.issues")} · {counts.prs} {t("settings.integrationspage.prs")}</p>}
      <host.ui.components.Button size="sm" onClick={() => { host.navigation.setOverlay(null); host.navigation.openWorkspacePane("github"); }}>{t("settings.integrationspage.openGithubView")}</host.ui.components.Button>
    </> : <p role="status">{t("githubview.loadingGithubActivity")}</p>}
    {error && <p role="alert">{error}</p>}
  </details>;
}
export function installGithubIntegration(host: WebPackageHost): Array<() => void> {
  return [
    host.slots.register({ slot: "settings.integrations", id: "github.integration", order: 10, render: () => <GithubIntegration host={host} /> }),
    host.slots.register({ slot: "git.repository.identity", id: "github.identity", order: 10, render: props => typeof props.projectId === "string" ? <GithubIdentity host={host} projectId={props.projectId} /> : null }),
  ];
}
