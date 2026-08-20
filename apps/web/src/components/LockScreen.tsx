// F16 lock screen: shown before the app boots when the server requires a UI
// password (and again if the device session is revoked mid-use). Static
// assets are public, so this shell always renders; every /api call behind it
// stays 401 until login mints the polyth_auth cookie.
import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";

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
        setError("Too many attempts.");
      } else if (r.error === "invalid-password") {
        setError("Wrong password.");
      } else {
        setError(r.message);
      }
      setPassword("");
    } catch {
      setError("Couldn’t reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lock-screen">
      <form className="lock-card" onSubmit={submit}>
        <span className="welcome-mark">p</span>
        <h1>Polyth is locked</h1>
        <p className="lock-hint">Enter the UI password to continue.</p>
        <input
          ref={inputRef}
          type="password"
          className="lock-input"
          value={password}
          placeholder="Password"
          autoComplete="current-password"
          aria-label="UI password"
          disabled={locked || busy}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && (
          <p className="lock-error" role="alert">
            {error}{locked && ` Try again in ${secondsLeft}s.`}
          </p>
        )}
        <button className="primary-btn lock-submit" type="submit" disabled={locked || busy || !password}>
          {busy ? "Checking…" : locked ? `Locked (${secondsLeft}s)` : "Unlock"}
        </button>
      </form>
    </div>
  );
}
