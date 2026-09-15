import { useEffect, useRef, useState, type Ref, type ChangeEvent } from "react";
import { createApiTransport, type WebPackageHost } from "@polyth/web-sdk";
import type { HostingResult } from "@polyth/code-hosting/types";
import type { GitlabAccount } from "../src/auth.ts";
import type { GitRemoteLocation, GitlabRemoteBinding } from "../src/remote.ts";
import { gitlabText, type GitlabMessageKey } from "../src/i18n/index.ts";

const api = createApiTransport();
interface Context { accounts: GitlabAccount[]; remotes: GitRemoteLocation[]; binding: GitlabRemoteBinding | null; reason?: string }
interface CurrentChangeRequest { number: number; title: string; url: string; changedFiles: number; additions: number; deletions: number }
const message = (error: unknown, fallback: string): string => {
  if (!(error instanceof Error)) return fallback;
  try { const parsed = JSON.parse(error.message); if (typeof parsed.reason === "string") return parsed.reason; } catch { /* Already a plain diagnostic. */ }
  return error.message;
};
const read = async <T,>(promise: Promise<HostingResult<T>>): Promise<T> => {
  const result = await promise;
  if (!result.ok) throw new Error(result.reason);
  return result.data;
};
const applicable = (account: GitlabAccount, remote: GitRemoteLocation) => {
  const instance = new URL(account.instanceId);
  return remote.protocol === "https" || remote.protocol === "http" ? new URL(remote.url).origin === instance.origin : instance.hostname.replace(/^\[|\]$/g, "") === remote.hostname;
};

export function GitlabAccounts({ host, initialInstance = "https://gitlab.com", onAccountsChanged }: { host: WebPackageHost; initialInstance?: string; onAccountsChanged?: (accounts: GitlabAccount[]) => void }) {
  const { Button, TextInput } = host.ui.components;
  const t = (key: GitlabMessageKey, vars?: Record<string, string | number>) => gitlabText(host.ui.locale.get(), key, vars);
  const [accounts, setAccounts] = useState<GitlabAccount[]>([]);
  const [instance, setInstance] = useState(initialInstance);
  const [username, setUsername] = useState("");
  const [authKind, setAuthKind] = useState("glab");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [validity, setValidity] = useState<Record<string, string>>({});
  const mounted = useRef(true);
  const refresh = () => read(api.get<HostingResult<GitlabAccount[]>>("/api/gitlab/accounts")).then(rows => { if (mounted.current) { setAccounts(rows); onAccountsChanged?.(rows); } });
  useEffect(() => { mounted.current = true; void refresh().catch(e => setError(message(e, t("unavailable")))); return () => { mounted.current = false; }; }, []);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); if (mounted.current) await refresh(); }
    catch (e) { if (mounted.current) setError(message(e, t("unavailable"))); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <details className="gitlab-accounts">
    <summary><strong>{t("title")}</strong><span>{accounts.length ? t("connected", { count: accounts.length }) : t("notConnected")}</span></summary>
    <p className="muted">{t("description")}</p>
    {accounts.map(account => <div className="gitlab-account-row" key={account.id}>
      <div><strong>@{account.username}</strong><small>{account.instanceId} · {account.authKind}</small>{validity[account.id] && <small role="status">{validity[account.id]}</small>}</div>
      <Button size="sm" disabled={busy} onClick={() => void run(async () => {
        try { await read(api.post<HostingResult<unknown>>(`/api/gitlab/accounts/${account.id}/verify`, {})); setValidity(v => ({ ...v, [account.id]: t("connectedStatus") })); }
        catch (e) { setValidity(v => ({ ...v, [account.id]: message(e, t("unavailable")) })); }
      })}>{t("check")}</Button>
      <Button size="sm" disabled={busy} onClick={() => void run(() => api.delete(`/api/gitlab/accounts/${account.id}`))}>{t("remove")}</Button>
    </div>)}
    <form onSubmit={event => { event.preventDefault(); void run(async () => {
      await read(api.post<HostingResult<GitlabAccount>>("/api/gitlab/accounts", { instance, username, authKind, ...(authKind === "pat" ? { token } : {}) }));
      setToken(""); setUsername("");
    }); }}>
      <label>{t("instance")}<TextInput value={instance} required disabled={busy} placeholder="https://gitlab.company.com" onChange={(e: ChangeEvent<HTMLInputElement>) => setInstance(e.target.value)} /></label>
      <label>{t("username")}<TextInput value={username} required disabled={busy} autoComplete="username" onChange={(e: ChangeEvent<HTMLInputElement>) => setUsername(e.target.value)} /></label>
      <label>{t("authentication")}<select value={authKind} disabled={busy} onChange={e => { setAuthKind(e.target.value); setToken(""); }}><option value="glab">{t("glabLogin")}</option><option value="pat">{t("personalToken")}</option></select></label>
      {authKind === "pat" ? <label>{t("accessToken")}<TextInput type="password" value={token} required disabled={busy} autoComplete="off" onChange={(e: ChangeEvent<HTMLInputElement>) => setToken(e.target.value)} /></label> : <p className="muted">{t("signIn", { host: (() => { try { return new URL(instance).host; } catch { return "gitlab.com"; } })() })}</p>}
      <Button type="submit" disabled={busy || !username.trim() || (authKind === "pat" && !token.trim())} busy={busy}>{t("addAccount")}</Button>
    </form>
    {error && <p role="alert">{error}</p>}
  </details>;
}

export function GitlabIdentity({ host, projectId }: { host: WebPackageHost; projectId: string }) {
  const t = (key: GitlabMessageKey, vars?: Record<string, string | number>) => gitlabText(host.ui.locale.get(), key, vars);
  const [context, setContext] = useState<Context | null>(null);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    const gen = ++generation.current;
    setContext(null); setError(""); setBusy(false);
    void read(api.get<HostingResult<Context>>(`/api/gitlab/context?projectId=${encodeURIComponent(projectId)}`)).then(data => {
      if (gen !== generation.current) return;
      setContext(data);
      const selected = data.binding?.observedUrl ?? data.remotes.find(r => r.hostname === "gitlab.com" || data.accounts.some(a => applicable(a, r)))?.url ?? data.remotes[0]?.url ?? "";
      setRemoteUrl(selected);
    }).catch(e => { if (gen === generation.current) setError(message(e, t("unavailable"))); });
    return () => { generation.current++; };
  }, [projectId]);
  if (!context || !context.remotes.some(r => r.hostname === "gitlab.com" || context.accounts.some(a => applicable(a, r))) && !context.binding) return null;
  const account = context.accounts.find(a => a.id === context.binding?.accountId);
  const remote = context.remotes.find(r => r.url === remoteUrl);
  const Menu = host.ui.components.Menu;
  const entries = context.accounts.map(a => ({
    id: a.id, label: `@${a.username}`, detail: `${a.instanceId}${remote && applicable(a, remote) ? "" : ` · ${t("anotherInstance")}`}`,
    kind: "radio", checked: context.binding?.accountId === a.id, disabled: busy || !remote || !applicable(a, remote),
    onSelect: async () => {
      if (!remote || busy) return;
      const gen = generation.current;
      setBusy(true); setError("");
      try {
        const binding = await read(api.post<HostingResult<GitlabRemoteBinding>>("/api/gitlab/binding", { projectId, accountId: a.id, remoteName: remote.remoteName, observedUrl: remote.url }));
        if (gen === generation.current) setContext(c => c ? { ...c, binding, reason: undefined } : c);
      } catch (e) { if (gen === generation.current) setError(message(e, t("unavailable"))); }
      finally { if (gen === generation.current) setBusy(false); }
    },
  }));
  return <div className="gitlab-identity">
    <Menu title={t("selectAccount")} label={t("identityTitle")} entries={[...entries, "separator", { id: "manage", label: t("manage"), onSelect: () => host.navigation.openSettingsPage("integrations") }]} footer={<div className="gitlab-identity-footer">
      <label>{t("repositoryRemote")}<select value={remoteUrl} disabled={busy} onChange={e => setRemoteUrl(e.target.value)}>{context.remotes.map(r => <option key={`${r.remoteName}:${r.url}`} value={r.url}>{r.remoteName} · {r.hostname}/{r.fullPath}</option>)}</select></label>
      <small>{t("hostingIdentity")}</small>
    </div>}>
      {(trigger: { ref: Ref<HTMLButtonElement>; onClick: () => void; "aria-haspopup": "menu" | "dialog"; "aria-expanded": boolean }) => <button {...trigger} type="button" className="gitlab-identity-trigger" title={context.reason ?? t("identityTitle")}>{t("title")} · {account ? `@${account.username}` : t("connect")}{context.reason ? " !" : ""}</button>}
    </Menu>
    {error && <span role="alert">{error}</span>}
    {context.reason && <span role="status">{context.reason}</span>}
  </div>;
}

function GitlabChangeRequestState({ host, projectId }: { host: WebPackageHost; projectId: string }) {
  const [mergeRequest, setMergeRequest] = useState<CurrentChangeRequest | null>(null);
  useEffect(() => {
    let stale = false;
    setMergeRequest(null);
    void api.get<HostingResult<CurrentChangeRequest>>(`/api/gitlab/pr/current?projectId=${encodeURIComponent(projectId)}`)
      .then(result => { if (!stale && result.ok) setMergeRequest(result.data); })
      .catch(() => {});
    return () => { stale = true; };
  }, [projectId]);
  if (!mergeRequest) return null;
  return <host.ui.components.Button
    size="sm"
    variant="ghost"
    title={mergeRequest.title}
    onClick={() => host.navigation.openWorkspacePane("gitlab")}
  >MR !{mergeRequest.number}</host.ui.components.Button>;
}

export function installGitlabAccounts(host: WebPackageHost): Array<() => void> {
  return [
    host.slots.register({ slot: "settings.integrations", id: "gitlab.accounts", order: 20, render: () => <GitlabAccounts host={host} /> }),
    host.slots.register({ slot: "git.repository.identity.provider", id: "gitlab.identity", order: 20, render: props => typeof props.projectId === "string" ? <GitlabIdentity host={host} projectId={props.projectId} /> : null }),
    host.slots.register({ slot: "git.repository.change-request.provider", id: "gitlab.change-request", order: 20, render: props => typeof props.projectId === "string" ? <GitlabChangeRequestState host={host} projectId={props.projectId} /> : null }),
  ];
}
