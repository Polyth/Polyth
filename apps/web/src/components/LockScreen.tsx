// Shown before the app boots when the server requires authentication (and
// again if the current device session is revoked mid-use). Static assets are
// public; every protected /api call stays 401 until login mints the httpOnly
// account-bound session cookie.
import { useEffect, useRef, useState } from "react";
import { currentBrowserLogin, loginAccount, recoverAccount, type AccountLoginResult } from "../accounts.ts";
import { browserSupportsPasskeys, signInWithPasskey } from "../passkeys.ts";
import { tr } from "../i18n/index.ts";
import { Button, TextInput } from "./ui/index.ts";

type LockMode = "password" | "recovery";

export default function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [mode, setMode] = useState<LockMode>("password");
  const [login, setLogin] = useState(currentBrowserLogin);
  const [password, setPassword] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [mode]);

  useEffect(() => {
    if (retryAt === null) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [retryAt]);

  void tick;
  const secondsLeft = retryAt === null ? 0 : Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
  const locked = secondsLeft > 0;
  const complete = mode === "password"
    ? !!login.trim() && !!password
    : !!login.trim() && !!recoveryCode.trim() && !!password;
  const passkeySupported = browserSupportsPasskeys();

  const unlock = (): void => {
    if (typeof window !== "undefined") window.location.reload();
    else onUnlocked();
  };

  const showFailure = (result: AccountLoginResult, fallback: string): void => {
    if (result.error === "rate-limited" && result.retryAfterSec) {
      setRetryAt(Date.now() + result.retryAfterSec * 1000);
      setError(tr("lockscreen.tooManyAttempts"));
      return;
    }
    if (result.error === "invalid-password" || result.error === "invalid-credentials") {
      setError(fallback);
      return;
    }
    setError(result.message ?? fallback);
  };

  const signInPasskey = async (): Promise<void> => {
    if (busy || locked) return;
    setBusy(true);
    setError(null);
    try {
      const result = await signInWithPasskey();
      if (result.ok) {
        unlock();
        return;
      }
      showFailure(result, result.error === "passkey-cancelled" ? "Passkey sign-in was cancelled." : "Passkey sign-in failed.");
    } catch (cause) {
      const code = (cause as { code?: unknown } | null)?.code;
      setError(code === "unsupported" ? "Passkeys are not supported by this browser." : "Passkey sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || locked || !complete) return;
    setBusy(true);
    setError(null);
    let passwordWasRecovered = false;
    try {
      if (mode === "password") {
        const result = await loginAccount(login, password);
        if (result.ok) {
          unlock();
          return;
        }
        showFailure(result, tr("lockscreen.wrongPassword"));
        setPassword("");
        return;
      }

      const recovered = await recoverAccount(login, recoveryCode, password);
      if (!recovered.ok) {
        showFailure(
          recovered,
          recovered.error === "invalid-input"
            ? "Choose a stronger new password."
            : "Login or recovery code is invalid.",
        );
        setRecoveryCode("");
        setPassword("");
        return;
      }
      passwordWasRecovered = true;

      // Recovery intentionally revokes every old session. Mint the replacement
      // session through the normal login path rather than treating recovery as
      // authentication or reusing stale browser account authority.
      const signedIn = await loginAccount(login, password);
      if (signedIn.ok) {
        unlock();
        return;
      }
      setMode("password");
      setRecoveryCode("");
      showFailure(signedIn, "Password was reset. Sign in with your new password.");
    } catch {
      if (passwordWasRecovered) {
        setMode("password");
        setRecoveryCode("");
        setError("Password was reset. Sign in with your new password.");
      } else {
        setError(tr("lockscreen.couldnTReachTheServer"));
      }
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (): void => {
    setMode((current) => current === "password" ? "recovery" : "password");
    setPassword("");
    setRecoveryCode("");
    setError(null);
    setRetryAt(null);
  };

  return (
    <div className="lock-screen">
      <form className="lock-card" onSubmit={submit}>
        <img className="welcome-mark" src="/icon-192.png" alt="" aria-hidden="true" />
        <h1>{mode === "password" ? tr("lockscreen.polythIsLocked") : "Recover account"}</h1>
        <p className="lock-hint">
          {mode === "password"
            ? "Sign in to this Polyth server."
            : "Use one of the recovery codes saved during setup and choose a new password."}
        </p>
        <TextInput
          value={login}
          placeholder="Login"
          autoComplete="username"
          aria-label="Login"
          disabled={locked || busy}
          onChange={(e) => {
            setLogin(e.target.value);
            setError(null);
          }}
        />
        {mode === "recovery" && (
          <TextInput
            ref={inputRef}
            className="lock-input"
            value={recoveryCode}
            placeholder="Recovery code"
            autoComplete="one-time-code"
            aria-label="Recovery code"
            disabled={locked || busy}
            onChange={(e) => {
              setRecoveryCode(e.target.value);
              setError(null);
            }}
          />
        )}
        <TextInput
          ref={mode === "password" ? inputRef : undefined}
          type="password"
          className="lock-input"
          value={password}
          placeholder={mode === "password" ? tr("lockscreen.password") : "New password"}
          autoComplete={mode === "password" ? "current-password" : "new-password"}
          aria-label={mode === "password" ? tr("lockscreen.uiPassword") : "New password"}
          disabled={locked || busy}
          onChange={(e) => {
            setPassword(e.target.value);
            setError(null);
          }}
        />
        {error && (
          <p className="lock-error" role="alert">
            {error}{locked && ` Try again in ${secondsLeft}s.`}
          </p>
        )}
        <Button variant="primary" className="lock-submit" type="submit" busy={busy} disabled={locked || !complete}>
          {busy
            ? tr("lockscreen.checking")
            : locked
              ? tr("lockscreen.lockedValueS", { secondsLeft })
              : mode === "password" ? tr("lockscreen.unlock") : "Recover and sign in"}
        </Button>
        {mode === "password" && passkeySupported && (
          <Button className="lock-submit" type="button" disabled={busy || locked} onClick={() => void signInPasskey()}>
            Sign in with a passkey
          </Button>
        )}
        <Button variant="ghost" size="sm" type="button" disabled={busy} onClick={switchMode}>
          {mode === "password" ? "Use a recovery code" : "Use password instead"}
        </Button>
      </form>
    </div>
  );
}
