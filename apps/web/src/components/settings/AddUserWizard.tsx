// Settings → Users → Add user: a three-step flow that a non-technical owner can
// follow without knowing what a Space role or a guardrail is, and that a
// professional can finish with Enter, Enter:
//   1. Who: name, login (suggested from the name) and a generated temporary
//      password, already filled in.
//   2. What they can do: one preset (Teammate, Protected, Viewer, Admin,
//      Account only), each a Space role with or without Protected mode.
//   3. Done: the sign-in details and a ready-made invitation to send. The
//      temporary password is shown here for the last time.
// Projects, assistants and daily limits are fine-tuned on the person's page.
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { GUARDRAIL_DEFAULT_GRANTS } from "@polyth/contracts";
import SlotHost, { useSlotVersion } from "../slots/SlotHost.ts";
import { listSlots } from "../../slots.ts";
import { openSettingsPage } from "../../store.ts";
import Dialog from "../a11y/Dialog.tsx";
import { refreshProjects } from "../../init.ts";
import {
  accountGuardrails,
  createAccount,
  inviteAccount,
  setAccountGuardrails,
  type AccountChoice,
} from "../../accounts.ts";
import { invitationUrl } from "../../invitationLink.ts";
import { grantSpaceMember, type CurrentSpaceAccess } from "../../spaceAccess.ts";
import { Button, Icon, IconButton, Notice, TextInput } from "../ui/index.ts";
import {
  BackIcon,
  CheckIcon,
  ChevronRightIcon,
  CloseIcon,
  CopiedIcon,
  CopyIcon,
  KeyIcon,
  PeopleIcon,
  SessionIcon,
  ShareIcon,
  ShieldIcon,
  ShowIcon,
  SuccessIcon,
  type LucideIcon,
} from "../ui/icons.ts";
import { FormField } from "./parts.tsx";
import { PassphraseField } from "./UserDetail.tsx";
import { buildGuardrails } from "./accountGuardrailsModel.ts";
import { isReauthCancelled, type WithReauth } from "./ownerReauth.tsx";
import {
  accountErrorText,
  defaultPreset,
  generatePassphrase,
  invitationLinkText,
  invitationText,
  LOGIN_PATTERN,
  MIN_PASSWORD_LENGTH,
  presetChoices,
  presetPlan,
  presetRoleTag,
  presetText,
  shareableAddress,
  suggestLogin,
  type UserPreset,
} from "./usersModel.ts";
import { tr } from "../../i18n/index.ts";

type Step = "who" | "access" | "done";

const PRESET_ICONS: Record<UserPreset, LucideIcon> = {
  teammate: PeopleIcon,
  protected: ShieldIcon,
  viewer: ShowIcon,
  admin: KeyIcon,
  account: SessionIcon,
};

interface Created {
  account: AccountChoice;
  name: string;
  login: string;
  password: string;
  /** A one-time sign-in link, when this server could issue one at a shareable address. */
  invitation: { url: string; expiresAt: number } | null;
  /** Joined the current Space, so the owner can pair their Polyth app. */
  member: boolean;
  preset: UserPreset;
  /** Sentences for whatever was created only in part. */
  problems: string[];
}

/** A phone opens the flow without summoning its keyboard; a desktop types at once. */
const finePointer = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: fine)").matches;

export default function AddUserWizard({ spaceAccess, withReauth, onClose, onCreated, onOpenAccount }: {
  spaceAccess: CurrentSpaceAccess | null;
  withReauth: WithReauth;
  /** Leave the flow (Cancel, X, Escape, Done). */
  onClose: () => void;
  /** The account exists: refresh the list behind the flow. */
  onCreated: (account: AccountChoice) => void;
  /** Done → "Fine-tune access": open the new person's page. */
  onOpenAccount: (accountId: string) => void;
}) {
  const canManageMembers = !!spaceAccess?.canManageMembers;
  const space = spaceAccess?.name ?? null;
  const [step, setStep] = useState<Step>("who");
  const [name, setName] = useState("");
  const [login, setLogin] = useState("");
  const [loginEdited, setLoginEdited] = useState(false);
  // A strong temporary password is ready before anyone thinks about one.
  const [password, setPassword] = useState(() => generatePassphrase());
  const [visible, setVisible] = useState(true);
  const [copied, setCopied] = useState(false);
  const [preset, setPreset] = useState<UserPreset>(() => defaultPreset(canManageMembers));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const firstStep = useRef(true);

  const normalizedLogin = login.trim().toLowerCase();
  const loginValid = LOGIN_PATTERN.test(normalizedLogin);
  const passwordValid = [...password].length >= MIN_PASSWORD_LENGTH;
  const whoReady = !!name.trim() && loginValid && passwordValid;
  const displayName = name.trim();
  const choices = useMemo(() => presetChoices(canManageMembers), [canManageMembers]);

  // Each step announces itself: focus its title (step 2: the chosen option,
  // so arrow keys and Enter work at once). The first step keeps the dialog's
  // own opening focus.
  useEffect(() => {
    if (firstStep.current) { firstStep.current = false; return; }
    bodyRef.current?.scrollTo?.({ top: 0 });
    const radio = step === "access" ? bodyRef.current?.querySelector<HTMLInputElement>("input[type=radio]:checked") : null;
    (radio ?? titleRef.current)?.focus({ preventScroll: true });
  }, [step]);

  const close = () => { if (!busy) onClose(); };

  const toAccess = () => {
    if (!whoReady || busy) return;
    setError(null);
    setStep("access");
  };

  const create = async () => {
    if (!whoReady || busy) return;
    setBusy(true);
    setError(null);
    const plan = presetPlan(preset, canManageMembers);
    try {
      const account = await withReauth(() => createAccount(normalizedLogin, displayName, password));
      const shownName = account.name && account.name !== account.id ? account.name : displayName;
      const problems: string[] = [];
      // Protection comes before access: a person meant to be protected never
      // gets into a Space without it.
      let guarded = !plan.guarded;
      if (plan.guarded) {
        try {
          const current = await accountGuardrails(account.id);
          const guardrails = buildGuardrails({ enabled: true, models: [], approvals: "none", extra: [] }, GUARDRAIL_DEFAULT_GRANTS);
          await withReauth(() => setAccountGuardrails(account.id, guardrails, current.revision));
          guarded = true;
        } catch (cause) {
          problems.push(tr("settings.users.createdGuardFailed", {
            name: shownName,
            reason: isReauthCancelled(cause) ? tr("settings.users.errorPasskeyCancelled") : accountErrorText(cause),
          }));
        }
      }
      let member = false;
      if (plan.role && spaceAccess && guarded) {
        try {
          await grantSpaceMember(spaceAccess.id, account.id, plan.role);
          member = true;
          void refreshProjects();
        } catch (cause) {
          problems.push(tr("settings.users.createdGrantFailed", { name: shownName, space: spaceAccess.name, reason: accountErrorText(cause) }));
        }
      }
      // The link is the easy way in; the temporary password stays as a fallback
      // (an older server, or one reachable only on this computer).
      let invitation: Created["invitation"] = null;
      try {
        const issued = await withReauth(() => inviteAccount(account.id));
        const url = invitationUrl(issued.url, typeof location === "undefined" ? "" : location.origin, shareableAddress);
        if (url) invitation = { url, expiresAt: issued.expiresAt };
      } catch { /* the password below still works */ }
      setCreated({ account, name: shownName, login: account.login ?? normalizedLogin, password, invitation, member, preset, problems });
      setStep("done");
      onCreated(account);
    } catch (cause) {
      if (!isReauthCancelled(cause)) setError(accountErrorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const total = 2;
  const index = step === "who" ? 1 : step === "access" ? 2 : 3;

  return (
    <Dialog
      title={tr("settings.users.addUser")}
      onClose={close}
      size="md"
      className="user-wizard"
      initialFocus={finePointer() ? ".user-wizard-name" : ".user-wizard-title"}
    >
      <header className="user-wizard-head" data-step={step}>
        <div className="user-wizard-head-top">
          {step === "done" ? (
            <span className="user-wizard-done-mark" aria-hidden="true"><Icon icon={SuccessIcon} size="md" /></span>
          ) : (
            <span className="user-wizard-step">{tr("setup.progress", { current: index, total })}</span>
          )}
          <IconButton icon={CloseIcon} label={tr("common.close")} disabled={busy} onClick={close} />
        </div>
        <h2 className="user-wizard-title" ref={titleRef} tabIndex={-1}>
          {step === "who" && tr("settings.users.wizard.whoTitle")}
          {step === "access" && tr("settings.users.wizard.accessTitle", { name: displayName })}
          {step === "done" && created && tr("settings.users.wizard.doneTitle", { name: created.name })}
        </h2>
        <p className="user-wizard-hint">
          {step === "who" && tr("settings.users.wizard.whoHint")}
          {step === "access" && tr("settings.users.wizard.accessHint")}
          {step === "done" && created && tr("settings.users.wizard.doneHint", { name: created.name.split(/\s+/)[0] ?? created.name })}
        </p>
        {/* Progress along the head's bottom edge: half, full, then done. */}
        <span className="user-wizard-progress" aria-hidden="true">
          <span style={{ inlineSize: `${(Math.min(index, total) / total) * 100}%` }} />
        </span>
      </header>

      {step === "who" && (
        <form className="user-wizard-form" onSubmit={(event) => { event.preventDefault(); toAccess(); }}>
          <div className="user-wizard-body" ref={bodyRef}>
            {/* What the new person can read from day one, for whoever is inviting. */}
            <SlotHost slot="settings.users.invite.notice" />
            <FormField label={tr("settings.users.name")}>
              {(field) => (
                <TextInput
                  {...field}
                  className="user-wizard-name"
                  value={name}
                  placeholder={tr("settings.users.namePlaceholder")}
                  autoComplete="off"
                  enterKeyHint="next"
                  disabled={busy}
                  onChange={(event) => {
                    setName(event.target.value);
                    if (!loginEdited) setLogin(suggestLogin(event.target.value));
                  }}
                />
              )}
            </FormField>
            <FormField
              label={tr("settings.users.login")}
              hint={tr("settings.users.loginHint")}
              {...(login.length > 0 && !loginValid ? { error: tr("settings.users.loginInvalid") } : {})}
            >
              {(field) => (
                <TextInput
                  {...field}
                  value={login}
                  placeholder="maria"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  enterKeyHint="next"
                  disabled={busy}
                  invalid={login.length > 0 && !loginValid}
                  onChange={(event) => { setLogin(event.target.value); setLoginEdited(true); }}
                />
              )}
            </FormField>
            <PassphraseField
              label={tr("settings.users.wizard.tempPassword")}
              value={password}
              visible={visible}
              copied={copied}
              disabled={busy}
              onChange={(next) => { setPassword(next); setCopied(false); }}
              onToggleVisible={() => setVisible(!visible)}
              onGenerate={() => { setPassword(generatePassphrase()); setVisible(true); setCopied(false); }}
              onCopied={() => setCopied(true)}
            />
          </div>
          <footer className="user-wizard-foot">
            <Button type="button" variant="ghost" disabled={busy} onClick={close}>{tr("common.cancel")}</Button>
            <Button type="submit" variant="primary" iconEnd={ChevronRightIcon} disabled={!whoReady}>{tr("common.continue")}</Button>
          </footer>
        </form>
      )}

      {step === "access" && (
        <form className="user-wizard-form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <div className="user-wizard-body" ref={bodyRef}>
            {!canManageMembers && (
              <Notice tone="info">{spaceAccess ? tr("settings.users.cannotManageMembers") : tr("settings.users.spaceUnavailable")}</Notice>
            )}
            <div className="user-wizard-presets" role="radiogroup" aria-label={tr("settings.users.wizard.accessTitle", { name: displayName })}>
              {choices.map((choice) => {
                const selected = choice === preset;
                const text = presetText(choice, space);
                const tag = presetRoleTag(choice, canManageMembers);
                return (
                  <label key={choice} className="user-wizard-preset" data-preset={choice} data-selected={selected || undefined}>
                    <input
                      type="radio"
                      name="user-wizard-preset"
                      value={choice}
                      className="sr-only"
                      checked={selected}
                      disabled={busy}
                      aria-describedby={`user-wizard-preset-${choice}`}
                      onChange={() => setPreset(choice)}
                    />
                    <span className="user-wizard-preset-icon" aria-hidden="true"><Icon icon={PRESET_ICONS[choice]} size="md" /></span>
                    <span className="user-wizard-preset-text">
                      <span className="user-wizard-preset-title">
                        {text.label}
                        {tag && <span className="user-wizard-preset-tag">{tag}</span>}
                      </span>
                      <span className="user-wizard-preset-detail" id={`user-wizard-preset-${choice}`}>{text.detail}</span>
                    </span>
                    <span className="user-wizard-radio" aria-hidden="true">
                      {selected && <Icon icon={CheckIcon} size="sm" />}
                    </span>
                  </label>
                );
              })}
            </div>
            {error && <Notice tone="error" role="alert">{error}</Notice>}
          </div>
          <footer className="user-wizard-foot">
            <Button type="button" variant="ghost" iconStart={BackIcon} disabled={busy} onClick={() => { setError(null); setStep("who"); }}>{tr("common.back")}</Button>
            <Button type="submit" variant="primary" busy={busy}>{tr("settings.users.createUser")}</Button>
          </footer>
        </form>
      )}

      {step === "done" && created && (
        <DoneStep
          created={created}
          space={space}
          canManageMembers={canManageMembers}
          bodyRef={bodyRef}
          onDone={onClose}
          onOpenAccount={() => onOpenAccount(created.account.id)}
        />
      )}
    </Dialog>
  );
}

function DoneStep({ created, space, canManageMembers, bodyRef, onDone, onOpenAccount }: {
  created: Created;
  space: string | null;
  canManageMembers: boolean;
  bodyRef: RefObject<HTMLDivElement | null>;
  onDone: () => void;
  onOpenAccount: () => void;
}) {
  const address = useMemo(() => shareableAddress(typeof location === "undefined" ? "" : location.origin), []);
  const link = created.invitation;
  const until = link ? new Date(link.expiresAt).toLocaleDateString(undefined, { day: "numeric", month: "long" }) : "";
  const invitation = link
    ? invitationLinkText({ name: created.name, url: link.url, until })
    : invitationText({ name: created.name, login: created.login, password: created.password, address });
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = (id: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(id);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 2400);
    }, () => undefined);
  };
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  // Without an internet address the link reaches no one outside this network:
  // Polyth Link pairs their own Polyth app instead (the Link page, owner side).
  const slotsAt = useSlotVersion();
  const linkPairing = useMemo(() => created.member && listSlots("settings.pages").some((page) => page.id === "tunnel"), [slotsAt, created.member]);
  const remote = !link || !link.url.startsWith("https:");
  const connectApp = () => {
    onDone();
    openSettingsPage("tunnel", { sectionId: "pair-for", itemId: created.account.id });
  };
  const access = presetPlan(created.preset, canManageMembers).role || created.preset === "protected"
    ? space
      ? tr("settings.users.wizard.accessValue", { preset: presetText(created.preset, space).label, space })
      : presetText(created.preset, space).label
    : presetText("account", space).detail;

  return (
    <>
      <div className="user-wizard-body" ref={bodyRef}>
        {link && (
          <dl className="user-wizard-credentials">
            <CredentialRow label={tr("settings.users.wizard.invitationLink")} value={link.url} mono copyLabel={tr("settings.users.wizard.copyLink")} copied={copied === "link"} onCopy={() => copy("link", link.url)} />
            <div className="user-wizard-credential">
              <dt>{tr("settings.users.wizard.access")}</dt>
              <dd><span className="user-wizard-credential-value">{access}</span></dd>
            </div>
          </dl>
        )}
        {!link && <dl className="user-wizard-credentials">
          {address && (
            <CredentialRow label={tr("settings.users.wizard.address")} value={address} copyLabel={tr("settings.users.wizard.copyAddress")} copied={copied === "address"} onCopy={() => copy("address", address)} />
          )}
          <CredentialRow label={tr("settings.users.login")} value={created.login} mono copyLabel={tr("settings.users.wizard.copyLogin")} copied={copied === "login"} onCopy={() => copy("login", created.login)} />
          <CredentialRow label={tr("settings.users.wizard.tempPassword")} value={created.password} mono copyLabel={tr("settings.users.copyPassword")} copied={copied === "password"} onCopy={() => copy("password", created.password)} />
          <div className="user-wizard-credential">
            <dt>{tr("settings.users.wizard.access")}</dt>
            <dd><span className="user-wizard-credential-value">{access}</span></dd>
          </div>
        </dl>}
        <div className="user-wizard-share">
          <Button
            variant="quiet"
            iconStart={copied === "invitation" ? CopiedIcon : CopyIcon}
            onClick={() => copy("invitation", invitation)}
          >
            {copied === "invitation" ? tr("settings.users.wizard.invitationCopied") : tr("settings.users.wizard.copyInvitation")}
          </Button>
          {canShare && (
            <Button variant="quiet" iconStart={ShareIcon} onClick={() => { void navigator.share({ text: invitation }).catch(() => undefined); }}>
              {tr("settings.users.wizard.share")}
            </Button>
          )}
        </div>
        <p className="user-wizard-note">{link ? tr("settings.users.wizard.linkOnce", { date: until }) : tr("settings.users.wizard.passwordOnce")}</p>
        {link && (
          <details className="user-wizard-fallback">
            <summary>{tr("settings.users.wizard.passwordInstead")}</summary>
            <dl className="user-wizard-credentials">
              <CredentialRow label={tr("settings.users.login")} value={created.login} mono copyLabel={tr("settings.users.wizard.copyLogin")} copied={copied === "login"} onCopy={() => copy("login", created.login)} />
              <CredentialRow label={tr("settings.users.wizard.tempPassword")} value={created.password} mono copyLabel={tr("settings.users.copyPassword")} copied={copied === "password"} onCopy={() => copy("password", created.password)} />
            </dl>
            <p className="user-wizard-note">{tr("settings.users.wizard.passwordOnce")}</p>
          </details>
        )}
        {linkPairing && (
          <div className="user-wizard-connect">
            <p className="user-wizard-note">
              {remote
                ? tr("settings.users.wizard.connectAppRemote", { name: created.name.split(/\s+/)[0] || created.name })
                : tr("settings.users.wizard.connectAppAlso")}
            </p>
            <Button variant="quiet" onClick={connectApp}>{tr("settings.users.wizard.connectApp")}</Button>
          </div>
        )}
        {created.problems.map((problem) => <Notice key={problem} tone="warning" role="alert">{problem}</Notice>)}
      </div>
      <footer className="user-wizard-foot">
        <Button variant="ghost" onClick={onOpenAccount}>{tr("settings.users.wizard.fineTune")}</Button>
        <Button variant="primary" onClick={onDone}>{tr("common.done")}</Button>
      </footer>
    </>
  );
}

function CredentialRow({ label, value, mono = false, copyLabel, copied, onCopy }: {
  label: string;
  value: string;
  mono?: boolean;
  copyLabel: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="user-wizard-credential">
      <dt>{label}</dt>
      <dd>
        <span className={`user-wizard-credential-value${mono ? " is-mono" : ""}`} dir="ltr">{value}</span>
        <IconButton
          icon={copied ? CopiedIcon : CopyIcon}
          label={copied ? tr("settings.users.wizard.copied") : copyLabel}
          className={copied ? "is-copied" : undefined}
          onClick={onCopy}
        />
      </dd>
    </div>
  );
}
