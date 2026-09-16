import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { HarnessSelection, HarnessSnapshot, HarnessTransition, SessionEvent, SessionProjection } from "@polyth/contracts";
import { peekHarnessSnapshots, readHarnessSnapshots, useCatalogRevision } from "@polyth/models/runtime-catalog";
import { createApiTransport, type WebPackageHost } from "@polyth/web-sdk";
import { Button, Dialog, Notice } from "../../../apps/web/src/components/ui/index.ts";
import { harnessDisplayName } from "./presentation.ts";
import { HarnessTransitionStatus } from "./runtime.tsx";

const api = createApiTransport();
const AUTH_HISTORY_LIMIT = 200;
const AUTH_HISTORY_TAIL = Number.MAX_SAFE_INTEGER;

type RecoveryKind = "sign-in" | "bridge-reconnect";
type SignInSource = "transition" | "turn" | "discovery";

type Props = {
  host: WebPackageHost;
  projectId?: string;
  spaceId?: string;
  sessionId?: string;
  resolvedHarnessId?: string;
  pendingHarnessSelection?: HarnessSelection;
  transition?: HarnessTransition;
};

export interface HarnessTurnAuthFailure {
  turnId: string;
  harnessId?: string;
  message: string;
  prompt?: string;
  attachmentCount: number;
}

interface HarnessTurnFailure extends HarnessTurnAuthFailure {
  authHint: boolean;
}

const bridgeNeedsReconnect = (transition: HarnessTransition): boolean => {
  if (transition.phase !== "failed") return false;
  const message = transition.error?.message ?? "";
  return /agent-tools bridge/i.test(message)
    && /status:\s*authenticationRequired/i.test(message);
};

const messageNeedsSignIn = (message: string): boolean =>
  /unauthori[sz]ed/i.test(message)
  || /(?:authentication|credentials?|sign[- ]?in|log[- ]?in).*(?:required|expired|missing|invalid)/i.test(message);

const stringValue = (event: SessionEvent, key: string): string | undefined => {
  const value = event.data[key];
  return typeof value === "string" ? value : undefined;
};

const eventNeedsSignIn = (event: SessionEvent): boolean => {
  if (event.type !== "turn/stopped" || stringValue(event, "reason") !== "error") return false;
  const code = stringValue(event, "code");
  return code === "auth-expired" || code === "auth" || messageNeedsSignIn(stringValue(event, "error") ?? "");
};

/** Latest unresolved failed turn from canonical history. A newer prompt or
 * turn supersedes it; nothing here replays a mutation. `authHint` is only a
 * fast path — an unclassified failure is checked against authoritative harness
 * availability before any auth UI is shown. */
function latestHarnessTurnFailure(events: readonly SessionEvent[]): HarnessTurnFailure | undefined {
  let lastPrompt: { text: string; attachmentCount: number } | undefined;
  let activeTurn: { turnId: string; harnessId?: string } | undefined;
  let candidate: HarnessTurnFailure | undefined;

  for (const event of events.toSorted((a, b) => a.seq - b.seq)) {
    if (event.type === "user/message") {
      const raw = stringValue(event, "raw");
      const text = raw ?? stringValue(event, "text") ?? "";
      const attachments = event.data.attachments;
      lastPrompt = {
        text,
        attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
      };
      candidate = undefined;
      continue;
    }
    if (event.type === "turn/started") {
      const harnessId = stringValue(event, "harnessId");
      activeTurn = {
        turnId: stringValue(event, "turnId") ?? "",
        ...(harnessId ? { harnessId } : {}),
      };
      candidate = undefined;
      continue;
    }
    if (event.type !== "turn/stopped") continue;

    const reason = stringValue(event, "reason");
    if (reason !== "error") {
      candidate = undefined;
      activeTurn = undefined;
      continue;
    }
    const turnId = stringValue(event, "turnId") ?? "";
    const matchingTurn = activeTurn?.turnId === turnId ? activeTurn : undefined;
    const harnessId = stringValue(event, "harnessId") ?? matchingTurn?.harnessId;
    candidate = {
      turnId,
      ...(harnessId ? { harnessId } : {}),
      message: stringValue(event, "error") ?? "Harness turn failed",
      ...(lastPrompt?.text ? { prompt: lastPrompt.text } : {}),
      attachmentCount: lastPrompt?.attachmentCount ?? 0,
      authHint: eventNeedsSignIn(event),
    };
    activeTurn = undefined;
  }
  return candidate;
}

export function latestHarnessAuthFailure(events: readonly SessionEvent[]): HarnessTurnAuthFailure | undefined {
  const candidate = latestHarnessTurnFailure(events);
  if (!candidate?.authHint) return undefined;
  const { authHint: _authHint, ...failure } = candidate;
  return failure;
}

export function harnessRecoveryKind(transition?: HarnessTransition): RecoveryKind | undefined {
  if (!transition || transition.phase !== "failed") return undefined;
  if (bridgeNeedsReconnect(transition)) return "bridge-reconnect";
  if (transition.error?.code === "auth" || messageNeedsSignIn(transition.error?.message ?? "")) return "sign-in";
  return undefined;
}

const snapshotNeedsSignIn = (snapshot?: HarnessSnapshot): boolean =>
  snapshot?.availability.state === "auth-required";

const recoveryNoticeBody = (
  content: ReactNode,
  status: string,
  failure: string,
) => <>
  {content}
  {status && <p role="status" aria-live="polite">{status}</p>}
  {failure && <p role="alert">{failure}</p>}
</>;

export default function HarnessAuthRecovery({
  host,
  projectId,
  spaceId,
  sessionId,
  resolvedHarnessId,
  pendingHarnessSelection,
  transition,
}: Props) {
  const catalogRevision = useCatalogRevision();
  const explicitKind = harnessRecoveryKind(transition);
  const [turnFailure, setTurnFailure] = useState<HarnessTurnFailure>();
  const [dismissedTurnId, setDismissedTurnId] = useState<string>();
  const [confirmedAuthTurnId, setConfirmedAuthTurnId] = useState<string>();
  const [verifiedTurnId, setVerifiedTurnId] = useState<string>();
  const selectedHarnessId = pendingHarnessSelection?.mode === "pinned"
    ? pendingHarnessSelection.harnessId
    : resolvedHarnessId;
  const visibleTurnFailure = turnFailure?.turnId === dismissedTurnId ? undefined : turnFailure;
  const targetId = transition?.targetHarnessId
    ?? visibleTurnFailure?.harnessId
    ?? (visibleTurnFailure ? resolvedHarnessId : selectedHarnessId)
    ?? selectedHarnessId;

  const cachedSnapshot = targetId
    ? peekHarnessSnapshots({ projectId, spaceId, harnessId: targetId, detail: true })?.[0]
      ?? peekHarnessSnapshots({ projectId, spaceId })?.find((row) => row.identity.id === targetId)
    : undefined;
  void catalogRevision;

  const [snapshot, setSnapshot] = useState<HarnessSnapshot>();
  const [snapshotChecked, setSnapshotChecked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [terminalId, setTerminalId] = useState<string>();
  const [failure, setFailure] = useState("");
  const [status, setStatus] = useState("");
  const effectiveSnapshot = snapshot ?? cachedSnapshot;

  const loadTurnFailure = useCallback(async () => {
    if (!sessionId) {
      setTurnFailure(undefined);
      return;
    }
    try {
      const events = await api.get<SessionEvent[]>(
        `/api/sessions/${encodeURIComponent(sessionId)}/events?afterSeq=0&beforeSeq=${AUTH_HISTORY_TAIL}&limit=${AUTH_HISTORY_LIMIT}`,
      );
      setTurnFailure(latestHarnessTurnFailure(events));
    } catch {
      // Existing generic failed-turn handling remains the fallback when the
      // recent canonical window cannot be read.
    }
  }, [sessionId]);

  useEffect(() => {
    setTurnFailure(undefined);
    setDismissedTurnId(undefined);
    setConfirmedAuthTurnId(undefined);
    setVerifiedTurnId(undefined);
    if (!sessionId) return;
    let active = true;
    const refresh = () => { if (active) void loadTurnFailure(); };
    refresh();
    const dispose = host.sessions.subscribeEvents((event) => {
      if (event.sessionId !== sessionId) return;
      if (event.type === "user/message" || event.type === "turn/started" || event.type === "turn/stopped") refresh();
    });
    return () => {
      active = false;
      dispose();
    };
  }, [host.sessions, loadTurnFailure, sessionId]);

  const refreshSnapshot = useCallback(async (force = true): Promise<HarnessSnapshot | undefined> => {
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
        force,
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

  const cachedNeedsSignIn = snapshotNeedsSignIn(cachedSnapshot);
  const needsSnapshot = Boolean(
    targetId
    && (
      (transition?.phase === "failed" && explicitKind !== "bridge-reconnect")
      || visibleTurnFailure
      || cachedNeedsSignIn
    ),
  );

  useEffect(() => {
    setSnapshot(undefined);
    setSnapshotChecked(false);
    setFailure("");
    setStatus("");
    setTerminalId(undefined);
    setDialogOpen(false);
    if (!needsSnapshot) {
      setSnapshotChecked(true);
      return;
    }
    void refreshSnapshot(Boolean(transition?.phase === "failed" || visibleTurnFailure));
  }, [needsSnapshot, refreshSnapshot, targetId, transition?.id, visibleTurnFailure?.turnId]);

  useEffect(() => {
    if (visibleTurnFailure && snapshotNeedsSignIn(effectiveSnapshot)) {
      setConfirmedAuthTurnId(visibleTurnFailure.turnId);
    }
  }, [effectiveSnapshot?.availability.state, visibleTurnFailure?.turnId]);

  const retryTransition = useCallback(async () => {
    if (!transition || !sessionId) return;
    setBusy(true);
    setFailure("");
    try {
      const projection = await api.post<SessionProjection>(
        `/api/harnesses/sessions/${encodeURIComponent(sessionId)}`,
        { selection: transition.selection, timing: "after-turn" },
      );
      host.sessions.upsert(projection);
      setStatus(explicitKind === "bridge-reconnect" ? "Reconnecting agent tools…" : "Signed in. Reconnecting…");
      if (terminalId) {
        setTerminalId(undefined);
        host.navigation.closeWorkspacePane();
      }
    } catch (cause) {
      setFailure(host.errors.friendly("Reconnect harness", cause));
    } finally {
      setBusy(false);
    }
  }, [explicitKind, host, sessionId, terminalId, transition]);

  const transitionSignIn = transition?.phase === "failed"
    && (explicitKind === "sign-in" || snapshotNeedsSignIn(effectiveSnapshot));
  const turnSignIn = !transition
    && Boolean(visibleTurnFailure)
    && (
      visibleTurnFailure?.authHint === true
      || snapshotNeedsSignIn(effectiveSnapshot)
      || confirmedAuthTurnId === visibleTurnFailure?.turnId
    );
  const discoverySignIn = !transition && !visibleTurnFailure && snapshotNeedsSignIn(effectiveSnapshot);
  const signInSource: SignInSource | undefined = transitionSignIn
    ? "transition"
    : turnSignIn
      ? "turn"
      : discoverySignIn
        ? "discovery"
        : undefined;
  const turnVerified = Boolean(visibleTurnFailure && verifiedTurnId === visibleTurnFailure.turnId);

  const checkAndContinue = useCallback(async () => {
    if (!signInSource) return;
    setFailure("");
    const next = await refreshSnapshot(true);
    if (!next) return;
    if (snapshotNeedsSignIn(next)) {
      setStatus(`${next.identity.name} still needs sign-in.`);
      return;
    }
    if (signInSource === "transition") {
      setStatus("Sign-in confirmed. Reconnecting…");
      await retryTransition();
      return;
    }
    if (signInSource === "turn" && visibleTurnFailure) {
      setConfirmedAuthTurnId(visibleTurnFailure.turnId);
      setVerifiedTurnId(visibleTurnFailure.turnId);
      setStatus("Sign-in confirmed. The failed message was not replayed automatically.");
      if (terminalId) {
        setTerminalId(undefined);
        host.navigation.closeWorkspacePane();
      }
      return;
    }
    setStatus("Sign-in confirmed. This harness is ready to use.");
  }, [host.navigation, refreshSnapshot, retryTransition, signInSource, terminalId, visibleTurnFailure]);

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
          void checkAndContinue();
        }
      }).catch(() => {});
    };
    const onFocus = () => void checkAndContinue();
    window.addEventListener("focus", onFocus);
    const interval = window.setInterval(checkTerminal, 3000);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
      window.clearInterval(interval);
    };
  }, [checkAndContinue, projectId, terminalId]);

  if (transition?.phase === "failed" && explicitKind !== "bridge-reconnect" && !snapshotChecked) {
    return <div className="pkg-harnesses pkg-harnesses-transition-status">
      <div className="pkg-harnesses-transition" role="status">Checking {harnessDisplayName(targetId ?? "harness")} recovery…</div>
    </div>;
  }

  const name = effectiveSnapshot?.identity.name ?? harnessDisplayName(targetId ?? "Harness");
  const command = effectiveSnapshot?.setup?.signInCommand;
  const setupUrl = effectiveSnapshot?.setup?.setupUrl;
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
      setStatus(`Finish ${name} sign-in in the terminal. Polyth will check it automatically.`);
    } catch (cause) {
      setFailure(host.errors.friendly("Start harness sign-in", cause));
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  const restoreFailedPrompt = async () => {
    if (!visibleTurnFailure?.prompt || !projectId || !sessionId) return;
    const draft = host.handoffTargets.list().find((target) => target.id === "draft" && target.available());
    if (!draft) {
      setFailure("The failed message could not be restored to the composer.");
      return;
    }
    setBusy(true);
    setFailure("");
    try {
      await draft.send({ projectId, sessionId, text: visibleTurnFailure.prompt });
      setStatus("Message restored to the composer. Review it, reattach any files if needed, then Send.");
      setDismissedTurnId(visibleTurnFailure.turnId);
    } catch (cause) {
      setFailure(host.errors.friendly("Restore failed message", cause));
    } finally {
      setBusy(false);
    }
  };

  if (explicitKind === "bridge-reconnect" && transition?.phase === "failed" && sessionId) {
    return <div className="pkg-harnesses pkg-harnesses-transition-status">
      <Notice
        tone={failure ? "error" : "warning"}
        role="alert"
        heading={`${name} agent tools need to reconnect`}
        actions={<>
          <Button size="sm" busy={busy} onClick={() => void retryTransition()}>Reconnect</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={openSettings}>Harness settings</Button>
        </>}
      >
        {recoveryNoticeBody(
          <>
            Polyth will restart the private agent-tools connection and retry this harness without changing your conversation.
            <details className="pkg-harnesses-diagnostics"><summary>Technical details</summary><p>{transition.error?.message}</p></details>
          </>,
          status,
          failure,
        )}
      </Notice>
    </div>;
  }

  if (signInSource === "turn" && visibleTurnFailure && turnVerified) {
    return <div className="pkg-harnesses pkg-harnesses-transition-status">
      <Notice
        tone={failure ? "error" : "success"}
        role="status"
        heading={`${name} sign-in restored`}
        actions={<>
          {visibleTurnFailure.prompt && <Button size="sm" busy={busy} onClick={() => void restoreFailedPrompt()}>Restore message</Button>}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDismissedTurnId(visibleTurnFailure.turnId)}>Continue without retry</Button>
        </>}
      >
        {recoveryNoticeBody(
          <>
            The failed turn was not replayed automatically because it may already have changed your project.
            {visibleTurnFailure.attachmentCount > 0 && <p>The original message had {visibleTurnFailure.attachmentCount} attachment{visibleTurnFailure.attachmentCount === 1 ? "" : "s"}. Reattach them before sending again.</p>}
            {!visibleTurnFailure.prompt && <p>Authentication is restored. Continue from the composer when you are ready.</p>}
          </>,
          status,
          failure,
        )}
      </Notice>
    </div>;
  }

  if (!signInSource || (signInSource !== "discovery" && !sessionId)) {
    return <HarnessTransitionStatus
      host={host}
      sessionId={sessionId}
      resolvedHarnessId={resolvedHarnessId}
      transition={transition}
    />;
  }

  const technicalMessage = signInSource === "turn"
    ? visibleTurnFailure?.message
    : transition?.phase === "failed"
      ? transition.error?.message
      : effectiveSnapshot?.message;
  const heading = signInSource === "turn"
    ? `Sign in to ${name} to retry safely`
    : `Sign in to ${name} to continue`;

  return <div className="pkg-harnesses pkg-harnesses-transition-status" aria-busy={loading || busy}>
    <Notice
      tone={failure ? "error" : "warning"}
      role="alert"
      heading={heading}
      actions={<>
        {loading && !command
          ? <Button size="sm" disabled busy>Checking sign-in…</Button>
          : command && projectId
            ? <Button size="sm" busy={busy} onClick={() => setDialogOpen(true)}>Sign in</Button>
            : <Button size="sm" onClick={openSettings}>Open Harnesses</Button>}
        <Button size="sm" variant="ghost" busy={loading || busy} disabled={loading || busy} onClick={() => void checkAndContinue()}>I’ve signed in</Button>
      </>}
    >
      {recoveryNoticeBody(
        <>
          {signInSource === "turn"
            ? <>This turn stopped because the harness needs authentication. Your conversation is safe, and Polyth will not replay the failed message automatically.</>
            : <>Your conversation is safe. Sign in again, then Polyth will verify this harness and continue the recovery flow.</>}
          {!command && !loading && <p>The native sign-in command is not available here. Open Harnesses to finish authentication.</p>}
          {setupUrl && <p><a className="pkg-harnesses-setup-link" href={setupUrl} target="_blank" rel="noreferrer">Open setup guide ↗</a></p>}
          {technicalMessage && <details className="pkg-harnesses-diagnostics"><summary>Technical details</summary><p>{technicalMessage}</p></details>}
        </>,
        status,
        failure,
      )}
    </Notice>
    {dialogOpen && command && <Dialog title={`Sign in to ${name}`} onClose={() => setDialogOpen(false)}>
      <div className="pkg-harnesses pkg-harnesses-command-review">
        <p>Run this harness’s native sign-in command on the selected project target:</p>
        <pre>{command}</pre>
        <p>Your conversation stays open. After sign-in finishes, Polyth checks authentication automatically.</p>
        <Button busy={busy} onClick={() => void runSignIn()}>Run sign-in</Button>
      </div>
    </Dialog>}
  </div>;
}
