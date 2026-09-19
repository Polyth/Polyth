import { useEffect, useRef, useState } from "react";
import { authJson } from "../authClient.ts";
import { acceptAuthenticatedBrowserAccount } from "../authPrefetch.ts";
import { desktopBridge } from "../desktopBridge.ts";
import { Button, TextInput } from "./ui/index.ts";

const errorMessage = (body: Record<string, unknown>, status: number): string =>
  typeof body.message === "string"
    ? body.message
    : typeof body.error === "string"
      ? body.error.replace(/-/g, " ")
      : `HTTP ${status}`;

export default function SetupScreen({ restartRequired = false }: { restartRequired?: boolean }) {
  const desktop = desktopBridge();
  const isDesktop = desktop !== null;
  const desktopPrepareStarted = useRef(false);
  const [claimToken, setClaimToken] = useState("");
  const [recoverySetId, setRecoverySetId] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [organizationName, setOrganizationName] = useState("Personal");
  const [login, setLogin] = useState("owner");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [recoverySaved, setRecoverySaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [complete, setComplete] = useState(false);

  const prepare = async () => {
    const token = claimToken.trim().toLowerCase();
    if (busy || (!isDesktop && !/^[a-f0-9]{64}$/.test(token))) return;
    setBusy(true); setError("");
    try {
      const claimBody = isDesktop ? {} : { claimToken: token };
      const bound = await authJson("/api/auth/setup/claim", claimBody);
      if (!bound.response.ok) throw new Error(errorMessage(bound.body, bound.response.status));
      const recovery = await authJson<{ setId?: unknown; codes?: unknown }>("/api/auth/setup/recovery", claimBody);
      if (!recovery.response.ok) throw new Error(errorMessage(recovery.body, recovery.response.status));
      if (typeof recovery.body.setId !== "string" || !Array.isArray(recovery.body.codes)
        || !recovery.body.codes.every(code => typeof code === "string")) {
        throw new Error("Server returned invalid recovery material");
      }
      setRecoverySetId(recovery.body.setId);
      setRecoveryCodes(recovery.body.codes as string[]);
      setRecoverySaved(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (!isDesktop || restartRequired || desktopPrepareStarted.current) return;
    desktopPrepareStarted.current = true;
    void prepare();
  }, [isDesktop, restartRequired]);

  const finish = async () => {
    if (busy || !recoverySetId || !recoverySaved || password !== confirmPassword
      || password.length < 12 || !name.trim() || !organizationName.trim() || !login.trim()) return;
    setBusy(true); setError("");
    try {
      const result = await authJson("/api/auth/setup/complete", {
        claimToken: claimToken.trim().toLowerCase(),
        name: name.trim(),
        organizationName: organizationName.trim(),
        login: login.trim().toLowerCase(),
        password,
        recoverySetId,
        recoveryAcknowledged: true,
      });
      if (!result.response.ok) throw new Error(errorMessage(result.body, result.response.status));
      const meResponse = await fetch("/api/auth/me", { cache: "no-store" });
      const me = await meResponse.json().catch(() => ({})) as { id?: unknown };
      if (meResponse.ok && typeof me.id === "string" && me.id.trim()) {
        acceptAuthenticatedBrowserAccount(me.id);
      }
      try { localStorage.setItem("polyth.lastLogin", login.trim().toLowerCase()); } catch { /* private mode */ }
      setPassword(""); setConfirmPassword(""); setComplete(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  if (complete || restartRequired) return (
    <div className="lock-screen">
      <div className="lock-card">
        <img className="welcome-mark" src="/icon-192.png" alt="" aria-hidden="true" />
        <h1>Polyth is ready</h1>
        <p className="lock-hint">The canonical owner account and recovery credentials are committed.</p>
        <p className="lock-hint">Restart the Polyth server once to start the full workspace runtime.</p>
        <Button variant="primary" onClick={() => location.reload()}>Check after restart</Button>
      </div>
    </div>
  );

  return (
    <div className="lock-screen">
      <div className="lock-card">
        <img className="welcome-mark" src="/icon-192.png" alt="" aria-hidden="true" />
        <h1>Set up Polyth</h1>
        {recoveryCodes.length === 0 ? (
          <>
            <p className="lock-hint">Generate a short-lived operator claim with <code>npm run setup:claim</code>, then paste it here.</p>
            <TextInput
              value={claimToken}
              placeholder="Setup claim token"
              autoComplete="off"
              aria-label="Setup claim token"
              disabled={busy}
              onChange={(event) => { setClaimToken(event.target.value); setError(""); }}
            />
            <Button variant="primary" busy={busy} disabled={!/^[a-f0-9]{64}$/i.test(claimToken.trim())} onClick={() => void prepare()}>
              Continue securely
            </Button>
          </>
        ) : (
          <>
            <p className="lock-hint">Save these recovery codes before creating the owner account. They will not be shown again.</p>
            <pre className="mono" style={{ whiteSpace: "pre-wrap", userSelect: "all" }}>{recoveryCodes.join("\n")}</pre>
            <label className="lock-hint">
              <input type="checkbox" checked={recoverySaved} onChange={(event) => setRecoverySaved(event.target.checked)} /> I saved the recovery codes
            </label>
            <TextInput value={name} placeholder="Your name" autoComplete="name" aria-label="Your name" disabled={busy} onChange={(event) => setName(event.target.value)} />
            <TextInput value={organizationName} placeholder="Organization" aria-label="Organization" disabled={busy} onChange={(event) => setOrganizationName(event.target.value)} />
            <TextInput value={login} placeholder="Login" autoComplete="username" aria-label="Login" disabled={busy} onChange={(event) => setLogin(event.target.value)} />
            <TextInput type="password" value={password} placeholder="Passphrase · at least 12 characters" autoComplete="new-password" aria-label="Passphrase" disabled={busy} onChange={(event) => setPassword(event.target.value)} />
            <TextInput type="password" value={confirmPassword} placeholder="Confirm passphrase" autoComplete="new-password" aria-label="Confirm passphrase" disabled={busy} onChange={(event) => setConfirmPassword(event.target.value)} />
            {confirmPassword && password !== confirmPassword && <p className="lock-error">Passphrases do not match.</p>}
            <Button
              variant="primary"
              busy={busy}
              disabled={!recoverySaved || !name.trim() || !organizationName.trim() || !login.trim() || password.length < 12 || password !== confirmPassword}
              onClick={() => void finish()}
            >
              Create owner account
            </Button>
          </>
        )}
        {error && <p className="lock-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
