// Protect a password-less owner ("only me" first run) once Polyth starts to
// admit other people or other ways in. Same two beats as setup: choose a
// password, then save recovery codes; the password only takes effect with the
// codes the owner confirmed saving. The owner keeps their account and data and
// signs in as `owner` from then on.
import { Fragment, useState } from "react";
import { prepareOwnerRecovery, protectOwnerAccount } from "../../accounts.ts";
import { desktopBridge } from "../../desktopBridge.ts";
import { copyText } from "../../utils.ts";
import { Button, Checkbox, CopiedIcon, CopyIcon, Dialog, DownloadIcon, Notice, TextInput } from "../ui/index.ts";
import { FormField } from "./parts.tsx";
import { accountErrorText, MIN_PASSWORD_LENGTH } from "./usersModel.ts";
import { tr } from "../../i18n/index.ts";

type Stage = "password" | "codes";

/** The server accepts these steps only right after the Desktop main process
 *  confirmed this window's session; a copied cookie can never do it. */
async function confirmOnThisComputer(): Promise<void> {
  const confirm = desktopBridge()?.confirmOwnerSession;
  if (confirm && !(await confirm().catch(() => false))) {
    throw Object.assign(new Error(tr("settings.secure.confirmFailed")), { code: "desktop-confirmation-failed" });
  }
}

/** Four-character groups for reading; the copied text stays one unbroken code. */
const codeGroups = (code: string): string[] => code.match(/.{1,4}/g) ?? [code];

export default function SecureAccountDialog({ reason, onClose, onSecured }: {
  /** Why now, e.g. "Before you add people…"; a general intro when absent. */
  reason?: string;
  onClose: () => void;
  onSecured: (login: string) => void;
}) {
  const [stage, setStage] = useState<Stage>("password");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [recovery, setRecovery] = useState<{ setId: string; codes: string[] } | null>(null);
  const [saved, setSaved] = useState(false);
  const [renewed, setRenewed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooShort = password.length > 0 && [...password].length < MIN_PASSWORD_LENGTH;
  const passwordReady = [...password].length >= MIN_PASSWORD_LENGTH;

  const fail = (cause: unknown): void => setError(
    (cause as { code?: unknown } | null)?.code === "invalid-transition"
      ? tr("settings.secure.alreadyProtected")
      : accountErrorText(cause),
  );

  const toCodes = async (): Promise<void> => {
    if (!passwordReady || busy) return;
    setBusy(true);
    setError(null);
    try {
      await confirmOnThisComputer();
      setRecovery(await prepareOwnerRecovery());
      setSaved(false);
      setStage("codes");
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  const protect = async (): Promise<void> => {
    if (!recovery || !saved || busy) return;
    setBusy(true);
    setError(null);
    try {
      await confirmOnThisComputer();
      const { login } = await protectOwnerAccount(password, recovery.setId);
      setPassword("");
      onSecured(login);
    } catch (cause) {
      const code = (cause as { code?: unknown } | null)?.code;
      if (code === "recovery-ack-required") {
        // The prepared codes are gone (replaced elsewhere): show new ones.
        try {
          await confirmOnThisComputer();
          setRecovery(await prepareOwnerRecovery());
          setSaved(false);
          setRenewed(true);
        } catch (inner) {
          fail(inner);
        }
      } else if (code === "invalid-input") {
        setStage("password");
        fail(cause);
      } else {
        fail(cause);
      }
      setBusy(false);
    }
  };

  const copyCodes = async (): Promise<void> => {
    if (!recovery) return;
    if (!(await copyText(recovery.codes.join("\n")))) {
      setError(tr("setup.recovery.copyFailed"));
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const downloadCodes = (): void => {
    if (!recovery) return;
    const contents = [
      tr("setup.recovery.fileTitle"),
      "",
      tr("setup.recovery.fileUsage", { login: "owner" }),
      tr("setup.recovery.fileKeepSafe"),
      "",
      ...recovery.codes,
      "",
    ].join("\n");
    const url = URL.createObjectURL(new Blob([contents], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "polyth-recovery-codes.txt";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const close = (): void => { if (!busy) onClose(); };
  // The login stays a literal, emphasized value inside the sentence.
  const signInAs = tr("settings.secure.signInAs", { login: "\u0000" }).split("\u0000");

  return (
    <Dialog
      title={stage === "password" ? tr("settings.secure.title") : tr("setup.recovery.title")}
      // Wide enough for one recovery code per line, as on the setup card.
      size={stage === "password" ? "sm" : "md"}
      className="users-dialog secure-account-dialog"
      onClose={close}
      footer={stage === "password" ? (
        <>
          <Button variant="ghost" disabled={busy} onClick={close}>{tr("common.cancel")}</Button>
          <Button variant="primary" busy={busy} disabled={!passwordReady} onClick={() => void toCodes()}>{tr("common.continue")}</Button>
        </>
      ) : (
        <>
          <Button variant="ghost" disabled={busy} onClick={() => { setStage("password"); setError(null); }}>{tr("common.back")}</Button>
          <Button variant="primary" busy={busy} disabled={!saved} onClick={() => void protect()}>{tr("settings.secure.protect")}</Button>
        </>
      )}
    >
      {stage === "password" ? (
        <form className="users-dialog-form" onSubmit={(event) => { event.preventDefault(); void toCodes(); }}>
          <p className="users-dialog-intro">
            {reason ?? tr("settings.secure.intro")}
            {" "}{signInAs[0]}<strong>owner</strong>{signInAs[1]}
          </p>
          {/* Lets a password manager save the new password for the right login. */}
          <input type="text" name="username" autoComplete="username" value="owner" readOnly hidden />
          <FormField
            label={tr("settings.users.password")}
            hint={tr("settings.account.newPasswordHint", { count: MIN_PASSWORD_LENGTH })}
            {...(tooShort ? { error: tr("settings.users.passwordTooShort", { count: MIN_PASSWORD_LENGTH }) } : {})}
          >
            {(field) => (
              <span className="users-passphrase">
                <TextInput
                  {...field}
                  type={visible ? "text" : "password"}
                  value={password}
                  autoComplete="new-password"
                  spellCheck={false}
                  disabled={busy}
                  invalid={tooShort}
                  onChange={(event) => { setPassword(event.target.value); setError(null); }}
                />
                <Button size="sm" variant="quiet" disabled={busy} onClick={() => setVisible(!visible)}>{visible ? tr("settings.account.hide") : tr("settings.account.show")}</Button>
              </span>
            )}
          </FormField>
          {error && <Notice tone="error" role="alert">{error}</Notice>}
        </form>
      ) : recovery && (
        <div className="users-dialog-form">
          <p className="users-dialog-intro">{tr("setup.recovery.intro")}</p>
          {renewed && (
            <Notice tone="warning" role="alert">{tr("settings.secure.codesRenewed")}</Notice>
          )}
          <ol className="setup-codes" aria-label={tr("setup.recovery.listLabel")}>
            {recovery.codes.map((code) => (
              <li key={code}>
                <code className="setup-code">
                  {codeGroups(code).map((group, index, groups) => (
                    <Fragment key={index}>
                      {index === Math.ceil(groups.length / 2) && <wbr />}
                      <span>{group}</span>
                    </Fragment>
                  ))}
                </code>
              </li>
            ))}
          </ol>
          <div className="setup-codes-actions">
            <Button iconStart={DownloadIcon} disabled={busy} onClick={downloadCodes}>{tr("setup.recovery.download")}</Button>
            <Button className={copied ? "is-copied" : undefined} iconStart={copied ? CopiedIcon : CopyIcon} disabled={busy} onClick={() => void copyCodes()}>
              {copied ? tr("setup.recovery.copied") : tr("common.copy")}
            </Button>
          </div>
          <Checkbox checked={saved} disabled={busy} onChange={setSaved} label={tr("setup.recovery.saved")} />
          {error && <Notice tone="error" role="alert">{error}</Notice>}
        </div>
      )}
    </Dialog>
  );
}
