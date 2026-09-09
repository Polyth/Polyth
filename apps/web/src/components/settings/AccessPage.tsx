import { useCallback, useEffect, useState } from "react";
import { api, type AuthDeviceDto, type AuthStatusDto } from "@polyth/session/web-api";
import {
  accountState,
  changeAccountPassword,
  createAccount,
  removeAccount,
  switchAccount,
  type AccountChoice,
} from "../../accounts.ts";
import { confirmAlert } from "../../alerts.ts";
import { EmptyState, PageHead, Row } from "./parts.tsx";
import { getLocale, tr } from "../../i18n/index.ts";
import { Button, TextInput } from "../ui/index.ts";

const when = (ts: number): string => new Date(ts).toLocaleString(getLocale());

/** "Chrome on macOS"-ish from a stored user-agent; raw prefix as fallback. */
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

export default function AccessPage() {
  const [status, setStatus] = useState<AuthStatusDto | null>(null);
  const [devices, setDevices] = useState<AuthDeviceDto[]>([]);
  const [accounts, setAccounts] = useState<AccountChoice[]>([]);
  const [currentAccountId, setCurrentAccountId] = useState("");
  const [canManage, setCanManage] = useState(false);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [switchPassword, setSwitchPassword] = useState("");
  const [newName, setNewName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(() => {
    setErr("");
    void Promise.all([api.authStatus(), accountState()]).then(([nextStatus, nextAccounts]) => {
      setStatus(nextStatus);
      setAccounts(nextAccounts.accounts);
      setCurrentAccountId(nextAccounts.currentAccountId);
      setCanManage(nextAccounts.canManage);
      void api.authSessions().then(setDevices).catch(() => setDevices([]));
    }).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const revoke = (id: string) => {
    void api.authRevoke(id).then(refresh).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };
  const signOutAll = async () => {
    if (!await confirmAlert(tr("settings.accesspage.signOutEveryDeviceIncludingThisOne"), { title: tr("settings.accesspage.signOutEverywhere"), confirmLabel: tr("settings.accesspage.signOut") })) return;
    void api.authLogoutAll().then(() => location.reload()).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };
  const addAccount = async () => {
    if (busy || !newName.trim() || newPassword.length < 8) return;
    setBusy(true); setErr(""); setNotice("");
    try {
      await createAccount(newName.trim(), newPassword);
      setNewName(""); setNewPassword("");
      setNotice("Account created. It gets its own Personal space when it first signs in.");
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const savePassword = async () => {
    if (busy || password.length < 8 || !currentAccountId) return;
    setBusy(true); setErr(""); setNotice("");
    try {
      const authWasOff = status?.required === false;
      await changeAccountPassword(currentAccountId, password);
      if (authWasOff) {
        await switchAccount(currentAccountId, password);
        return;
      }
      setPassword("");
      setNotice("Password updated.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const doSwitch = async (accountId: string) => {
    if (busy || switchPassword.length === 0) return;
    setBusy(true); setErr("");
    try {
      const result = await switchAccount(accountId, switchPassword);
      if (!result.ok) setErr(result.message ?? "Couldn’t sign in to that account.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const remove = async (account: AccountChoice) => {
    if (!await confirmAlert(`Remove ${account.name} from this server? Their tenant data is retained for safe recovery.`, { title: "Remove account", confirmLabel: tr("common.remove") })) return;
    setBusy(true); setErr("");
    try {
      await removeAccount(account.id);
      if (switchingTo === account.id) { setSwitchingTo(null); setSwitchPassword(""); }
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  if (err && !status) return <><PageHead title={tr("settings.accesspage.access")} /><EmptyState title={tr("settings.accesspage.serverUnreachable")} body={err} /></>;
  if (!status) return <><PageHead title={tr("settings.accesspage.access")} /><EmptyState title={tr("common.loading")} busy /></>;

  const current = accounts.find((account) => account.id === currentAccountId);

  return (
    <>
      <PageHead title="Accounts & Access" blurb="Server identity, accounts, authentication, and remembered devices." />
      <Row label="Server" hint="The Polyth server this browser is connected to." itemId="access.server">
        <span className="mono">{typeof location === "undefined" ? "Polyth" : location.host}</span>
      </Row>
      <Row label="Current account" hint="Projects, Spaces, settings, presets, and restoration use this identity." itemId="access.account">
        <span className="tag">{current?.name ?? currentAccountId}</span>
      </Row>
      <Row label={tr("settings.accesspage.passwordProtection")} hint={status.required ? "Account authentication is required by this server." : "Authentication is currently off for the local owner. Set a password to enable it."} itemId="access.protection">
        <span className="tag">{status.required ? tr("settings.accesspage.on") : "Off"}</span>
      </Row>

      <div className="set-page-head"><h3>Accounts on this server</h3></div>
      {accounts.map((account) => (
        <Row
          key={account.id}
          label={account.current ? `${account.name} · Current` : account.name}
          hint={account.id}
        >
          <div className="set-row-control">
            {!account.current && (
              <Button size="sm" disabled={busy} onClick={() => {
                setSwitchingTo((currentId) => currentId === account.id ? null : account.id);
                setSwitchPassword("");
                setErr("");
              }}>Switch</Button>
            )}
            {canManage && !account.current && account.id !== "usr_owner" && (
              <Button size="sm" variant="danger" disabled={busy} onClick={() => void remove(account)}>Remove</Button>
            )}
          </div>
        </Row>
      ))}
      {switchingTo && (
        <Row label={`Sign in as ${accounts.find((account) => account.id === switchingTo)?.name ?? switchingTo}`} hint="Switching reloads the app so state from the previous account cannot survive.">
          <div className="set-row-control">
            <TextInput uiSize="sm" type="password" value={switchPassword} autoComplete="current-password" placeholder="Password" aria-label="Account password" onChange={(event) => setSwitchPassword(event.target.value)} />
            <Button size="sm" variant="primary" busy={busy} disabled={!switchPassword} onClick={() => void doSwitch(switchingTo)}>Sign in</Button>
          </div>
        </Row>
      )}

      {canManage && (
        <>
          <div className="set-page-head"><h3>Add account</h3></div>
          <Row label="New account" hint="A new account starts with an isolated Personal space and independent settings.">
            <div className="set-row-control">
              <TextInput uiSize="sm" value={newName} placeholder="Name" aria-label="New account name" onChange={(event) => setNewName(event.target.value)} />
              <TextInput uiSize="sm" type="password" value={newPassword} autoComplete="new-password" placeholder="Password" aria-label="New account password" onChange={(event) => setNewPassword(event.target.value)} />
              <Button size="sm" busy={busy} disabled={!newName.trim() || newPassword.length < 8} onClick={() => void addAccount()}>Add</Button>
            </div>
          </Row>
        </>
      )}

      <div className="set-page-head"><h3>Credentials</h3></div>
      <Row label={status.required ? "Change password" : "Set owner password"} hint="Passwords are scrypt-hashed server-side; plaintext is never persisted." itemId="access.password">
        <div className="set-row-control">
          <TextInput uiSize="sm" type="password" value={password} autoComplete="new-password" placeholder="New password" aria-label="New password" onChange={(event) => setPassword(event.target.value)} />
          <Button size="sm" busy={busy} disabled={password.length < 8} onClick={() => void savePassword()}>Save</Button>
        </div>
      </Row>

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
      {status.required && (
        <Row label={tr("settings.accesspage.signOutEverywhere")} hint="Revokes remembered sessions for this account only." itemId="access.logout-all">
          <Button size="sm" variant="danger" onClick={() => void signOutAll()}>{tr("settings.accesspage.signOutAllDevices")}</Button>
        </Row>
      )}
      {notice && <p className="muted" role="status">{notice}</p>}
      {err && <p className="form-error" role="alert">{err}</p>}
    </>
  );
}
