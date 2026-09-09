import { useEffect, useRef, useState } from "react";
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
} from "./polythLink.ts";
import {
  installNativePolythLink,
  nativePairingScannerAvailable,
  scanNativePairingQr,
} from "./nativePolythLink.ts";
import { isPairingLink, previewPairingLink } from "@polyth/pairing-qr";
import { bootstrapUrlWithNext, connectionUiState } from "./connectionUi.ts";
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

function trustedConnectionDetail(connection: ConnectionMetadata): string {
  if (connection.revoked) return "Revoked";
  if (!connection.hasSecureIdentity) return "Secure identity unavailable — pair again";
  if (connection.pairingState === "prepared") return "Pairing interrupted — verify host approval to recover";
  if (connection.lastTransport) return `Last connected via ${connection.lastTransport}`;
  return "Paired securely";
}

function ConnectionScreen({ launch }: { launch: ConnectLaunch }) {
  const nativeAvailable = nativeLinkAvailable();
  const initialPending = launch.pendingPair ?? peekPendingPairingLink();
  const ui = connectionUiState({ nativeAvailable, pendingPair: initialPending });
  const [ticket, setTicket] = useState(initialPending ?? "");
  const [phrase, setPhrase] = useState<string[] | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [trusted, setTrusted] = useState<ConnectionMetadata[]>([]);
  const [stage, setStage] = useState(ui.showUnavailableBanner
    ? "Polyth Link is unavailable in this build"
    : "Connect to your Polyth");
  const [url, setUrl] = useState(launch.preferred ?? launch.recent[0]?.url ?? "");
  const [recent, setRecent] = useState(launch.recent);
  const [error, setError] = useState(launch.error ?? "");
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [cameraPermission, setCameraPermission] = useState<"unknown" | "prompt" | "granted" | "denied">("unknown");
  const [developer, setDeveloper] = useState(false);
  const cancelledAttempts = useRef(new Set<string>());

  useEffect(() => {
    void SplashScreen.hide();
    return () => {
      (scanQr as { cleanup?: () => void }).cleanup?.();
    };
  }, []);

  useEffect(() => {
    if (!nativeAvailable) return;
    let cancelled = false;
    void polythLink().listConnections()
      .then((connections) => {
        if (!cancelled) setTrusted(connections);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { cancelled = true; };
  }, [nativeAvailable]);

  useEffect(() => {
    if (launch.pendingPair) rememberPendingPairingLink(launch.pendingPair);
    const off = subscribePendingPairingLink((value) => {
      setTicket(value);
    });
    return off;
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
    if (!nativeLinkAvailable()) {
      setError("Secure pairing is unavailable in this build.");
      return;
    }
    setError("");

    if (nativePairingScannerAvailable()) {
      try {
        const raw = await scanNativePairingQr();
        if (!raw) return;
        if (!isPairingLink(raw)) {
          setError("This QR code is not a Polyth pairing code.");
          return;
        }
        setCameraPermission("granted");
        rememberPendingPairingLink(raw);
        setTicket(raw);
        await startPair(raw);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        const denied = /denied|permission|not authorized/i.test(detail);
        setCameraPermission(denied ? "denied" : "prompt");
        setError(denied
          ? "Camera permission is required to scan. You can also paste the pairing code."
          : "Camera scanning failed. Paste the pairing code instead.");
      }
      return;
    }

    const Detector = (globalThis as {
      BarcodeDetector?: new (opts: { formats: string[] }) => {
        detect(source: HTMLVideoElement): Promise<Array<{ rawValue?: string }>>;
      };
    }).BarcodeDetector;
    if (!Detector) {
      setError("Camera scanning is unavailable here. Paste the pairing code instead.");
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
      setError("Camera preview is unavailable.");
      return;
    }
    mount.replaceChildren(video);
    setScanning(true);
    const cleanup = () => {
      cancelled = true;
      stream?.getTracks().forEach((item) => item.stop());
      video.remove();
      mount.replaceChildren();
      setScanning(false);
    };
    (scanQr as { cleanup?: () => void }).cleanup = cleanup;
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
          cleanup();
          await startPair(raw);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!cancelled) setError("No pairing QR was found. Paste the pairing code instead.");
    } catch (cause) {
      const denied = cause instanceof Error && /denied|permission|notallowed/i.test(cause.message);
      setCameraPermission(denied ? "denied" : "prompt");
      setError(denied
        ? "Camera permission is required to scan. You can also paste the pairing code."
        : "Camera scanning failed. Paste the pairing code instead.");
    } finally {
      cleanup();
    }
  };

  const startPair = async (raw: string) => {
    setError("");
    rememberPendingPairingLink(raw);
    if (!nativeLinkAvailable()) {
      setError("Secure pairing needs the native Polyth Link core. The pairing code is saved for retry.");
      setStage("Polyth Link is unavailable in this build");
      return;
    }
    const preview = previewPairingLink(raw);
    if (!preview.ok) {
      setError("This pairing code is not valid.");
      return;
    }
    setBusy(true);
    setStage("Connecting securely…");
    try {
      const attempt = await polythLink().beginPairing(raw, "This phone");
      setAttemptId(attempt.attemptId);
      setPhrase(attempt.safetyPhrase ?? null);
      setStage(attempt.safetyPhrase ? "Compare these words…" : "Verifying your Polyth…");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStage("Connect to your Polyth");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!attemptId) return;
    const currentAttempt = attemptId;
    setBusy(true);
    setError("");
    setStage("Waiting for approval on your computer…");
    try {
      const launched = await polythLink().confirmPairing(currentAttempt);
      cancelledAttempts.current.delete(currentAttempt);
      setStage("Connected");
      location.replace(bootstrapUrlWithNext(launched.bootstrapUrl, launch.deepLinkPath));
    } catch (cause) {
      if (!cancelledAttempts.current.delete(currentAttempt)) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setBusy(false);
    }
  };

  const cancelPair = () => {
    if (!attemptId) return;
    const currentAttempt = attemptId;
    cancelledAttempts.current.add(currentAttempt);
    void polythLink().cancelPairing(currentAttempt).catch((cause: unknown) => {
      cancelledAttempts.current.delete(currentAttempt);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
    setBusy(false);
    setPhrase(null);
    setAttemptId(null);
    setStage("Connect to your Polyth");
  };

  const reconnectTrusted = async (connection: ConnectionMetadata) => {
    if (connection.revoked || !connection.hasSecureIdentity) return;
    setBusy(true);
    setError("");
    setStage(connection.pairingState === "prepared"
      ? `Checking interrupted pairing with ${connection.hostLabel || "your Polyth"}…`
      : `Connecting to ${connection.hostLabel || "your Polyth"}…`);
    try {
      const launched = await polythLink().connect(connection.id);
      location.replace(bootstrapUrlWithNext(launched.bootstrapUrl, launch.deepLinkPath));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStage("Connect to your Polyth");
    } finally {
      setBusy(false);
    }
  };

  const forgetTrusted = async (connectionId: string) => {
    setBusy(true);
    setError("");
    try {
      await polythLink().forgetConnection(connectionId);
      setTrusted((connections) => connections.filter((connection) => connection.id !== connectionId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const legacyConnect = async () => {
    setBusy(true);
    const checked = await checkPolythHost(url);
    if (!checked.ok) {
      setError(checked.message);
      setBusy(false);
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
              This build does not include a native Polyth Link adapter, so QR pairing cannot run.
              You can still use an insecure development URL below.
            </p>
          ) : (
            <p>
              Pair once with a QR from Settings → Polyth Link. After approval, this device keeps its
              identity in the system secure store and can reconnect here without another QR.
            </p>
          )}
        </div>

        {nativeAvailable && trusted.length > 0 && (
          <section className="mobile-connect-recents" aria-labelledby="mobile-trusted-title">
            <h2 id="mobile-trusted-title">Polyth Link hosts</h2>
            {trusted.map((connection) => (
              <article key={connection.id}>
                <button
                  type="button"
                  className="mobile-connect-recent"
                  disabled={busy || connection.revoked || !connection.hasSecureIdentity}
                  onClick={() => void reconnectTrusted(connection)}
                >
                  <strong>{connection.hostLabel || "Polyth"}</strong>
                  <span>{trustedConnectionDetail(connection)}</span>
                </button>
                <button
                  type="button"
                  className="mobile-connect-forget"
                  disabled={busy}
                  onClick={() => void forgetTrusted(connection.id)}
                >
                  Forget
                </button>
              </article>
            ))}
          </section>
        )}

        {ui.showSecurePairing && !phrase && (
          <>
            <div className="mobile-connect-scan" hidden={!scanning}>
              <div id="mobile-connect-scan-preview" className="mobile-connect-scan-preview" />
              <div className="mobile-connect-scan-frame" aria-hidden="true" />
              {cameraPermission === "denied" && (
                <p className="mobile-connect-message">Camera permission is denied.</p>
              )}
              <button type="button" className="mobile-connect-test" onClick={() => {
                (scanQr as { cleanup?: () => void }).cleanup?.();
              }}>
                Cancel scan
              </button>
            </div>
            <label className="mobile-connect-field">
              <span>Pairing code</span>
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
          </>
        )}

        {!ui.showSecurePairing && ui.preservePendingPair && (
          <p className="mobile-connect-message">Saved pairing code: {ticket || initialPending}</p>
        )}

        {phrase && (
          <ol className="mobile-connect-phrase">
            {phrase.map((word) => <li key={word}>{word}</li>)}
          </ol>
        )}

        {error && <div className="mobile-connect-message is-error" role="alert">{error}</div>}

        {ui.showSecurePairing && (
          <div className="mobile-connect-actions">
            {!phrase && (
              <>
                <button
                  type="button"
                  className="mobile-connect-primary"
                  disabled={busy}
                  onClick={() => void scanQr()}
                >
                  Scan QR code
                </button>
                <button
                  type="button"
                  className="mobile-connect-test"
                  disabled={busy || !isPairingLink(ticket)}
                  onClick={() => void startPair(ticket)}
                >
                  {busy ? "Connecting…" : "Paste pairing code"}
                </button>
              </>
            )}
            {phrase && (
              <>
                <button type="button" className="mobile-connect-primary" disabled={busy} onClick={() => void confirm()}>
                  The words match
                </button>
                <button type="button" className="mobile-connect-test" disabled={!attemptId} onClick={cancelPair}>
                  Cancel
                </button>
              </>
            )}
          </div>
        )}

        <button type="button" className="mobile-connect-forget" onClick={() => setDeveloper((value) => !value)}>
          {developer ? "Hide insecure development connections" : "Advanced → Insecure development connection"}
        </button>

        {developer && (
          <section className="mobile-connect-recents" aria-labelledby="mobile-legacy-title">
            <h2 id="mobile-legacy-title">Insecure development connection</h2>
            <p>Raw URL mode is not Polyth Link. It is not a paired device and is not a secure connection.</p>
            <label className="mobile-connect-field">
              <span>Server address</span>
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
