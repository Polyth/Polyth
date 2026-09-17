import { useCallback, useEffect, useState } from "react";
import type { AuthDeviceDto } from "@polyth/session/web-api";
import {
  accountState,
  changeAccountPassword,
  createAccount,
  disableAccount,
  renameCurrentAccount,
  type AccountChoice,
} from "../../accounts.ts";
import { authJson, fetchAuthStatus } from "../../authClient.ts";
import type { BrowserAuthStatus } from "../../authBootstrap.ts";
import {
  browserSupportsPasskeys,
  listPasskeys,
  registerPasskey,
  removePasskey,
  type PasskeySummary,
} from "../../passkeys.ts";
import {
  grantSpaceMember,
  loadCurrentSpaceAccess,
  type CurrentSpaceAccess,
} from "../../spaceAccess.ts";
import { confirmAlert } from "../../alerts.ts";
import { EmptyState, PageHead, Row } from "./parts.tsx";
import { getLocale, tr } from "../../i18n/index.ts";
import { Button, TextInput } from "../ui/index.ts";

const when = (ts: number): string => new Date(ts).toLocaleString(getLocale());
type AccessDevice = AuthDeviceDto & { revision?: number; expiresAt?: number };

const deviceLabel = (ua: string): string => {
  if (!ua) return tr("settings.accesspage.unknownDevice");
  const browser =
    /Edg\//.test(ua) ? tr("settings.accesspage.edge") : /Firefox\//.test(ua) ? tr("settings.accesspage.firefox")
    : /Chrome\//.test(ua) ? tr("settings.accesspage.chrome") : /Safari\//.test(ua) ? tr("settings.accesspage.safari") : null;
  const os =
    /Windows/.test(ua) ? tr("settings.accesspage.windows") : /Mac OS X|Macintosh/.test(ua) ? tr("settings.accesspage.macos")
    : /Android/.test(ua) ? tr("settings.accesspage.android") : /iPhone|iPad/.test(ua) ? tr("settings.accesspage.ios")
    : /Linux/.test(ua) ? tr("settings.accesspage.linux") : null;
  if (browser && os) return tr("settings.accesspage.valueOnValue", { browser, os });
  return browser ?? os ?? ua.slice(0, 40);
};

async function browserSessions(): Promise<AccessDevice[]> {
  const response = await fetch("/api/auth/sessions", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json() as unknown;
  if (Array.isArray(body)) return body as AccessDevice[];
  if (body && typeof body === "object" && Array.isArray((body as { sessions?: unknown }).sessions)) {
    return (body as { sessions: AccessDevice[] }).sessions;
  }
  throw new Error("Invalid session response");
}

const authError = (response: Response, body: Record<string, unknown>): Error => new Error(
  typeof body.message === "string"
    ? body.message
    : typeof body.error === "string" ? body.error.replace(/-/g, " ") : `HTTP ${response.status}`,
);

export default function AccessPage() {
  const [status, setStatus] = useState<BrowserAuthStatus | null>(null);
  const [devices, setDevices] = useState<AccessDevice[]>([]);
  const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);
  const [accounts, setAccounts] = useState<AccountChoice[]>([]);
  const [currentAccountId, setCurrentAccountId] = useState("");
  const [profileName, setProfileName] = useState("");
  const [canManage, setCanManage] = useState(false);
  const [spaceAccess, setSpaceAccess] = useState<CurrentSpaceAccess | null>(null);
  const [managementPassword, setManagementPassword] = useState("");
  const [newLogin, setNewLogin] = useState("");
  const [newName, setNewName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [passkeyName, setPasskeyName] = useState("");
  const [passkeyPassword, setPasskeyPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(() => {
    setErr("");
    void Promise.all([
      fetchAuthStatus(),
      accountState(),
      loadCurrentSpaceAccess().catch(() => null),
    ]).then(([nextStatus, nextAccounts, nextSpaceAccess]) => {
      setStatus(nextStatus);
      setAccounts(nextAccounts.accounts);
      setCurrentAccountId(nextAccounts.currentAccountId);
      setProfileName(nextAccounts.accounts.find((account) => account.id === nextAccounts.currentAccountId)?.name ?? "");
      setCanManage(nextAccounts.canManage);
      setSpaceAccess(nextSpaceAccess);
      void browserSessions().then(setDevices).catch(() => setDevices([]));
      void listPasskeys().then(setPasskeys).catch(() => setPasskeys([]));
    }).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const reauthenticate = async (passwordValue: string): Promise<void> => {
    const result = await authJson("/api/auth/reauthenticate", { password: passwordValue });
    if (!result.response.ok) throw authError(result.response, result.body);
  };

  const revoke = (id: string) => {
    const device = devices.find((entry) => entry.id === id);
    void authJson(`/api/auth/sessions/${encodeURIComponent(id)}`, {
      ...(device?.revision ? { expectedRevision: device.revision } : {}),
    }, "DELETE").then(({ response, body }) => {
      if (!response.ok) throw authError(response, body);
      if (device?.current) location.reload();
      else refresh();
    }).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };
  const signOutAll = async () => {
    if (!await confirmAlert(tr("settings.accesspage.signOutEveryDeviceIncludingThisOne"), { title: tr("settings.accesspage.signOutEverywhere"), confirmLabel: tr("settings.accesspage.signOut") })) return;
    void authJson("/api/auth/logout-all", {}).then(({ response, body }) => {
      if (!response.ok) throw authError(response, body);
      location.reload();
    }).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };
  const addAccount = async () => {
    if (busy || !newLogin.trim() || !newName.trim() || newPassword.length < 12 || !managementPassword) return;
    setBusy(true); setErr(""); setNotice("");
    try {
      await reauthenticate(managementPassword);
      const account = await createAccount(newLogin.trim().toLowerCase(), newName.trim(), newPassword);
      setNewLogin(""); setNewName(""); setNewPassword(""); setManagementPassword("");
      setNotice(spaceAccess?.canManageMembers
        ? `${account.name} was created without tenant access. Use Grant to ${spaceAccess.name} to admit this account explicitly.`
        : "Account created. Organization and Space access remain ungranted until an authorized tenant admin admits it.");
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const grantCurrentSpace = async (account: AccountChoice) => {
    if (!spaceAccess?.canManageMembers || account.status === "disabled") return;
    setBusy(true); setErr(""); setNotice("");
    try {
      await grantSpaceMember(spaceAccess.id, account.id, "member");
      const next = await loadCurrentSpaceAccess();
      setSpaceAccess(next);
      setNotice(`${account.name} now has member access to ${spaceAccess.name}.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const saveProfile = async () => {
    const current = accounts.find((account) => account.id === currentAccountId);
    const name = profileName.trim();
    if (busy || !current || current.managed || !name || name === current.name) return;
    setBusy(true); setErr(""); setNotice("");
    try {
      const renamed = await renameCurrentAccount(current, name);
      setAccounts((items) => items.map((account) => account.id === renamed.id ? { ...account, ...renamed } : account));
      setProfileName(renamed.name);
      setNotice("Display name updated. Your account identity and sign-in methods are unchanged.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      refresh();
    } finally { setBusy(false); }
  };
  const savePassword = async () => {
    if (busy || !currentPassword || password.length < 12 || !currentAccountId) return;
    setBusy(true); setErr(""); setNotice("");
    try {
      await changeAccountPassword(currentAccountId, currentPassword, password);
      setCurrentPassword(""); setPassword("");
      location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const addPasskey = async () => {
    if (busy || !passkeyName.trim() || !passkeyPassword) return;
    setBusy(true); setErr(""); setNotice("");
    try {
      await reauthenticate(passkeyPassword);
      const added = await registerPasskey(passkeyName.trim());
      setPasskeyName("");
      setPasskeyPassword("");
      setNotice(`${added.name} is now available for passwordless sign-in.`);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const removeRegisteredPasskey = async (passkey: PasskeySummary) => {
    if (!passkeyPassword) {
      setErr("Enter your current password under Passkeys before removing a passkey.");
      return;
    }
    if (!await confirmAlert(`Remove ${passkey.name}? This credential will stop signing in to this account.`, { title: "Remove passkey", confirmLabel: "Remove" })) return;
    setBusy(true); setErr(""); setNotice("");
    try {
      await reauthenticate(passkeyPassword);
      await removePasskey(passkey);
      setPasskeyPassword("");
      setNotice(`${passkey.name} was removed. Other sign-in methods remain unchanged.`);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const disable = async (account: AccountChoice) => {
    if (!managementPassword) {
      setErr("Enter your current password under Account management before disabling an account.");
      return;
    }
    if (!await confirmAlert(`Disable ${account.name}? Their identity remains durable and tenant data is retained for recovery.`, { title: "Disable account", confirmLabel: "Disable" })) return;
    setBusy(true); setErr(""); setNotice("");
    try {
      await reauthenticate(managementPassword);
      await disableAccount(account);
      setManagementPassword("");
      setNotice(`${account.name} is disabled. Existing sessions were revoked.`);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  if (err && !status) return <><PageHead title={tr("settings.accesspage.access")} /><EmptyState title={tr("settings.accesspage.serverUnreachable")} body={err} /></>;
  if (!status) return <><PageHead title={tr("settings.accesspage.access")} /><EmptyState title={tr("common.loading")} busy /></>;

  const current = accounts.find((account) => account.id === currentAccountId);
  const passkeysAvailable = status.methods?.includes("passkey") === true && browserSupportsPasskeys();

  return (
    <>
      <PageHead title="Accounts & Access" blurb="Server identity, accounts, authentication, and explicit Space grants." />
      <Row label="Server" hint="The Polyth server this browser is connected to." itemId="access.server">
        <span className="mono">{typeof location === "undefined" ? "Polyth" : location.host}</span>
      </Row>
      <Row label="Current account" hint="Your display name can change; the immutable account ID underneath continues to own Projects, Spaces, settings, presets, and restoration." itemId="access.account">
        {current?.managed ? (
          <span className="tag">{current.name} · Managed</span>
        ) : (
          <div className="set-row-control">
            <TextInput
              uiSize="sm"
              value={profileName}
              placeholder="Display name"
              aria-label="Current account display name"
              onChange={(event) => setProfileName(event.target.value)}
            />
            <Button
              size="sm"
              busy={busy}
              disabled={!current || !profileName.trim() || profileName.trim() === current.name}
              onClick={() => void saveProfile()}
            >
              Save name
            </Button>
          </div>
        )}
      </Row>
      <Row label="Account ID" hint="Stable identity used by ownership and access records.">
        <span className="mono">{currentAccountId}</span>
      </Row>
      <Row label="Current Space" hint="Accounts do not enter a Space merely because they exist on this server." itemId="access.space">
        <span className="tag">{spaceAccess ? `${spaceAccess.name} · ${spaceAccess.role}` : "Unavailable"}</span>
      </Row>
      <Row label={tr("settings.accesspage.passwordProtection")} hint="Canonical account authentication is required by this server." itemId="access.protection">
        <span className="tag">{tr("settings.accesspage.on")}</span>
      </Row>

      <div className="set-page-head"><h3>Accounts on this server</h3></div>
      {accounts.map((account) => {
        const membership = spaceAccess?.members.find((member) => member.userId === account.id);
        return (
          <Row
            key={account.id}
            label={account.current ? `${account.name} · Current` : account.name}
            hint={`${account.id}${account.status ? ` · ${account.status}` : ""}${membership && spaceAccess ? ` · ${spaceAccess.name}: ${membership.role}` : " · no current Space access"}`}
          >
            <div className="set-row-control">
              {spaceAccess?.canManageMembers && !membership && account.status !== "disabled" && (
                <Button size="sm" disabled={busy} onClick={() => void grantCurrentSpace(account)}>
                  Grant to {spaceAccess.name}
                </Button>
              )}
              {canManage && !account.current && !account.managed && account.status !== "disabled" && (
                <Button size="sm" variant="danger" disabled={busy} onClick={() => void disable(account)}>Disable</Button>
              )}
            </div>
          </Row>
        );
      })}
      <Row label="Switch account" hint="Sign out, then enter the other account’s login name. Account IDs are not login credentials.">
        <Button size="sm" onClick={() => void authJson("/api/auth/logout", {}).then(() => location.reload())}>Sign out</Button>
      </Row>

      {canManage && (
        <>
          <div className="set-page-head"><h3>Account management</h3></div>
          <Row label="Confirm owner password" hint="Creating or disabling accounts requires recent reauthentication.">
            <TextInput
              uiSize="sm"
              type="password"
              value={managementPassword}
              autoComplete="current-password"
              placeholder="Current password"
              aria-label="Owner password"
              onChange={(event) => setManagementPassword(event.target.value)}
            />
          </Row>
          <Row label="New account" hint="Identity creation grants no organization, Space, project, or secret access. Grant the current Space separately above when appropriate.">
            <div className="set-row-control">
              <TextInput uiSize="sm" value={newLogin} autoComplete="off" placeholder="Login" aria-label="New account login" onChange={(event) => setNewLogin(event.target.value)} />
              <TextInput uiSize="sm" value={newName} placeholder="Display name" aria-label="New account name" onChange={(event) => setNewName(event.target.value)} />
              <TextInput uiSize="sm" type="password" value={newPassword} autoComplete="new-password" placeholder="Passphrase · 12+ characters" aria-label="New account passphrase" onChange={(event) => setNewPassword(event.target.value)} />
              <Button size="sm" busy={busy} disabled={!managementPassword || !newLogin.trim() || !newName.trim() || newPassword.length < 12} onClick={() => void addAccount()}>Add</Button>
            </div>
          </Row>
        </>
      )}

      <div className="set-page-head"><h3>Credentials</h3></div>
      <Row label="Change password" hint="Changing the password revokes remembered sessions; sign in again afterwards." itemId="access.password">
        <div className="set-row-control">
          <TextInput uiSize="sm" type="password" value={currentPassword} autoComplete="current-password" placeholder="Current password" aria-label="Current password" onChange={(event) => setCurrentPassword(event.target.value)} />
          <TextInput uiSize="sm" type="password" value={password} autoComplete="new-password" placeholder="New passphrase · 12+ characters" aria-label="New passphrase" onChange={(event) => setPassword(event.target.value)} />
          <Button size="sm" busy={busy} disabled={!currentPassword || password.length < 12} onClick={() => void savePassword()}>Save</Button>
        </div>
      </Row>
      {passkeysAvailable ? (
        <>
          <Row label="Add passkey" hint="Passkeys are device-backed, phishing-resistant sign-in credentials. Current-password confirmation elevates this session before registration." itemId="access.passkeys">
            <div className="set-row-control">
              <TextInput uiSize="sm" value={passkeyName} placeholder="Passkey name" aria-label="Passkey name" onChange={(event) => setPasskeyName(event.target.value)} />
              <TextInput uiSize="sm" type="password" value={passkeyPassword} autoComplete="current-password" placeholder="Current password" aria-label="Passkey current password" onChange={(event) => setPasskeyPassword(event.target.value)} />
              <Button size="sm" busy={busy} disabled={!passkeyName.trim() || !passkeyPassword} onClick={() => void addPasskey()}>Add passkey</Button>
            </div>
          </Row>
          {passkeys.length === 0
            ? <Row label="Registered passkeys" hint="No passkeys are registered for this account."><span className="tag">None</span></Row>
            : passkeys.map((passkey) => (
              <Row
                key={passkey.id}
                label={passkey.name}
                hint={`Created ${when(passkey.createdAt)}${passkey.lastUsedAt ? ` · last used ${when(passkey.lastUsedAt)}` : " · not used yet"}`}
              >
                <Button size="sm" variant="danger" disabled={busy} onClick={() => void removeRegisteredPasskey(passkey)}>Remove</Button>
              </Row>
            ))}
        </>
      ) : (
        <Row label="Passkeys" hint="This browser or server does not expose WebAuthn passkeys for the current origin.">
          <span className="tag">Unavailable</span>
        </Row>
      )}

      <div className="set-page-head"><h3>{tr("settings.accesspage.rememberedDevices")}</h3></div>
      {devices.length === 0
        ? <EmptyState title={tr("settings.accesspage.noRememberedDevices")} body={tr("settings.accesspage.sessionsAppearHereAfterASuccessfulLogin")} />
        : devices.map((d) => (
          <Row
            key={d.id}
            label={d.current
              ? tr("settings.accesspage.valueThisDevice", { value: deviceLabel(d.label) })
              : deviceLabel(d.label)}
            hint={tr("settings.accesspage.signedInValueLastSeenValue", { value: when(d.createdAt), value2: when(d.lastSeenAt) })}
          >
            <Button size="sm" onClick={() => revoke(d.id)}>
              {d.current ? tr("settings.accesspage.signOut") : tr("settings.accesspage.revoke")}
            </Button>
          </Row>
        ))}
      <Row label={tr("settings.accesspage.signOutEverywhere")} hint="Revokes remembered sessions for this account only." itemId="access.logout-all">
        <Button size="sm" variant="danger" onClick={() => void signOutAll()}>{tr("settings.accesspage.signOutAllDevices")}</Button>
      </Row>
      {notice && <p className="muted" role="status">{notice}</p>}
      {err && <p className="form-error" role="alert">{err}</p>}
    </>
  );
}
