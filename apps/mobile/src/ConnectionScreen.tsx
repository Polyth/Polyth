import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@capacitor/app";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { SplashScreen } from "@capacitor/splash-screen";
import {
  checkPolythHost,
  forgetMobileHost,
  isPairingDeepLink,
  navigateToMobileHost,
  rememberMobileHost,
  type MobileHost,
  type MobileLaunch,
} from "./runtime.ts";
import {
  nativeLinkAvailable,
  polythLink,
  type ConnectionMetadata,
  type ProxyLaunch,
} from "./polythLink.ts";
import {
  installNativePolythLink,
  nativePairingScannerAvailable,
  scanNativePairingQr,
} from "./nativePolythLink.ts";
import {
  nativeDiscoveryAvailable,
  startNativeDiscovery,
} from "./nativeDiscovery.ts";
import { isPairingLink } from "@polyth/pairing-qr";
import { bootstrapUrlWithNext, connectionUiState } from "./connectionUi.ts";
import {
  ConnectionController,
  connectionPhaseBusy,
  type ConnectionControllerState,
} from "./connectionController.ts";
import {
  peekPendingPairingLink,
  rememberPendingPairingLink,
  subscribePendingPairingLink,
} from "./pendingPair.ts";
import "./styles.css";

type ConnectLaunch = Extract<MobileLaunch, { kind: "connect" }>;

installNativePolythLink();

function connectionLabel(host: MobileHost): string {
  try {
    return new URL(host.url).host;
  } catch {
    return host.url;
  }
}

function trustedConnectionDetail(connection: ConnectionMetadata, activeConnectionId: string | null): string {
  if (connection.id === activeConnectionId) return "Connected";
  if (connection.revoked || connection.pairingState === "revoked") return "Revoked";
  if (!connection.hasSecureIdentity) return "Secure identity unavailable — pair again";
  if (connection.pairingState === "prepared") return "Pairing interrupted — verify host approval to recover";
  if (connection.lastTransport) return `Last connected via ${connection.lastTransport}`;
  return "Paired securely";
}

function connectionHeading(state: ConnectionControllerState | null, nativeAvailable: boolean): string {
  if (!nativeAvailable) return "Polyth Link is unavailable in this build";
  const target = state?.trusted.find((connection) => connection.id === state.targetConnectionId);
  const targetLabel = target?.hostLabel || "your Polyth";
  switch (state?.phase) {
    case "loading-trusted-connections":
      return "Loading your Polyth servers…";
    case "discovering":
      return "Looking for nearby Polyth servers…";
    case "discovery-empty":
      return "No nearby Polyth found";
    case "discovery-results":
      return "Polyth servers nearby";
    case "discovery-permission-required":
      return "Local network access is disabled";
    case "scanning-qr":
      return "Scan pairing QR";
    case "validating-pairing":
    case "preparing-pairing":
      return "Connecting securely…";
    case "pairing":
      return "Ready to pair";
    case "safety-confirmation":
      return "Compare these words…";
    case "awaiting-host-approval":
      return "Waiting for approval on your computer…";
    case "committing":
      return "Saving trusted connection…";
    case "switching":
      return `Switching to ${targetLabel}…`;
    case "reconnecting":
      return `Connecting to ${targetLabel}…`;
    case "connected":
      return "Connected";
    case "offline":
      return "You’re offline";
    case "unreachable":
      return `Can’t reach ${targetLabel}`;
    case "revoked":
      return "This phone no longer has access";
    case "identity-mismatch":
      return "The server identity changed";
    case "incompatible":
      return "This Polyth server requires a newer app";
    case "pairing-expired":
      return "This pairing code expired";
    case "pairing-rejected":
      return "Pairing was rejected";
    default:
      return "How do you want to connect?";
  }
}

function ConnectionScreen({ launch }: { launch: ConnectLaunch }) {
  const nativeAvailable = nativeLinkAvailable();
  const discoveryAvailable = nativeDiscoveryAvailable();
  const initialPending = launch.pendingPair ?? peekPendingPairingLink();
  const ui = connectionUiState({ nativeAvailable, pendingPair: initialPending });
  const controller = useMemo(
    () => nativeAvailable ? new ConnectionController(polythLink(), launch.error) : null,
    [nativeAvailable],
  );
  const [connectionState, setConnectionState] = useState<ConnectionControllerState | null>(
    () => controller?.state ?? null,
  );
  const [ticket, setTicket] = useState(initialPending ?? "");
  const [url, setUrl] = useState(launch.preferred ?? launch.recent[0]?.url ?? "");
  const [recent, setRecent] = useState(launch.recent);
  const [cameraPermission, setCameraPermission] = useState<"unknown" | "prompt" | "granted" | "denied">("unknown");
  const [developer, setDeveloper] = useState(false);
  const [legacyBusy, setLegacyBusy] = useState(false);
  const [legacyError, setLegacyError] = useState("");
  const scanCleanup = useRef<(() => void) | null>(null);
  const scanIntent = useRef<number | null>(null);

  const trusted = connectionState?.trusted ?? [];
  const discovered = connectionState?.discovered ?? [];
  const attempt = connectionState?.pairingAttempt ?? null;
  const phrase = attempt?.safetyPhrase ?? null;
  const controllerBusy = connectionState
    ? connectionPhaseBusy(connectionState.phase) && connectionState.phase !== "pairing"
    : false;
  const busy = legacyBusy || controllerBusy;
  const scanning = connectionState?.phase === "scanning-qr";
  const discovering = connectionState?.phase === "discovering"
    || connectionState?.phase === "discovery-empty"
    || connectionState?.phase === "discovery-results";
  const discoveryPermissionDenied = connectionState?.phase === "discovery-permission-required";
  const error = connectionState?.error || legacyError || (!nativeAvailable ? launch.error ?? "" : "");
  const stage = connectionHeading(connectionState, nativeAvailable);

  const stopCamera = () => {
    scanCleanup.current?.();
    scanCleanup.current = null;
  };

  const openLaunch = (next: ProxyLaunch) => {
    location.replace(bootstrapUrlWithNext(next.bootstrapUrl, launch.deepLinkPath));
  };

  const finishPairing = async () => {
    if (!controller) return;
    const launched = await controller.confirmPairing();
    if (launched) openLaunch(launched);
  };

  const startPair = async (raw: string) => {
    stopCamera();
    rememberPendingPairingLink(raw);
    if (!controller) return;
    const pairing = await controller.beginPairing(raw, "This phone");
    if (pairing && !pairing.safetyPhrase?.length) await finishPairing();
  };

  useEffect(() => {
    void SplashScreen.hide();
  }, []);

  useEffect(() => {
    if (!controller) return;
    const unsubscribe = controller.subscribe(setConnectionState);
    void controller.loadTrustedConnections();
    return () => {
      stopCamera();
      unsubscribe();
      controller.dispose();
    };
  }, [controller]);

  useEffect(() => {
    if (launch.pendingPair) rememberPendingPairingLink(launch.pendingPair);
    return subscribePendingPairingLink((value) => {
      setTicket(value);
    });
  }, [launch.pendingPair]);

  useEffect(() => {
    let handle: { remove: () => Promise<void> } | undefined;
    void App.addListener("appUrlOpen", ({ url: opened }) => {
      if (!isPairingDeepLink(opened)) return;
      rememberPendingPairingLink(opened);
      setTicket(opened);
    }).then((next) => { handle = next; });
    return () => { void handle?.remove(); };
  }, []);

  useEffect(() => {
    if (!ui.autoStartPairing || !initialPending) return;
    void startPair(initialPending);
  }, []);

  const scanQr = async () => {
    if (!controller) return;
    stopCamera();
    const scanEpoch = controller.startQrScan();
    scanIntent.current = scanEpoch;

    if (nativePairingScannerAvailable()) {
      try {
        const raw = await scanNativePairingQr();
        if (!raw) {
          controller.cancelQrScan(scanEpoch);
          return;
        }
        if (!isPairingLink(raw)) {
          controller.failQrScan(scanEpoch, new Error("This QR code is not a Polyth pairing code."));
          return;
        }
        setCameraPermission("granted");
        rememberPendingPairingLink(raw);
        setTicket(raw);
        const pairing = await controller.acceptQrResult(scanEpoch, raw, "This phone");
        if (pairing && !pairing.safetyPhrase?.length) await finishPairing();
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        const denied = /denied|permission|not authorized/i.test(detail);
        setCameraPermission(denied ? "denied" : "prompt");
        controller.failQrScan(
          scanEpoch,
          new Error(denied
            ? "Camera permission is required to scan. Use another pairing method or allow camera access in Settings."
            : "Camera scanning failed. Use another pairing method."),
        );
      }
      return;
    }

    const Detector = (globalThis as {
      BarcodeDetector?: new (opts: { formats: string[] }) => {
        detect(source: HTMLVideoElement): Promise<Array<{ rawValue?: string }>>;
      };
    }).BarcodeDetector;
    if (!Detector) {
      controller.failQrScan(scanEpoch, new Error("Camera scanning is unavailable here. Use another pairing method."));
      return;
    }

    let stream: MediaStream | undefined;
    let cancelled = false;
    const video = document.createElement("video");
    video.setAttribute("playsinline", "true");
    video.setAttribute("aria-label", "Camera preview for pairing QR");
    video.muted = true;
    video.className = "mobile-connect-scan-video";
    const mount = document.getElementById("mobile-connect-scan-preview");
    if (!mount) {
      controller.failQrScan(scanEpoch, new Error("Camera preview is unavailable."));
      return;
    }
    mount.replaceChildren(video);
    scanCleanup.current = () => {
      cancelled = true;
      stream?.getTracks().forEach((item) => item.stop());
      video.remove();
      mount.replaceChildren();
    };

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      setCameraPermission("granted");
      video.srcObject = stream;
      await video.play();
      const detector = new Detector({ formats: ["qr_code"] });
      const started = Date.now();
      while (!cancelled && Date.now() - started < 20_000) {
        const codes = await detector.detect(video);
        const raw = codes.find((code) => code.rawValue && isPairingLink(code.rawValue))?.rawValue;
        if (raw) {
          rememberPendingPairingLink(raw);
          setTicket(raw);
          stopCamera();
          const pairing = await controller.acceptQrResult(scanEpoch, raw, "This phone");
          if (pairing && !pairing.safetyPhrase?.length) await finishPairing();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!cancelled) controller.failQrScan(scanEpoch, new Error("No Polyth pairing QR was found."));
    } catch (cause) {
      const denied = cause instanceof Error && /denied|permission|notallowed/i.test(cause.message);
      setCameraPermission(denied ? "denied" : "prompt");
      controller.failQrScan(
        scanEpoch,
        new Error(denied
          ? "Camera permission is required to scan. Use another pairing method or allow camera access in Settings."
          : "Camera scanning failed. Use another pairing method."),
      );
    } finally {
      stopCamera();
    }
  };

  const cancelScan = () => {
    const epoch = scanIntent.current;
    stopCamera();
    if (controller && epoch !== null) controller.cancelQrScan(epoch);
  };

  const findNearby = async () => {
    if (!controller || !discoveryAvailable) return;
    stopCamera();
    await controller.startDiscovery(startNativeDiscovery);
  };

  const reconnectTrusted = async (connection: ConnectionMetadata) => {
    if (!controller || connection.revoked || !connection.hasSecureIdentity) return;
    stopCamera();
    const launched = await controller.connect(connection.id);
    if (launched) openLaunch(launched);
  };

  const legacyConnect = async () => {
    setLegacyBusy(true);
    setLegacyError("");
    const checked = await checkPolythHost(url);
    if (!checked.ok) {
      setLegacyError(checked.message);
      setLegacyBusy(false);
      return;
    }
    const host = await rememberMobileHost(url);
    await Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined);
    navigateToMobileHost(host, launch.deepLinkPath);
  };

  return (
    <main className="mobile-connect">
      <section className="mobile-connect-card" aria-labelledby="mobile-connect-title">
        <div className="mobile-connect-brand" aria-hidden="true">P</div>
        <div className="mobile-connect-copy">
          <span className="mobile-connect-eyebrow">Polyth Link</span>
          <h1 id="mobile-connect-title">{stage}</h1>
          {ui.showUnavailableBanner ? (
            <p>
              This build does not include the native secure connection core. Insecure development URL mode remains available under Advanced.
            </p>
          ) : trusted.length > 0 ? (
            <p>Choose a trusted server or pair another Polyth.</p>
          ) : (
            <p>Pair this phone once, then reconnect without another QR.</p>
          )}
        </div>

        {nativeAvailable && trusted.length > 0 && (
          <section className="mobile-connect-recents" aria-labelledby="mobile-trusted-title">
            <h2 id="mobile-trusted-title">Existing servers</h2>
            {trusted.map((connection) => (
              <article key={connection.id}>
                <button
                  type="button"
                  className="mobile-connect-recent"
                  disabled={busy || connection.revoked || !connection.hasSecureIdentity}
                  onClick={() => void reconnectTrusted(connection)}
                >
                  <strong>{connection.hostLabel || "Polyth"}</strong>
                  <span>{trustedConnectionDetail(connection, connectionState?.activeConnectionId ?? null)}</span>
                </button>
                <button
                  type="button"
                  className="mobile-connect-forget"
                  disabled={busy}
                  onClick={() => void controller?.forget(connection.id)}
                >
                  Forget
                </button>
              </article>
            ))}
          </section>
        )}

        {ui.showSecurePairing && (
          <section className="mobile-connect-recents" aria-labelledby="mobile-pair-title">
            <h2 id="mobile-pair-title">Add another Polyth</h2>

            {!attempt && (
              <>
                <div className="mobile-connect-actions">
                  <button
                    type="button"
                    className="mobile-connect-primary"
                    disabled={busy}
                    onClick={() => void scanQr()}
                  >
                    Scan QR
                  </button>
                  <button
                    type="button"
                    className="mobile-connect-test"
                    disabled={busy || !discoveryAvailable}
                    onClick={() => void findNearby()}
                  >
                    Find nearby
                  </button>
                </div>

                <div className="mobile-connect-scan" hidden={!scanning}>
                  <div id="mobile-connect-scan-preview" className="mobile-connect-scan-preview" />
                  <div className="mobile-connect-scan-frame" aria-hidden="true" />
                  {cameraPermission === "denied" && (
                    <p className="mobile-connect-message">Camera permission is denied. Find nearby remains available.</p>
                  )}
                  <button type="button" className="mobile-connect-test" onClick={cancelScan}>
                    Cancel scan
                  </button>
                </div>

                {discovering && (
                  <section aria-labelledby="mobile-nearby-title">
                    <h2 id="mobile-nearby-title">Nearby</h2>
                    {discovered.length === 0 ? (
                      <p className="mobile-connect-message">
                        {connectionState?.phase === "discovery-empty"
                          ? "No Polyth server is advertising on this network yet."
                          : "Servers will appear here as they are found."}
                      </p>
                    ) : discovered.map((nearby) => {
                      const paired = trusted.find((connection) => connection.hostEndpointId === nearby.hostEndpointId);
                      return (
                        <article key={nearby.id}>
                          {paired ? (
                            <button
                              type="button"
                              className="mobile-connect-recent"
                              disabled={busy || paired.revoked || !paired.hasSecureIdentity}
                              onClick={() => void reconnectTrusted(paired)}
                            >
                              <strong>{paired.hostLabel || nearby.hostLabel}</strong>
                              <span>Nearby · already paired</span>
                            </button>
                          ) : (
                            <div className="mobile-connect-recent" aria-label={`${nearby.hostLabel}, nearby and not yet trusted`}>
                              <strong>{nearby.hostLabel}</strong>
                              <span>Nearby · pair securely before connecting</span>
                            </div>
                          )}
                        </article>
                      );
                    })}
                    <button type="button" className="mobile-connect-test" onClick={() => controller?.stopDiscovery()}>
                      Stop finding nearby
                    </button>
                  </section>
                )}

                {discoveryPermissionDenied && (
                  <p className="mobile-connect-message">
                    Local network access is disabled. You can still scan a QR code; enable local network access in system Settings to find nearby servers.
                  </p>
                )}
              </>
            )}

            {phrase && (
              <ol className="mobile-connect-phrase">
                {phrase.map((word) => <li key={word}>{word}</li>)}
              </ol>
            )}

            {attempt && (
              <div className="mobile-connect-actions">
                <button type="button" className="mobile-connect-primary" disabled={busy} onClick={() => void finishPairing()}>
                  {phrase?.length ? "The words match" : "Continue pairing"}
                </button>
                <button type="button" className="mobile-connect-test" disabled={busy} onClick={() => controller?.cancelPairing()}>
                  Cancel
                </button>
              </div>
            )}
          </section>
        )}

        {!ui.showSecurePairing && ui.preservePendingPair && (
          <p className="mobile-connect-message">Saved pairing request is ready when native Polyth Link is available.</p>
        )}

        {error && <div className="mobile-connect-message is-error" role="alert">{error}</div>}

        <button type="button" className="mobile-connect-forget" onClick={() => setDeveloper((value) => !value)}>
          {developer ? "Hide advanced options" : "Advanced"}
        </button>

        {developer && (
          <section className="mobile-connect-recents" aria-labelledby="mobile-legacy-title">
            <h2 id="mobile-legacy-title">Development connections</h2>
            <p>These paths are not production trust state.</p>
            {ui.showSecurePairing && (
              <>
                <label className="mobile-connect-field">
                  <span>Full pairing link</span>
                  <textarea
                    rows={3}
                    autoCapitalize="none"
                    autoCorrect="off"
                    placeholder="polyth://pair?v=1&t=…"
                    value={ticket}
                    onChange={(event) => {
                      setTicket(event.target.value);
                      if (isPairingDeepLink(event.target.value)) rememberPendingPairingLink(event.target.value);
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="mobile-connect-test"
                  disabled={busy || !isPairingLink(ticket)}
                  onClick={() => void startPair(ticket)}
                >
                  Use full pairing link
                </button>
              </>
            )}
            <label className="mobile-connect-field">
              <span>Insecure server address</span>
              <input
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://polyth.example.com"
              />
            </label>
            <button type="button" className="mobile-connect-test" disabled={busy} onClick={() => void legacyConnect()}>
              Connect insecurely
            </button>
            {recent.length > 0 && recent.map((host) => (
              <article key={host.url}>
                <button type="button" className="mobile-connect-recent" onClick={() => setUrl(host.url)}>
                  <strong>{connectionLabel(host)}</strong>
                  <span>Insecure development connection · {host.url}</span>
                </button>
                <button type="button" className="mobile-connect-forget" onClick={() => void forgetMobileHost(host.url).then((state) => setRecent(state.recent))}>
                  Remove
                </button>
              </article>
            ))}
          </section>
        )}
      </section>
    </main>
  );
}

export function renderMobileConnection(launch: ConnectLaunch): void {
  createRoot(document.getElementById("root") as HTMLElement).render(
    <ConnectionScreen launch={launch} />,
  );
}
