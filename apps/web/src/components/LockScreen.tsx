// Shown before the app boots when the server requires authentication (and
// again if the current device session is revoked mid-use). Static assets are
// public; every protected /api call stays 401 until login mints the httpOnly
// account-bound polyth_auth cookie.
import { useEffect, useRef, useState } from "react";
import { currentBrowserAccountId, loginAccount } from "../accounts.ts";
import { tr } from "../i18n/index.ts";
import { Button, TextInput } from "./ui/index.ts";

export default function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [accountId, setAccountId] = useState(currentBrowserAccountId);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // Countdown re-render while rate-limited; the disabled state lifts itself.
  useEffect(() => {
    if (retryAt === null) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [retryAt]);

  void tick;
  const secondsLeft = retryAt === null ? 0 : Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
  const locked = secondsLeft > 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || locked || !accountId.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const r = await loginAccount(accountId, password);
      if (r.ok) {
        // Preference modules cache account-scoped state at import time. Reload
        // after authentication so the newly authenticated account owns the
        // first real application render instead of inheriting the prior user.
        if (typeof window !== "undefined") window.location.reload();
        else onUnlocked();
        return;
      }
      if (r.error === "rate-limited" && r.retryAfterSec) {
        setRetryAt(Date.now() + r.retryAfterSec * 1000);
        setError(tr("lockscreen.tooManyAttempts"));
      } else if (r.error === "invalid-password") {
        setError(tr("lockscreen.wrongPassword"));
      } else {
        setError(r.message ?? tr("lockscreen.wrongPassword"));
      }
      setPassword("");
    } catch {
      setError(tr("lockscreen.couldnTReachTheServer"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lock-screen">
      <form className="lock-card" onSubmit={submit}>
        <img className="welcome-mark" src="/icon-192.png" alt="" aria-hidden="true" />
        <h1>{tr("lockscreen.polythIsLocked")}</h1>
        <p className="lock-hint">Sign in to this Polyth server.</p>
        <TextInput
          value={accountId}
          placeholder="Account"
          autoComplete="username"
          aria-label="Account"
          disabled={locked || busy}
          onChange={(e) => {
            setAccountId(e.target.value);
            setError(null);
          }}
        />
        <TextInput
          ref={inputRef}
          type="password"
          className="lock-input"
          value={password}
          placeholder={tr("lockscreen.password")}
          autoComplete="current-password"
          aria-label={tr("lockscreen.uiPassword")}
          disabled={locked || busy}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && (
          <p className="lock-error" role="alert">
            {error}{locked && ` Try again in ${secondsLeft}s.`}
          </p>
        )}
        <Button variant="primary" className="lock-submit" type="submit" busy={busy} disabled={locked || !accountId.trim() || !password}>
          {busy ? tr("lockscreen.checking") : locked ? tr("lockscreen.lockedValueS", { secondsLeft: secondsLeft }) : tr("lockscreen.unlock")}
        </Button>
      </form>
    </div>
  );
}
