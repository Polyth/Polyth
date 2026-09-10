import { useCallback, useEffect, useRef, useState } from "react";
import { createApiTransport, type WebPackageHost } from "@polyth/web-sdk";
import { parseGitRemoteUrl } from "@polyth/code-hosting/remotes";
import type { HostingResult } from "@polyth/code-hosting/types";
import type { GitlabAccount } from "../src/auth.ts";
import { gitlabText, type GitlabMessageKey } from "../src/i18n/index.ts";
import { GitlabAccounts, GitlabIdentity } from "./Accounts.tsx";

const api = createApiTransport();
type Configure = (id: string, callback?: (projectId: string) => Promise<void>) => void;
interface Props { host: WebPackageHost; repository?: string; onConfigure?: Configure }
const read = async <T,>(request: Promise<HostingResult<T>>): Promise<T> => {
  const result = await request;
  if (!result.ok) throw new Error(result.reason);
  return result.data;
};
const accountFits = (account: GitlabAccount, repository: string): boolean => {
  const remote = parseGitRemoteUrl(repository.trim());
  if (!remote) return false;
  const instance = new URL(account.instanceId);
  return remote.protocol === "http" || remote.protocol === "https"
    ? instance.origin === new URL(remote.url).origin
    : instance.hostname.replace(/^\[|\]$/g, "") === remote.hostname;
};

export function GitlabCloneIdentity({ host, repository = "", onConfigure }: Props) {
  const t = (key: GitlabMessageKey) => gitlabText(host.ui.locale.get(), key);
  const [accounts, setAccounts] = useState<GitlabAccount[]>([]);
  const [selected, setSelected] = useState("");
  const remote = parseGitRemoteUrl(repository.trim());
  useEffect(() => {
    let active = true;
    void read(api.get<HostingResult<GitlabAccount[]>>("/api/gitlab/accounts")).then(rows => { if (active) setAccounts(rows); }).catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const matches = accounts.filter(a => accountFits(a, repository));
    setSelected(current => matches.some(a => a.id === current) ? current : matches.length === 1 ? matches[0]!.id : "");
  }, [accounts, repository]);
  useEffect(() => {
    if (!onConfigure) return;
    const account = accounts.find(a => a.id === selected && accountFits(a, repository));
    onConfigure("gitlab", account ? async projectId => {
      const context = await read(api.get<HostingResult<{ remotes: Array<{ remoteName: string; url: string }> }>>(`/api/gitlab/context?projectId=${encodeURIComponent(projectId)}`));
      // Bind only the endpoint the user entered, never another matching remote.
      const observed = context.remotes.find(r => r.url === repository.trim() && accountFits(account, r.url));
      if (!observed) throw new Error(t("remoteChanged"));
      await read(api.post<HostingResult<unknown>>("/api/gitlab/binding", { projectId, accountId: account.id, remoteName: observed.remoteName, observedUrl: observed.url }));
    } : undefined);
    return () => onConfigure("gitlab");
  }, [accounts, onConfigure, repository, selected]);
  if (!remote) return null;
  const hasMatch = accounts.some(a => accountFits(a, repository));
  return <details className="gitlab-clone-identity" open={hasMatch || undefined}>
    <summary>{t("cloneIdentity")}{selected ? ` · @${accounts.find(a => a.id === selected)?.username}` : ""}</summary>
    <small>{t("hostingIdentity")}</small>
    <label>{t("selectAccount")}<select value={selected} onChange={event => setSelected(event.target.value)}>
      <option value="">{t("skipIdentity")}</option>
      {accounts.map(account => <option key={account.id} value={account.id} disabled={!accountFits(account, repository)}>@{account.username} · {new URL(account.instanceId).host}{accountFits(account, repository) ? "" : t("anotherInstance")}</option>)}
    </select></label>
    <GitlabAccounts host={host} initialInstance={`${remote.protocol === "http" ? "http" : "https"}://${remote.protocol === "https" || remote.protocol === "http" ? new URL(remote.url).host : remote.hostname}`} onAccountsChanged={setAccounts} />
  </details>;
}

/** Optional post-add step: only an explicitly opened project receives a binding. */
function GitlabAddIdentity({ host, onConfigure }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [accountRevision, setAccountRevision] = useState(0);
  const accountsChanged = useCallback(() => setAccountRevision(value => value + 1), []);
  const done = useRef<(() => void) | null>(null);
  const t = (key: GitlabMessageKey) => gitlabText(host.ui.locale.get(), key);
  const finish = useCallback(() => { done.current?.(); done.current = null; }, []);
  useEffect(() => {
    onConfigure?.("gitlab", enabled ? id => new Promise<void>(resolve => { done.current = resolve; setProjectId(id); }) : undefined);
    return () => { onConfigure?.("gitlab"); finish(); };
  }, [enabled, onConfigure, finish]);
  const { Button } = host.ui.components;
  return <div className="gitlab-add-identity">
    {!projectId ? <label><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /> {t("configureAfterOpen")}</label> : <>
      <GitlabIdentity key={accountRevision} host={host} projectId={projectId} />
      <GitlabAccounts host={host} onAccountsChanged={accountsChanged} />
      <Button onClick={finish}>{t("continue")}</Button>
    </>}
  </div>;
}

export function installGitlabClone(host: WebPackageHost): Array<() => void> {
  const configure = (props: Record<string, unknown>): Configure | undefined => typeof props.onConfigure === "function" ? props.onConfigure as Configure : undefined;
  return [
    host.slots.register({ slot: "project.repository.options", id: "gitlab.clone-identity", order: 20, render: props => <GitlabCloneIdentity host={host} repository={typeof props.repository === "string" ? props.repository : ""} onConfigure={configure(props)} /> }),
    host.slots.register({ slot: "project.create.options", id: "gitlab.add-identity", order: 30, render: props => props.armedId ? null : <GitlabAddIdentity host={host} onConfigure={configure(props)} /> }),
  ];
}
