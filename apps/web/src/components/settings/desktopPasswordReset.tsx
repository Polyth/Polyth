// A forgotten owner password, reset in Polyth Desktop on the computer that
// runs Polyth. The app's main process asks the operating system first (Touch
// ID, or a native confirmation no page can answer) and only then sets the new
// password in-process; there is no HTTP route for it. Every sign-in ends and
// the app reopens this window as the owner.
import { useState } from "react";
import { localDesktopBridge } from "../../desktopBridge.ts";
import { reloadBehindVeil } from "../../launchVeil.ts";
import { tr } from "../../i18n/index.ts";
import { Button, Dialog, Notice, TextInput } from "../ui/index.ts";
import { FormField } from "./parts.tsx";
import { MIN_PASSWORD_LENGTH } from "./usersModel.ts";

/** Only Polyth Desktop showing its own server can offer it. */
export const canResetOnThisComputer = (): boolean => typeof localDesktopBridge()?.resetOwnerPassword === "function";

/** The quiet "forgot it?" link that opens the dialog below. */
export function ResetOnThisComputerLink({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  if (!canResetOnThisComputer()) return null;
  return (
    <Button variant="ghost" size="sm" className="desktop-reset-link" disabled={disabled} onClick={onClick}>
      {tr("settings.desktopReset.link")}
    </Button>
  );
}

/** The dialog runs only in the desktop app on the server's own computer, so
 *  the browser's platform is that computer's: only a Mac offers Touch ID. */
const onMac = (): boolean => typeof navigator !== "undefined" && /^mac/i.test(navigator.platform ?? "");

export function DesktopPasswordResetDialog({ onClose }: { onClose: () => void }) {
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooShort = next.length > 0 && [...next].length < MIN_PASSWORD_LENGTH;
  const mismatch = repeat.length > 0 && repeat !== next;
  const ready = [...next].length >= MIN_PASSWORD_LENGTH && repeat === next;

  const reset = async () => {
    const run = localDesktopBridge()?.resetOwnerPassword;
    if (!ready || busy || !run) return;
    setBusy(true);
    setError(null);
    const result = await run(next).catch(() => ({ ok: false as const, error: "unavailable" as const }));
    if (result.ok) {
      // Every session ended; the app already reopened this window's one.
      reloadBehindVeil();
      return;
    }
    setBusy(false);
    if (result.error === "cancelled") return;
    setError(result.error === "invalid-input"
      ? tr("lockscreen.strongerPassword")
      : result.error === "forbidden" ? tr("settings.desktopReset.forbidden") : tr("settings.desktopReset.failed"));
  };

  return (
    <Dialog
      title={tr("settings.desktopReset.title")}
      size="sm"
      className="users-dialog"
      onClose={() => { if (!busy) onClose(); }}
      footer={(
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{tr("common.cancel")}</Button>
          <Button variant="primary" busy={busy} disabled={!ready} onClick={() => void reset()}>{tr("settings.desktopReset.submit")}</Button>
        </>
      )}
    >
      <form className="users-dialog-form" onSubmit={(event) => { event.preventDefault(); void reset(); }}>
        <p className="users-dialog-intro">{tr(onMac() ? "settings.desktopReset.introMac" : "settings.desktopReset.intro")}</p>
        <FormField
          label={tr("settings.account.newPassword")}
          hint={tr("settings.account.newPasswordHint", { count: MIN_PASSWORD_LENGTH })}
          {...(tooShort ? { error: tr("settings.users.passwordTooShort", { count: MIN_PASSWORD_LENGTH }) } : {})}
        >
          {(field) => (
            <TextInput {...field} type="password" value={next} autoComplete="new-password" spellCheck={false} disabled={busy} invalid={tooShort}
              onChange={(event) => { setNext(event.target.value); setError(null); }} />
          )}
        </FormField>
        <FormField label={tr("lockscreen.passwordChange.repeat")} {...(mismatch ? { error: tr("lockscreen.passwordChange.mismatch") } : {})}>
          {(field) => (
            <TextInput {...field} type="password" value={repeat} autoComplete="new-password" spellCheck={false} disabled={busy} invalid={mismatch}
              onChange={(event) => { setRepeat(event.target.value); setError(null); }} />
          )}
        </FormField>
        {error && <Notice tone="error" role="alert">{error}</Notice>}
      </form>
    </Dialog>
  );
}
