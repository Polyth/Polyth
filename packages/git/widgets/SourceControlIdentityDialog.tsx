// Create or edit one Git identity: who commits (name, email), how commits are
// signed, which code-hosting account it belongs to and how Git signs in.
// Identities are Space-wide; each project picks one (SourceControlProfilesSettings).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  type SourceControlAuthMode,
  type SourceControlHostingAccount,
  type SourceControlHostingAccountRef,
  type SourceControlProfile,
  type SourceControlProvider,
} from "@polyth/contracts/source-control";
import { api } from "@polyth/session/web-api";
import { createApiTransport } from "@polyth/web-sdk";
import {
  BranchIcon,
  Button,
  Checkbox,
  Dialog,
  GlobeIcon,
  Icon,
  InfoIcon,
  KeyIcon,
  MonitorIcon,
  PeopleIcon,
  Select,
  TextInput,
  Tooltip,
  VisuallyHidden,
  type LucideIcon,
} from "../../../apps/web/src/components/ui/index.ts";
import { Seg } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";

const transport = createApiTransport();

type SshKey = { path: string; name: string; comment?: string };
/** The four ways an identity's Git signs in, as the dialog offers them. */
export type IdentityAuthChoice = "machine" | "account" | "ssh" | "anonymous";

export const authChoiceOf = (mode: SourceControlAuthMode): IdentityAuthChoice =>
  mode === "account" ? "account" : mode === "ssh-key" ? "ssh" : mode === "anonymous" ? "anonymous" : "machine";

const modeOf = (choice: IdentityAuthChoice, current: SourceControlAuthMode): SourceControlAuthMode => {
  if (choice === "account") return "account";
  if (choice === "ssh") return "ssh-key";
  if (choice === "anonymous") return "anonymous";
  // "This machine" keeps a legacy descriptive mode (ssh-agent, helper, CLI).
  return current === "account" || current === "ssh-key" || current === "anonymous" ? "system-git" : current;
};

const accountKey = (row: Pick<SourceControlHostingAccountRef, "provider" | "accountId">): string => `${row.provider}:${row.accountId}`;
const hostOf = (origin: string): string => {
  try { return new URL(origin).hostname; } catch { return origin; }
};
const providerOf = (account: SourceControlHostingAccountRef): SourceControlProvider =>
  account.provider === "github" || account.provider === "gitlab" ? account.provider : "generic";

export const blankIdentity = (): SourceControlProfile => ({
  id: crypto.randomUUID(),
  label: "",
  provider: "generic",
  commitAuthor: { name: "", email: "" },
  authentication: { mode: "system-git" },
});

const EMAIL = /^[^\s@]+@[^\s@]+$/;

function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="git-identity-field">
      <div className="git-identity-field-label">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
        {hint && (
          <Tooltip content={hint}>
            <span className="git-identity-field-hint" tabIndex={0} role="img" aria-label={hint}>
              <Icon icon={InfoIcon} size="sm" />
            </span>
          </Tooltip>
        )}
      </div>
      <div className="git-identity-field-control">{children}</div>
    </div>
  );
}

const authOption = (icon: LucideIcon, label: string): ReactNode => (
  <span className="git-identity-auth-option"><Icon icon={icon} size="sm" />{label}</span>
);

export default function SourceControlIdentityDialog({ initial, isNew, onClose, onSave }: {
  initial: SourceControlProfile;
  isNew: boolean;
  onClose(): void;
  onSave(profile: SourceControlProfile): void;
}) {
  const [draft, setDraft] = useState<SourceControlProfile>(initial);
  const [keys, setKeys] = useState<SshKey[]>([]);
  const [accounts, setAccounts] = useState<SourceControlHostingAccount[]>([]);
  const [signing, setSigning] = useState(!!initial.signingKey);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const choice = authChoiceOf(draft.authentication.mode);

  useEffect(() => {
    let live = true;
    void api.gitSshKeys().then((r) => { if (live) setKeys(r.keys); }).catch(() => {});
    void transport.get<{ accounts?: SourceControlHostingAccount[] }>("/api/git/accounts")
      .then((r) => { if (live) setAccounts(Array.isArray(r.accounts) ? r.accounts : []); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  useEffect(() => setTest(null), [draft.authentication.identityFile, draft.hostingAccount?.accountId]);

  const account = draft.hostingAccount;
  const accountOptions = useMemo(() => [
    { value: "", label: tr("gitidentity.noAccount"), detail: accounts.length ? undefined : tr("gitidentity.noAccountsConnected") },
    ...accounts.map((row) => ({
      value: accountKey(row),
      label: `@${row.login}`,
      detail: [row.providerLabel, hostOf(row.origin), tr(row.owner === "personal" ? "gitidentity.accountYours" : row.owner === "installation" ? "gitidentity.accountMachine" : "gitidentity.accountSpace")].join(" · "),
    })),
    ...(account && !accounts.some((row) => accountKey(row) === accountKey(account))
      ? [{ value: accountKey(account), label: `@${account.login}`, detail: hostOf(account.origin) }] : []),
  ], [accounts, account]);

  const privateKeyOptions = [
    { value: "", label: keys.length ? tr("gitidentity.chooseKey") : tr("gitidentity.noKeys") },
    ...keys.map((key) => ({ value: key.path, label: key.name, ...(key.comment ? { detail: key.comment } : {}) })),
    ...(draft.authentication.identityFile && !keys.some((key) => key.path === draft.authentication.identityFile)
      ? [{ value: draft.authentication.identityFile, label: draft.authentication.identityFile }] : []),
  ];
  const signingOptions = [
    { value: "", label: keys.length ? tr("gitidentity.chooseKey") : tr("gitidentity.noKeys") },
    ...keys.map((key) => ({ value: `${key.path}.pub`, label: `${key.name}.pub`, ...(key.comment ? { detail: key.comment } : {}) })),
    ...(draft.signingKey && !keys.some((key) => `${key.path}.pub` === draft.signingKey)
      ? [{ value: draft.signingKey, label: draft.signingKey }] : []),
  ];

  const chooseAccount = (key: string) => {
    const row = accounts.find((candidate) => accountKey(candidate) === key);
    if (!row) {
      const { hostingAccount: _dropped, ...rest } = draft;
      setDraft({ ...rest, authentication: draft.authentication.mode === "account" ? { mode: "system-git" } : draft.authentication });
      return;
    }
    const ref: SourceControlHostingAccountRef = { provider: row.provider, accountId: row.accountId, login: row.login, origin: row.origin };
    // The account's host decides which repositories this identity applies to.
    setDraft({ ...draft, hostingAccount: ref, provider: providerOf(ref), host: hostOf(ref.origin), username: ref.login });
  };

  const chooseAuth = (next: IdentityAuthChoice) => {
    const mode = modeOf(next, draft.authentication.mode);
    setDraft({
      ...draft,
      authentication: mode === "ssh-key"
        ? { mode, ...(draft.authentication.identityFile ? { identityFile: draft.authentication.identityFile } : {}) }
        : { mode, ...(draft.authentication.credentialRef ? { credentialRef: draft.authentication.credentialRef } : {}) },
    });
  };

  const sshHost = draft.host?.trim() || (draft.provider === "gitlab" ? "gitlab.com" : "github.com");
  const testKey = async () => {
    const path = draft.authentication.identityFile;
    if (!path) return;
    setTesting(true);
    try {
      const r = await api.gitSshKeyTest(path, sshHost);
      const expected = draft.username?.trim().replace(/^@/, "");
      const mismatch = r.ok && r.account && expected && r.account.toLowerCase() !== expected.toLowerCase();
      setTest(mismatch
        ? { ok: false, text: tr("gitidentity.keyOtherAccount", { account: r.account!, expected: expected! }) }
        : { ok: r.ok, text: r.ok && r.account ? tr("gitidentity.keyConnected", { account: r.account }) : r.message });
    } catch (cause) {
      setTest({ ok: false, text: cause instanceof Error ? cause.message : String(cause) });
    } finally { setTesting(false); }
  };

  const name = draft.commitAuthor?.name.trim() ?? "";
  const email = draft.commitAuthor?.email.trim() ?? "";
  const missing = !draft.label.trim() ? "label"
    : !name ? "name"
    : !EMAIL.test(email) ? "email"
    : signing && !draft.signingKey ? "signing"
    : choice === "ssh" && !draft.authentication.identityFile ? "ssh"
    : choice === "account" && !account ? "account"
    : null;

  const save = () => {
    if (missing) return;
    const host = draft.host?.trim();
    const username = draft.username?.trim();
    const accountLabel = draft.account?.trim();
    const { signingKey: _signing, ...rest } = draft;
    onSave({
      ...rest,
      label: draft.label.trim(),
      ...(host ? { host } : { host: undefined }),
      ...(username ? { username } : { username: undefined }),
      ...(accountLabel ? { account: accountLabel } : { account: undefined }),
      commitAuthor: { name, email },
      ...(signing && draft.signingKey ? { signingKey: draft.signingKey } : {}),
    });
  };

  const initialLetter = draft.label.trim().slice(0, 1).toUpperCase();
  return (
    <Dialog
      title={isNew ? tr("gitidentity.newTitle") : tr("gitidentity.editTitle", { name: initial.label })}
      onClose={onClose}
      className="git-identity-dialog"
      initialFocus=".git-identity-label-input"
      footer={(
        <>
          <Button size="sm" onClick={onClose}>{tr("gitidentity.cancel")}</Button>
          <Button size="sm" variant="primary" disabled={!!missing} onClick={save}>
            {isNew ? tr("gitidentity.create") : tr("gitidentity.save")}
          </Button>
        </>
      )}
    >
      <form className="git-identity-form" onSubmit={(event) => { event.preventDefault(); save(); }}>
        <div className="git-identity-head">
          <span className="git-identity-mark" aria-hidden="true">
            {initialLetter || <Icon icon={BranchIcon} size="sm" />}
          </span>
          <TextInput
            className="git-identity-label-input"
            aria-label={tr("gitidentity.label")}
            value={draft.label}
            placeholder={tr("gitidentity.labelPlaceholder")}
            onChange={(event) => setDraft({ ...draft, label: event.target.value })}
          />
        </div>

        <Field label={tr("gitidentity.userName")} hint={tr("gitidentity.userNameHint")} htmlFor="git-identity-name">
          <TextInput
            id="git-identity-name"
            value={draft.commitAuthor?.name ?? ""}
            placeholder="Ada Lovelace"
            autoComplete="name"
            onChange={(event) => setDraft({ ...draft, commitAuthor: { name: event.target.value, email: draft.commitAuthor?.email ?? "" } })}
          />
        </Field>
        <Field label={tr("gitidentity.email")} hint={tr("gitidentity.emailHint")} htmlFor="git-identity-email">
          <TextInput
            id="git-identity-email"
            type="email"
            value={draft.commitAuthor?.email ?? ""}
            placeholder="ada@example.com"
            autoComplete="email"
            onChange={(event) => setDraft({ ...draft, commitAuthor: { name: draft.commitAuthor?.name ?? "", email: event.target.value } })}
          />
        </Field>
        <Field label={tr("gitidentity.signing")} hint={tr("gitidentity.signingHint")}>
          <div className="git-identity-signing">
            <Checkbox
              checked={signing}
              onChange={setSigning}
              label={<VisuallyHidden>{tr("gitidentity.signCommits")}</VisuallyHidden>}
            />
            <Select
              label={tr("gitidentity.signingKey")}
              ariaLabel={tr("gitidentity.signingKey")}
              value={draft.signingKey ?? ""}
              options={signingOptions}
              placeholder="~/.ssh/id_ed25519.pub"
              disabled={!signing}
              onChange={(path) => setDraft({ ...draft, ...(path ? { signingKey: path } : { signingKey: undefined }) })}
            />
          </div>
        </Field>
        <Field label={tr("gitidentity.account")} hint={tr("gitidentity.accountHint")}>
          <Select
            label={tr("gitidentity.account")}
            ariaLabel={tr("gitidentity.account")}
            value={account ? accountKey(account) : ""}
            options={accountOptions}
            onChange={chooseAccount}
            className="git-identity-account"
          />
        </Field>
        <Field label={tr("gitidentity.auth")} hint={tr("gitidentity.authHint")}>
          <div className="git-identity-auth">
            <Seg<IdentityAuthChoice>
              label={tr("gitidentity.auth")}
              value={choice}
              onChange={chooseAuth}
              options={[
                ["machine", authOption(MonitorIcon, tr("gitidentity.authMachine"))],
                ["account", authOption(PeopleIcon, tr("gitidentity.authAccount"))],
                ["ssh", authOption(KeyIcon, tr("gitidentity.authSsh"))],
                ["anonymous", authOption(GlobeIcon, tr("gitidentity.authAnonymous"))],
              ]}
            />
            <small className="git-identity-note" role={choice === "account" && !account ? "alert" : undefined}>
              {choice === "machine" ? tr("gitidentity.authMachineDetail")
                : choice === "account" ? (account ? tr("gitidentity.authAccountDetail", { account: `@${account.login}` }) : tr("gitidentity.authAccountMissing"))
                : choice === "ssh" ? tr("gitidentity.authSshDetail")
                : tr("gitidentity.authAnonymousDetail")}
            </small>
          </div>
        </Field>
        <Field label={tr("gitidentity.sshKey")} hint={tr("gitidentity.sshKeyHint")}>
          <div className="git-identity-ssh">
            <Select
              label={tr("gitidentity.sshKey")}
              ariaLabel={tr("gitidentity.sshKey")}
              value={draft.authentication.identityFile ?? ""}
              options={privateKeyOptions}
              placeholder={tr("gitidentity.sshKeys")}
              disabled={choice !== "ssh"}
              onChange={(path) => setDraft({ ...draft, authentication: path ? { mode: "ssh-key", identityFile: path } : { mode: "ssh-key" } })}
            />
            {choice === "ssh" && (
              <Button size="sm" disabled={!draft.authentication.identityFile || testing} onClick={() => void testKey()}>
                {testing ? tr("gitidentity.testing") : tr("gitidentity.test")}
              </Button>
            )}
          </div>
          {test && <small role="status" className={test.ok ? "git-identity-note" : "form-error"}>{test.text}</small>}
        </Field>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}
