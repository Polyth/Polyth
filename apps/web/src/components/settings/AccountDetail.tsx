import { useCallback, useEffect, useState } from "react";
import type { AuthDeviceDto } from "@polyth/session/web-api";
import { changeAccountPassword, renameCurrentAccount, type AccountChoice } from "../../accounts.ts";
import { authJson, fetchAuthStatus } from "../../authClient.ts";
import {
  browserSupportsPasskeys,
  listPasskeys,
  registerPasskey,
  removePasskey,
  type PasskeySummary,
} from "../../passkeys.ts";
import type { CurrentSpaceAccess } from "../../spaceAccess.ts";
import { confirmAlert } from "../../alerts.ts";
import { getLocale, tr } from "../../i18n/index.ts";
import CopyButton from "../CopyButton.tsx";
import { Badge, Button, Dialog, Icon, Notice, TextInput } from "../ui/index.ts";
import { BackIcon, KeyIcon, MonitorIcon, SignOutIcon, SmartphoneIcon } from "../ui/icons.ts";
import { isImeComposing } from "../input/editorCore.ts";
import { EmptyState, FormField, ItemList, ItemRow, ReadonlyRow, Row, Section } from "./parts.tsx";
import { LinkedSignIns } from "./ExternalIdentitySettings.tsx";
import { isReauthCancelled, type WithReauth } from "./ownerReauth.tsx";
import SecureAccountDialog from "./SecureAccountDialog.tsx";
import { accountErrorText, initials, MIN_PASSWORD_LENGTH, roleText } from "./usersModel.ts";

type BrowserSession = AuthDeviceDto & { revision?: number; expiresAt?: number };

const ACTIVE_NOW_MS = 5 * 60_000;

const when = (ts: number): string =>
  new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "short" }).format(ts);

const deviceLabel = (ua: string): string => {
  if (!ua) return tr("settings.accesspage.unknownDevice");
  const browser =
    /Edg\//.test(ua) ? tr("settings.accesspage.edge") : /Firefox\//.test(ua) ? tr("settings.accesspage.firefox")
    : /Chrome\//.test(ua) ? tr("settings.accesspage.chrome") : /Safari\//.test(ua) ? tr("settings.accesspage.safari") : null;
  const os =
    /Windows/.test(ua) ? tr("settings.accesspage.windows") : /Mac OS X|Macintosh/.test(ua) && !/iPhone|iPad/.test(ua) ? tr("settings.accesspage.macos")
    : /Android/.test(ua) ? tr("settings.accesspage.android") : /iPhone|iPad/.test(ua) ? tr("settings.accesspage.ios")
    : /Linux/.test(ua) ? tr("settings.accesspage.linux") : null;
  if (browser && os) return tr("settings.accesspage.valueOnValue", { browser, os });
  return browser ?? os ?? ua.slice(0, 40);
};

const isPhone = (ua: string): boolean => /iPhone|Android.+Mobile|Mobile Safari/.test(ua);

async function browserSessions(): Promise<BrowserSession[]> {
  const response = await fetch("/api/auth/sessions", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json() as unknown;
  if (Array.isArray(body)) return body as BrowserSession[];
  if (body && typeof body === "object" && Array.isArray((body as { sessions?: unknown }).sessions)) {
    return (body as { sessions: BrowserSession[] }).sessions;
  }
  throw new Error("Invalid session response");
}

const authError = (response: Response, body: Record<string, unknown>): Error => new Error(
  typeof body.message === "string"
    ? body.message
    : typeof body.error === "string" ? body.error.replace(/-/g, " ") : `HTTP ${response.status}`,
);

interface Props {
  account: AccountChoice;
  /** Display name already resolved by the list. */
  name: string;
  spaceAccess: CurrentSpaceAccess | null;
  withReauth: WithReauth;
  onBack: () => void;
  /** Re-read accounts after a change. */
  onChanged: () => Promise<void>;
}

/** The signed-in person's own account: profile, how they sign in and where
 *  they are signed in. Owners manage everyone else in `UserDetail`. */
export default function AccountDetail({ account, name, spaceAccess, withReauth, onBack, onChanged }: Props) {
  const [nameDraft, setNameDraft] = useState(name);
  const [passkeysAvailable, setPasskeysAvailable] = useState<boolean | null>(null);
  const [passkeys, setPasskeys] = useState<PasskeySummary[] | null>(null);
  const [sessions, setSessions] = useState<BrowserSession[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passkeyOpen, setPasskeyOpen] = useState(false);
  // No password yet ("only me" first run): Polyth opens only in this app.
  const [localAccess, setLocalAccess] = useState(false);
  const [secureOpen, setSecureOpen] = useState(false);

  useEffect(() => { setNameDraft(name); }, [name]);

  const loadPasskeys = useCallback(() => {
    void listPasskeys().then(setPasskeys, () => setPasskeys([]));
  }, []);
  const loadSessions = useCallback(() => {
    void browserSessions().then(setSessions, () => setSessions([]));
  }, []);

  useEffect(() => {
    void fetchAuthStatus().then(
      (status) => {
        setPasskeysAvailable(status.methods?.includes("passkey") === true && browserSupportsPasskeys());
        setLocalAccess(status.accessMode === "local");
      },
      () => setPasskeysAvailable(false),
    );
    loadPasskeys();
    loadSessions();
  }, [loadPasskeys, loadSessions]);

  const membership = spaceAccess?.members.find((member) => member.userId === account.id);
  const role = membership?.role ?? spaceAccess?.role;

  const run = async (action: () => Promise<void>, success?: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await withReauth(action);
      if (success) setNotice({ tone: "success", text: success });
    } catch (cause) {
      if (!isReauthCancelled(cause)) setNotice({ tone: "error", text: accountErrorText(cause) });
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    const next = nameDraft.trim();
    if (!next || next === name || busy) return;
    await run(async () => {
      await renameCurrentAccount(account, next);
      await onChanged();
    }, tr("settings.account.renamed", { name: next }));
  };

  const removeKey = async (passkey: PasskeySummary) => {
    const ok = await confirmAlert(
      tr("settings.account.removePasskeyBody", { name: passkey.name }),
      { title: tr("settings.account.removePasskeyTitle", { name: passkey.name }), confirmLabel: tr("settings.account.removePasskey") },
    );
    if (!ok) return;
    await run(async () => {
      await removePasskey(passkey);
      loadPasskeys();
    }, tr("settings.account.passkeyRemoved", { name: passkey.name }));
  };

  const revoke = (session: BrowserSession) => {
    void authJson(`/api/auth/sessions/${encodeURIComponent(session.id)}`, {
      ...(session.revision ? { expectedRevision: session.revision } : {}),
    }, "DELETE").then(({ response, body }) => {
      if (!response.ok) throw authError(response, body);
      if (session.current) location.reload();
      else {
        setNotice({ tone: "success", text: tr("settings.account.deviceSignedOut", { device: deviceLabel(session.label) }) });
        loadSessions();
      }
    }).catch((cause) => setNotice({ tone: "error", text: accountErrorText(cause) }));
  };

  const signOut = () => {
    void authJson("/api/auth/logout", {}).then(() => location.reload());
  };

  const signOutEverywhere = async () => {
    const ok = await confirmAlert(tr("settings.accesspage.signOutEveryDeviceIncludingThisOne"), {
      title: tr("settings.accesspage.signOutEverywhere"),
      confirmLabel: tr("settings.accesspage.signOut"),
    });
    if (!ok) return;
    void authJson("/api/auth/logout-all", {}).then(({ response, body }) => {
      if (!response.ok) throw authError(response, body);
      location.reload();
    }).catch((cause) => setNotice({ tone: "error", text: accountErrorText(cause) }));
  };

  const ordered = sessions
    ? [...sessions].sort((a, b) => Number(Boolean(b.current)) - Number(Boolean(a.current)) || b.lastSeenAt - a.lastSeenAt)
    : null;

  return (
    <div className="user-detail account-detail">
      <div className="user-detail-head">
        <Button size="sm" variant="ghost" iconStart={BackIcon} className="user-detail-back" onClick={onBack}>{tr("settings.users.allUsers")}</Button>
        <div className="user-detail-identity">
          <div className="user-avatar is-large is-self" aria-hidden="true">{initials(name)}</div>
          <div className="user-row-copy">
            <div className="user-row-name">
              <strong>{name}</strong>
              <Badge tone="accent">{tr("settings.users.you")}</Badge>
            </div>
            <span className="user-row-meta">
              {account.login ? `@${account.login}` : localAccess ? tr("settings.account.noPasswordLocal") : tr("settings.users.noPasswordSignIn")}
              {spaceAccess && role ? ` · ${tr("settings.users.roleIn", { role: roleText(role).label, space: spaceAccess.name })}` : ""}
            </span>
          </div>
        </div>
      </div>

      {notice && (
        <Notice tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</Notice>
      )}

      <Section title={tr("settings.users.profile")} itemId="users.account.profile">
        {account.managed ? (
          <ReadonlyRow label={tr("settings.users.name")} value={name} hint={tr("settings.account.nameManagedHint")} />
        ) : (
          <Row label={tr("settings.users.name")} hint={tr("settings.account.nameHint")}>
            <span className="user-detail-inline">
              <TextInput
                uiSize="sm"
                value={nameDraft}
                aria-label={tr("settings.account.yourName")}
                disabled={busy}
                onChange={(event) => setNameDraft(event.target.value)}
                onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === "Enter") void rename(); }}
              />
              {nameDraft.trim() !== name && nameDraft.trim() && (
                <Button size="sm" variant="quiet" disabled={busy} onClick={() => void rename()}>{tr("common.save")}</Button>
              )}
            </span>
          </Row>
        )}
        {account.login && <ReadonlyRow label={tr("settings.users.login")} value={`@${account.login}`} mono hint={tr("settings.account.loginHint")} />}
        <ReadonlyRow
          label={tr("settings.account.accountId")}
          hint={tr("settings.account.accountIdHint")}
          value={<span className="account-detail-id" title={account.id}>{account.id}</span>}
          mono
          action={<CopyButton text={account.id} label={tr("settings.account.copyAccountId")} />}
        />
      </Section>

      <Section title={tr("settings.users.signIn")} hint={tr("settings.account.signInHint")} itemId="users.account.signin">
        {!account.managed && account.login && (
          <Row label={tr("settings.users.password")} hint={tr("settings.account.passwordHint")}>
            <Button size="sm" variant="quiet" disabled={busy} onClick={() => setPasswordOpen(true)}>{tr("settings.account.changePasswordEllipsis")}</Button>
          </Row>
        )}
        {localAccess && !account.login && (
          <Row
            label={tr("settings.users.password")}
            hint={tr("settings.account.passwordNoneHint")}
          >
            <Button size="sm" variant="quiet" disabled={busy} onClick={() => setSecureOpen(true)}>{tr("settings.account.setPasswordEllipsis")}</Button>
          </Row>
        )}
        {localAccess ? (
          <ReadonlyRow label={tr("settings.account.passkeys")} value={<Badge>{tr("settings.account.afterPassword")}</Badge>} hint={tr("settings.account.passkeysAfterPasswordHint")} />
        ) : passkeysAvailable === false ? (
          <ReadonlyRow label={tr("settings.account.passkeys")} value={<Badge>{tr("common.unavailable")}</Badge>} hint={tr("settings.account.passkeysUnsupportedHint")} />
        ) : (
          <Row label={tr("settings.account.passkeys")} hint={tr("settings.account.passkeysHint")}>
            <Button size="sm" variant="quiet" disabled={busy || passkeysAvailable !== true} onClick={() => setPasskeyOpen(true)}>{tr("settings.account.addPasskeyEllipsis")}</Button>
          </Row>
        )}
        {passkeysAvailable !== false && passkeys && passkeys.length > 0 && (
          <ItemList label={tr("settings.account.yourPasskeys")} className="account-detail-list">
            {passkeys.map((passkey) => (
              <ItemRow
                key={passkey.id}
                icon={<Icon icon={KeyIcon} size="sm" />}
                title={passkey.name}
                description={passkey.lastUsedAt
                  ? tr("settings.account.lastUsed", { date: when(passkey.lastUsedAt) })
                  : tr("settings.account.addedNotUsed", { date: when(passkey.createdAt) })}
                trailing={<Button size="sm" variant="ghost" disabled={busy} onClick={() => void removeKey(passkey)}>{tr("common.remove")}</Button>}
              />
            ))}
          </ItemList>
        )}
      </Section>

      <LinkedSignIns />

      <Section
        title={tr("settings.account.devicesTitle")}
        hint={tr("settings.account.devicesHint")}
        itemId="users.account.devices"
      >
        {ordered === null ? (
          <EmptyState compact busy title={tr("common.loading")} />
        ) : ordered.length === 0 ? (
          <EmptyState compact icon="lock" title={tr("settings.accesspage.noRememberedDevices")} body={tr("settings.accesspage.sessionsAppearHereAfterASuccessfulLogin")} />
        ) : (
          <ItemList label={tr("settings.account.signedInBrowsers")} className="account-detail-list">
            {ordered.map((session) => {
              const recent = Date.now() - session.lastSeenAt < ACTIVE_NOW_MS;
              return (
                <ItemRow
                  key={session.id}
                  icon={<Icon icon={isPhone(session.label) ? SmartphoneIcon : MonitorIcon} size="sm" />}
                  title={deviceLabel(session.label)}
                  {...(session.current ? { meta: <Badge tone="success" dot>{tr("settings.account.thisDevice")}</Badge> } : {})}
                  description={session.current || recent ? tr("settings.account.activeNow") : tr("settings.account.lastActive", { date: when(session.lastSeenAt) })}
                  trailing={(
                    <Button size="sm" variant="ghost" onClick={() => revoke(session)}>
                      {session.current ? tr("settings.accesspage.signOut") : tr("settings.accesspage.revoke")}
                    </Button>
                  )}
                />
              );
            })}
          </ItemList>
        )}
      </Section>

      {!localAccess && <Section title={tr("settings.accesspage.signOut")} tone="danger" itemId="users.account.signout">
        <Row label={tr("settings.account.switchAccount")} hint={tr("settings.account.switchAccountHint")}>
          <Button size="sm" variant="quiet" iconStart={SignOutIcon} onClick={signOut}>{tr("settings.accesspage.signOut")}</Button>
        </Row>
        <Row label={tr("settings.accesspage.signOutEverywhere")} hint={tr("settings.account.signOutEverywhereHint")}>
          <Button size="sm" variant="danger" onClick={() => void signOutEverywhere()}>{tr("settings.accesspage.signOutAllDevices")}</Button>
        </Row>
      </Section>}

      {passwordOpen && (
        <ChangePasswordDialog
          accountId={account.id}
          onClose={() => setPasswordOpen(false)}
        />
      )}
      {secureOpen && (
        <SecureAccountDialog
          onClose={() => setSecureOpen(false)}
          onSecured={(login) => {
            setSecureOpen(false);
            setLocalAccess(false);
            setNotice({ tone: "success", text: tr("settings.account.securedNotice", { login }) });
            void onChanged();
          }}
        />
      )}
      {passkeyOpen && (
        <AddPasskeyDialog
          withReauth={withReauth}
          onClose={() => setPasskeyOpen(false)}
          onAdded={(added) => {
            setPasskeyOpen(false);
            setNotice({ tone: "success", text: tr("settings.account.passkeyAdded", { name: added.name }) });
            loadPasskeys();
          }}
        />
      )}
    </div>
  );
}

function ChangePasswordDialog({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooShort = next.length > 0 && [...next].length < MIN_PASSWORD_LENGTH;
  const ready = !!current && [...next].length >= MIN_PASSWORD_LENGTH;

  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await changeAccountPassword(accountId, current, next);
      // Remembered sessions were revoked; sign in again with the new one.
      location.reload();
    } catch (cause) {
      setError(accountErrorText(cause));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={tr("settings.account.changePassword")}
      size="sm"
      className="users-dialog"
      onClose={() => { if (!busy) onClose(); }}
      footer={(
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{tr("common.cancel")}</Button>
          <Button variant="primary" busy={busy} disabled={!ready} onClick={() => void save()}>{tr("settings.account.changePassword")}</Button>
        </>
      )}
    >
      <form className="users-dialog-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <p className="users-dialog-intro">{tr("settings.account.changePasswordIntro")}</p>
        <FormField label={tr("settings.account.currentPassword")}>
          {(field) => (
            <TextInput {...field} type="password" value={current} autoComplete="current-password" disabled={busy} onChange={(event) => setCurrent(event.target.value)} />
          )}
        </FormField>
        <FormField
          label={tr("settings.account.newPassword")}
          hint={tr("settings.account.newPasswordHint", { count: MIN_PASSWORD_LENGTH })}
          {...(tooShort ? { error: tr("settings.users.passwordTooShort", { count: MIN_PASSWORD_LENGTH }) } : {})}
        >
          {(field) => (
            <span className="users-passphrase">
              <TextInput
                {...field}
                type={visible ? "text" : "password"}
                value={next}
                autoComplete="new-password"
                spellCheck={false}
                disabled={busy}
                invalid={tooShort}
                onChange={(event) => setNext(event.target.value)}
              />
              <Button size="sm" variant="quiet" disabled={busy} onClick={() => setVisible(!visible)}>{visible ? tr("settings.account.hide") : tr("settings.account.show")}</Button>
            </span>
          )}
        </FormField>
        {error && <Notice tone="error" role="alert">{error}</Notice>}
      </form>
    </Dialog>
  );
}

function AddPasskeyDialog({ withReauth, onClose, onAdded }: {
  withReauth: WithReauth;
  onClose: () => void;
  onAdded: (passkey: PasskeySummary) => void;
}) {
  const [name, setName] = useState(() => deviceLabel(typeof navigator === "undefined" ? "" : navigator.userAgent));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      onAdded(await withReauth(() => registerPasskey(name.trim())));
    } catch (cause) {
      if (!isReauthCancelled(cause)) setError(accountErrorText(cause));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={tr("settings.account.addPasskeyTitle")}
      size="sm"
      className="users-dialog"
      onClose={() => { if (!busy) onClose(); }}
      footer={(
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{tr("common.cancel")}</Button>
          <Button variant="primary" busy={busy} disabled={!name.trim()} onClick={() => void add()}>{tr("common.continue")}</Button>
        </>
      )}
    >
      <form className="users-dialog-form" onSubmit={(event) => { event.preventDefault(); void add(); }}>
        <p className="users-dialog-intro">{tr("settings.account.addPasskeyIntro")}</p>
        <FormField label={tr("settings.account.passkeyName")} hint={tr("settings.account.passkeyNameHint")}>
          {(field) => (
            <TextInput {...field} value={name} autoComplete="off" disabled={busy} onChange={(event) => setName(event.target.value)} />
          )}
        </FormField>
        {error && <Notice tone="error" role="alert">{error}</Notice>}
      </form>
    </Dialog>
  );
}
