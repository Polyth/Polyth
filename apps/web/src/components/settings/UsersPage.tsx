import { refreshProjects } from "../../init.ts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@polyth/session/web-api";
import {
  accountState,
  currentBrowserLogin,
  type AccountChoice,
} from "../../accounts.ts";
import {
  loadCurrentSpaceAccess,
  type CurrentSpaceAccess,
} from "../../spaceAccess.ts";
import type { SettingsNavigationTarget } from "@polyth/web-sdk";
import { EmptyState, ErrorState, PageHead, Section } from "./parts.tsx";
import { Badge, Button, Notice, TextInput } from "../ui/index.ts";
import { AddIcon, ChevronRightIcon, HelpIcon } from "../ui/icons.ts";
import UserDetail from "./UserDetail.tsx";
import AccountDetail from "./AccountDetail.tsx";
import AddUserWizard from "./AddUserWizard.tsx";
import UsersGuide from "./UsersGuide.tsx";
import { inviteStatuses, type InviteStatus } from "./inviteMethods.ts";
import SecureAccountDialog from "./SecureAccountDialog.tsx";
import { fetchAuthStatus } from "../../authClient.ts";
import { SignInProviders } from "./ExternalIdentitySettings.tsx";
import SharingPolicySection from "./SharingPolicySection.tsx";
import { useOwnerReauth } from "./ownerReauth.tsx";
import {
  initials,
  limitsSummary,
  OWN_ACCOUNT_TARGET,
  roleText,
} from "./usersModel.ts";
import { getLocale, tr } from "../../i18n/index.ts";
import "./UsersPage.css";

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
  // A paired phone may read and (as the owner) administer people; its own
  // account's name, password and passkeys still change in a signed-in browser.
  const [readOnly, setReadOnly] = useState<{ owner: boolean } | null>(null);
  const [spaceAccess, setSpaceAccess] = useState<CurrentSpaceAccess | null>(null);
  const [harnessNames, setHarnessNames] = useState<Record<string, string>>({});
  // Who joined through an invitation, and whose link is still unopened.
  const [invites, setInvites] = useState<ReadonlyMap<string, InviteStatus>>(new Map());
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [adding, setAdding] = useState(false);
  // "How it works" beside Add user; while the owner is alone it is the page's
  // empty state instead.
  const [guideOpen, setGuideOpen] = useState(false);
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
    // A person's id: "Roman joined" opens Roman.
    else if (targetItem) { setOwnOpen(false); setSelectedId(targetItem); }
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
      setReadOnly(state.readOnly ? { owner: state.canManageInBrowser } : null);
      setSpaceAccess(access);
      setLoadError(null);
      if (state.canManage) void inviteStatuses().then(setInvites, () => undefined);
    } catch (cause) {
      setLoadError(cause);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  // Someone joining or leaving changes who each project is shared with, and with
  // it the Shared / Only me switch.
  const accountChanged = useCallback(async () => {
    await refresh();
    void refreshProjects();
  }, [refresh]);
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

  if (ownOpen && self && !readOnly) {
    return (
      <div className="users-page">
        <AccountDetail
          account={self}
          name={displayName(self)}
          spaceAccess={spaceAccess}
          withReauth={withReauth}
          onBack={() => { setFeedback(null); setOwnOpen(false); }}
          onChanged={accountChanged}
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
          onChanged={accountChanged}
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

  const selfCard = self && (
    <>
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
        <span className="users-self-hint">{tr(readOnly ? "settings.users.selfHintBrowser" : "settings.users.selfHint")}</span>
      </span>
    </>
  );

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

      {self && (readOnly ? (
        // Name, password and passkeys change only in a signed-in browser.
        <div className="users-self-card is-readonly" data-settings-item="users.account">{selfCard}</div>
      ) : (
        <button
          type="button"
          className="users-self-card"
          aria-label={tr("header.yourAccount")}
          data-settings-item="users.account"
          onClick={() => { setFeedback(null); setOwnOpen(true); }}
        >
          {selfCard}
          <ChevronRightIcon className="user-row-chevron" aria-hidden="true" />
        </button>
      ))}

      <Section
        title={tr("settings.users.people")}
        itemId="users.manage"
        hint={canManageAccounts
          ? others.length === 0
            ? tr("settings.users.peopleHintEmpty")
            : tr(new Intl.PluralRules(getLocale()).select(others.length) === "one"
              ? "settings.users.peopleHintOne"
              : "settings.users.peopleHintOther", { count: others.length })
          : readOnly?.owner ? tr("settings.users.manageInBrowser") : tr("settings.users.peopleHintReadonly")}
        // Alone, the guide below is the empty state and carries Add user itself.
        action={canManageAccounts && others.length > 0 ? (
          <div className="users-people-actions">
            <Button
              variant="ghost"
              size="sm"
              iconStart={HelpIcon}
              aria-expanded={guideOpen}
              className="users-guide-toggle"
              onClick={() => setGuideOpen(!guideOpen)}
            >
              {tr("settings.users.guide.toggle")}
            </Button>
            <Button variant="primary" size="sm" iconStart={AddIcon} className="users-add-button" onClick={openAdd}>{tr("settings.users.addUser")}</Button>
          </div>
        ) : undefined}
      >
        {canManageAccounts && (others.length === 0 || guideOpen) && (
          <UsersGuide
            space={spaceAccess?.name ?? null}
            {...(others.length === 0 ? { onAdd: openAdd } : { onClose: () => setGuideOpen(false) })}
          />
        )}

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
            : canManageAccounts ? null : (
              <EmptyState
                compact
                icon="user"
                title={tr("settings.users.onlyYou")}
                body={readOnly?.owner ? tr("settings.users.manageInBrowser") : tr("settings.users.onlyYouBodyReadonly")}
              />
            )
        ) : (
          <ul className="users-list">
            {visibleAccounts.map((account) => {
              const name = displayName(account);
              const role = spaceAccess?.members.find((member) => member.userId === account.id)?.role;
              const invite = invites.get(account.id);
              const day = (at: number) => new Date(at).toLocaleDateString(getLocale(), { day: "numeric", month: "long" });
              // Limits read as words in the summary line, so the name line
              // keeps only what changes how the account behaves at a glance.
              const summary = [
                account.login ? `@${account.login}` : null,
                spaceAccess ? (role ? roleText(role).label : tr("settings.users.noAccess")) : null,
                invite && "joined" in invite ? tr("settings.users.joinedOn", { date: day(invite.joined) }) : null,
                invite && "until" in invite ? tr("settings.users.invitedUntil", { date: day(invite.until) }) : null,
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
                      {invite && "until" in invite && (
                        <Badge tone="info">{tr("settings.users.invited")}</Badge>
                      )}
                      {canManageAccounts && account.guarded && <Badge tone="info">{tr("settings.users.protected")}</Badge>}
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

      {/* Sign-in providers are configured in a browser identity session. */}
      {canManageAccounts && !localAccess && !readOnly && <SignInProviders withReauth={withReauth} />}
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
        <AddUserWizard
          spaceAccess={spaceAccess}
          withReauth={withReauth}
          onClose={() => setAdding(false)}
          onCreated={() => { setGuideOpen(false); void accountChanged(); }}
          onOpenAccount={(accountId) => {
            setAdding(false);
            setFeedback(null);
            setSelectedId(accountId);
          }}
        />
      )}
      {prompt}
    </div>
  );
}
