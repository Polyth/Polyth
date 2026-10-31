import { useCallback, useEffect, useMemo, useState } from "react";
import { isSpaceRole, type SpaceRole } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import {
  accountState,
  createAccount,
  currentBrowserLogin,
  type AccountChoice,
} from "../../accounts.ts";
import {
  grantSpaceMember,
  loadCurrentSpaceAccess,
  type CurrentSpaceAccess,
} from "../../spaceAccess.ts";
import type { SettingsNavigationTarget } from "@polyth/web-sdk";
import { EmptyState, ErrorState, FormField, PageHead, Section } from "./parts.tsx";
import { Badge, Button, Dialog, Notice, Select, TextInput } from "../ui/index.ts";
import { AddIcon, ChevronRightIcon } from "../ui/icons.ts";
import UserDetail, { PassphraseField } from "./UserDetail.tsx";
import AccountDetail from "./AccountDetail.tsx";
import SecureAccountDialog from "./SecureAccountDialog.tsx";
import { fetchAuthStatus } from "../../authClient.ts";
import { SignInProviders } from "./ExternalIdentitySettings.tsx";
import SharingPolicySection from "./SharingPolicySection.tsx";
import { isReauthCancelled, useOwnerReauth } from "./ownerReauth.tsx";
import {
  accountErrorText,
  generatePassphrase,
  initials,
  limitsSummary,
  OWN_ACCOUNT_TARGET,
  LOGIN_PATTERN,
  MIN_PASSWORD_LENGTH,
  roleText,
  suggestLogin,
} from "./usersModel.ts";
import { getLocale, tr } from "../../i18n/index.ts";

type AccessChoice = SpaceRole | "none";
type Feedback = { tone: "success" | "error" | "info"; text: string };

/** The server falls back to the raw account id when no name is set; never
 *  show that id as the headline. */
const displayName = (account: AccountChoice): string =>
  account.name && account.name !== account.id
    ? account.name
    : account.login ?? (account.current ? tr("header.yourAccount") : tr("settings.users.unnamedAccount"));

/** Search only earns its space once the list is long enough to scan. */
const SEARCH_THRESHOLD = 5;

export default function UsersPage({ settingsTarget }: { settingsTarget?: SettingsNavigationTarget }) {
  const [accounts, setAccounts] = useState<AccountChoice[]>([]);
  const [currentAccountId, setCurrentAccountId] = useState("");
  const [loadError, setLoadError] = useState<unknown>(null);
  const [canManageAccounts, setCanManageAccounts] = useState(false);
  const [spaceAccess, setSpaceAccess] = useState<CurrentSpaceAccess | null>(null);
  const [harnessNames, setHarnessNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [adding, setAdding] = useState(false);
  // No password yet ("only me" first run): protect the account before the
  // first other person gets one.
  const [localAccess, setLocalAccess] = useState(false);
  const [securing, setSecuring] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ownOpen, setOwnOpen] = useState(settingsTarget?.itemId === OWN_ACCOUNT_TARGET);
  // Deep links (account menu, provider link return) can land while the page
  // is already open.
  const targetItem = settingsTarget?.itemId;
  useEffect(() => {
    if (targetItem === OWN_ACCOUNT_TARGET) { setSelectedId(null); setOwnOpen(true); }
  }, [targetItem]);
  const { withReauth, prompt } = useOwnerReauth();

  const refresh = useCallback(async () => {
    try {
      const [state, access] = await Promise.all([
        accountState(),
        loadCurrentSpaceAccess().catch(() => null),
      ]);
      setAccounts(state.accounts);
      setCurrentAccountId(state.currentAccountId);
      setCanManageAccounts(state.canManage);
      setSpaceAccess(access);
      setLoadError(null);
    } catch (cause) {
      setLoadError(cause);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    let live = true;
    void fetchAuthStatus().then((status) => { if (live) setLocalAccess(status.accessMode === "local"); }, () => undefined);
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!canManageAccounts) return;
    let live = true;
    // Names for the one-line summaries; ids are an acceptable fallback.
    void api.harnessSnapshots().then((list) => {
      if (live) setHarnessNames(Object.fromEntries(list.map((snapshot) => [snapshot.identity.id, snapshot.identity.name])));
    }, () => undefined);
    return () => { live = false; };
  }, [canManageAccounts]);

  // A non-owner may receive only a partial list; the signed-in account is
  // always shown so the page never reads as "0 users".
  const listedAccounts = useMemo(() => {
    if (!currentAccountId || accounts.some((account) => account.id === currentAccountId)) return accounts;
    const login = currentBrowserLogin();
    return [
      { id: currentAccountId, name: login || currentAccountId, ...(login ? { login } : {}), current: true },
      ...accounts,
    ];
  }, [accounts, currentAccountId]);

  const self = listedAccounts.find((account) => account.current);
  const others = useMemo(() => listedAccounts.filter((account) => !account.current), [listedAccounts]);
  const showSearch = others.length >= SEARCH_THRESHOLD;

  const visibleAccounts = useMemo(() => {
    const needle = showSearch ? query.trim().toLowerCase() : "";
    if (!needle) return others;
    return others.filter((account) =>
      account.name.toLowerCase().includes(needle)
      || account.login?.toLowerCase().includes(needle)
      || account.id.toLowerCase().includes(needle)
      || account.status?.toLowerCase().includes(needle),
    );
  }, [others, query, showSearch]);

  const blurb = spaceAccess
    ? tr("settings.users.blurbSpace", { space: spaceAccess.name })
    : tr("settings.users.blurb");

  const selected = selectedId ? listedAccounts.find((account) => account.id === selectedId) : undefined;
  // A manageable account is anyone but yourself; your own account opens
  // AccountDetail instead.
  const manageable = (account: AccountChoice): boolean => canManageAccounts && !account.current;

  if (loading) {
    return (
      <>
        <PageHead blurb={blurb} />
        <EmptyState compact title={tr("settings.users.loadingUsers")} busy />
      </>
    );
  }

  if (loadError && listedAccounts.length === 0) {
    return (
      <>
        <PageHead blurb={blurb} />
        <ErrorState title={tr("settings.users.unavailable")} error={loadError} onRetry={() => { setLoading(true); void refresh(); }} />
      </>
    );
  }

  if (ownOpen && self) {
    return (
      <div className="users-page">
        <AccountDetail
          account={self}
          name={displayName(self)}
          spaceAccess={spaceAccess}
          withReauth={withReauth}
          onBack={() => { setFeedback(null); setOwnOpen(false); }}
          onChanged={refresh}
        />
        {prompt}
      </div>
    );
  }

  if (selected && manageable(selected)) {
    return (
      <div className="users-page">
        <UserDetail
          key={selected.id}
          account={selected}
          name={displayName(selected)}
          spaceAccess={spaceAccess}
          withReauth={withReauth}
          onBack={() => { setFeedback(null); setSelectedId(null); }}
          onChanged={refresh}
          welcome={feedback?.tone === "success" ? feedback.text : undefined}
          onRemoved={(text) => {
            setSelectedId(null);
            setFeedback({ tone: "success", text });
            void refresh();
          }}
        />
        {prompt}
      </div>
    );
  }

  const openAdd = () => {
    setFeedback(null);
    if (localAccess) setSecuring(true);
    else setAdding(true);
  };

  return (
    <div className="users-page">
      <PageHead blurb={blurb} />

      {feedback && (
        <Notice tone={feedback.tone} role={feedback.tone === "error" ? "alert" : "status"}>
          {feedback.text}
        </Notice>
      )}
      {loadError !== null && <ErrorState compact error={loadError} onRetry={() => void refresh()} />}

      {self && (
        <button
          type="button"
          className="users-self-card"
          aria-label={tr("header.yourAccount")}
          data-settings-item="users.account"
          onClick={() => { setFeedback(null); setOwnOpen(true); }}
        >
          <span className="user-avatar is-large is-self" aria-hidden="true">{initials(displayName(self))}</span>
          <span className="user-row-copy">
            <span className="user-row-name">
              <strong>{displayName(self)}</strong>
              <Badge tone="accent">{tr("settings.users.you")}</Badge>
            </span>
            <span className="user-row-meta">
              {[
                self.login ? `@${self.login}` : null,
                spaceAccess ? tr("settings.users.roleIn", { role: roleText(spaceAccess.role).label, space: spaceAccess.name }) : null,
              ].filter(Boolean).join(" · ")}
            </span>
            <span className="users-self-hint">{tr("settings.users.selfHint")}</span>
          </span>
          <ChevronRightIcon className="user-row-chevron" aria-hidden="true" />
        </button>
      )}

      <Section
        title={tr("settings.users.people")}
        itemId="users.manage"
        hint={canManageAccounts
          ? others.length === 0
            ? tr("settings.users.peopleHintEmpty")
            : tr(new Intl.PluralRules(getLocale()).select(others.length) === "one"
              ? "settings.users.peopleHintOne"
              : "settings.users.peopleHintOther", { count: others.length })
          : tr("settings.users.peopleHintReadonly")}
        action={canManageAccounts ? (
          <Button variant="primary" size="sm" iconStart={AddIcon} onClick={openAdd}>{tr("settings.users.addUser")}</Button>
        ) : undefined}
      >
        {showSearch && (
          <div className="users-page-filter">
            <TextInput
              type="search"
              value={query}
              placeholder={tr("settings.users.searchUsers")}
              aria-label={tr("settings.users.searchUsers")}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        )}

        {visibleAccounts.length === 0 ? (
          query.trim() && showSearch
            ? <EmptyState compact icon="user" title={tr("settings.users.noMatch")} body={tr("settings.users.noMatchBody")} />
            : (
              <EmptyState
                compact
                icon="user"
                title={tr("settings.users.onlyYou")}
                body={canManageAccounts ? tr("settings.users.onlyYouBody") : tr("settings.users.onlyYouBodyReadonly")}
                {...(canManageAccounts ? { action: { label: tr("settings.users.addUser"), onClick: openAdd } } : {})}
              />
            )
        ) : (
          <ul className="users-list">
            {visibleAccounts.map((account) => {
              const name = displayName(account);
              const role = spaceAccess?.members.find((member) => member.userId === account.id)?.role;
              const summary = [
                account.login ? `@${account.login}` : null,
                spaceAccess ? (role ? roleText(role).label : tr("settings.users.noAccess")) : null,
                ...limitsSummary(account.limits, (id) => harnessNames[id] ?? id),
              ].filter(Boolean).join(" · ");
              const content = (
                <>
                  <span className="user-avatar" aria-hidden="true">{initials(name)}</span>
                  <span className="user-row-copy">
                    <span className="user-row-name">
                      <strong>{name}</strong>
                      {account.status === "suspended" && <Badge tone="warning">{tr("settings.users.paused")}</Badge>}
                      {(account.status === "disabled" || account.status === "offboarding") && <Badge tone="danger">{tr("settings.users.disabled")}</Badge>}
                      {account.managed && <Badge>{tr("settings.users.managed")}</Badge>}
                      {canManageAccounts && account.guarded && <Badge tone="info">{tr("settings.users.protected")}</Badge>}
                      {canManageAccounts && account.limits && <Badge tone="info">{tr("settings.users.limited")}</Badge>}
                    </span>
                    <span className="user-row-meta" title={account.id}>{summary || account.id}</span>
                  </span>
                </>
              );
              return (
                <li key={account.id}>
                  {manageable(account) ? (
                    <button
                      type="button"
                      className="user-row is-interactive"
                      aria-label={tr("settings.users.manageUser", { name })}
                      onClick={() => { setFeedback(null); setSelectedId(account.id); }}
                    >
                      {content}
                      <ChevronRightIcon className="user-row-chevron" aria-hidden="true" />
                    </button>
                  ) : (
                    <div className="user-row">{content}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <SharingPolicySection />

      {canManageAccounts && !localAccess && <SignInProviders withReauth={withReauth} />}
      {securing && (
        <SecureAccountDialog
          reason={tr("settings.users.secureReason")}
          onClose={() => setSecuring(false)}
          onSecured={(login) => {
            setSecuring(false);
            setLocalAccess(false);
            setFeedback({ tone: "success", text: tr("settings.users.securedNotice", { login }) });
            void refresh();
            setAdding(true);
          }}
        />
      )}

      {adding && (
        <AddUserDialog
          spaceAccess={spaceAccess}
          withReauth={withReauth}
          onClose={() => setAdding(false)}
          onCreated={async (account, text) => {
            setAdding(false);
            await refresh();
            // Straight into the new account so its limits can be set now.
            setSelectedId(account.id);
            setFeedback({ tone: "success", text });
          }}
        />
      )}
      {prompt}
    </div>
  );
}

function AddUserDialog({ spaceAccess, withReauth, onClose, onCreated }: {
  spaceAccess: CurrentSpaceAccess | null;
  withReauth: ReturnType<typeof useOwnerReauth>["withReauth"];
  onClose: () => void;
  onCreated: (account: AccountChoice, message: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [login, setLogin] = useState("");
  const [loginEdited, setLoginEdited] = useState(false);
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [role, setRole] = useState<AccessChoice>(spaceAccess?.canManageMembers ? "member" : "none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalizedLogin = login.trim().toLowerCase();
  const loginValid = LOGIN_PATTERN.test(normalizedLogin);
  const passwordValid = [...password].length >= MIN_PASSWORD_LENGTH;
  const ready = !!name.trim() && loginValid && passwordValid;

  const create = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const account = await withReauth(() => createAccount(normalizedLogin, name.trim(), password));
      let grantFailure: string | null = null;
      if (role !== "none" && spaceAccess?.canManageMembers) {
        try {
          await grantSpaceMember(spaceAccess.id, account.id, role);
        } catch (cause) {
          grantFailure = accountErrorText(cause);
        }
      }
      const created = account.name || name.trim();
      await onCreated(account, grantFailure
        ? spaceAccess
          ? tr("settings.users.createdGrantFailed", { name: created, space: spaceAccess.name, reason: grantFailure })
          : tr("settings.users.createdGrantFailedNoSpace", { name: created, reason: grantFailure })
        : role !== "none" && spaceAccess
          ? tr("settings.users.createdWithRole", { name: created, login: normalizedLogin, role: roleText(role).label, space: spaceAccess.name })
          : tr("settings.users.createdNoAccess", { name: created, login: normalizedLogin }));
    } catch (cause) {
      if (!isReauthCancelled(cause)) setError(accountErrorText(cause));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={tr("settings.users.addUser")}
      size="sm"
      className="users-dialog"
      onClose={() => { if (!busy) onClose(); }}
      footer={(
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{tr("common.cancel")}</Button>
          <Button variant="primary" busy={busy} disabled={!ready} onClick={() => void create()}>{tr("settings.users.createUser")}</Button>
        </>
      )}
    >
      <form className="users-dialog-form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <p className="users-dialog-intro">
          {tr("settings.users.addUserIntro")}
        </p>
        <FormField label={tr("settings.users.name")}>
          <TextInput
            className="users-dialog-name"
            value={name}
            placeholder={tr("settings.users.namePlaceholder")}
            autoComplete="off"
            disabled={busy}
            onChange={(event) => {
              setName(event.target.value);
              if (!loginEdited) setLogin(suggestLogin(event.target.value));
            }}
          />
        </FormField>
        <FormField
          label={tr("settings.users.login")}
          hint={tr("settings.users.loginHint")}
          {...(login.length > 0 && !loginValid ? { error: tr("settings.users.loginInvalid") } : {})}
        >
          {(field) => (
            <TextInput
              {...field}
              value={login}
              placeholder="maria"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              disabled={busy}
              invalid={login.length > 0 && !loginValid}
              onChange={(event) => { setLogin(event.target.value); setLoginEdited(true); }}
            />
          )}
        </FormField>
        <PassphraseField
          value={password}
          visible={visible}
          copied={copied}
          disabled={busy}
          onChange={(next) => { setPassword(next); setCopied(false); }}
          onToggleVisible={() => setVisible(!visible)}
          onGenerate={() => { setPassword(generatePassphrase()); setVisible(true); setCopied(false); }}
          onCopied={() => setCopied(true)}
        />
        <FormField label={spaceAccess ? tr("settings.users.accessTo", { space: spaceAccess.name }) : tr("settings.users.spaceAccess")}>
          <Select
            label={tr("settings.users.initialSpaceAccess")}
            ariaLabel={tr("settings.users.initialSpaceAccess")}
            value={role}
            disabled={busy || !spaceAccess?.canManageMembers}
            options={spaceAccess?.canManageMembers
              ? [
                  { value: "none", label: tr("settings.users.noAccess"), detail: tr("settings.users.noAccessCreateOnly") },
                  ...(["viewer", "member", "admin", "owner"] as const)
                    .filter((value) => value !== "owner" || spaceAccess.role === "owner")
                    .map((value) => ({ value, ...roleText(value) })),
                ]
              : [{ value: "none", label: tr("settings.users.noAccess"), detail: tr("settings.users.cannotManageMembers") }]}
            onChange={(value) => { if (value === "none" || isSpaceRole(value)) setRole(value); }}
          />
        </FormField>
        {error && <Notice tone="error" role="alert">{error}</Notice>}
      </form>
    </Dialog>
  );
}
