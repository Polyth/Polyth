// Shown before the app boots when the server requires authentication (and
// again if the current device session is revoked mid-use). Static assets are
// public; every protected /api call stays 401 until login mints the httpOnly
// account-bound session cookie.
import { useEffect, useRef, useState } from "react";
import { reloadBehindVeil } from "../launchVeil.ts";
import { currentBrowserLogin, loginAccount, recoverAccount, type AccountLoginResult } from "../accounts.ts";
import { fetchAuthStatus } from "../authClient.ts";
import { desktopBridge } from "../desktopBridge.ts";
import { browserSupportsPasskeys, signInWithPasskey } from "../passkeys.ts";
import {
  beginProviderFlow,
  listLoginProviders,
  type LoginProvider,
} from "../identityProviders.ts";
import { tr } from "../i18n/index.ts";
import { Button, TextInput } from "./ui/index.ts";
import { POLYTH_MARK_SRC } from "../brandAsset.ts";

type LockMode = "password" | "recovery";

const providerLabel = (provider: LoginProvider): string => {
  if (provider.kind === "github") return "GitHub";
  if (provider.kind === "gitlab") return "GitLab";
  if (provider.kind === "bitbucket") return "Bitbucket";
  return provider.id;
};

/** A password-less owner (`local` access): no form can unlock this
 *  installation. Polyth Desktop re-opens its own session; a browser is told
 *  where Polyth opens and how to add a password. */
function LocalOwnerLock() {
  const renew = desktopBridge()?.renewOwnerSession;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const reopen = async (): Promise<void> => {
    if (!renew || busy) return;
    setBusy(true);
    setFailed(false);
    const renewed = await renew().catch(() => false);
    if (renewed) {
      reloadBehindVeil();
      return;
    }
    setFailed(true);
    setBusy(false);
  };
  return (
    <div className="lock-screen">
      <div className="lock-card lock-card--local" aria-labelledby="lock-title">
        <div className="lock-mark-frame">
          <img className="welcome-mark" src={POLYTH_MARK_SRC} alt="" aria-hidden="true" />
        </div>
        <h1 id="lock-title">{renew ? tr("lockscreen.localOwner.desktopTitle") : tr("lockscreen.localOwner.title")}</h1>
        <p className="lock-hint">{renew ? tr("lockscreen.localOwner.desktopBody") : tr("lockscreen.localOwner.body")}</p>
        {!renew && <p className="lock-local-howto">{tr("lockscreen.localOwner.howTo")}</p>}
        {failed && <p className="lock-error" role="alert">{tr("setup.error.generic")}</p>}
        {renew && (
          <div className="lock-actions">
            <Button variant="primary" className="lock-submit" busy={busy} block onClick={() => void reopen()}>
              {tr("common.continue")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** `localOwner` is known when boot read the auth status; a session that ends
 *  mid-use (`polyth:auth-required`) leaves it unknown, so ask the server
 *  whether this installation has any password before offering a form. */
export default function LockScreen({ onUnlocked, localOwner }: { onUnlocked: () => void; localOwner?: boolean }) {
  const [local, setLocal] = useState(localOwner === true);
  useEffect(() => {
    if (localOwner !== undefined) return;
    let cancelled = false;
    void fetchAuthStatus().then((status) => {
      if (!cancelled && status.accessMode === "local") setLocal(true);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [localOwner]);
  if (local) return <LocalOwnerLock />;
  return <PasswordLock onUnlocked={onUnlocked} />;
}

function PasswordLock({ onUnlocked }: { onUnlocked: () => void }) {
  const [mode, setMode] = useState<LockMode>("password");
  const [login, setLogin] = useState(currentBrowserLogin);
  const [password, setPassword] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [providers, setProviders] = useState<LoginProvider[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [mode]);

  useEffect(() => {
    if (typeof window === "undefined" || window.location.protocol !== "https:") return;
    void listLoginProviders().then(setProviders).catch(() => setProviders([]));
  }, []);

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
    // The signed-in boot starts behind the launch veil; it comes
    // back first so the sign-in card dissolves into it instead of cutting.
    if (typeof window !== "undefined") reloadBehindVeil();
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
      showFailure(result, result.error === "passkey-cancelled" ? tr("lockscreen.passkeyCancelled") : tr("lockscreen.passkeyFailed"));
    } catch (cause) {
      const code = (cause as { code?: unknown } | null)?.code;
      setError(code === "unsupported" ? tr("lockscreen.passkeyUnsupported") : tr("lockscreen.passkeyFailed"));
    } finally {
      setBusy(false);
    }
  };

  const signInProvider = async (provider: LoginProvider): Promise<void> => {
    if (busy || locked) return;
    setBusy(true);
    setError(null);
    try {
      await beginProviderFlow(provider.id, "login", "/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("lockscreen.externalFailed"));
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
            ? tr("lockscreen.strongerPassword")
            : tr("lockscreen.recoveryInvalid"),
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
      showFailure(signedIn, tr("lockscreen.passwordReset"));
    } catch {
      if (passwordWasRecovered) {
        setMode("password");
        setRecoveryCode("");
        setError(tr("lockscreen.passwordReset"));
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
      <form className="lock-card" aria-labelledby="lock-title" onSubmit={submit}>
        <div className="lock-mark-frame">
          <img className="welcome-mark" src={POLYTH_MARK_SRC} alt="" aria-hidden="true" />
        </div>
        <h1 id="lock-title">{mode === "password" ? tr("lockscreen.polythIsLocked") : tr("lockscreen.recoverAccount")}</h1>
        <p className="lock-hint">
          {mode === "password"
            ? tr("lockscreen.signInHint")
            : tr("lockscreen.recoveryHint")}
        </p>
        <div className="lock-fields">
          <label className="lock-field" htmlFor="lock-login">
            <span>{tr("settings.users.login")}</span>
            <TextInput
              id="lock-login"
              value={login}
              placeholder="owner"
              autoComplete="username"
              disabled={locked || busy}
              onChange={(e) => {
                setLogin(e.target.value);
                setError(null);
              }}
            />
          </label>
          {mode === "recovery" && (
            <label className="lock-field" htmlFor="lock-recovery-code">
              <span>{tr("lockscreen.recoveryCode")}</span>
              <TextInput
                ref={inputRef}
                id="lock-recovery-code"
                value={recoveryCode}
                placeholder={tr("lockscreen.recoveryCode")}
                autoComplete="one-time-code"
                disabled={locked || busy}
                onChange={(e) => {
                  setRecoveryCode(e.target.value);
                  setError(null);
                }}
              />
            </label>
          )}
          <label className="lock-field" htmlFor="lock-password">
            <span>{mode === "password" ? tr("lockscreen.password") : tr("settings.account.newPassword")}</span>
            <TextInput
              ref={mode === "password" ? inputRef : undefined}
              id="lock-password"
              type="password"
              value={password}
              placeholder={mode === "password" ? tr("lockscreen.password") : tr("settings.account.newPassword")}
              autoComplete={mode === "password" ? "current-password" : "new-password"}
              disabled={locked || busy}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
            />
          </label>
        </div>
        {error && (
          <p className="lock-error" role="alert">
            {error}{locked && ` ${tr("lockscreen.tryAgainIn", { seconds: secondsLeft })}`}
          </p>
        )}
        <div className="lock-actions">
          <Button variant="primary" className="lock-submit" type="submit" busy={busy} disabled={locked || !complete} block>
            {busy
              ? tr("lockscreen.checking")
              : locked
                ? tr("lockscreen.lockedValueS", { secondsLeft })
                : mode === "password" ? tr("lockscreen.unlock") : tr("lockscreen.recoverAndSignIn")}
          </Button>
          {mode === "password" && (passkeySupported || providers.length > 0) && (
            <div className="lock-alternatives">
              <span className="lock-divider" aria-hidden="true">{tr("lockscreen.or")}</span>
              {passkeySupported && (
                <Button className="lock-submit lock-submit--secondary" type="button" disabled={busy || locked} onClick={() => void signInPasskey()} block>
                  {tr("lockscreen.signInWithPasskey")}
                </Button>
              )}
              {providers.map((provider) => (
                <Button key={provider.id} className="lock-submit lock-submit--secondary" type="button" disabled={busy || locked} onClick={() => void signInProvider(provider)} block>
                  {tr("lockscreen.signInWithProvider", { provider: providerLabel(provider) })}
                </Button>
              ))}
            </div>
          )}
        </div>
        <Button variant="ghost" size="sm" className="lock-recovery" type="button" disabled={busy} onClick={switchMode}>
          {mode === "password" ? tr("lockscreen.useRecoveryCode") : tr("lockscreen.usePassword")}
        </Button>
      </form>
    </div>
  );
}
