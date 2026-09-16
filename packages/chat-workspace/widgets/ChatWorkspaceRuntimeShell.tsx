import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import { createApiTransport } from "@polyth/web-sdk";
import {
  desktopBridge,
  type DesktopChatWorkspaceConnection,
  type DesktopChatWorkspacePairingAttempt,
  type DesktopChatWorkspacePairingPreview,
  type DesktopChatWorkspaceSurface,
} from "../../../apps/web/src/desktopBridge.ts";
import { useStore } from "../../../apps/web/src/store.ts";
import ChatWorkspaceView from "./ChatWorkspaceView.tsx";
import "./runtime.css";

type RuntimeMode = "local-first" | "local-only" | "remote";
type ProviderAction = "add-to-agent" | "ask-agent" | "new-agent-chat";

interface RuntimePreference {
  mode: RuntimeMode;
  deviceId?: string;
  allowRemoteFallback: boolean;
}

interface RuntimeCandidate {
  kind: "desktop-local" | "server-remote";
  available: boolean;
  deviceId?: string;
  deviceName?: string;
  reason?: string;
  localRendering: boolean;
  localProfileState: boolean;
}

interface RuntimeState {
  binding: { preference: RuntimePreference; updatedAt: number };
  candidates: RuntimeCandidate[];
  selection: {
    selected: RuntimeCandidate | null;
    waitingForDevice: boolean;
    reason?: string;
  };
}

interface PendingProviderAction {
  sequence: number;
  eventId: string;
  deviceId: string;
  action: ProviderAction;
  handoff: {
    projectId: string;
    profileId: string;
    tabId: string;
    text: string;
  };
  createdAt: number;
}

const transport = createApiTransport();
const HIDDEN_SURFACE: DesktopChatWorkspaceSurface = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  visible: false,
  claimed: true,
};

const runtimeLabel = (state: RuntimeState | null): string => {
  if (!state) return "Browser runtime";
  if (state.selection.waitingForDevice) return "Waiting for Desktop";
  const selected = state.selection.selected;
  if (!selected) return "Browser unavailable";
  if (selected.kind === "server-remote") return "Remote browser";
  return selected.deviceName?.trim() || "This Desktop";
};

const connectionIdOf = (connection: DesktopChatWorkspaceConnection): string =>
  connection.id ?? connection.connectionId ?? "";

const sameSurface = (a: DesktopChatWorkspaceSurface | null, b: DesktopChatWorkspaceSurface): boolean =>
  !!a
  && a.x === b.x
  && a.y === b.y
  && a.width === b.width
  && a.height === b.height
  && a.visible === b.visible
  && a.claimed === b.claimed;

const newConsumerId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `chat-workspace:${crypto.randomUUID()}`;
  }
  return `chat-workspace:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
};

export default function ChatWorkspaceRuntimeShell(props: {
  host: WebPackageHost;
  active: boolean;
}) {
  const projectId = useStore((state) => state.activeProjectId);
  const sessionId = useStore((state) => state.activeSessionId);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastSurfaceRef = useRef<DesktopChatWorkspaceSurface | null>(null);
  const consumerIdRef = useRef<string>(newConsumerId());
  const providerActionBusyRef = useRef(false);
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);
  const [connections, setConnections] = useState<DesktopChatWorkspaceConnection[]>([]);
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [pairingTicket, setPairingTicket] = useState("");
  const [pairingPreview, setPairingPreview] = useState<DesktopChatWorkspacePairingPreview | null>(null);
  const [pairingAttempt, setPairingAttempt] = useState<DesktopChatWorkspacePairingAttempt | null>(null);
  const desktop = desktopBridge();

  const resetPairing = useCallback(() => {
    setPairingOpen(false);
    setPairingTicket("");
    setPairingPreview(null);
    setPairingAttempt(null);
  }, []);

  const load = useCallback(async () => {
    if (!projectId) {
      setRuntime(null);
      return;
    }
    const [runtimeState, desktopState] = await Promise.all([
      transport.get<RuntimeState>(`/api/chat-workspace/projects/${encodeURIComponent(projectId)}/runtime`),
      desktop?.chatWorkspaceConnections().catch(() => null) ?? Promise.resolve(null),
    ]);
    setRuntime(runtimeState);
    if (desktopState) {
      setConnections(desktopState.connections);
      setActiveConnectionId(desktopState.activeConnectionId);
    }
  }, [desktop, projectId]);

  useEffect(() => {
    void load().catch((failure) => setError(failure instanceof Error ? failure.message : String(failure)));
  }, [load]);

  useEffect(() => {
    if (!runtime?.selection.waitingForDevice || !projectId) return;
    const timer = window.setInterval(() => {
      void load().catch(() => {});
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [load, projectId, runtime?.selection.waitingForDevice]);

  const savePreference = async (preference: RuntimePreference, closeMenu = true) => {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      const next = await transport.put<RuntimeState>(
        `/api/chat-workspace/projects/${encodeURIComponent(projectId)}/runtime`,
        preference,
      );
      setRuntime(next);
      if (closeMenu) setOpen(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const connect = async (connectionId: string) => {
    if (!desktop || !connectionId) return;
    setBusy(true);
    setError(null);
    try {
      await desktop.connectChatWorkspace(connectionId);
      await new Promise((resolve) => window.setTimeout(resolve, 150));
      await load();
      await savePreference({ mode: "local-first", allowRemoteFallback: false }, false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const previewPairing = async () => {
    if (!desktop || !pairingTicket.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const preview = await desktop.previewChatWorkspacePairing(pairingTicket.trim());
      setPairingPreview(preview);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const beginPairing = async () => {
    if (!desktop || !pairingTicket.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const attempt = await desktop.beginChatWorkspacePairing(pairingTicket.trim(), "Polyth Desktop");
      setPairingAttempt(attempt);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const confirmPairing = async () => {
    if (!desktop || !pairingAttempt) return;
    setBusy(true);
    setError(null);
    try {
      await desktop.confirmChatWorkspacePairing(pairingAttempt.attemptId);
      resetPairing();
      await new Promise((resolve) => window.setTimeout(resolve, 200));
      await load();
      await savePreference({ mode: "local-first", allowRemoteFallback: false }, false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const cancelPairing = async () => {
    if (desktop && pairingAttempt) {
      await desktop.cancelChatWorkspacePairing(pairingAttempt.attemptId).catch(() => {});
    }
    resetPairing();
  };

  const localCandidates = useMemo(
    () => runtime?.candidates.filter((candidate) => candidate.kind === "desktop-local") ?? [],
    [runtime],
  );
  const remoteCandidate = runtime?.candidates.find((candidate) => candidate.kind === "server-remote") ?? null;
  const preference = runtime?.binding.preference;
  const selected = runtime?.selection.selected ?? null;
  const localRendering = selected?.kind === "desktop-local" && selected.available && selected.localRendering;
  const selectedDeviceId = selected?.kind === "desktop-local" ? selected.deviceId : undefined;
  const nativeSurfaceVisible = Boolean(desktop && localRendering && props.active && !open);

  useEffect(() => {
    if (!projectId || !localRendering || !props.active) return;
    let stopped = false;

    const executeProviderAction = async (item: PendingProviderAction): Promise<boolean> => {
      const targetId = item.action === "new-agent-chat"
        ? "new-session"
        : item.action === "add-to-agent"
          ? "draft"
          : "current-session";
      const target = props.host.handoffTargets.list().find((candidate) => candidate.id === targetId);
      if (!target?.available()) return false;
      if (item.action !== "new-agent-chat" && !sessionId) return false;
      await target.send({
        projectId,
        sessionId: item.action === "new-agent-chat" ? null : sessionId,
        text: item.handoff.text,
      });
      return true;
    };

    const poll = async () => {
      if (stopped || providerActionBusyRef.current) return;
      providerActionBusyRef.current = true;
      try {
        const consumerId = encodeURIComponent(consumerIdRef.current);
        const response = await transport.get<{ actions: PendingProviderAction[] }>(
          `/api/chat-workspace/projects/${encodeURIComponent(projectId)}/provider-actions?consumerId=${consumerId}`,
        );
        for (const item of response.actions.sort((a, b) => a.sequence - b.sequence)) {
          if (stopped) break;
          const completed = await executeProviderAction(item);
          if (!completed) break;
          await transport.post(
            `/api/chat-workspace/projects/${encodeURIComponent(projectId)}/provider-actions/${encodeURIComponent(item.eventId)}/ack?consumerId=${consumerId}`,
            {},
          );
        }
      } catch (failure) {
        if (!stopped) setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        providerActionBusyRef.current = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 1_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [localRendering, projectId, props.active, props.host, sessionId]);

  useEffect(() => {
    if (!desktop) return;
    let frame = 0;
    let observer: ResizeObserver | null = null;
    let viewport: HTMLElement | null = null;
    let stopped = false;

    const push = (next: DesktopChatWorkspaceSurface) => {
      if (sameSurface(lastSurfaceRef.current, next)) return;
      lastSurfaceRef.current = next;
      void desktop.setChatWorkspaceSurface(next).catch(() => {});
    };

    const measure = () => {
      frame = 0;
      if (stopped || !nativeSurfaceVisible) {
        push(HIDDEN_SURFACE);
        return;
      }
      viewport = rootRef.current?.querySelector<HTMLElement>(".chat-workspace-viewport") ?? null;
      if (!viewport) {
        push(HIDDEN_SURFACE);
        return;
      }
      const rect = viewport.getBoundingClientRect();
      const left = Math.max(0, rect.left);
      const top = Math.max(0, rect.top);
      const right = Math.min(window.innerWidth, rect.right);
      const bottom = Math.min(window.innerHeight, rect.bottom);
      const next: DesktopChatWorkspaceSurface = {
        x: Math.round(left),
        y: Math.round(top),
        width: Math.max(0, Math.round(right - left)),
        height: Math.max(0, Math.round(bottom - top)),
        visible: right > left && bottom > top,
        claimed: true,
      };
      push(next.visible ? next : HIDDEN_SURFACE);
    };

    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(measure);
    };

    const root = rootRef.current;
    if (root && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(schedule);
      observer.observe(root);
      const currentViewport = root.querySelector<HTMLElement>(".chat-workspace-viewport");
      if (currentViewport) observer.observe(currentViewport);
    }
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    schedule();

    return () => {
      stopped = true;
      if (frame) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
      const released: DesktopChatWorkspaceSurface = { ...HIDDEN_SURFACE, claimed: false };
      lastSurfaceRef.current = released;
      void desktop.setChatWorkspaceSurface(released).catch(() => {});
    };
  }, [desktop, nativeSurfaceVisible]);

  return (
    <div
      ref={rootRef}
      className={`chat-workspace-runtime-shell ${localRendering ? "is-local-runtime" : ""}`}
    >
      {projectId ? (
        <div className="chat-workspace-runtime-bar">
          <div className="chat-workspace-runtime-menu-wrap">
            <button
              type="button"
              className={`chat-workspace-runtime-chip ${runtime?.selection.waitingForDevice ? "is-waiting" : ""}`}
              aria-expanded={open}
              onClick={() => {
                setOpen((value) => !value);
                setError(null);
              }}
            >
              <span className="chat-workspace-runtime-dot" aria-hidden />
              <span>{runtimeLabel(runtime)}</span>
              <span className="chat-workspace-runtime-chevron" aria-hidden>⌄</span>
            </button>
            {open ? (
              <div className="chat-workspace-runtime-menu">
                <div className="chat-workspace-runtime-heading">Browser runs on</div>
                {localCandidates.map((candidate) => (
                  <button
                    key={candidate.deviceId}
                    type="button"
                    className="chat-workspace-runtime-option"
                    disabled={busy || !candidate.available}
                    onClick={() => void savePreference({
                      mode: "local-only",
                      ...(candidate.deviceId ? { deviceId: candidate.deviceId } : {}),
                      allowRemoteFallback: false,
                    })}
                  >
                    <span className="chat-workspace-runtime-option-main">
                      <strong>{candidate.deviceName || "Desktop"}</strong>
                      <small>{candidate.available ? "Local rendering · local login" : candidate.reason || "Unavailable"}</small>
                    </span>
                    {selectedDeviceId === candidate.deviceId ? <span aria-hidden>✓</span> : null}
                  </button>
                ))}
                {desktop && connections
                  .filter((connection) => {
                    const id = connectionIdOf(connection);
                    return id && id !== activeConnectionId;
                  })
                  .map((connection) => {
                    const connectionId = connectionIdOf(connection);
                    return (
                      <button
                        key={`link:${connectionId}`}
                        type="button"
                        className="chat-workspace-runtime-option"
                        disabled={busy || connection.revoked}
                        onClick={() => void connect(connectionId)}
                      >
                        <span className="chat-workspace-runtime-option-main">
                          <strong>{connection.hostLabel || "Paired Polyth host"}</strong>
                          <small>{connection.revoked ? "Pairing revoked" : "Connect this Desktop as browser worker"}</small>
                        </span>
                        <span aria-hidden>↗</span>
                      </button>
                    );
                  })}
                {desktop ? (
                  <>
                    <div className="chat-workspace-runtime-separator" />
                    {!pairingOpen ? (
                      <button
                        type="button"
                        className="chat-workspace-runtime-option"
                        disabled={busy}
                        onClick={() => {
                          setPairingOpen(true);
                          setPairingPreview(null);
                          setPairingAttempt(null);
                          setError(null);
                        }}
                      >
                        <span className="chat-workspace-runtime-option-main">
                          <strong>Pair another Polyth host</strong>
                          <small>Use its Polyth Link pairing ticket</small>
                        </span>
                        <span aria-hidden>＋</span>
                      </button>
                    ) : (
                      <div className="chat-workspace-pairing">
                        {!pairingPreview ? (
                          <>
                            <label className="chat-workspace-pairing-label" htmlFor="chat-workspace-pairing-ticket">Pairing ticket</label>
                            <textarea
                              id="chat-workspace-pairing-ticket"
                              className="chat-workspace-pairing-ticket"
                              value={pairingTicket}
                              rows={3}
                              autoFocus
                              spellCheck={false}
                              placeholder="Paste Polyth Link ticket"
                              onChange={(event) => setPairingTicket(event.target.value)}
                            />
                            <div className="chat-workspace-pairing-actions">
                              <button type="button" className="chat-workspace-pairing-button is-secondary" onClick={() => void cancelPairing()}>Cancel</button>
                              <button type="button" className="chat-workspace-pairing-button" disabled={busy || !pairingTicket.trim()} onClick={() => void previewPairing()}>Review</button>
                            </div>
                          </>
                        ) : !pairingAttempt ? (
                          <>
                            <div className="chat-workspace-pairing-host">
                              <strong>{pairingPreview.hostLabel || "Polyth host"}</strong>
                              <small>{pairingPreview.hostFingerprint}</small>
                            </div>
                            <p className="chat-workspace-pairing-copy">Confirm this is the host you intended to pair with.</p>
                            <div className="chat-workspace-pairing-actions">
                              <button type="button" className="chat-workspace-pairing-button is-secondary" onClick={() => { setPairingPreview(null); setError(null); }}>Back</button>
                              <button type="button" className="chat-workspace-pairing-button" disabled={busy} onClick={() => void beginPairing()}>Continue</button>
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="chat-workspace-pairing-host">
                              <strong>Verify safety phrase</strong>
                              <div className="chat-workspace-pairing-phrase">
                                {(pairingAttempt.safetyPhrase ?? []).join(" · ") || "Confirm on the host"}
                              </div>
                            </div>
                            <p className="chat-workspace-pairing-copy">Only confirm if the same phrase is shown by the Polyth host.</p>
                            <div className="chat-workspace-pairing-actions">
                              <button type="button" className="chat-workspace-pairing-button is-secondary" disabled={busy} onClick={() => void cancelPairing()}>Cancel</button>
                              <button type="button" className="chat-workspace-pairing-button" disabled={busy} onClick={() => void confirmPairing()}>Confirm & connect</button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </>
                ) : null}
                <div className="chat-workspace-runtime-separator" />
                <button
                  type="button"
                  className="chat-workspace-runtime-option"
                  disabled={busy || !remoteCandidate?.available}
                  onClick={() => void savePreference({ mode: "remote", allowRemoteFallback: true })}
                >
                  <span className="chat-workspace-runtime-option-main">
                    <strong>Remote server</strong>
                    <small>{remoteCandidate?.available ? "Fallback · streamed browser" : remoteCandidate?.reason || "Unavailable"}</small>
                  </span>
                  {preference?.mode === "remote" ? <span aria-hidden>✓</span> : null}
                </button>
                {error ? <div className="chat-workspace-runtime-error">{error}</div> : null}
              </div>
            ) : null}
          </div>
          {runtime?.selection.waitingForDevice ? (
            <span className="chat-workspace-runtime-status">
              {remoteCandidate?.available
                ? "Open or connect the selected Desktop — or pick Remote server here to stream it"
                : "Open or connect the selected Desktop to continue"}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="chat-workspace-runtime-content">
        <ChatWorkspaceView host={props.host} active={props.active && !localRendering} />
      </div>
    </div>
  );
}
