import { useEffect, useState, useSyncExternalStore } from "react";
import { createApiTransport, type WebPackageHost } from "@polyth/web-sdk";
import type { HostingResult, HostingStatus } from "@polyth/code-hosting/types";
import type { GitRemoteLocation } from "@polyth/code-hosting/remotes";
import GithubAccounts from "./GithubAccounts.tsx";
import { ReadonlyRow, Section } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";

const api = createApiTransport();
interface Context { remotes: GitRemoteLocation[]; user: HostingStatus["user"] }
interface CurrentChangeRequest { number: number; title: string; url: string; changedFiles: number; additions: number; deletions: number }
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
  if (!context.user) {
    return <div className="github-repository-provider">
      <span>{tr("githubview.identityWithStatus", { status: tr("gitview.providerNotConnected") })}</span>
      <host.ui.components.Button size="sm" variant="quiet" onClick={() => host.navigation.openSettingsPage("git", { itemId: "git.personAccounts" })}>
        {tr("gitview.providerSignIn")}
      </host.ui.components.Button>
    </div>;
  }
  return <host.ui.components.Button size="sm" variant="ghost" title={tr("githubview.identityLabel")} onClick={() => host.navigation.openSettingsPage("git", { itemId: "git.personAccounts" })}>{tr("githubview.identityWithStatus", { status: context.user ? `@${context.user.login}` : "gh" })}</host.ui.components.Button>;
}
function GithubChangeRequestState({ host, projectId }: { host: WebPackageHost; projectId: string }) {
  const { context } = useContext(host, projectId);
  const [pullRequest, setPullRequest] = useState<CurrentChangeRequest | null>(null);
  const applicable = context?.remotes.some(r => r.hostname === "github.com") === true;
  useEffect(() => {
    let stale = false;
    setPullRequest(null);
    if (applicable) void api.get<HostingResult<CurrentChangeRequest>>(`/api/github/pr/current?projectId=${encodeURIComponent(projectId)}`)
      .then(result => { if (!stale && result.ok) setPullRequest(result.data); })
      .catch(() => {});
    return () => { stale = true; };
  }, [applicable, projectId]);
  if (!pullRequest) return null;
  return <host.ui.components.Button
    size="sm"
    variant="ghost"
    title={pullRequest.title}
    onClick={() => host.navigation.openWorkspacePane("github")}
  >{tr("widgets.githubplugin.pr")}{pullRequest.number}</host.ui.components.Button>;
}
/** Settings → Source control → This project → "GitHub": the repository and
 *  the GitHub CLI's sign-in as the server sees them, with a way into the
 *  GitHub view. Nothing when the project has no github.com remote. */
function GithubProjectSection({ host, projectId }: { host: WebPackageHost; projectId: string }) {
  const { context } = useContext(host, projectId);
  const [status, setStatus] = useState<HostingStatus | null>(null);
  const [error, setError] = useState("");
  const applicable = context?.remotes.some(r => r.hostname === "github.com") === true;
  useEffect(() => {
    let stale = false; setStatus(null); setError("");
    if (applicable) void api.get<HostingStatus>(`/api/github/status?projectId=${encodeURIComponent(projectId)}`)
      .then(next => { if (!stale) setStatus(next); })
      .catch(e => { if (!stale) setError(host.errors.friendly("GitHub", e)); });
    return () => { stale = true; };
  }, [applicable, projectId]);
  if (!applicable) return null;
  const login = context?.user?.login;
  const cli = !status ? { value: tr("githubproject.checking") }
    : !status.installed ? { value: tr("githubproject.notInstalled"), hint: tr("githubproject.notInstalledHint") }
    : !status.authenticated ? { value: tr("githubproject.notSignedIn"), hint: tr("githubproject.notSignedInHint") }
    : { value: login ? tr("githubproject.signedInAs", { login }) : tr("githubproject.signedIn") };
  return (
    <Section
      title={tr("githubproject.title")}
      hint={tr("githubproject.hint")}
      action={<host.ui.components.Button size="sm" variant="quiet" onClick={() => { host.navigation.setOverlay(null); host.navigation.openWorkspacePane("github"); }}>{tr("githubproject.open")}</host.ui.components.Button>}
    >
      {status?.repo && (
        <ReadonlyRow label={tr("githubproject.repository")} value={<a className="pkg-github-project-repo" href={status.repo.url} target="_blank" rel="noreferrer">{status.repo.owner}/{status.repo.name}</a>} mono />
      )}
      <ReadonlyRow label={tr("githubproject.cli")} {...(cli.hint ? { hint: cli.hint } : {})} value={cli.value} />
      {(error || status?.reason) && <p className="pkg-github-project-note" role={error ? "alert" : "status"}>{error || status?.reason}</p>}
    </Section>
  );
}
export function installGithubIntegration(host: WebPackageHost): Array<() => void> {
  return [
    // Settings → Source control: your accounts (Accounts tab) and this
    // project's GitHub repository (This project tab).
    host.slots.register({ slot: "settings.integrations", id: "github.integration", order: 10, render: () => <GithubAccounts /> }),
    host.slots.register({ slot: "settings.integrations.project", id: "github.project", order: 10, render: props => typeof props.projectId === "string" ? <GithubProjectSection host={host} projectId={props.projectId} /> : null }),
    host.slots.register({ slot: "git.repository.identity.provider", id: "github.identity", order: 10, render: props => typeof props.projectId === "string" ? <GithubIdentity host={host} projectId={props.projectId} /> : null }),
    host.slots.register({ slot: "git.repository.change-request.provider", id: "github.change-request", order: 10, render: props => typeof props.projectId === "string" ? <GithubChangeRequestState host={host} projectId={props.projectId} /> : null }),
  ];
}
