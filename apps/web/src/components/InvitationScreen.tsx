// Someone opened an invitation link (`/#invite=<code>`). They choose their own
// password here and are signed in; nobody else ever knows it. After that a
// short "you're in" step names what a newcomer to a shared Polyth looks for
// first, because the people features stay out of sight for anyone alone.
import { useEffect, useRef, useState } from "react";
import { acceptInvitation, previewInvitation, type InvitationPreview } from "../accounts.ts";
import { tr } from "../i18n/index.ts";
import { POLYTH_MARK_SRC } from "../brandAsset.ts";
import { forgetInvitationCode } from "../invitationLink.ts";
import { Button, TextInput } from "./ui/index.ts";
import { accountErrorText, MIN_PASSWORD_LENGTH } from "./settings/usersModel.ts";

type Phase =
  | { kind: "checking" }
  | { kind: "invalid" }
  | { kind: "problem"; message: string }
  | { kind: "form"; invite: InvitationPreview }
  | { kind: "joined"; invite: InvitationPreview };

export default function InvitationScreen({ code, onDone }: { code: string; onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstField = useRef<HTMLInputElement>(null);
  const joinedCard = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void previewInvitation(code).then(
      (invite) => { if (live) setPhase({ kind: "form", invite }); },
      (cause: { code?: unknown; status?: unknown }) => {
        if (!live) return;
        if (cause?.code === "invalid-invitation") {
          forgetInvitationCode();
          setPhase({ kind: "invalid" });
        } else {
          setPhase({ kind: "problem", message: typeof cause?.status === "number" ? accountErrorText(cause) : tr("lockscreen.couldnTReachTheServer") });
        }
      },
    );
    return () => { live = false; };
  }, [code]);

  useEffect(() => {
    if (phase.kind === "form") firstField.current?.focus();
    if (phase.kind === "joined") joinedCard.current?.querySelector<HTMLButtonElement>(".lock-submit")?.focus();
  }, [phase.kind]);

  const leave = () => { forgetInvitationCode(); onDone(); };

  if (phase.kind === "checking") return <div className="lock-screen" aria-busy="true" />;

  if (phase.kind === "invalid" || phase.kind === "problem") {
    return (
      <div className="lock-screen">
        <div className="lock-card lock-card--invitation" role="alert">
          <div className="lock-mark-frame"><img className="welcome-mark" src={POLYTH_MARK_SRC} alt="" aria-hidden="true" /></div>
          <h1>{phase.kind === "invalid" ? tr("lockscreen.invitation.invalidTitle") : tr("lockscreen.invitation.problemTitle")}</h1>
          <p className="lock-hint">{phase.kind === "invalid" ? tr("lockscreen.invitation.invalidBody") : phase.message}</p>
          <div className="lock-actions">
            {phase.kind === "problem" && <Button variant="primary" className="lock-submit" onClick={() => location.reload()}>{tr("common.retry")}</Button>}
            <Button variant={phase.kind === "invalid" ? "primary" : "ghost"} className="lock-submit" onClick={leave}>{tr("lockscreen.invitation.toSignIn")}</Button>
          </div>
        </div>
      </div>
    );
  }

  const invite = phase.invite;
  const first = invite.name.trim().split(/\s+/)[0] || invite.name;

  if (phase.kind === "joined") {
    return (
      <div className="lock-screen">
        <div className="lock-card lock-card--invitation" ref={joinedCard} aria-labelledby="invitation-joined-title">
          <div className="lock-mark-frame"><img className="welcome-mark" src={POLYTH_MARK_SRC} alt="" aria-hidden="true" /></div>
          <h1 id="invitation-joined-title">{tr("lockscreen.invitation.joinedTitle", { name: first })}</h1>
          <p className="lock-hint">{tr("lockscreen.invitation.joinedBody")}</p>
          <ul className="invitation-pointers">
            <li><strong>{tr("lockscreen.invitation.pointChatsTitle")}</strong><span>{tr("lockscreen.invitation.pointChatsBody")}</span></li>
            <li><strong>{tr("lockscreen.invitation.pointPeopleTitle")}</strong><span>{tr("lockscreen.invitation.pointPeopleBody")}</span></li>
            <li><strong>{tr("lockscreen.invitation.pointDevicesTitle")}</strong><span>{tr("lockscreen.invitation.pointDevicesBody")}</span></li>
          </ul>
          <div className="lock-actions">
            <Button variant="primary" className="lock-submit" onClick={leave} block>{tr("lockscreen.invitation.open")}</Button>
          </div>
        </div>
      </div>
    );
  }

  const tooShort = next.length > 0 && [...next].length < MIN_PASSWORD_LENGTH;
  const mismatch = repeat.length > 0 && repeat !== next;
  const ready = [...next].length >= MIN_PASSWORD_LENGTH && repeat === next;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const result = await acceptInvitation(code, invite.login, next).catch(() => ({ ok: false as const }));
    if (result.ok) {
      forgetInvitationCode();
      setPhase({ kind: "joined", invite });
      setBusy(false);
      return;
    }
    setBusy(false);
    if ("error" in result && result.error === "invalid-invitation") { forgetInvitationCode(); setPhase({ kind: "invalid" }); return; }
    setError(accountErrorText(Object.assign(new Error("message" in result && result.message ? result.message : ""), "error" in result ? { code: result.error } : {})));
  };

  return (
    <div className="lock-screen">
      <form className="lock-card lock-card--invitation" aria-labelledby="invitation-title" onSubmit={submit}>
        <div className="lock-mark-frame"><img className="welcome-mark" src={POLYTH_MARK_SRC} alt="" aria-hidden="true" /></div>
        <h1 id="invitation-title">{tr("lockscreen.invitation.title", { name: first })}</h1>
        <p className="lock-hint">{tr("lockscreen.invitation.body")}</p>
        <div className="lock-fields">
          <label className="lock-field" htmlFor="invitation-login">
            <span>{tr("settings.users.login")}</span>
            {/* Read-only so a password manager files the new password under it. */}
            <TextInput id="invitation-login" name="username" autoComplete="username" value={invite.login} readOnly dir="ltr" />
          </label>
          <label className="lock-field" htmlFor="invitation-next">
            <span>{tr("settings.account.newPassword")}</span>
            <TextInput
              ref={firstField}
              id="invitation-next"
              type="password"
              value={next}
              autoComplete="new-password"
              spellCheck={false}
              disabled={busy}
              invalid={tooShort}
              onChange={(event) => { setNext(event.target.value); setError(null); }}
            />
          </label>
          <label className="lock-field" htmlFor="invitation-repeat">
            <span>{tr("lockscreen.passwordChange.repeat")}</span>
            <TextInput
              id="invitation-repeat"
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
            {busy ? tr("lockscreen.checking") : tr("lockscreen.invitation.submit")}
          </Button>
        </div>
        <Button variant="ghost" size="sm" className="lock-recovery" type="button" disabled={busy} onClick={leave}>
          {tr("lockscreen.invitation.haveAccount")}
        </Button>
      </form>
    </div>
  );
}
