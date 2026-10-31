import { useCallback, useEffect, useRef, useState } from "react";
import type { HarnessSetupAction, HarnessSetupTerminalDto, HarnessSetupTerminalPreviewDto } from "@polyth/contracts";
import { createApiTransport, type WebPackageHost } from "@polyth/web-sdk";
import ProviderLogo from "@polyth/models/provider-logo";
import { Button, CloseIcon, Dialog, ExternalLinkIcon, Icon, IconButton, Notice, TerminalIcon } from "../../../apps/web/src/components/ui/index.ts";
import CopyButton from "../../../apps/web/src/components/CopyButton.tsx";

const api = createApiTransport();

/** A started sign-in survives closing Settings: the terminal needs the whole
 *  window, and the person comes back to Settings to see the result. */
const PENDING_KEY = "polyth.harnesses.pending-sign-in";
const PENDING_TTL_MS = 30 * 60_000;

export type SignInKind = "install" | "sign-in" | "sign-in-again";
export interface SignInRequest {
  harnessId: string;
  harnessName: string;
  command: string;
  kind: SignInKind;
  setupUrl?: string;
}
type PendingSignIn = { harnessId: string; harnessName: string; kind: SignInKind; startedAt: number };

export function readPendingSignIn(): PendingSignIn | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null") as PendingSignIn | null;
    if (!value || typeof value.harnessId !== "string" || Date.now() - value.startedAt > PENDING_TTL_MS) return undefined;
    return value;
  } catch {
    return undefined;
  }
}
export function clearPendingSignIn(): void {
  try { sessionStorage.removeItem(PENDING_KEY); } catch { /* storage unavailable */ }
}
const writePendingSignIn = (value: PendingSignIn) => {
  try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(value)); } catch { /* storage unavailable */ }
};

/** Message keys per kind, under `harnessruntime.signin.`. */
const copy = {
  install: { title: "title.install", action: "action.install", lead: "lead.install" },
  "sign-in": { title: "title.signIn", action: "action.signIn", lead: "lead.signIn" },
  "sign-in-again": { title: "title.signInAgain", action: "action.signInAgain", lead: "lead.signInAgain" },
} as const;

/** The project whose Terminal view shows a setup terminal: the open project,
 *  else the open chat's. */
export function useSetupProjectId(host: WebPackageHost): string | null {
  const activeProjectId = host.store.select((state) => state.activeProjectId);
  const activeSessionId = host.store.select((state) => state.activeSessionId);
  return activeProjectId ?? (activeSessionId ? host.sessions.get(activeSessionId)?.projectId ?? null : null);
}

const setupPath = (harnessId: string) => `/api/harnesses/${encodeURIComponent(harnessId)}/setup-terminal`;

/** What the server will run for this harness, and where. */
export const previewHarnessSetup = (harnessId: string, action: HarnessSetupAction, projectId: string | null | undefined) =>
  api.get<HarnessSetupTerminalPreviewDto>(`${setupPath(harnessId)}?action=${action}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`);

/** Open a harness install/sign-in terminal and bring it on screen: the
 *  server picks the command and machine; the Terminal view of `projectId`
 *  shows the tab in any chat (it is announced and listed as machine-wide). */
export async function openHarnessSetupTerminal(host: WebPackageHost, input: { harnessId: string; action: HarnessSetupAction; projectId: string }): Promise<HarnessSetupTerminalDto> {
  const result = await api.post<HarnessSetupTerminalDto>(setupPath(input.harnessId), { action: input.action, projectId: input.projectId });
  host.navigation.setOverlay(null);
  host.navigation.openWorkspacePane("terminal");
  // The Terminal view may still be mounting; the announcement is idempotent.
  const announce = () => window.dispatchEvent(new window.CustomEvent("polyth:terminal-created", {
    detail: { terminalId: result.terminalId, projectId: result.projectId, title: result.title, purpose: "harness-setup" },
  }));
  announce();
  for (const delay of [300, 1_000]) window.setTimeout(announce, delay);
  return result;
}


/** Guided install / sign-in / re-sign-in through the harness's own CLI. */
export function useHarnessSignIn({ host, projectId }: { host: WebPackageHost; projectId?: string | null }) {
  const [request, setRequest] = useState<SignInRequest>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [preview, setPreview] = useState<HarnessSetupTerminalPreviewDto>();
  const [previewFailure, setPreviewFailure] = useState("");
  const action: HarnessSetupAction | undefined = request ? (request.kind === "install" ? "install" : "sign-in") : undefined;
  const t = useCallback((key: string, values?: Record<string, string | number>) => host.ui.locale.translate(`harnessruntime.signin.${key}`, values), [host]);

  useEffect(() => {
    setPreview(undefined);
    setPreviewFailure("");
    setFailure("");
    if (!request || !action) return;
    let live = true;
    void previewHarnessSetup(request.harnessId, action, projectId).then(
      (next) => { if (live) setPreview(next); },
      (cause) => { if (live) setPreviewFailure(host.errors.friendly(t(copy[request.kind].action), cause)); },
    );
    return () => { live = false; };
  }, [action, host.errors, projectId, request, t]);

  const run = useCallback(async () => {
    if (!request || !action || !projectId) return;
    setBusy(true);
    setFailure("");
    try {
      await openHarnessSetupTerminal(host, { harnessId: request.harnessId, action, projectId });
      writePendingSignIn({ harnessId: request.harnessId, harnessName: request.harnessName, kind: request.kind, startedAt: Date.now() });
      setRequest(undefined);
    } catch (cause) {
      setFailure(host.errors.friendly(t(copy[request.kind].action), cause));
    } finally {
      setBusy(false);
    }
  }, [action, host, projectId, request, t]);

  /** Built only while a request is open, so an idle page reads no copy. */
  const renderDialog = (request: SignInRequest) => {
    const onMachine = preview?.target === "remote" ? t("onRemoteHost") : host.ui.locale.translate("harnessruntime.install.machine.onServerComputer");
    const name = request.harnessName;
    const steps = request.kind === "install"
      ? [t("step.installRun", { onMachine }), t("step.installWait"), t("step.installBack", { name })]
      : [t("step.signInRun", { onMachine }), preview?.deviceCode ? t("step.signInDevice") : t("step.signInFollow"), t("step.signInBack")];
    const command = preview?.command ?? request.command;
    const title = t(copy[request.kind].title, { name });
    return <Dialog title={title} onClose={() => setRequest(undefined)} hideHeader className="pkg-harnesses-signin-dialog" footer={<div className="pkg-harnesses-install-actions">
      {request.setupUrl && <a className="ui-btn ui-btn--ghost ui-btn--sm pkg-harnesses-install-guide" href={request.setupUrl} target="_blank" rel="noreferrer">{host.ui.locale.translate("harnessruntime.install.action.guide")}<Icon icon={ExternalLinkIcon} size="sm" /></a>}
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRequest(undefined)}>{host.ui.locale.translate("harnessruntime.install.action.cancel")}</Button>
      <Button variant="primary" size="sm" iconStart={TerminalIcon} busy={busy} disabled={!projectId || Boolean(previewFailure)} onClick={() => void run()}>{t(copy[request.kind].action)}</Button>
    </div>}>
      <div className="pkg-harnesses pkg-harnesses-install pkg-harnesses-signin">
        <header className="pkg-harnesses-install-hero">
          <span className="pkg-harnesses-install-mark">
            <span className="pkg-harnesses-logo-tile pkg-harnesses-logo-tile--lg"><ProviderLogo providerID={request.harnessId} providerName={name} size="regular" /></span>
          </span>
          <div className="pkg-harnesses-install-heading">
            <h2>{title}</h2>
            <p>{t(copy[request.kind].lead, { name })}</p>
          </div>
          <IconButton icon={CloseIcon} label={host.ui.locale.translate("harnessruntime.install.action.close")} onClick={() => setRequest(undefined)} />
        </header>
        <ol className="pkg-harnesses-signin-steps">
          {steps.map((step, index) => <li key={index}><span aria-hidden="true">{index + 1}</span><p>{step}</p></li>)}
        </ol>
        {!projectId && <Notice>{t("needsProject", { onMachine })}</Notice>}
        {previewFailure && <Notice tone="error" role="alert">{previewFailure}</Notice>}
        {failure && <Notice tone="error" role="alert">{failure}</Notice>}
        {command && <details className="pkg-harnesses-install-details" open={!projectId || undefined}>
          <summary><span>{host.ui.locale.translate("harnessruntime.install.details.summary")}</span></summary>
          <div className="pkg-harnesses-install-details-body">
            <div className="pkg-harnesses-install-block" aria-busy={!preview && !previewFailure}>
              <span className="pkg-harnesses-install-block-label">{host.ui.locale.translate("harnessruntime.install.details.command")}</span>
              <div className="pkg-harnesses-install-log" data-kind="command">
                <pre>{command}</pre>
                <CopyButton text={command} label={host.ui.locale.translate("harnessruntime.install.action.copyCommand")} />
              </div>
            </div>
          </div>
        </details>}
      </div>
    </Dialog>;
  };
  const dialog = request ? renderDialog(request) : null;

  return { start: setRequest, dialog };
}

/** Result of a sign-in started from Settings, shown once on return. The
 *  caller forces a fresh probe and reports the harness's new state. */
export function usePendingSignIn(onReturn: () => Promise<void> | void) {
  const [pending, setPending] = useState(readPendingSignIn);
  // A forced probe changes the catalog revision and with it the caller's
  // callback; reading it through a ref keeps this to one probe per return.
  const latest = useRef(onReturn);
  latest.current = onReturn;
  const active = pending !== undefined;
  useEffect(() => {
    if (!active) return;
    void latest.current();
    const focus = () => { void latest.current(); };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [active]);
  const finish = useCallback(() => { clearPendingSignIn(); setPending(undefined); }, []);
  return { pending, finish };
}

export type HarnessAccountStatus = { loggedIn: boolean | "unknown"; email?: string; plan?: string };

/** Who a multi-account harness is signed in as, from its family's local
 *  account report (`claude auth status`, `codex login status`, …). Harnesses
 *  without an account list report nothing here. */
export function useHarnessAccountStatus(endpoint: string | undefined, harnessId: string, revision: unknown) {
  const [status, setStatus] = useState<HarnessAccountStatus>();
  useEffect(() => {
    if (!endpoint) { setStatus(undefined); return; }
    let live = true;
    void api.get<{ accounts: Array<{ harnessId: string; status: HarnessAccountStatus }> }>(endpoint)
      .then((list) => { if (live) setStatus(list.accounts.find((row) => row.harnessId === harnessId)?.status); })
      .catch(() => { if (live) setStatus(undefined); });
    return () => { live = false; };
  }, [endpoint, harnessId, revision]);
  return status;
}
