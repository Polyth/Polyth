import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { TaskTrackerProvider } from "@polyth/contracts";
import type { TaskTrackersMessageKey } from "../src/i18n/en.ts";
import {
  Button,
  Dialog,
  Notice,
  TextInput,
} from "../../../apps/web/src/components/ui/index.ts";
import { api } from "./api.ts";
import { AccountAvatar, PROVIDER_LABELS, ProviderMark, SuccessCheck } from "./brand.tsx";
import { tt } from "./i18n.ts";
import { applyManagement, friendly } from "./store.ts";
import {
  JIRA_TOKEN_PAGE,
  LINEAR_KEY_PAGE,
  looksLikeLinearKey,
  normalizeJiraSite,
  TRELLO_KEY_PAGE,
  trelloAuthorizeUrl,
  type TaskTrackerConnectionDto,
  type TaskTrackerConnectionScope,
} from "../src/types.ts";

type Step = 0 | 1 | 2;

const STEP_KEYS: Record<TaskTrackerProvider, readonly [TaskTrackersMessageKey, TaskTrackersMessageKey, TaskTrackersMessageKey]> = {
  jira: ["tasktrackers.connect.step.site", "tasktrackers.connect.step.apiToken", "tasktrackers.connect.step.verify"],
  trello: ["tasktrackers.connect.step.apiKey", "tasktrackers.connect.step.authorize", "tasktrackers.connect.step.verify"],
  linear: ["tasktrackers.connect.step.createKey", "tasktrackers.connect.step.pasteKey", "tasktrackers.connect.step.verify"],
} as const;

const TRELLO_ORIGIN = "https://trello.com";

function Stepper({ provider, step }: { provider: TaskTrackerProvider; step: Step }) {
  return (
    <ol className="tt-stepper" aria-label={tt("tasktrackers.connect.steps")} style={{ "--tt-step": step } as Record<string, number>}>
      {STEP_KEYS[provider].map((key, index) => {
        const label = tt(key);
        return (
          <li
            key={label}
            className={index < step ? "done" : index === step ? "current" : ""}
            aria-current={index === step ? "step" : undefined}
          >
            <span className="tt-stepper-dot">{index + 1}</span>
            <span className="tt-stepper-label">{label}</span>
          </li>
        );
      })}
      <span className="tt-stepper-track" aria-hidden="true"><i /></span>
    </ol>
  );
}

function Guide({ children }: { children: ReactNode }) {
  return <ol className="tt-guide">{children}</ol>;
}

function openExternal(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

export interface ConnectWizardProps {
  provider: TaskTrackerProvider;
  /** `personal` connects the caller's own account; `space` the shared one. */
  scope?: TaskTrackerConnectionScope;
  existing?: TaskTrackerConnectionDto;
  onClose: () => void;
  onConnected?: (connection: TaskTrackerConnectionDto) => void;
}

/**
 * Guided connection. Credentials are typed into this protected app form,
 * posted once to the server for verification, and stored only in the
 * Credential Vault; local state is cleared as soon as the request settles.
 */
export function ConnectWizard({ provider, scope = "space", existing, onClose, onConnected }: ConnectWizardProps) {
  const [step, setStep] = useState<Step>(0);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [site, setSite] = useState(existing?.account.site ?? "");
  const [email, setEmail] = useState(provider === "jira" ? existing?.account.email ?? "" : "");
  const [secret, setSecret] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [manual, setManual] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState<TaskTrackerConnectionDto | null>(null);
  const popupRef = useRef<Window | null>(null);
  const label = PROVIDER_LABELS[provider];
  const normalizedSite = normalizeJiraSite(site);

  const go = (next: Step) => {
    setDirection(next > step ? "forward" : "back");
    setError("");
    setStep(next);
  };

  const submit = async (token: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    go(2);
    try {
      const result = provider === "jira"
        ? await api.taskTrackerConnectJira({ site: normalizedSite ?? site, email, apiToken: token }, scope)
        : provider === "trello"
          ? await api.taskTrackerConnectTrello({ apiKey, token }, scope)
          : await api.taskTrackerConnectLinear({ apiKey: token }, scope);
      applyManagement(result);
      // A person may own several accounts of one service; the new one is on here.
      const connection = (scope === "personal"
        ? (result.personalConnections ?? []).find((item) => item.provider === provider && item.enabled !== false)
        : result.connections.find((item) => item.provider === provider)) ?? null;
      setConnected(connection);
      if (connection) onConnected?.(connection);
    } catch (cause) {
      setError(friendly(tt("tasktrackers.connect.rejected", { provider: label }), cause));
      setDirection("back");
      setStep(1);
    } finally {
      setSecret("");
      setBusy(false);
      setWaiting(false);
    }
  };

  // Trello's authorize page posts the token back to this origin.
  useEffect(() => {
    if (provider !== "trello" || !waiting) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== TRELLO_ORIGIN || event.source !== popupRef.current) return;
      const token = typeof event.data === "string" ? event.data.trim() : "";
      popupRef.current?.close();
      popupRef.current = null;
      if (!/^[A-Za-z0-9]{32,256}$/.test(token)) {
        setWaiting(false);
        setError(tt("tasktrackers.connect.trelloCancelled"));
        return;
      }
      void submit(token);
    };
    const poll = window.setInterval(() => {
      if (popupRef.current?.closed) {
        popupRef.current = null;
        setWaiting(false);
      }
    }, 600);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(poll);
    };
  }, [provider, waiting, apiKey]);

  useEffect(() => () => { popupRef.current?.close(); }, []);

  const authorizeTrello = () => {
    setError("");
    const width = 560;
    const height = 720;
    const left = Math.max(0, window.screenX + (window.outerWidth - width) / 2);
    const top = Math.max(0, window.screenY + (window.outerHeight - height) / 2);
    const popup = window.open(
      trelloAuthorizeUrl(apiKey, window.location.origin),
      "polyth-trello-authorize",
      `popup=yes,width=${width},height=${height},left=${left},top=${top}`,
    );
    if (!popup) {
      setManual(true);
      setError(tt("tasktrackers.connect.popupBlocked"));
      return;
    }
    popupRef.current = popup;
    setWaiting(true);
  };

  const stepBody = (): ReactNode => {
    if (step === 2) {
      if (busy || !connected) {
        return (
          <div className="tt-verify" role="status" aria-live="polite">
            <span className="tt-verify-orbit"><ProviderMark provider={provider} size="lg" /></span>
            <strong>{tt("tasktrackers.connect.checking", { provider: label })}</strong>
            <small>{tt("tasktrackers.connect.vaultNote")}</small>
            <small>{scope === "personal"
              ? tt("tasktrackers.connect.personalScope")
              : tt("tasktrackers.connect.spaceScope")}</small>
          </div>
        );
      }
      return (
        <div className="tt-verify done" role="status" aria-live="polite">
          <SuccessCheck />
          <strong>{tt("tasktrackers.connect.connected", { provider: label })}</strong>
          <div className="tt-verify-account">
            <AccountAvatar account={connected.account} />
            <span>
              <b>{connected.account.name}</b>
              <small>{connected.account.site ?? connected.account.email ?? ""}</small>
            </span>
          </div>
        </div>
      );
    }

    if (provider === "jira" && step === 0) {
      return (
        <div className="tt-wizard-fields">
          <p className="tt-wizard-lead">{tt("tasktrackers.connect.jiraSiteQuestion")}</p>
          <label className="tt-field">
            <span>{tt("tasktrackers.connect.jiraSite")}</span>
            <TextInput
              value={site}
              autoFocus
              autoComplete="url"
              inputMode="url"
              placeholder="acme.atlassian.net"
              invalid={site.trim().length > 0 && !normalizedSite}
              onChange={(event) => setSite(event.target.value)}
            />
          </label>
          <p className={`tt-site-preview${normalizedSite ? " ok" : ""}`} aria-live="polite">
            {normalizedSite ? tt("tasktrackers.connect.connectingTo", { site: normalizedSite }) : site.trim() ? tt("tasktrackers.connect.invalidSite") : " "}
          </p>
        </div>
      );
    }

    if (provider === "jira") {
      return (
        <div className="tt-wizard-fields">
          <Guide>
            <li>
              <span>{tt("tasktrackers.connect.jiraStep1")}</span>
              <Button size="sm" onClick={() => openExternal(JIRA_TOKEN_PAGE)}>{tt("tasktrackers.connect.openAtlassian")}</Button>
            </li>
            <li><span>{tt("tasktrackers.connect.jiraStep2")}</span></li>
          </Guide>
          <label className="tt-field">
            <span>{tt("tasktrackers.connect.atlassianEmail")}</span>
            <TextInput
              type="email"
              value={email}
              autoFocus
              autoComplete="username"
              placeholder="you@company.com"
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label className="tt-field">
            <span>{tt("tasktrackers.connect.apiToken")}</span>
            <TextInput
              type="password"
              value={secret}
              autoComplete="off"
              spellCheck={false}
              placeholder={tt("tasktrackers.connect.pasteToken")}
              onChange={(event) => setSecret(event.target.value)}
            />
          </label>
          <small className="tt-secure-note">{tt("tasktrackers.connect.secureNote")}</small>
        </div>
      );
    }

    if (provider === "linear" && step === 0) {
      return (
        <div className="tt-wizard-fields">
          <p className="tt-wizard-lead">{tt("tasktrackers.connect.linearLead")}</p>
          <Guide>
            <li>
              <span>{tt("tasktrackers.connect.linearStep1")}</span>
              <Button size="sm" onClick={() => openExternal(LINEAR_KEY_PAGE)}>{tt("tasktrackers.connect.openLinear")}</Button>
            </li>
            <li><span>{tt("tasktrackers.connect.linearStep2")}</span></li>
            <li><span>{tt("tasktrackers.connect.linearStep3")}</span></li>
          </Guide>
        </div>
      );
    }

    if (provider === "linear") {
      const unusual = secret.trim().length > 0 && !looksLikeLinearKey(secret);
      return (
        <div className="tt-wizard-fields">
          <label className="tt-field">
            <span>{tt("tasktrackers.connect.personalApiKey")}</span>
            <TextInput
              type="password"
              value={secret}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="lin_api_…"
              invalid={/\s/.test(secret.trim())}
              onChange={(event) => setSecret(event.target.value)}
            />
          </label>
          <p className={`tt-site-preview${unusual ? "" : " ok"}`} aria-live="polite">
            {unusual ? tt("tasktrackers.connect.linearKeyHint") : " "}
          </p>
          <small className="tt-secure-note">{tt("tasktrackers.connect.secureNote")}</small>
        </div>
      );
    }

    if (step === 0) {
      return (
        <div className="tt-wizard-fields">
          <Guide>
            <li>
              <span>{tt("tasktrackers.connect.trelloStep1")}</span>
              <Button size="sm" onClick={() => openExternal(TRELLO_KEY_PAGE)}>{tt("tasktrackers.connect.openTrello")}</Button>
            </li>
            <li><span>{tt("tasktrackers.connect.trelloStep2", { origin: typeof window === "undefined" ? "" : window.location.origin })}</span></li>
          </Guide>
          <label className="tt-field">
            <span>{tt("tasktrackers.connect.apiKey")}</span>
            <TextInput
              value={apiKey}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder={tt("tasktrackers.connect.keyPlaceholder")}
              invalid={apiKey.trim().length > 0 && !/^[a-z0-9]+$/i.test(apiKey.trim())}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
        </div>
      );
    }

    return (
      <div className="tt-wizard-fields">
        <div className={`tt-authorize${waiting ? " waiting" : ""}`}>
          <ProviderMark provider="trello" size="lg" />
          <div>
            <strong>{waiting ? tt("tasktrackers.connect.waitingForTrello") : tt("tasktrackers.connect.approveTrello")}</strong>
            <small>{waiting ? tt("tasktrackers.connect.trelloWaitingHint") : tt("tasktrackers.connect.trelloHint")}</small>
          </div>
          <Button variant="primary" busy={waiting} disabled={waiting || busy} onClick={authorizeTrello}>
            {waiting ? tt("tasktrackers.connect.authorizing") : tt("tasktrackers.connect.authorizeTrello")}
          </Button>
        </div>
        <button type="button" className="tt-disclosure" aria-expanded={manual} onClick={() => setManual((value) => !value)}>
          {tt("tasktrackers.connect.pasteInstead")}
        </button>
        {manual && (
          <label className="tt-field tt-reveal">
            <span>{tt("tasktrackers.connect.trelloToken")}</span>
            <TextInput
              type="password"
              value={secret}
              autoComplete="off"
              spellCheck={false}
              placeholder={tt("tasktrackers.connect.pasteToken")}
              onChange={(event) => setSecret(event.target.value)}
            />
          </label>
        )}
      </div>
    );
  };

  const canContinue = provider === "jira"
    ? step === 0 ? normalizedSite !== null : email.trim().length > 3 && secret.trim().length > 0
    : provider === "linear"
      ? step === 0 || (secret.trim().length >= 8 && !/\s/.test(secret.trim()))
      : step === 0 ? /^[a-z0-9]{16,}$/i.test(apiKey.trim()) : manual && secret.trim().length > 0;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!canContinue || busy) return;
    if (step === 0) go(1);
    else if (step === 1) void submit(secret.trim());
  };

  const footer = step === 2 && connected ? (
    <Button variant="primary" onClick={onClose}>{tt("tasktrackers.connect.done")}</Button>
  ) : (
    <>
      {step === 1 && <Button variant="ghost" disabled={busy || waiting} onClick={() => go(0)}>{tt("tasktrackers.connect.back")}</Button>}
      <Button variant="ghost" onClick={onClose}>{tt("tasktrackers.connect.cancel")}</Button>
      {step < 2 && !(provider === "trello" && step === 1 && !manual) && (
        <Button type="submit" variant="primary" disabled={!canContinue || busy} busy={busy} form="tt-connect-form">
          {step === 0 ? tt("tasktrackers.connect.continue") : tt("tasktrackers.connect.connect")}
        </Button>
      )}
    </>
  );

  return (
    <Dialog
      title={existing
        ? tt("tasktrackers.connect.titleReconnect", { provider: label })
        : scope === "personal"
          ? tt("tasktrackers.connect.titleConnectPersonal", { provider: label })
          : tt("tasktrackers.connect.titleConnect", { provider: label })}
      onClose={onClose}
      size="md"
      className="tt-connect-dialog"
      footer={footer}
    >
      <form id="tt-connect-form" className="tt-wizard" onSubmit={onSubmit} noValidate>
        <div className="tt-wizard-hero">
          <ProviderMark provider={provider} size="lg" />
          <Stepper provider={provider} step={step} />
        </div>
        {error && <Notice tone="error" className="tt-wizard-error">{error}</Notice>}
        <div className="tt-wizard-stage" data-direction={direction}>
          <div className="tt-wizard-step" key={`${provider}-${step}`}>{stepBody()}</div>
        </div>
      </form>
    </Dialog>
  );
}
