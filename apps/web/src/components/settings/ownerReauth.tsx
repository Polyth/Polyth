import { useCallback, useRef, useState, type ReactNode } from "react";
import { isReauthRequired, reauthenticate } from "../../accounts.ts";
import { Button, Dialog, Notice, TextInput } from "../ui/index.ts";
import { FormField } from "./parts.tsx";
import { accountErrorText } from "./usersModel.ts";
import { tr } from "../../i18n/index.ts";

/** Thrown when the owner closes the password prompt; callers stay quiet. */
export const REAUTH_CANCELLED = Object.freeze(Object.assign(new Error("Cancelled"), { code: "reauth-cancelled" }));
export const isReauthCancelled = (cause: unknown): boolean => cause === REAUTH_CANCELLED;

export type WithReauth = <T>(action: () => Promise<T>) => Promise<T>;

/**
 * Owner actions on accounts need a recent password confirmation (the server
 * keeps it for five minutes). Run the action first; only when the server asks
 * for it, prompt once, confirm, and run the action again. Wrong passwords are
 * explained inside the prompt, never behind it.
 */
export function useOwnerReauth(): { withReauth: WithReauth; prompt: ReactNode } {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ resolve: () => void; reject: (cause: unknown) => void } | null>(null);

  const ask = useCallback(() => new Promise<void>((resolve, reject) => {
    pending.current?.reject(REAUTH_CANCELLED);
    pending.current = { resolve, reject };
    setPassword("");
    setError(null);
    setOpen(true);
  }), []);

  const withReauth = useCallback<WithReauth>(async (action) => {
    try {
      return await action();
    } catch (cause) {
      if (!isReauthRequired(cause)) throw cause;
      await ask();
      return action();
    }
  }, [ask]);

  const close = () => {
    if (busy) return;
    pending.current?.reject(REAUTH_CANCELLED);
    pending.current = null;
    setOpen(false);
  };
  const confirm = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await reauthenticate(password);
      setOpen(false);
      setPassword("");
      const done = pending.current;
      pending.current = null;
      done?.resolve();
    } catch (cause) {
      setError(accountErrorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const prompt = open ? (
    <Dialog
      title={tr("settings.reauth.title")}
      size="sm"
      className="users-dialog"
      initialFocus=".users-reauth-password"
      onClose={close}
      footer={(
        <>
          <Button variant="ghost" disabled={busy} onClick={close}>{tr("common.cancel")}</Button>
          <Button variant="primary" busy={busy} disabled={!password} onClick={() => void confirm()}>{tr("settings.reauth.confirm")}</Button>
        </>
      )}
    >
      <form className="users-dialog-form" onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
        <p className="users-dialog-intro">
          {tr("settings.reauth.intro")}
        </p>
        <FormField label={tr("settings.reauth.yourPassword")}>
          <TextInput
            className="users-reauth-password"
            type="password"
            value={password}
            autoComplete="current-password"
            invalid={error !== null}
            onChange={(event) => setPassword(event.target.value)}
          />
        </FormField>
        {error && <Notice tone="error" role="alert">{error}</Notice>}
      </form>
    </Dialog>
  ) : null;

  return { withReauth, prompt };
}
