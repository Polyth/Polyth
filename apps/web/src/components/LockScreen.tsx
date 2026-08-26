// F16 lock screen: shown before the app boots when the server requires a UI
// password (and again if the device session is revoked mid-use). Static
// assets are public, so this shell always renders; every /api call behind it
// stays 401 until login mints the polyth_auth cookie.
import { useEffect, useRef, useState } from "react";
import { api } from "@polyth/session/web-api";
import { tr } from "../i18n/index.ts";

export default function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

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
    if (busy || locked || !password) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.authLogin(password);
      if (r.ok) {
        onUnlocked();
        return;
      }
      if (r.error === "rate-limited" && r.retryAfterSec) {
        setRetryAt(Date.now() + r.retryAfterSec * 1000);
        setError(tr("lockscreen.tooManyAttempts"));
      } else if (r.error === "invalid-password") {
        setError(tr("lockscreen.wrongPassword"));
      } else {
        setError(r.message);
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
        <span className="welcome-mark">{tr("lockscreen.p")}</span>
        <h1>{tr("lockscreen.polythIsLocked")}</h1>
        <p className="lock-hint">{tr("lockscreen.enterTheUiPasswordToContinue")}</p>
        <input
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
        <button className="primary-btn lock-submit" type="submit" disabled={locked || busy || !password}>
          {busy ? tr("lockscreen.checking") : locked ? tr("lockscreen.lockedValueS", { secondsLeft: secondsLeft }) : tr("lockscreen.unlock")}
        </button>
      </form>
    </div>
  );
}
