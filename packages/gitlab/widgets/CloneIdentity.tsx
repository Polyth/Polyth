import type { WebPackageHost } from "@polyth/web-sdk";
import { parseGitRemoteUrl } from "@polyth/code-hosting/remotes";
import { GitlabAccounts } from "./Accounts.tsx";

interface Props { host: WebPackageHost; repository?: string; hasAccount?: boolean; onAccountsChanged?: () => void }

/** Clone flow helper: the Git package's account picker lists connected
 * GitLab accounts and binds the chosen one server-side. When a GitLab host has
 * no connected account yet, offer to connect one in place. */
export function GitlabCloneIdentity({ host, repository = "", hasAccount = false, onAccountsChanged }: Props) {
  const remote = parseGitRemoteUrl(repository.trim());
  if (!remote || hasAccount || !/(^|\.)gitlab\./i.test(`${remote.hostname}.`)) return null;
  const origin = `${remote.protocol === "http" ? "http" : "https"}://${remote.protocol === "https" || remote.protocol === "http" ? new URL(remote.url).host : remote.hostname}`;
  return <div className="gitlab-clone-connect">
    <GitlabAccounts host={host} initialInstance={origin} onAccountsChanged={() => onAccountsChanged?.()} />
  </div>;
}

export function installGitlabClone(host: WebPackageHost): Array<() => void> {
  return [
    host.slots.register({ slot: "project.repository.options", id: "gitlab.clone-identity", order: 20, render: props => <GitlabCloneIdentity host={host} repository={typeof props.repository === "string" ? props.repository : ""} hasAccount={props.hasAccount === true} onAccountsChanged={typeof props.onAccountsChanged === "function" ? props.onAccountsChanged as () => void : undefined} /> }),
  ];
}
