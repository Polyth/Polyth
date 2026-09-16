import { useCallback, useEffect, useState } from "react";
import type { HarnessSnapshot, HarnessTransition, SessionProjection } from "@polyth/contracts";
import { readHarnessSnapshots } from "@polyth/models/runtime-catalog";
import { createApiTransport, type WebPackageHost } from "@polyth/web-sdk";
import { Button, Dialog, Notice } from "../../../apps/web/src/components/ui/index.ts";
import { harnessDisplayName } from "./presentation.ts";
import { HarnessTransitionStatus } from "./runtime.tsx";

const api = createApiTransport();

type RecoveryKind = "sign-in" | "bridge-reconnect";

type Props = {
  host: WebPackageHost;
  projectId?: string;
  spaceId?: string;
  sessionId?: string;
  resolvedHarnessId?: string;
  transition?: HarnessTransition;
};

const bridgeNeedsReconnect = (transition: HarnessTransition): boolean => {
  if (transition.phase !== "failed") return false;
  const message = transition.error?.message ?? "";
  return /agent-tools bridge/i.test(message)
    && /status:\s*authenticationRequired/i.test(message);
};

const messageNeedsSignIn = (message: string): boolean =>
  /unauthori[sz]ed/i.test(message)
  || /(?:authentication|credentials?|sign[- ]?in|log[- ]?in).*(?:required|expired|missing|invalid)/i.test(message);

export function harnessRecoveryKind(transition?: HarnessTransition): RecoveryKind | undefined {
  if (!transition || transition.phase !== "failed") return undefined;
  if (bridgeNeedsReconnect(transition)) return "bridge-reconnect";
  if (transition.error?.code === "auth" || messageNeedsSignIn(transition.error?.message ?? "")) return "sign-in";
  return undefined;
}

const snapshotNeedsSignIn = (snapshot?: HarnessSnapshot): boolean =>
  snapshot?.availability.state === "auth-required";

export default function HarnessAuthRecovery({
  host,
  projectId,
  spaceId,
  sessionId,
  resolvedHarnessId,
  transition,
}: Props) {
  const explicitKind = harnessRecoveryKind(transition);
  const targetId = transition?.targetHarnessId;
  const [snapshot, setSnapshot] = useState<HarnessSnapshot>();
  const [snapshotChecked, setSnapshotChecked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [terminalId, setTerminalId] = useState<string>();
  const [failure, setFailure] = useState("");
  const [status, setStatus] = useState("");
  const kind = explicitKind ?? (snapshotNeedsSignIn(snapshot) ? "sign-in" : undefined);

  const refresh = useCallback(async (): Promise<HarnessSnapshot | undefined> => {
    if (!targetId) {
      setSnapshotChecked(true);
      return undefined;
    }
    setLoading(true);
    try {
      const rows = await readHarnessSnapshots({
        projectId,
        spaceId,
        harnessId: targetId,
        detail: true,
        force: true,
      });
      const next = rows.find((row) => row.identity.id === targetId);
      setSnapshot(next);
      return next;
    } catch (cause) {
      setFailure(host.errors.friendly("Check harness sign-in", cause));
      return undefined;
    } finally {
      setSnapshotChecked(true);
      setLoading(false);
    }
  }, [host.errors, projectId, spaceId, targetId]);

  useEffect(() => {
    setSnapshot(undefined);
    setSnapshotChecked(false);
    setFailure("");
    setStatus("");
    setTerminalId(undefined);
    setDialogOpen(false);
    if (transition?.phase !== "failed" || !targetId || explicitKind === "bridge-reconnect") {
      setSnapshotChecked(true);
      return;
    }
    void refresh();
  }, [explicitKind, refresh, targetId, transition?.id, transition?.phase]);

  const retry = useCallback(async () => {
    if (!transition || !sessionId) return;
    setBusy(true);
    setFailure("");
    try {
      const projection = await api.post<SessionProjection>(
        `/api/harnesses/sessions/${encodeURIComponent(sessionId)}`,
        { selection: transition.selection, timing: "after-turn" },
      );
      host.sessions.upsert(projection);
      setStatus(kind === "bridge-reconnect" ? "Reconnecting agent tools…" : "Signed in. Reconnecting…");
      if (terminalId) {
        setTerminalId(undefined);
        host.navigation.closeWorkspacePane();
      }
    } catch (cause) {
      setFailure(host.errors.friendly("Reconnect harness", cause));
    } finally {
      setBusy(false);
    }
  }, [host, kind, sessionId, terminalId, transition]);

  const checkAndRetry = useCallback(async () => {
    if (kind !== "sign-in") return retry();
    setFailure("");
    const next = await refresh();
    if (!next) return;
    if (snapshotNeedsSignIn(next)) {
      setStatus(`${next.identity.name} still needs sign-in.`);
      return;
    }
    setStatus("Sign-in confirmed. Reconnecting…");
    await retry();
  }, [kind, refresh, retry]);

  useEffect(() => {
    if (!terminalId || !projectId) return;
    let active = true;
    const checkTerminal = () => {
      void api.get<Array<{ id: string; running: boolean }>>(
        `/api/terminals?projectId=${encodeURIComponent(projectId)}`,
      ).then((items) => {
        if (!active) return;
        if (!items.find((item) => item.id === terminalId)?.running) {
          setTerminalId(undefined);
          void checkAndRetry();
        }
      }).catch(() => {});
    };
    const onFocus = () => void checkAndRetry();
    window.addEventListener("focus", onFocus);
    const interval = window.setInterval(checkTerminal, 3000);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
      window.clearInterval(interval);
    };
  }, [checkAndRetry, projectId, terminalId]);

  if (transition?.phase === "failed" && explicitKind !== "bridge-reconnect" && !snapshotChecked) {
    return <div className="pkg-harnesses pkg-harnesses-transition-status">
      <div className="pkg-harnesses-transition" role="status">Checking {harnessDisplayName(targetId ?? "harness")} recovery…</div>
    </div>;
  }

  if (!kind || !transition || transition.phase !== "failed" || !sessionId) {
    return <HarnessTransitionStatus
      host={host}
      sessionId={sessionId}
      resolvedHarnessId={resolvedHarnessId}
      transition={transition}
    />;
  }

  const name = snapshot?.identity.name ?? harnessDisplayName(targetId ?? "Harness");
  const command = snapshot?.setup?.signInCommand;
  const setupUrl = snapshot?.setup?.setupUrl;
  const openSettings = () => host.navigation.openSettingsPage("harnesses", targetId ? { itemId: targetId } : undefined);

  const runSignIn = async () => {
    if (!projectId || !command) return;
    setBusy(true);
    setFailure("");
    setStatus("Opening sign-in terminal…");
    try {
      const result = await api.post<{ terminalId: string }>("/api/terminals", { projectId, cmd: command });
      setTerminalId(result.terminalId);
      setDialogOpen(false);
      host.navigation.setOverlay(null);
      host.navigation.openWorkspacePane("terminal");
      setStatus(`Finish ${name} sign-in in the terminal. Polyth will reconnect automatically.`);
    } catch (cause) {
      setFailure(host.errors.friendly("Start harness sign-in", cause));
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  if (kind === "bridge-reconnect") {
    return <div className="pkg-harnesses pkg-harnesses-transition-status">
      <Notice
        tone="warning"
        role="alert"
        heading={`${name} agent tools need to reconnect`}
        actions={<>
          <Button size="sm" busy={busy} onClick={() => void retry()}>Reconnect</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={openSettings}>Harness settings</Button>
        </>}
      >
        Polyth will restart the private agent-tools connection and retry this harness without changing your conversation.
        <details className="pkg-harnesses-diagnostics"><summary>Technical details</summary><p>{transition.error?.message}</p></details>
      </Notice>
      {status && <p role="status" aria-live="polite">{status}</p>}
      {failure && <Notice tone="error" role="alert">{failure}</Notice>}
    </div>;
  }

  return <div className="pkg-harnesses pkg-harnesses-transition-status" aria-busy={loading || busy}>
    <Notice
      tone="warning"
      role="alert"
      heading={`Sign in to ${name} to continue`}
      actions={<>
        {command && projectId
          ? <Button size="sm" busy={busy} onClick={() => setDialogOpen(true)}>Sign in</Button>
          : <Button size="sm" onClick={openSettings}>Open Harnesses</Button>}
        <Button size="sm" variant="ghost" busy={loading || busy} onClick={() => void checkAndRetry()}>I’ve signed in</Button>
      </>}
    >
      Your conversation is safe. Sign in again, then Polyth will reconnect this harness and continue on the same canonical session.
      {!command && !loading && <p>The native sign-in command is not available here. Open Harnesses to finish authentication.</p>}
      {setupUrl && <p><a href={setupUrl} target="_blank" rel="noreferrer">Open setup guide ↗</a></p>}
      <details className="pkg-harnesses-diagnostics"><summary>Technical details</summary><p>{transition.error?.message}</p></details>
    </Notice>
    {status && <p role="status" aria-live="polite">{status}</p>}
    {failure && <Notice tone="error" role="alert">{failure}</Notice>}
    {dialogOpen && command && <Dialog title={`Sign in to ${name}`} onClose={() => setDialogOpen(false)}>
      <div className="pkg-harnesses pkg-harnesses-command-review">
        <p>Run this harness’s native sign-in command on the selected project target:</p>
        <pre>{command}</pre>
        <p>Your conversation stays open. After sign-in finishes, Polyth checks authentication and reconnects automatically.</p>
        <Button busy={busy} onClick={() => void runSignIn()}>Run sign-in</Button>
      </div>
    </Dialog>}
  </div>;
}
