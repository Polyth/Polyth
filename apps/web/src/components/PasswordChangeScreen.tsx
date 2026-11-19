// Someone else (an owner creating or resetting the account) chose the password
// this person signed in with. The server opens nothing but the change to their
// session until they choose their own, so this screen stands in for the app.
import { useEffect, useRef, useState } from "react";
import { authJson } from "../authClient.ts";
import { changeAccountPassword, loginAccount } from "../accounts.ts";
import { tr } from "../i18n/index.ts";
import { POLYTH_MARK_SRC } from "../brandAsset.ts";
import { DesktopServerExit } from "./DesktopServerSwitcher.tsx";
import { Button, TextInput } from "./ui/index.ts";
import { accountErrorText, MIN_PASSWORD_LENGTH } from "./settings/usersModel.ts";

interface Me { id: string; login?: string }

export default function PasswordChangeScreen({ onChanged }: { onChanged: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    void fetch("/api/auth/me", { cache: "no-store", credentials: "same-origin" })
      .then((response) => response.ok ? response.json() as Promise<Partial<Me>> : null)
      .then((body) => {
        if (!live) return;
        if (body && typeof body.id === "string") setMe({ id: body.id, ...(typeof body.login === "string" ? { login: body.login } : {}) });
        else setError(tr("lockscreen.couldnTReachTheServer"));
      })
      .catch(() => { if (live) setError(tr("lockscreen.couldnTReachTheServer")); });
    firstField.current?.focus();
    return () => { live = false; };
  }, []);

  const tooShort = next.length > 0 && [...next].length < MIN_PASSWORD_LENGTH;
  const mismatch = repeat.length > 0 && repeat !== next;
  const ready = !!me && !!current && [...next].length >= MIN_PASSWORD_LENGTH && repeat === next;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready || busy || !me) return;
    if (next === current) { setError(tr("lockscreen.passwordChange.sameAsGiven")); return; }
    setBusy(true);
    setError(null);
    try {
      await changeAccountPassword(me.id, current, next);
    } catch (cause) {
      setError(accountErrorText(cause));
      setBusy(false);
      return;
    }
    // The change ends every session, this one included: sign straight back in
    // with the new password, or land on the sign-in screen if that fails.
    if (me.login) await loginAccount(me.login, next).catch(() => undefined);
    onChanged();
  };

  const signOut = () => {
    setBusy(true);
    void authJson("/api/auth/logout", {}).finally(() => location.reload());
  };

  return (
    <div className="lock-screen">
      <form className="lock-card" aria-labelledby="password-change-title" onSubmit={submit}>
        <div className="lock-mark-frame">
          <img className="welcome-mark" src={POLYTH_MARK_SRC} alt="" aria-hidden="true" />
        </div>
        <h1 id="password-change-title">{tr("lockscreen.passwordChange.title")}</h1>
        <p className="lock-hint">{tr("lockscreen.passwordChange.body")}</p>
        <div className="lock-fields">
          {/* Lets a password manager file the new password under this login. */}
          {me?.login && <input type="text" name="username" autoComplete="username" value={me.login} readOnly hidden />}
          <label className="lock-field" htmlFor="password-change-current">
            <span>{tr("lockscreen.passwordChange.current")}</span>
            <TextInput
              ref={firstField}
              id="password-change-current"
              type="password"
              value={current}
              autoComplete="current-password"
              disabled={busy}
              onChange={(event) => { setCurrent(event.target.value); setError(null); }}
            />
          </label>
          <label className="lock-field" htmlFor="password-change-next">
            <span>{tr("settings.account.newPassword")}</span>
            <TextInput
              id="password-change-next"
              type="password"
              value={next}
              autoComplete="new-password"
              spellCheck={false}
              disabled={busy}
              invalid={tooShort}
              onChange={(event) => { setNext(event.target.value); setError(null); }}
            />
          </label>
          <label className="lock-field" htmlFor="password-change-repeat">
            <span>{tr("lockscreen.passwordChange.repeat")}</span>
            <TextInput
              id="password-change-repeat"
              type="password"
              value={repeat}
              autoComplete="new-password"
              spellCheck={false}
              disabled={busy}
              invalid={mismatch}
              onChange={(event) => { setRepeat(event.target.value); setError(null); }}
            />
          </label>
        </div>
        {error || tooShort || mismatch
          ? (
            <p className="lock-error" role="alert">
              {error ?? (tooShort
                ? tr("settings.users.passwordTooShort", { count: MIN_PASSWORD_LENGTH })
                : tr("lockscreen.passwordChange.mismatch"))}
            </p>
          )
          : <p className="lock-hint">{tr("settings.account.newPasswordHint", { count: MIN_PASSWORD_LENGTH })}</p>}
        <div className="lock-actions">
          <Button variant="primary" className="lock-submit" type="submit" busy={busy} disabled={!ready} block>
            {busy ? tr("lockscreen.checking") : tr("lockscreen.passwordChange.submit")}
          </Button>
        </div>
        <Button variant="ghost" size="sm" className="lock-recovery" type="button" disabled={busy} onClick={signOut}>
          {tr("settings.accesspage.signOut")}
        </Button>
        <DesktopServerExit />
      </form>
    </div>
  );
}
