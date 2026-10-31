// First-run setup: one short guided flow that creates the owner account.
// Polyth Desktop first asks how Polyth will be used. Alone ("just me", or "me,
// from my phone too") needs no password: the main process finishes setup with
// the name of the OS account and keeps opening the owner's session itself; the
// phone pairs through Polyth Link, which opens next. With other people, and on
// a standalone server, the owner gets an account: Desktop supplies the setup
// claim from its trusted main process, so the person sees their account, then
// their recovery codes; a server first asks for the operator's setup code. The
// owner login is fixed and the organization defaults, so only a name and a
// password are typed. A refused or expired claim never strands the flow:
// Desktop starts over with a fresh claim and new codes, a server returns to the
// setup-code step.
import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { authJson, clearAuthCsrf, type AuthJsonResult } from "../authClient.ts";
import { acceptAuthenticatedBrowserAccount } from "../authPrefetch.ts";
import { desktopBridge, type DesktopSetupClaim, type PolythDesktopApi } from "../desktopBridge.ts";
import { getLocaleSnapshot, subscribeLocale, tr, type TranslationKey } from "../i18n/index.ts";
import { copyText } from "../utils.ts";
import { MIN_PASSWORD_LENGTH } from "./settings/usersModel.ts";
import {
  Button,
  Checkbox,
  CheckIcon,
  CopiedIcon,
  CopyIcon,
  DownloadIcon,
  HideIcon,
  Icon,
  IconButton,
  Notice,
  ShowIcon,
  Spinner,
  TextInput,
} from "./ui/index.ts";
import { MonitorIcon, PeopleIcon, SmartphoneIcon } from "./ui/icons.ts";
import { POLYTH_MARK_SRC } from "../brandAsset.ts";
import LanguagePicker from "./LanguagePicker.tsx";

// The first account is always the owner; its login is fixed rather than asked
// for, and the sign-in screen is prefilled with it.
const OWNER_LOGIN = "owner";
// Not asked during setup; the owner's organization starts as "Personal".
const DEFAULT_ORGANIZATION = "Personal";
const SETUP_CLAIM_COMMAND = "npm run setup:claim";
const CLAIM_PATTERN = /^[a-f0-9]{64}$/;
// Prepared codes are reused only while their claim can still finish setup.
const CLAIM_REUSE_MARGIN_MS = 60_000;

type SetupStep = "usage" | "claim" | "account" | "recovery";
/** How Polyth will be used; only "people" needs accounts and a password. */
type Usage = "solo" | "devices" | "people";
// Where Polyth Link pairs a phone, opened after a "from my phone too" start.
const PAIR_PHONE_PATH = "/?settings=tunnel";
interface ClaimState { token: string; expiresAt: number }
interface RecoveryState { setId: string; codes: string[] }
/** A catalog key, not a string: the message follows a language switch. */
interface SetupProblem { message: TranslationKey; signIn?: boolean }

class SetupError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const errorCode = (cause: unknown): string => cause instanceof SetupError ? cause.code : "unknown";
const normalizeClaim = (value: string): string => value.replace(/\s+/g, "").toLowerCase();
const claimAlive = (claim: ClaimState | null): claim is ClaimState =>
  !!claim && claim.expiresAt - Date.now() > CLAIM_REUSE_MARGIN_MS;
const claimExpired = (claim: ClaimState | null): boolean =>
  !!claim && claim.expiresAt > 0 && Date.now() >= claim.expiresAt;
/** Four-character groups for reading; the copied text stays one unbroken code. */
const codeGroups = (code: string): string[] => code.match(/.{1,4}/g) ?? [code];

/** One canonical setup call. Refusals carry the server's error code. */
async function setupRequest<T extends Record<string, unknown>>(path: string, body: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    let result: AuthJsonResult<T>;
    try {
      result = await authJson<T>(path, body);
    } catch {
      throw new SetupError("network");
    }
    if (result.response.ok) return result.body;
    const code = typeof result.body.error === "string" ? result.body.error : `http-${result.response.status}`;
    // A stale CSRF nonce (cookie cleared, server restarted) is refreshed once.
    if (code === "forbidden" && attempt === 0) {
      clearAuthCsrf();
      continue;
    }
    throw new SetupError(code);
  }
}

async function requestRecovery(claimToken: string): Promise<RecoveryState> {
  const body = await setupRequest<{ setId?: unknown; codes?: unknown }>("/api/auth/setup/recovery", { claimToken });
  if (typeof body.setId !== "string" || !Array.isArray(body.codes) || body.codes.length === 0
    || !body.codes.every((code) => typeof code === "string")) {
    throw new SetupError("invalid-response");
  }
  return { setId: body.setId, codes: body.codes as string[] };
}

function problemFor(code: string, context: { desktop: boolean; expired: boolean }): SetupProblem {
  switch (code) {
    case "network": return { message: "setup.error.network" };
    case "invalid-claim":
      if (context.desktop) return { message: "setup.error.desktopUnavailable" };
      return { message: context.expired ? "setup.error.codeExpired" : "setup.error.codeInvalid" };
    case "desktop-unavailable": return { message: "setup.error.desktopUnavailable" };
    case "setup-completed": return { message: "setup.error.alreadySetUp", signIn: true };
    case "recovery-required": return { message: "setup.error.needsRecovery" };
    case "invalid-input": return { message: "setup.error.details" };
    case "rate-limited": return { message: "setup.error.tooManyAttempts" };
    case "insecure-transport": return { message: "setup.error.insecure" };
    case "wrong-origin": return { message: "setup.error.wrongAddress" };
    case "forbidden": return { message: "setup.error.sessionChanged" };
    default: return { message: "setup.error.generic" };
  }
}

/** Renders a sentence whose `{login}` placeholder becomes the owner login chip. */
function withLogin(key: TranslationKey): ReactNode {
  const marker = "\u0000";
  const [before = "", after = ""] = tr(key, { login: marker }).split(marker);
  return <>{before}<code className="setup-owner-login">{OWNER_LOGIN}</code>{after}</>;
}

const USAGE_OPTIONS: readonly { id: Usage; icon: typeof MonitorIcon; title: TranslationKey; detail: TranslationKey; foot: TranslationKey }[] = [
  { id: "solo", icon: MonitorIcon, title: "setup.usage.solo", detail: "setup.usage.soloDetail", foot: "setup.usage.soloFoot" },
  { id: "devices", icon: SmartphoneIcon, title: "setup.usage.devices", detail: "setup.usage.devicesDetail", foot: "setup.usage.devicesFoot" },
  { id: "people", icon: PeopleIcon, title: "setup.usage.people", detail: "setup.usage.peopleDetail", foot: "setup.usage.peopleFoot" },
];

function SetupMark() {
  return (
    <div className="lock-mark-frame">
      <img className="welcome-mark" src={POLYTH_MARK_SRC} alt="" aria-hidden="true" />
    </div>
  );
}

export default function SetupScreen({ restartRequired = false }: { restartRequired?: boolean }) {
  // A language switch re-renders the flow in place (bootstrap does not remount
  // it), so the step and everything typed survive the switch.
  useSyncExternalStore(subscribeLocale, getLocaleSnapshot, getLocaleSnapshot);
  const desktop = desktopBridge();
  // Shells older than password-less first run go straight to the account.
  const askUsage = typeof desktop?.completeLocalSetup === "function";
  const [usage, setUsage] = useState<Usage>("solo");
  const steps: SetupStep[] = !desktop ? ["claim", "account", "recovery"]
    : !askUsage ? ["account", "recovery"]
    : usage === "people" ? ["usage", "account", "recovery"] : ["usage"];
  const [step, setStep] = useState<SetupStep>(steps[0]!);
  const [view, setView] = useState<"form" | "finishing" | "done">(
    restartRequired ? (desktop ? "finishing" : "done") : "form",
  );
  const [claimInput, setClaimInput] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [recovery, setRecovery] = useState<RecoveryState | null>(null);
  const [recoverySaved, setRecoverySaved] = useState(false);
  const [codesRenewed, setCodesRenewed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [commandCopied, setCommandCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<SetupProblem | null>(null);
  const claim = useRef<ClaimState | null>(null);
  const copyTimer = useRef<number | null>(null);
  const commandTimer = useRef<number | null>(null);
  const restartStarted = useRef(false);
  const claimRef = useRef<HTMLInputElement>(null);
  const usageRef = useRef<HTMLInputElement>(null);
  // Where the finished Desktop setup opens; the workspace unless set.
  const destination = useRef<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    if (commandTimer.current !== null) window.clearTimeout(commandTimer.current);
  }, []);

  // Each step lands focus where the person continues: the first field, or the
  // heading of the recovery step so assistive tech announces the new task.
  useEffect(() => {
    if (view !== "form") return;
    const frame = requestAnimationFrame(() => {
      const target = step === "usage" ? usageRef.current
        : step === "claim" ? claimRef.current : step === "account" ? nameRef.current : headingRef.current;
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [step, view]);

  const normalizedClaim = normalizeClaim(claimInput);
  const claimReady = CLAIM_PATTERN.test(normalizedClaim);
  const claimMalformed = normalizedClaim.length > 0 && !claimReady
    && (normalizedClaim.length >= 64 || /[^a-f0-9]/.test(normalizedClaim));
  const passwordReady = [...password].length >= MIN_PASSWORD_LENGTH;
  const accountReady = !!name.trim() && passwordReady;
  const report = (cause: unknown): void => {
    setProblem(problemFor(errorCode(cause), { desktop: !!desktop, expired: claimExpired(claim.current) }));
  };

  const applyRecovery = (next: RecoveryState): void => {
    setRecovery(next);
    setRecoverySaved(false);
    setCopied(false);
  };

  /** Desktop: bind the main-process claim and prepare codes; a refused claim is replaced once. */
  const prepareDesktopRecovery = async (bridge: PolythDesktopApi, rotate: boolean): Promise<void> => {
    const attempt = async (fresh: boolean): Promise<RecoveryState> => {
      let issued: DesktopSetupClaim;
      try {
        issued = await bridge.requestSetupClaim({ fresh });
      } catch {
        throw new SetupError("desktop-unavailable");
      }
      const token = normalizeClaim(issued.claimToken);
      if (!CLAIM_PATTERN.test(token)) throw new SetupError("desktop-unavailable");
      claim.current = { token, expiresAt: typeof issued.expiresAt === "number" ? issued.expiresAt : 0 };
      await setupRequest("/api/auth/setup/claim", { claimToken: token });
      return requestRecovery(token);
    };
    try {
      applyRecovery(await attempt(rotate));
    } catch (cause) {
      if (rotate || errorCode(cause) !== "invalid-claim") throw cause;
      applyRecovery(await attempt(true));
    }
  };

  /** Server: return to the setup-code step after the claim was refused. */
  const backToClaim = (code: string): void => {
    const expired = claimExpired(claim.current);
    claim.current = null;
    setRecovery(null);
    setRecoverySaved(false);
    setCodesRenewed(false);
    setClaimInput("");
    setStep("claim");
    setProblem(problemFor(code, { desktop: false, expired }));
  };

  const submitClaim = async (): Promise<void> => {
    if (!claimReady) {
      setProblem({ message: "setup.error.codeFormat" });
      return;
    }
    try {
      const bound = await setupRequest<{ expiresAt?: unknown }>("/api/auth/setup/claim", { claimToken: normalizedClaim });
      claim.current = { token: normalizedClaim, expiresAt: typeof bound.expiresAt === "number" ? bound.expiresAt : 0 };
      setRecovery(null);
      setCodesRenewed(false);
      setStep("account");
    } catch (cause) {
      claim.current = null;
      report(cause);
    }
  };

  const submitAccount = async (): Promise<void> => {
    if (!accountReady) return;
    // Codes the person may already have saved stay valid while their claim
    // lives, so Back then Continue never silently replaces them.
    if (recovery && claimAlive(claim.current)) {
      setStep("recovery");
      return;
    }
    // Codes shown before are replaced below, so the person must hear about it.
    const replacingShownCodes = recovery !== null;
    try {
      if (desktop) await prepareDesktopRecovery(desktop, false);
      else if (claim.current) applyRecovery(await requestRecovery(claim.current.token));
      else throw new SetupError("invalid-claim");
      setCodesRenewed(replacingShownCodes);
      setStep("recovery");
    } catch (cause) {
      if (!desktop && errorCode(cause) === "invalid-claim") backToClaim("invalid-claim");
      else report(cause);
    }
  };

  const finishDesktop = async (): Promise<void> => {
    if (!desktop) return;
    setBusy(true);
    setProblem(null);
    try {
      await desktop.restartAfterSetup();
      if (destination.current) location.replace(destination.current);
      else location.reload();
    } catch {
      setProblem({ message: "setup.error.restartFailed" });
      setBusy(false);
    }
  };

  // The account already exists when the setup server reports ready; Desktop
  // finishes the switch to the full workspace on its own.
  useEffect(() => {
    if (view !== "finishing" || restartStarted.current) return;
    restartStarted.current = true;
    void finishDesktop();
  }, [view]);

  /** Alone: no account to create. People: continue to the owner account. */
  const submitUsage = async (): Promise<void> => {
    if (usage === "people" || !desktop?.completeLocalSetup) {
      setStep("account");
      return;
    }
    let result: Awaited<ReturnType<NonNullable<PolythDesktopApi["completeLocalSetup"]>>>;
    try {
      result = await desktop.completeLocalSetup();
    } catch {
      result = { ok: false, error: "unavailable" };
    }
    if (!result.ok) {
      report(new SetupError(result.error === "unavailable" ? "desktop-unavailable" : result.error));
      return;
    }
    destination.current = usage === "devices" ? PAIR_PHONE_PATH : null;
    setView("finishing");
  };

  const createAccount = async (): Promise<void> => {
    if (!recovery || !recoverySaved || !accountReady || !claim.current) return;
    try {
      await setupRequest("/api/auth/setup/complete", {
        claimToken: claim.current.token,
        name: name.trim(),
        organizationName: DEFAULT_ORGANIZATION,
        login: OWNER_LOGIN,
        password,
        recoverySetId: recovery.setId,
        recoveryAcknowledged: true,
      });
    } catch (cause) {
      const code = errorCode(cause);
      if (code === "invalid-input") {
        setStep("account");
        report(cause);
        return;
      }
      const codesStale = code === "conflict" || code === "recovery-ack-required";
      if (code === "invalid-claim" && !desktop) {
        backToClaim(code);
        return;
      }
      if (code !== "invalid-claim" && !codesStale) {
        report(cause);
        return;
      }
      // The saved codes can no longer finish setup (the claim expired or the
      // set was replaced elsewhere): show new ones and ask again.
      try {
        if (desktop) await prepareDesktopRecovery(desktop, code === "invalid-claim");
        else applyRecovery(await requestRecovery(claim.current.token));
        setCodesRenewed(true);
        setProblem(null);
      } catch (inner) {
        if (!desktop && errorCode(inner) === "invalid-claim") backToClaim("invalid-claim");
        else report(inner);
      }
      return;
    }
    try { localStorage.setItem("polyth.lastLogin", OWNER_LOGIN); } catch { /* private mode */ }
    setPassword("");
    if (desktop) {
      setView("finishing");
      return;
    }
    const meResponse = await fetch("/api/auth/me", { cache: "no-store" }).catch(() => null);
    const me = await meResponse?.json().catch(() => ({})) as { id?: unknown } | undefined;
    if (meResponse?.ok && typeof me?.id === "string" && me.id.trim()) acceptAuthenticatedBrowserAccount(me.id);
    setView("done");
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      if (step === "usage") await submitUsage();
      else if (step === "claim") await submitClaim();
      else if (step === "account") await submitAccount();
      else await createAccount();
    } finally {
      setBusy(false);
    }
  };

  const goBack = (): void => {
    if (busy) return;
    setProblem(null);
    if (step === "recovery") setStep("account");
    else if (step === "account" && !desktop) setStep("claim");
    else if (step === "account" && askUsage) setStep("usage");
  };

  const copyRecoveryCodes = async (): Promise<void> => {
    if (!recovery) return;
    const recoveryCodes = recovery.codes;
    const ok = await copyText(recoveryCodes.join("\n"));
    if (!ok) {
      setProblem({ message: "setup.recovery.copyFailed" });
      return;
    }
    setProblem(null);
    setCopied(true);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
  };

  const downloadRecoveryCodes = (): void => {
    if (!recovery) return;
    const contents = [
      tr("setup.recovery.fileTitle"),
      "",
      tr("setup.recovery.fileUsage", { login: OWNER_LOGIN }),
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

  const copyCommand = async (): Promise<void> => {
    if (!(await copyText(SETUP_CLAIM_COMMAND))) return;
    setCommandCopied(true);
    if (commandTimer.current !== null) window.clearTimeout(commandTimer.current);
    commandTimer.current = window.setTimeout(() => setCommandCopied(false), 1600);
  };

  const problemBanner = problem && (
    <div className="lock-error setup-error" role="alert">
      <span>{tr(problem.message)}</span>
      {problem.signIn && (
        <Button size="sm" onClick={() => location.reload()}>{tr("setup.signIn")}</Button>
      )}
    </div>
  );

  if (view === "finishing") return (
    <div className="lock-screen">
      <div className="lock-card lock-card--setup setup-status" aria-busy={!problem}>
        <SetupMark />
        <h1>{tr("setup.finishing.title")}</h1>
        <p className="lock-hint" role="status">{tr("setup.finishing.body")}</p>
        {problem ? (
          <div className="lock-actions">
            <Button variant="primary" className="lock-submit" busy={busy} block onClick={() => void finishDesktop()}>
              {tr("common.retry")}
            </Button>
          </div>
        ) : (
          <Spinner className="setup-spinner" size="md" />
        )}
        {problemBanner}
      </div>
    </div>
  );

  if (view === "done") return (
    <div className="lock-screen">
      <div className="lock-card lock-card--setup setup-status">
        <SetupMark />
        <h1>{tr("setup.done.title")}</h1>
        <p className="lock-hint">{withLogin("setup.done.body")}</p>
        <div className="lock-actions">
          <Button variant="primary" className="lock-submit" block onClick={() => location.reload()}>
            {tr("setup.done.open")}
          </Button>
        </div>
      </div>
    </div>
  );

  const stepIndex = steps.indexOf(step);
  return (
    <div className="lock-screen">
      <div className="lock-screen-bar">
        <LanguagePicker />
      </div>
      <form className="lock-card lock-card--setup" aria-labelledby="setup-title" noValidate onSubmit={(event) => void submit(event)}>
        <div className="setup-steps" data-hidden={steps.length === 1 || undefined}>
          <span className="sr-only">{tr("setup.progress", { current: stepIndex + 1, total: steps.length })}</span>
          {steps.map((entry, index) => (
            <span
              key={entry}
              aria-hidden="true"
              className={`setup-step-dot${index === stepIndex ? " is-current" : index < stepIndex ? " is-done" : ""}`}
            />
          ))}
        </div>
        <SetupMark />

        <div key={step} className="setup-step">
          {step === "usage" && (
            <>
              <h1 id="setup-title">{tr("setup.usage.title")}</h1>
              <p className="lock-hint">{tr("setup.usage.intro")}</p>
              <div className="setup-usage" role="radiogroup" aria-labelledby="setup-title">
                {USAGE_OPTIONS.map((option) => {
                  const selected = option.id === usage;
                  return (
                    <label key={option.id} className="setup-usage-option" data-selected={selected || undefined}>
                      <input
                        ref={selected ? usageRef : undefined}
                        type="radio"
                        name="setup-usage"
                        value={option.id}
                        className="sr-only"
                        checked={selected}
                        disabled={busy}
                        aria-describedby={`setup-usage-${option.id}`}
                        onChange={() => { setUsage(option.id); setProblem(null); }}
                      />
                      <span className="setup-usage-icon" aria-hidden="true"><Icon icon={option.icon} size="md" /></span>
                      <span className="setup-usage-text">
                        <span className="setup-usage-title">{tr(option.title)}</span>
                        <span className="setup-usage-detail" id={`setup-usage-${option.id}`}>{tr(option.detail)}</span>
                      </span>
                      <span className="setup-usage-radio" aria-hidden="true">
                        {selected && <Icon icon={CheckIcon} size="sm" />}
                      </span>
                    </label>
                  );
                })}
              </div>
              <div className="lock-actions">
                <Button variant="primary" className="lock-submit" type="submit" busy={busy} block>
                  {usage === "people" ? tr("common.continue") : tr("setup.usage.start")}
                </Button>
              </div>
              <p className="setup-signin">{tr(USAGE_OPTIONS.find((option) => option.id === usage)!.foot)}</p>
            </>
          )}

          {step === "claim" && (
            <>
              <h1 id="setup-title">{tr("setup.claim.title")}</h1>
              <p className="lock-hint">{tr("setup.claim.intro")}</p>
              <div className="setup-command">
                <code>{SETUP_CLAIM_COMMAND}</code>
                <IconButton
                  icon={commandCopied ? CopiedIcon : CopyIcon}
                  size="md"
                  label={commandCopied ? tr("setup.claim.commandCopied") : tr("setup.claim.copyCommand")}
                  onClick={() => void copyCommand()}
                />
              </div>
              <div className="lock-fields">
                <div className="lock-field">
                  <label className="lock-field-label" htmlFor="setup-claim">{tr("setup.claim.codeLabel")}</label>
                  <TextInput
                    ref={claimRef}
                    id="setup-claim"
                    className="setup-claim-input"
                    value={claimInput}
                    placeholder={tr("setup.claim.codePlaceholder")}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    invalid={claimMalformed}
                    disabled={busy}
                    aria-describedby="setup-claim-hint"
                    onChange={(event) => { setClaimInput(event.target.value); setProblem(null); }}
                  />
                  <small id="setup-claim-hint" className={claimMalformed ? "lock-field-error" : "lock-field-hint"}>
                    {claimMalformed ? tr("setup.error.codeFormat") : tr("setup.claim.codeHint")}
                  </small>
                </div>
              </div>
              <div className="lock-actions">
                <Button variant="primary" className="lock-submit" type="submit" busy={busy} disabled={!claimReady} block>
                  {tr("common.continue")}
                </Button>
              </div>
            </>
          )}

          {step === "account" && (
            <>
              <h1 id="setup-title">{tr("setup.account.title")}</h1>
              <p className="lock-hint">{tr("setup.account.intro")}</p>
              <div className="lock-fields">
                <div className="lock-field">
                  <label className="lock-field-label" htmlFor="setup-name">{tr("setup.account.nameLabel")}</label>
                  <TextInput
                    ref={nameRef}
                    id="setup-name"
                    value={name}
                    autoComplete="name"
                    maxLength={80}
                    disabled={busy}
                    onChange={(event) => { setName(event.target.value); setProblem(null); }}
                  />
                </div>
                <div className="lock-field">
                  <label className="lock-field-label" htmlFor="setup-password">{tr("setup.account.passwordLabel")}</label>
                  <div className="setup-password">
                    <TextInput
                      id="setup-password"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      autoComplete="new-password"
                      autoCapitalize="off"
                      spellCheck={false}
                      disabled={busy}
                      aria-describedby="setup-password-hint"
                      onChange={(event) => { setPassword(event.target.value); setProblem(null); }}
                    />
                    <IconButton
                      icon={showPassword ? HideIcon : ShowIcon}
                      size="md"
                      label={showPassword ? tr("setup.account.hidePassword") : tr("setup.account.showPassword")}
                      disabled={busy}
                      onClick={() => setShowPassword((shown) => !shown)}
                    />
                  </div>
                  <small id="setup-password-hint" className={`lock-field-hint${passwordReady ? " is-met" : ""}`}>
                    {passwordReady && <Icon icon={CheckIcon} size="sm" />}
                    {tr("setup.account.passwordHint", { count: MIN_PASSWORD_LENGTH })}
                  </small>
                </div>
              </div>
              <div className="lock-actions">
                <Button variant="primary" className="lock-submit" type="submit" busy={busy} disabled={!accountReady} block>
                  {tr("common.continue")}
                </Button>
              </div>
              <p className="setup-signin">{withLogin("setup.account.signInAs")}</p>
            </>
          )}

          {step === "recovery" && recovery && (
            <>
              <h1 id="setup-title" ref={headingRef} tabIndex={-1}>{tr("setup.recovery.title")}</h1>
              <p className="lock-hint">{tr("setup.recovery.intro")}</p>
              {codesRenewed && (
                <Notice tone="warning" className="setup-notice" role="alert">{tr("setup.recovery.renewed")}</Notice>
              )}
              <ol className="setup-codes" aria-label={tr("setup.recovery.listLabel")}>
                {recovery.codes.map((code, index) => (
                  <li key={code} style={{ animationDelay: `${60 + index * 24}ms` }}>
                    <code className="setup-code">
                      {codeGroups(code).map((group, groupIndex, groups) => (
                        <Fragment key={groupIndex}>
                          {groupIndex === Math.ceil(groups.length / 2) && <wbr />}
                          <span>{group}</span>
                        </Fragment>
                      ))}
                    </code>
                  </li>
                ))}
              </ol>
              <div className="setup-codes-actions">
                <Button iconStart={DownloadIcon} disabled={busy} onClick={downloadRecoveryCodes}>
                  {tr("setup.recovery.download")}
                </Button>
                <Button
                  className={copied ? "is-copied" : undefined}
                  iconStart={copied ? CopiedIcon : CopyIcon}
                  disabled={busy}
                  onClick={() => void copyRecoveryCodes()}
                >
                  {copied ? tr("setup.recovery.copied") : tr("common.copy")}
                </Button>
              </div>
              <Checkbox
                className="lock-agree"
                checked={recoverySaved}
                disabled={busy}
                onChange={setRecoverySaved}
                label={tr("setup.recovery.saved")}
              />
              <div className="lock-actions">
                <Button variant="primary" className="lock-submit" type="submit" busy={busy} disabled={!recoverySaved} block>
                  {tr("setup.recovery.create")}
                </Button>
              </div>
            </>
          )}
        </div>

        {problemBanner}
        {(step === "recovery" || (step === "account" && (!desktop || askUsage))) && (
          <Button variant="ghost" size="sm" className="setup-back" disabled={busy} onClick={goBack}>
            {tr("common.back")}
          </Button>
        )}
      </form>
    </div>
  );
}
