// "Clone repository" — a project-create source contributed to the folder
// picker's `project.create.options` slot. It is disclosed inline inside the
// picker: the picker's folder browser remains the clone destination.
//
// The user picks the code-hosting account (a GitHub `gh` login, a GitLab
// account connected in Polyth, … — whatever provider packages registered) that
// authenticates the clone. The server binds that account to the new project,
// so later fetch, pull and push from Polyth authenticate as the same account.
// A source-control identity with an SSH key is offered as an account too: it
// clones over SSH with that key and stays the repository's identity, so its
// commits, fetch, pull and push all use it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "@polyth/contracts";
import {
  SYSTEM_SOURCE_CONTROL_PROFILE_ID,
  inferSourceControlProvider,
  matchingSourceControlProfiles,
  parseSourceControlRemoteUrl,
  sourceControlAccountMatchesRemote,
  sourceControlRemoteOrigin,
  type SourceControlHostingAccount,
  type SourceControlProfile,
  type SourceControlRemote,
} from "@polyth/contracts/source-control";
import { createApiTransport, type WebPackageHost, isImeComposing } from "@polyth/web-sdk";
import { cloneProject } from "../../../apps/web/src/init.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, Select, TextInput, WorktreeIcon } from "../../../apps/web/src/components/ui/index.ts";
import {
  setRepositorySourceControlProfile,
  useSourceControlProfileState,
} from "./sourceControlProfiles.ts";
import { reconcileSourceControlIdentity } from "./sourceControlRuntime.ts";

const SOURCE_ID = "git-clone-project";
const AUTO_PROFILE = "auto";
const SYSTEM_ACCOUNT = "system";
const IDENTITY_PREFIX = "identity:";
const api = createApiTransport();

const message = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

const repoName = (url: string): string => {
  const trimmed = url.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  return trimmed.split(/[/:]/).pop() ?? "";
};

const providerLabel = (provider: "github" | "gitlab" | "generic"): string =>
  provider === "github" ? "GitHub" : provider === "gitlab" ? "GitLab" : "Git";

/** Generic remote parsing is intentionally broader than clone validation:
 * existing Git config may use user@host:path, while the server accepts SCP
 * clone syntax only as git@host:path. Keep the UI and backend allowlists equal. */
const parseCloneRemote = (repository: string): SourceControlRemote | null => {
  const value = repository.trim();
  const remote = parseSourceControlRemoteUrl(value);
  if (!remote || value.includes("://")) return remote;
  return /^git@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?:/i.test(value) ? remote : null;
};

const accountKey = (account: Pick<SourceControlHostingAccount, "provider" | "accountId">): string =>
  `${account.provider}:${account.accountId}`;
const identityKey = (profile: Pick<SourceControlProfile, "id">): string => `${IDENTITY_PREFIX}${profile.id}`;
const hasSshKey = (profile: SourceControlProfile | null | undefined): profile is SourceControlProfile =>
  profile?.authentication.mode === "ssh-key" && !!profile.authentication.identityFile;
const keyName = (profile: SourceControlProfile): string =>
  profile.authentication.identityFile?.split("/").pop() ?? "";

const hostOf = (origin: string): string => {
  try { return new URL(origin).host; } catch { return origin; }
};

/** Prefer the provider's active account, then the only one. */
const suggestAccount = (accounts: readonly SourceControlHostingAccount[]): SourceControlHostingAccount | null =>
  accounts.find((account) => account.active) ?? accounts[0] ?? null;

/** A saved commit identity that names the chosen account wins over defaults. */
const profileForAccount = (
  profiles: readonly SourceControlProfile[],
  account: SourceControlHostingAccount | null,
): SourceControlProfile | null => {
  if (!account) return null;
  const login = account.login.toLowerCase();
  return profiles.find((profile) => profile.provider === account.provider && profile.username?.toLowerCase() === login)
    ?? profiles.find((profile) => profile.username?.toLowerCase() === login)
    ?? null;
};

interface GitProjectSourceProps extends Record<string, unknown> {
  host: WebPackageHost;
}

interface HostContext {
  host: WebPackageHost;
  busy: boolean;
  browsedPath: string;
  armedId: string | null;
  arm: (id: string, opts?: { soloBrowser?: boolean }) => void;
  disarm: (id: string) => void;
  onProjectOpened?: () => void;
}

function readContext(props: GitProjectSourceProps): HostContext {
  return {
    host: props.host as WebPackageHost,
    busy: props.busy === true,
    browsedPath: typeof props.browsedPath === "string" ? props.browsedPath : "",
    armedId: typeof props.armedId === "string" ? props.armedId : null,
    arm: typeof props.arm === "function" ? props.arm as HostContext["arm"] : () => undefined,
    disarm: typeof props.disarm === "function" ? props.disarm as (id: string) => void : () => undefined,
    onProjectOpened: typeof props.onProjectOpened === "function" ? props.onProjectOpened as () => void : undefined,
  };
}

/** Every registered provider's accounts, refreshed on demand. */
function useHostingAccounts(): { accounts: SourceControlHostingAccount[]; loading: boolean; refresh: () => void } {
  const [accounts, setAccounts] = useState<SourceControlHostingAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void api.get<{ accounts?: SourceControlHostingAccount[] }>("/api/git/accounts")
      .then((result) => { if (active) setAccounts(Array.isArray(result.accounts) ? result.accounts : []); })
      .catch(() => { if (active) setAccounts([]); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [generation]);
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  return { accounts, loading, refresh };
}

function CloneInlinePanel({ ctx, onCancel }: { ctx: HostContext; onCancel: () => void }) {
  const profileState = useSourceControlProfileState();
  const hosting = useHostingAccounts();
  const [repository, setRepository] = useState("");
  const [name, setName] = useState("");
  const [accountChoice, setAccountChoice] = useState<string | null>(null);
  const [profileChoice, setProfileChoice] = useState(AUTO_PROFILE);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const configure = useRef(new Map<string, (projectId: string) => Promise<void>>());
  const [created, setCreated] = useState<Project | null>(null);
  const onConfigure = useCallback((id: string, callback?: (projectId: string) => Promise<void>) => {
    if (callback) configure.current.set(id, callback);
    else configure.current.delete(id);
  }, []);

  const remote = useMemo(() => parseCloneRemote(repository), [repository]);
  const origin = remote ? sourceControlRemoteOrigin(remote) : "";
  const provider = inferSourceControlProvider(remote, profileState.profiles);

  // ---- account --------------------------------------------------------------
  const accounts = useMemo(
    () => remote ? hosting.accounts.filter((account) => sourceControlAccountMatchesRemote(account, remote)) : [],
    [hosting.accounts, remote],
  );
  const suggestedAccount = useMemo(() => suggestAccount(accounts), [accounts]);
  const compatibleProfiles = useMemo(
    () => remote ? matchingSourceControlProfiles(profileState.profiles, remote) : [],
    [profileState.profiles, remote],
  );
  const sshIdentities = useMemo(() => compatibleProfiles.filter(hasSshKey), [compatibleProfiles]);
  // A new host resets the choice to that host's suggestion.
  useEffect(() => { setAccountChoice(null); setProfileChoice(AUTO_PROFILE); }, [origin]);
  const accountChoiceValid = accountChoice !== null && (
    accountChoice === SYSTEM_ACCOUNT
    || accounts.some((row) => accountKey(row) === accountChoice)
    || sshIdentities.some((profile) => identityKey(profile) === accountChoice));
  // Choosing an identity with an SSH key as the commit author also signs in
  // with it, unless the user picked the account explicitly.
  const chosenSshProfile = sshIdentities.find((profile) => profile.id === profileChoice) ?? null;
  const defaultSshProfile = !suggestedAccount
    ? sshIdentities.find((profile) => profile.id === profileState.globalDefaultProfileId)
      ?? (sshIdentities.length === 1 && compatibleProfiles.length === 1 ? sshIdentities[0]! : null)
    : null;
  const accountValue = accountChoiceValid
    ? accountChoice!
    : chosenSshProfile ? identityKey(chosenSshProfile)
      : suggestedAccount ? accountKey(suggestedAccount)
        : defaultSshProfile ? identityKey(defaultSshProfile) : SYSTEM_ACCOUNT;
  const account = accounts.find((row) => accountKey(row) === accountValue) ?? null;
  const sshIdentity = sshIdentities.find((profile) => identityKey(profile) === accountValue) ?? null;
  // Connected accounts name a self-hosted provider better than its hostname.
  const accountProviders = new Set(accounts.map((row) => row.providerLabel));
  const hostLabel = account?.providerLabel
    ?? (accountProviders.size === 1 ? [...accountProviders][0]! : providerLabel(provider));

  // ---- commit identity -------------------------------------------------------
  const suggestedProfile = useMemo(() => {
    if (sshIdentity) return sshIdentity;
    const byAccount = profileForAccount(compatibleProfiles, account);
    if (byAccount) return byAccount;
    const global = compatibleProfiles.find((profile) => profile.id === profileState.globalDefaultProfileId);
    return global ?? (compatibleProfiles.length === 1 ? compatibleProfiles[0]! : null);
  }, [sshIdentity, account, compatibleProfiles, profileState.globalDefaultProfileId]);
  // The repository's identity is what keeps an SSH identity's key applied, so
  // an identity that signs in is also the commit author.
  const profileValue = sshIdentity ? sshIdentity.id : profileChoice;
  const effectiveProfileId = sshIdentity
    ? sshIdentity.id
    : profileChoice === AUTO_PROFILE
      ? suggestedProfile?.id ?? SYSTEM_SOURCE_CONTROL_PROFILE_ID
      : profileChoice;

  const busy = submitting || ctx.busy;
  const locked = busy || !!created;
  const parentPath = ctx.browsedPath;
  const folderName = name.trim() || repoName(repository);
  const destination = parentPath && folderName ? `${parentPath.replace(/\/+$/, "")}/${folderName}` : parentPath;
  const canSubmit = !busy && remote !== null && parentPath !== "";
  const invalidUrl = repository.trim() !== "" && remote === null;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError("");
    try {
      const project: Project = created ?? await cloneProject({
        repository: repository.trim(),
        parentPath,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(account ? { account: { provider: account.provider, accountId: account.accountId } } : {}),
        ...(sshIdentity ? { identity: { profileId: sshIdentity.id } } : {}),
      });
      setCreated(project);
      const automaticNeedsOverride = profileChoice === AUTO_PROFILE
        && suggestedProfile !== null
        && suggestedProfile.id !== profileState.globalDefaultProfileId;
      // An SSH identity is pinned to the repository: a later global default
      // change must not swap the key its pushes sign in with.
      if (sshIdentity || profileChoice !== AUTO_PROFILE || automaticNeedsOverride) {
        setRepositorySourceControlProfile(project.id, effectiveProfileId);
        await reconcileSourceControlIdentity(project.id);
      }
      for (const callback of configure.current.values()) await callback(project.id);
      ctx.onProjectOpened?.();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const note = sshIdentity
    ? tr(remote?.protocol === "ssh" ? "gitprojectsource.noteIdentitySsh" : "gitprojectsource.noteIdentityHttps", {
      label: sshIdentity.label,
      key: keyName(sshIdentity),
    })
    : !account
      ? tr("gitprojectsource.noteSystem")
      : remote?.protocol === "ssh"
        ? tr("gitprojectsource.noteAccountSsh", { login: account.login })
        : tr("gitprojectsource.noteAccountHttps", { login: account.login });

  return (
    <div
      className="folder-source-panel git-clone-panel"
      role="group"
      aria-label={tr("gitprojectsource.cloneRepository")}
      // First Escape collapses this panel, the next closes the picker. The
      // Dialog's Escape listener sits on its panel and sees a bubbling event
      // first, so the panel claims it while capturing — except from an open
      // popup (select list, menu), which owns its own Escape.
      onKeyDownCapture={(event) => {
        if (isImeComposing(event)) return;
        if (event.key !== "Escape") return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('[role="listbox"], [role="menu"], [aria-expanded="true"]')) return;
        event.stopPropagation();
        if (!busy) onCancel();
      }}
    >
      <label className="folder-source-field git-clone-url">
        <span>{tr("gitprojectsource.repositoryUrl")}</span>
        <TextInput
          autoFocus
          value={repository}
          placeholder="https://github.com/owner/repo.git"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          inputMode="url"
          invalid={invalidUrl}
          disabled={locked}
          onChange={(event) => setRepository(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) void submit(); }}
        />
        <small className={`git-clone-detected${invalidUrl ? " is-invalid" : ""}`} aria-live="polite">
          {remote ? (
            <>
              <strong>{hostLabel}</strong>
              <span aria-hidden="true">·</span>
              <bdi>{hostOf(origin)}</bdi>
              <span aria-hidden="true">·</span>
              <span>{remote.protocol.toUpperCase()}</span>
            </>
          ) : invalidUrl ? tr("gitprojectsource.repositoryUrlInvalid") : tr("gitprojectsource.repositoryUrlHint")}
        </small>
      </label>

      {remote && (
        <fieldset className="git-clone-access" disabled={locked}>
          <legend>{tr("gitprojectsource.accessLegend")}</legend>
          <div className="git-clone-access-grid">
            <div className="folder-source-field">
              <span>{tr("gitprojectsource.account")}</span>
              <Select
                label={tr("gitprojectsource.account")}
                ariaLabel={tr("gitprojectsource.chooseAccount")}
                value={accountValue}
                disabled={locked}
                onChange={setAccountChoice}
                className="git-clone-picker git-clone-account-picker"
                options={[
                  ...accounts.map((row) => ({
                    value: accountKey(row),
                    label: `@${row.login}`,
                    detail: [
                      row.providerLabel,
                      hostOf(row.origin),
                      row.label && row.label !== row.login ? row.label : "",
                      row.active && accounts.filter((other) => other.provider === row.provider).length > 1 ? tr("gitprojectsource.accountActive") : "",
                    ].filter(Boolean).join(" · "),
                  })),
                  ...sshIdentities.map((profile) => ({
                    value: identityKey(profile),
                    label: profile.username ? `@${profile.username}` : profile.label,
                    detail: [
                      tr("gitprojectsource.sshKeyDetail", { key: keyName(profile) }),
                      profile.username && profile.label !== profile.username ? profile.label : "",
                    ].filter(Boolean).join(" · "),
                  })),
                  {
                    value: SYSTEM_ACCOUNT,
                    label: tr("gitprojectsource.systemGit"),
                    detail: tr("gitprojectsource.systemGitDetail"),
                  },
                ]}
              />
            </div>
            <div className="folder-source-field">
              <span>{tr("gitprojectsource.commitAs")}</span>
              <Select
                label={tr("gitprojectsource.commitAs")}
                ariaLabel={tr("gitprojectsource.chooseCommitIdentity")}
                value={profileValue}
                disabled={locked || sshIdentity !== null}
                onChange={setProfileChoice}
                className="git-clone-picker git-clone-identity-picker"
                options={[
                  {
                    value: AUTO_PROFILE,
                    label: tr("gitprojectsource.automatic", { value: suggestedProfile?.label ?? tr("gitprojectsource.systemGit") }),
                    detail: suggestedProfile?.commitAuthor
                      ? `${suggestedProfile.commitAuthor.name} · ${suggestedProfile.commitAuthor.email}`
                      : tr("gitprojectsource.automaticDetail"),
                  },
                  {
                    value: SYSTEM_SOURCE_CONTROL_PROFILE_ID,
                    label: tr("gitprojectsource.systemGit"),
                    detail: tr("gitprojectsource.systemIdentityDetail"),
                  },
                  ...compatibleProfiles.map((profile) => ({
                    value: profile.id,
                    label: profile.label,
                    detail: profile.commitAuthor
                      ? `${profile.commitAuthor.name} · ${profile.commitAuthor.email}`
                      : [providerLabel(profile.provider), profile.username ? `@${profile.username}` : profile.account].filter(Boolean).join(" · "),
                  })),
                ]}
              />
            </div>
          </div>
          <div className="git-clone-access-foot">
            <p className="git-clone-access-note" role="status">
              {hosting.loading && accounts.length === 0 && !sshIdentity
                ? tr("gitprojectsource.loadingAccounts")
                : accounts.length === 0 && sshIdentities.length === 0
                  ? tr("gitprojectsource.noAccounts", { host: hostOf(origin) })
                  : note}
            </p>
            <Button size="sm" variant="ghost" className="git-clone-manage" disabled={busy} onClick={() => ctx.host.navigation.openSettingsPage("git")}>
              {tr("gitprojectsource.manageAccounts")}
            </Button>
          </div>
        </fieldset>
      )}

      <label className="folder-source-field git-clone-name">
        <span>{tr("gitprojectsource.projectName")} <em>{tr("worktreesessiondialog.optional")}</em></span>
        <TextInput
          value={name}
          placeholder={repoName(repository) || "repo"}
          spellCheck={false}
          autoCapitalize="off"
          disabled={locked}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) void submit(); }}
        />
      </label>

      <ctx.host.ui.Slot slot="project.repository.options" context={{
        repository,
        onConfigure,
        onAccountsChanged: hosting.refresh,
        hasAccount: accounts.length > 0,
        sourceControlProfileId: effectiveProfileId,
        sourceControlProvider: provider,
      }} />

      {error && <div className="form-error folder-error" role="alert">{error}</div>}

      <div className="folder-source-actions git-clone-actions">
        <p className="git-clone-destination" title={destination}>
          <span>{tr("gitprojectsource.destination")}</span>
          <bdi className="mono">{destination || "…"}</bdi>
        </p>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>{tr("common.cancel")}</Button>
        <Button size="sm" variant="primary" busy={submitting} disabled={!canSubmit} onClick={() => void submit()}>
          {submitting ? tr("gitprojectsource.cloning") : created ? tr("common.retry") : tr("gitprojectsource.cloneRepository")}
        </Button>
      </div>
    </div>
  );
}

export default function GitProjectSource(props: Record<string, unknown>) {
  const ctx = readContext(props as GitProjectSourceProps);
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const armRef = useRef(ctx.arm);
  const disarmRef = useRef(ctx.disarm);
  armRef.current = ctx.arm;
  disarmRef.current = ctx.disarm;

  useEffect(() => {
    if (!open) return;
    armRef.current(SOURCE_ID, { soloBrowser: false });
    return () => disarmRef.current(SOURCE_ID);
  }, [open]);

  useEffect(() => {
    if (open && ctx.armedId !== null && ctx.armedId !== SOURCE_ID) setOpen(false);
  }, [ctx.armedId, open]);

  const close = () => {
    setOpen(false);
    chipRef.current?.focus();
  };
  return (
    <>
      <Button
        ref={chipRef}
        type="button"
        size="sm"
        iconStart={WorktreeIcon}
        className="ghost-link git-clone-source folder-source-chip"
        aria-expanded={open}
        disabled={ctx.busy}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {tr("gitprojectsource.cloneRepository")}
      </Button>
      {open && <CloneInlinePanel ctx={ctx} onCancel={close} />}
    </>
  );
}
