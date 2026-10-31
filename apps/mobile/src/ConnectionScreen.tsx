import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@capacitor/app";
import {
  checkPolythHost,
  forgetMobileHost,
  isPairingDeepLink,
  mobileDeepLinkPath,
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
import { nativeTapFeedback } from "./haptics.ts";
import { isPairingLink } from "@polyth/pairing-qr";
import {
  autoReconnectCandidate,
  bootstrapUrlWithNext,
  connectionUiState,
  HUB_LAUNCH_PATIENCE_MS,
  HUB_LAUNCH_STATUS_AFTER_MS,
  hubPresentation,
  LAUNCH_STALL_MS,
  preferredTrustedConnection,
  shouldAutoReconnect,
} from "./connectionUi.ts";
import { raiseLaunchCurtain, releaseLaunchCurtain, type LaunchVeil } from "./launch.ts";
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

// Session storage of the bundled origin survives the trips to the loopback
// page and back, so it remembers the last automatic resume across bounces.
const LAST_RESUME_KEY = "polyth.mobile.last-resume-at";

function lastResumeAt(): number | null {
  try {
    const value = Number(sessionStorage.getItem(LAST_RESUME_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function rememberResume(at: number): void {
  try { sessionStorage.setItem(LAST_RESUME_KEY, String(at)); } catch { /* best effort */ }
}

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
  if (connection.pairingState === "prepared") return "Pairing interrupted — resume pairing";
  return connection.lastTransport === "relay" ? "Ready · via relay" : "Ready";
}

function connectionStatusTone(connection: ConnectionMetadata, activeConnectionId: string | null): string {
  if (connection.id === activeConnectionId) return "is-connected";
  if (connection.revoked || connection.pairingState === "revoked") return "is-danger";
  if (!connection.hasSecureIdentity || connection.pairingState === "prepared") return "is-warning";
  return "is-ready";
}

type RecoveryPresentation = {
  tone: "warning" | "danger";
  body: string;
  action: "retry" | "scan" | null;
  actionLabel?: string;
};

function recoveryPresentation(phase?: ConnectionControllerState["phase"]): RecoveryPresentation | null {
  switch (phase) {
    case "offline":
      return {
        tone: "warning",
        body: "This phone is offline.",
        action: "retry",
        actionLabel: "Try again",
      };
    case "unreachable":
      return {
        tone: "warning",
        body: "Not reachable right now.",
        action: "retry",
        actionLabel: "Reconnect",
      };
    case "revoked":
      return {
        tone: "danger",
        body: "Access for this phone was revoked. Pair it again from a Polyth computer you trust.",
        action: "scan",
        actionLabel: "Pair again",
      };
    case "identity-mismatch":
      return {
        tone: "danger",
        body: "The saved server identity no longer matches. Do not reuse the old trust relationship; pair again.",
        action: "scan",
        actionLabel: "Scan a new QR",
      };
    case "incompatible":
      return {
        tone: "warning",
        body: "This server and mobile app do not share a compatible Polyth Link protocol version.",
        action: null,
      };
    case "pairing-expired":
      return {
        tone: "warning",
        body: "Pairing invitations are intentionally short-lived. Generate a new QR on the computer.",
        action: "scan",
        actionLabel: "Scan new QR",
      };
    case "pairing-rejected":
      return {
        tone: "warning",
        body: "The computer did not approve this pairing request. You can safely try again.",
        action: "scan",
        actionLabel: "Try another QR",
      };
    default:
      return null;
  }
}

function connectionDescription(
  state: ConnectionControllerState | null,
  nativeAvailable: boolean,
  trustedLoaded: boolean,
  trustedCount: number,
): string {
  if (!nativeAvailable) {
    return "Secure Polyth Link is not included in this build. Development server URLs remain available under Advanced.";
  }
  if (!trustedLoaded) return "Checking secure connections already stored on this device.";
  switch (state?.phase) {
    case "discovering":
    case "discovery-results":
    case "discovery-empty":
      return "Nearby discovery never grants access by itself. Choose a server and confirm it with the code shown on the computer.";
    case "discovery-permission-required":
      return "QR pairing still works. Local network access is only needed to discover nearby servers.";
    case "numeric-code-entry":
    case "numeric-code-validating":
    case "numeric-code-rate-limited":
      return "Enter the six-digit code shown by this Polyth. It authenticates only this pairing attempt.";
    case "safety-confirmation":
      return "Your computer shows four words too. They must be the same.";
    case "awaiting-host-approval":
      return "Approve this phone on the Polyth computer. Nothing is trusted until both sides confirm.";
    case "switching":
    case "reconnecting":
    case "recovering":
      return "Restoring the secure local Polyth Link connection.";
    case "offline":
      return "Reconnect this phone to the internet, then tap Try again.";
    case "unreachable":
      return "Make sure the computer is on and Polyth is running, then tap Reconnect.";
    case "revoked":
    case "identity-mismatch":
    case "incompatible":
    case "pairing-expired":
    case "pairing-rejected":
      return "The secure connection needs your attention.";
    case "connected":
      return "Secure connection established.";
    default:
      return trustedCount > 0
        ? "Tap a computer to open it."
        : "Open Polyth Link on your computer and scan the code. You only do this once.";
  }
}

function connectionHeading(state: ConnectionControllerState | null, nativeAvailable: boolean): string {
  if (!nativeAvailable) return "Polyth Link is unavailable in this build";
  const target = state?.trusted.find((connection) => connection.id === state.targetConnectionId);
  const targetLabel = target?.hostLabel || "your computer";
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
    case "numeric-code-entry":
      return `Enter the code from ${state.numericTarget?.hostLabel || "your Polyth"}`;
    case "numeric-code-validating":
      return "Checking pairing code securely…";
    case "numeric-code-rate-limited":
      return "Too many pairing attempts";
    case "scanning-qr":
      return "Scan pairing QR";
    case "validating-pairing":
    case "preparing-pairing":
      return "Connecting securely…";
    case "pairing":
      return "Ready to pair";
    case "safety-confirmation":
      return "Check the words";
    case "awaiting-host-approval":
      return "Waiting for approval on your computer…";
    case "committing":
      return "Saving trusted connection…";
    case "switching":
      return `Switching to ${targetLabel}…`;
    case "reconnecting":
      return `Connecting to ${targetLabel}…`;
    case "recovering":
      return `Resuming pairing with ${targetLabel}…`;
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

function ConnectionScreen({ launch, veil }: { launch: ConnectLaunch; veil: LaunchVeil | null }) {
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
  const [trustedLoaded, setTrustedLoaded] = useState(!nativeAvailable);
  const [ticket, setTicket] = useState(initialPending ?? "");
  const [numericCode, setNumericCode] = useState("");
  const [preferNumericDiscovery, setPreferNumericDiscovery] = useState(false);
  const [url, setUrl] = useState(launch.preferred ?? launch.recent[0]?.url ?? "");
  const [recent, setRecent] = useState(launch.recent);
  const [cameraPermission, setCameraPermission] = useState<"unknown" | "prompt" | "granted" | "denied">("unknown");
  const [developer, setDeveloper] = useState(false);
  const [legacyBusy, setLegacyBusy] = useState(false);
  const [legacyError, setLegacyError] = useState("");
  const [retryConnectionId, setRetryConnectionId] = useState<string | null>(null);
  const scanCleanup = useRef<(() => void) | null>(null);
  const scanIntent = useRef<number | null>(null);
  const autoReconnectStarted = useRef(false);
  const pendingPushConnectStarted = useRef(false);
  const switchConnectStarted = useRef(false);
  const pairSectionRef = useRef<HTMLElement | null>(null);
  // Read once: an automatic resume records itself, and the hub must keep
  // treating the open it started as automatic.
  const [initialLastResumeAt] = useState(lastResumeAt);
  const brandMarkRef = useRef<HTMLImageElement | null>(null);
  const mountedAt = useRef(Date.now());
  const [hubShown, setHubShown] = useState(() => !veil?.active);
  const hubShownRef = useRef(hubShown);
  const [patienceSpent, setPatienceSpent] = useState(false);
  const veilWaiting = useRef(false);

  const trusted = connectionState?.trusted ?? [];
  const discovered = connectionState?.discovered ?? [];
  const numericTarget = connectionState?.numericTarget ?? null;
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
  const numericCodeEntry = connectionState?.phase === "numeric-code-entry"
    || connectionState?.phase === "numeric-code-validating"
    || connectionState?.phase === "numeric-code-rate-limited";
  const discoveryPermissionDenied = connectionState?.phase === "discovery-permission-required";
  const normalizedNumericCode = numericCode.replace(/\s/gu, "");
  const numericCodeValid = /^\d{6}$/u.test(normalizedNumericCode);
  const numericDigits = Array.from({ length: 6 }, (_, index) => normalizedNumericCode[index] ?? "");
  const rawError = connectionState?.error || legacyError || (!nativeAvailable ? launch.error ?? "" : "");
  const error = connectionState?.phase === "numeric-code-rate-limited"
    ? "Too many attempts. Regenerate the code on your computer, or try again shortly."
    : rawError;
  const recovery = recoveryPresentation(connectionState?.phase);
  const preferredTrusted = preferredTrustedConnection(trusted);
  const retryConnection = trusted.find((connection) => connection.id === retryConnectionId) ?? preferredTrusted;
  // Network-type failures belong to one server: show them on its card instead
  // of a banner that pushes the layout around.
  const inlineRecovery = recovery?.action === "retry" && retryConnection ? recovery : null;
  const working = connectionState ? connectionPhaseBusy(connectionState.phase) : false;
  const stage = !trustedLoaded && nativeAvailable
    ? "Finding your Polyth…"
    : connectionState?.phase === "idle"
      ? trusted.length > 0 ? "Welcome back" : "Connect to your computer"
      : connectionHeading(connectionState, nativeAvailable);
  const description = connectionDescription(connectionState, nativeAvailable, trustedLoaded, trusted.length);
  const autoCandidate = trustedLoaded
    ? autoReconnectCandidate(trusted, connectionState?.activeConnectionId ?? null, launch.resume)
    : undefined;
  const autoReconnectWanted = shouldAutoReconnect({
    selectServer: launch.selectServer,
    pendingPair: initialPending,
    hasPendingPush: Boolean(launch.pendingPushOpen),
    deepLinkPath: launch.deepLinkPath,
    resume: launch.resume,
    lastResumeAt: initialLastResumeAt,
  });
  const pushTarget = launch.pendingPushOpen
    ? trusted.find((connection) => connection.id === launch.pendingPushOpen?.connectionId)
    : undefined;
  // The server picked from the native server menu opens behind the veil, as
  // a warm start does; one that cannot open leaves the hub showing it.
  const switchTarget = launch.switchTo
    ? trusted.find((connection) =>
        connection.id === launch.switchTo && !connection.revoked && connection.hasSecureIdentity)
    : undefined;
  const presentation = hubPresentation({
    veilActive: Boolean(veil?.active),
    nativeAvailable,
    trustedLoaded,
    phase: connectionState?.phase ?? null,
    error: connectionState?.error ?? null,
    autoOpening: autoReconnectStarted.current
      || pendingPushConnectStarted.current
      || Boolean(pushTarget)
      || switchConnectStarted.current
      || Boolean(switchTarget)
      || (autoReconnectWanted && Boolean(autoCandidate)),
    hubShown,
    elapsedMs: patienceSpent ? HUB_LAUNCH_PATIENCE_MS : 0,
  });
  const presented = hubShown || presentation === "hub";
  const openingTarget = trusted.find((connection) =>
    connection.id === (connectionState?.targetConnectionId ?? retryConnectionId)) ?? pushTarget ?? switchTarget ?? autoCandidate;
  const launchStatus = !trustedLoaded
    ? "Finding your Polyth…"
    : openingTarget
      ? `Connecting to ${openingTarget.hostLabel || "your computer"}…`
      : null;

  const stopCamera = () => {
    scanCleanup.current?.();
    scanCleanup.current = null;
  };

  const launchWatchdog = useRef<number | null>(null);
  const openLaunch = (next: ProxyLaunch) => {
    // The Link bootstrap accepts only a validated `next` target and discards
    // every outer query key. A push tap wins over an unrelated old deep link.
    const pending = launch.pendingPushOpen;
    const nextPath = pending && next.connectionId === pending.connectionId
      ? `/?nativePushOpen=${encodeURIComponent(pending.notificationId)}`
      : launch.deepLinkPath;
    const target = bootstrapUrlWithNext(next.bootstrapUrl, nextPath);
    void (async () => {
      // Shown controls give way to the launch veil (the brand mark
      // flies back to the centre) and the native curtain covers the page
      // swap, so the bootstrap page and the workspace's first frames are never
      // seen; the workspace lifts the veil once it has settled.
      if (veil && hubShownRef.current) await veil.restore({ from: brandMarkRef.current }).catch(() => undefined);
      await raiseLaunchCurtain({ fadeInMs: veilWaiting.current ? 180 : 0 });
      // WKWebView drops a navigation that fails before the page commits (a
      // loopback port nobody serves) without any event: this page simply
      // stays. Without the watchdog the hub kept saying "Connected" and every
      // tap replayed the same dead launch.
      if (launchWatchdog.current !== null) window.clearTimeout(launchWatchdog.current);
      launchWatchdog.current = window.setTimeout(() => {
        launchWatchdog.current = null;
        controller?.launchStalled(next.connectionId);
        // Nothing came to lift the cover: show the hub and what went wrong.
        void releaseLaunchCurtain();
        void veil?.lift({ into: brandMarkRef.current });
        setHubShown(true);
      }, LAUNCH_STALL_MS);
      location.replace(target);
    })();
  };

  useLayoutEffect(() => {
    if (!presented) return;
    hubShownRef.current = true;
    if (!hubShown) setHubShown(true);
    if (!veil?.active) return;
    // The user has something to do or read here: the launch screen clears to
    // the hub while its mark flies into the brand mark it becomes.
    veilWaiting.current = false;
    void releaseLaunchCurtain();
    void veil.lift({ into: brandMarkRef.current });
  }, [presented]);

  useEffect(() => {
    if (presented) return;
    const timer = window.setTimeout(
      () => setPatienceSpent(true),
      Math.max(0, HUB_LAUNCH_PATIENCE_MS - (Date.now() - mountedAt.current)),
    );
    return () => window.clearTimeout(timer);
  }, [presented]);

  useEffect(() => {
    if (presented || !veil?.active || !launchStatus) return;
    const timer = window.setTimeout(() => {
      veilWaiting.current = true;
      veil.wait(launchStatus);
    }, Math.max(0, HUB_LAUNCH_STATUS_AFTER_MS - (Date.now() - mountedAt.current)));
    return () => window.clearTimeout(timer);
  }, [presented, launchStatus]);

  useEffect(() => {
    const leaving = () => {
      if (launchWatchdog.current !== null) window.clearTimeout(launchWatchdog.current);
      launchWatchdog.current = null;
    };
    window.addEventListener("pagehide", leaving);
    return () => {
      window.removeEventListener("pagehide", leaving);
      leaving();
    };
  }, []);

  const finishPairing = async () => {
    if (!controller) return;
    const launched = await controller.confirmPairing();
    if (launched) openLaunch(launched);
  };

  const startPair = async (raw: string) => {
    stopCamera();
    setPreferNumericDiscovery(false);
    rememberPendingPairingLink(raw);
    if (!controller) return;
    const pairing = await controller.beginPairing(raw, "This phone");
    if (pairing && !pairing.safetyPhrase?.length) await finishPairing();
  };

  useEffect(() => {
    if (!controller) return;
    setTrustedLoaded(false);
    const unsubscribe = controller.subscribe(setConnectionState);
    void controller.loadTrustedConnections().finally(() => setTrustedLoaded(true));
    return () => {
      stopCamera();
      unsubscribe();
      controller.dispose();
    };
  }, [controller]);

  useEffect(() => {
    const pending = launch.pendingPushOpen;
    if (!controller || !pending || pendingPushConnectStarted.current || connectionState?.phase !== "idle") return;
    if (!connectionState.trusted.some((connection) => connection.id === pending.connectionId)) return;
    pendingPushConnectStarted.current = true;
    void controller.connect(pending.connectionId).then((next) => {
      if (next) openLaunch(next);
    });
  }, [controller, connectionState, launch.pendingPushOpen]);

  useEffect(() => {
    if (launch.pendingPair) rememberPendingPairingLink(launch.pendingPair);
    return subscribePendingPairingLink((value) => {
      setTicket(value);
    });
  }, [launch.pendingPair]);

  useEffect(() => {
    let handle: { remove: () => Promise<void> } | undefined;
    void App.addListener("appUrlOpen", ({ url: opened }) => {
      if (isPairingDeepLink(opened)) {
        rememberPendingPairingLink(opened);
        setTicket(opened);
        return;
      }
      if (mobileDeepLinkPath(opened)) {
        // Native capture retains this URL until the bundled origin consumes it.
        // Reload so prepareMobileLaunch() can attach the path to the server the
        // user explicitly chooses instead of the previously active server.
        // The veil comes back first: the reloaded hub starts behind it.
        void (veil?.restore({ from: hubShownRef.current ? brandMarkRef.current : null }) ?? Promise.resolve())
          .catch(() => undefined)
          .finally(() => location.reload());
      }
    }).then((next) => { handle = next; });
    return () => { void handle?.remove(); };
  }, []);

  useEffect(() => {
    if (!ui.autoStartPairing || !initialPending) return;
    void startPair(initialPending);
  }, []);

  const scanQr = async () => {
    if (!controller) return;
    setPreferNumericDiscovery(false);
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
            ? "Camera permission is required to scan. Find nearby or enter the code instead."
            : "Camera scanning failed. Find nearby or enter the code instead."),
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
      controller.failQrScan(scanEpoch, new Error("Camera scanning is unavailable here. Find nearby or enter the code instead."));
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
          ? "Camera permission is required to scan. Find nearby or enter the code instead."
          : "Camera scanning failed. Find nearby or enter the code instead."),
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

  const findNearby = async (forCode = false) => {
    if (!controller || !discoveryAvailable) return;
    setPreferNumericDiscovery(forCode);
    stopCamera();
    await controller.startDiscovery(startNativeDiscovery);
  };

  const chooseNumericTarget = (target: NonNullable<ConnectionControllerState["numericTarget"]>) => {
    if (!controller) return;
    setNumericCode("");
    controller.startNumericCodeEntry(target);
  };

  const submitNumericCode = async () => {
    if (!controller || !numericCodeValid) return;
    const pairing = await controller.submitNumericCode(normalizedNumericCode, "This phone");
    if (pairing && !pairing.safetyPhrase?.length) await finishPairing();
  };

  useEffect(() => {
    if (!controller || !numericCodeValid || connectionState?.phase !== "numeric-code-entry") return;
    const timer = window.setTimeout(() => { void submitNumericCode(); }, 180);
    return () => window.clearTimeout(timer);
  }, [controller, connectionState?.phase, normalizedNumericCode, numericCodeValid]);

  const cancelNumericCode = () => {
    setNumericCode("");
    controller?.cancelNumericCodeEntry();
  };

  const reconnectTrusted = async (connection: ConnectionMetadata) => {
    if (!controller || connection.revoked || !connection.hasSecureIdentity) return;
    setRetryConnectionId(connection.id);
    stopCamera();
    const launched = connection.pairingState === "prepared"
      ? await controller.recoverPrepared(connection.id)
      : await controller.connect(connection.id);
    if (launched) openLaunch(launched);
  };

  useEffect(() => {
    if (!controller || !trustedLoaded || !switchTarget || switchConnectStarted.current) return;
    if (connectionState?.phase !== "idle") return;
    switchConnectStarted.current = true;
    void reconnectTrusted(switchTarget);
  }, [controller, trustedLoaded, connectionState?.phase, switchTarget]);

  // "Add server" from the server menu: the hub comes up on its pairing card.
  useEffect(() => {
    if (!launch.addServer || !presented || !trustedLoaded) return;
    pairSectionRef.current?.scrollIntoView({ block: "center" });
  }, [launch.addServer, presented, trustedLoaded]);

  useEffect(() => {
    if (
      !controller
      || !trustedLoaded
      || autoReconnectStarted.current
      || !shouldAutoReconnect({
        selectServer: launch.selectServer,
        pendingPair: initialPending,
        hasPendingPush: Boolean(launch.pendingPushOpen),
        deepLinkPath: launch.deepLinkPath,
        resume: launch.resume,
        lastResumeAt: initialLastResumeAt,
      })
      || connectionState?.phase !== "idle"
    ) return;
    const candidate = autoReconnectCandidate(
      trusted,
      connectionState.activeConnectionId,
      launch.resume,
    );
    if (!candidate) return;
    autoReconnectStarted.current = true;
    if (launch.resume) rememberResume(Date.now());
    setRetryConnectionId(candidate.id);
    void controller.connect(candidate.id).then((next) => {
      if (next) openLaunch(next);
    });
  }, [
    controller,
    trustedLoaded,
    connectionState?.phase,
    trusted,
    launch.selectServer,
    launch.pendingPushOpen,
    launch.deepLinkPath,
    launch.resume,
    initialPending,
  ]);

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
    await nativeTapFeedback();
    if (veil) await veil.restore({ from: brandMarkRef.current }).catch(() => undefined);
    await raiseLaunchCurtain();
    navigateToMobileHost(host, launch.deepLinkPath);
  };

  return (
    <main
      className="mobile-connect"
      data-phase={connectionState?.phase ?? "idle"}
      data-presentation={presented ? "hub" : "launch"}
    >
      <section
        className="mobile-connect-scanner"
        hidden={!scanning}
        aria-hidden={!scanning}
        aria-label="Pairing QR scanner"
      >
        <header className="mobile-connect-scanner-header">
          <button type="button" className="mobile-connect-scanner-cancel" onClick={cancelScan}>
            Cancel
          </button>
          <div>
            <strong>Scan pairing QR</strong>
            <span>Point at the QR shown by your Polyth computer</span>
          </div>
          <span className="mobile-connect-scanner-secure" aria-hidden="true">Secure</span>
        </header>
        <div className="mobile-connect-scanner-camera">
          <div id="mobile-connect-scan-preview" className="mobile-connect-scan-preview" />
          <div className="mobile-connect-scan-dim" aria-hidden="true" />
          <div className="mobile-connect-scan-frame" aria-hidden="true" />
        </div>
        {cameraPermission === "denied" && (
          <p className="mobile-connect-scanner-message" role="alert">
            Camera access is off. Allow it in Settings to scan.
          </p>
        )}
      </section>

      <section className="mobile-connect-shell" aria-labelledby="mobile-connect-title">
        <header className="mobile-connect-brandbar">
          <div className="mobile-connect-brand-lockup">
            <div className="mobile-connect-brand" aria-hidden="true">
              <img
                ref={brandMarkRef}
                className="mobile-connect-brand-mark"
                src="/icon-512.png"
                alt=""
                draggable={false}
              />
            </div>
            <div>
              <strong>Polyth</strong>
              <span>Mobile</span>
            </div>
          </div>
          <span className={`mobile-connect-security ${nativeAvailable ? "is-secure" : "is-unavailable"}`}>
            {nativeAvailable ? "Secure Link" : "Development"}
          </span>
        </header>

        <section className="mobile-connect-hero" aria-live="polite" aria-busy={working}>
          <div className={`mobile-connect-hero-signal ${working ? "is-working" : ""}`} aria-hidden="true">
            <span />
          </div>
          <h1 id="mobile-connect-title">{stage}</h1>
          <p>{description}</p>
        </section>

        {nativeAvailable && trustedLoaded && trusted.length > 0 && (
          <section className="mobile-connect-section" aria-labelledby="mobile-trusted-title">
            <div className="mobile-connect-section-heading">
              <div>
                <h2 id="mobile-trusted-title">Your computers</h2>
              </div>
            </div>
            <div className="mobile-connect-server-list">
              {trusted.map((connection) => {
                const failed = inlineRecovery && connection.id === retryConnection?.id ? inlineRecovery : null;
                const connecting = (connectionState?.phase === "reconnecting" || connectionState?.phase === "switching" || connectionState?.phase === "recovering")
                  && connection.id === (connectionState.targetConnectionId ?? retryConnectionId);
                return (
                <article className="mobile-connect-server-row" key={connection.id}>
                  <button
                    type="button"
                    className={`mobile-connect-server${failed ? " is-failed" : ""}`}
                    disabled={busy || connection.revoked || !connection.hasSecureIdentity}
                    onClick={() => void reconnectTrusted(connection)}
                  >
                    <span
                      className={`mobile-connect-server-dot ${failed ? "is-warning" : connecting ? "is-working" : connectionStatusTone(connection, connectionState?.activeConnectionId ?? null)}`}
                      aria-hidden="true"
                    />
                    <span className="mobile-connect-server-copy">
                      <strong>{connection.hostLabel || "Polyth"}</strong>
                      <span>{failed ? failed.body : connecting ? "Connecting…" : trustedConnectionDetail(connection, connectionState?.activeConnectionId ?? null)}</span>
                    </span>
                    {failed
                      ? <span className="mobile-connect-server-retry">{failed.actionLabel ?? "Try again"}</span>
                      : <span className="mobile-connect-server-chevron" aria-hidden="true">›</span>}
                  </button>
                  <details className="mobile-connect-server-menu">
                    <summary aria-label={`More options for ${connection.hostLabel || "Polyth"}`}>•••</summary>
                    <div>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void controller?.forget(connection.id)}
                      >
                        Forget server
                      </button>
                    </div>
                  </details>
                </article>
                );
              })}
            </div>
          </section>
        )}

        {recovery && !inlineRecovery && (
          <section className={`mobile-connect-recovery is-${recovery.tone}`} role={recovery.tone === "danger" ? "alert" : "status"}>
            <p>{recovery.body}</p>
            {recovery.action === "scan" && nativeAvailable && (
              <button
                type="button"
                className="mobile-connect-secondary"
                disabled={busy}
                onClick={() => void scanQr()}
              >
                {recovery.actionLabel ?? "Scan QR"}
              </button>
            )}
          </section>
        )}

        {ui.showSecurePairing && trustedLoaded && (
          <section
            ref={pairSectionRef}
            className={`mobile-connect-pair ${trusted.length > 0 && !launch.addServer ? "is-secondary" : ""}`}
            aria-labelledby="mobile-pair-title"
          >
            {!attempt && !numericCodeEntry && !discovering && (
              <>
                <div className="mobile-connect-section-heading">
                  <div>
                    <h2 id="mobile-pair-title" className={trusted.length > 0 ? "" : "mobile-connect-visually-hidden"}>
                      {trusted.length > 0 ? "Add another computer" : "Pair this phone"}
                    </h2>
                  </div>
                </div>
                <div className="mobile-connect-pair-actions">
                  <button
                    type="button"
                    className={trusted.length > 0 && !launch.addServer ? "mobile-connect-secondary" : "mobile-connect-primary"}
                    disabled={busy}
                    onClick={() => void scanQr()}
                  >
                    Scan QR code
                  </button>
                  {discoveryAvailable && (
                    <div className="mobile-connect-pair-secondary">
                      <span>On the same Wi-Fi?</span>
                      <button
                        type="button"
                        className="mobile-connect-quiet-action"
                        disabled={busy}
                        onClick={() => void findNearby(false)}
                      >
                        Find nearby
                      </button>
                      <button
                        type="button"
                        className="mobile-connect-quiet-action"
                        disabled={busy}
                        onClick={() => void findNearby(true)}
                      >
                        Enter code
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}

            {discovering && (
              <section className="mobile-connect-nearby" aria-labelledby="mobile-nearby-title">
                <div className="mobile-connect-section-heading is-inline">
                  <div>
                    <h2 id="mobile-nearby-title">Nearby Polyth</h2>
                    <p>{preferNumericDiscovery ? "Choose the computer showing your six-digit code." : "Choose a server to pair securely."}</p>
                  </div>
                  <button type="button" className="mobile-connect-quiet-action" onClick={() => controller?.stopDiscovery()}>
                    Done
                  </button>
                </div>
                {discovered.length === 0 ? (
                  <div className="mobile-connect-empty" role="status">
                    <span className="mobile-connect-search-pulse" aria-hidden="true" />
                    <strong>{connectionState?.phase === "discovery-empty" ? "No nearby Polyth found" : "Looking nearby…"}</strong>
                    <span>
                      {connectionState?.phase === "discovery-empty"
                        ? "Make sure the computer and phone are on the same local network."
                        : "Servers appear here as they are discovered."}
                    </span>
                  </div>
                ) : (
                  <div className="mobile-connect-server-list">
                    {discovered.map((nearby) => {
                      const paired = trusted.find((connection) => connection.hostEndpointId === nearby.hostEndpointId);
                      return (
                        <button
                          type="button"
                          className="mobile-connect-server"
                          key={nearby.id}
                          disabled={busy || Boolean(paired?.revoked) || Boolean(paired && !paired.hasSecureIdentity)}
                          onClick={() => paired ? void reconnectTrusted(paired) : chooseNumericTarget(nearby)}
                        >
                          <span className={`mobile-connect-server-dot ${paired ? "is-ready" : "is-nearby"}`} aria-hidden="true" />
                          <span className="mobile-connect-server-copy">
                            <strong>{paired?.hostLabel || nearby.hostLabel}</strong>
                            <span>{paired ? "Nearby · already paired" : "Nearby · confirm with six-digit code"}</span>
                          </span>
                          <span className="mobile-connect-server-chevron" aria-hidden="true">›</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            )}

            {discoveryPermissionDenied && (
              <section className="mobile-connect-recovery is-warning" role="status">
                <p>
                  Local network access is disabled. QR pairing still works; enable local network access in system Settings to find nearby servers.
                </p>
              </section>
            )}

            {!attempt && numericCodeEntry && numericTarget && (
              <section className="mobile-connect-code" aria-labelledby="mobile-code-title">
                <div className="mobile-connect-section-heading">
                  <div>
                    <span className="mobile-connect-eyebrow">Nearby pairing</span>
                    <h2 id="mobile-code-title">{numericTarget.hostLabel}</h2>
                    <p>Enter the six digits shown on this Polyth computer.</p>
                  </div>
                </div>
                <label className="mobile-connect-code-field">
                  <span>Pairing code</span>
                  <div className="mobile-connect-code-control">
                    <input
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      autoCapitalize="none"
                      autoCorrect="off"
                      maxLength={6}
                      aria-label="Six-digit pairing code"
                      value={normalizedNumericCode}
                      onChange={(event) => setNumericCode(event.target.value.replace(/\D/gu, "").slice(0, 6))}
                    />
                    <div className="mobile-connect-code-slots" aria-hidden="true">
                      {numericDigits.map((digit, index) => (
                        <span className={digit ? "is-filled" : ""} key={index}>{digit}</span>
                      ))}
                    </div>
                  </div>
                </label>
                <p className="mobile-connect-code-hint">
                  Pairing starts automatically when all six digits are entered.
                </p>
                <div className="mobile-connect-inline-actions">
                  <button
                    type="button"
                    className="mobile-connect-primary is-compact"
                    disabled={busy || !numericCodeValid || connectionState?.phase === "numeric-code-rate-limited"}
                    onClick={() => void submitNumericCode()}
                  >
                    Pair securely
                  </button>
                  <button type="button" className="mobile-connect-quiet-action" disabled={busy} onClick={cancelNumericCode}>
                    Cancel
                  </button>
                </div>
              </section>
            )}

            {attempt && connectionState?.phase !== "awaiting-host-approval" && (
              <section className="mobile-connect-verify" aria-labelledby="mobile-verify-title">
                <span className="mobile-connect-eyebrow">Security check</span>
                <h2 id="mobile-verify-title">{phrase?.length ? "Do these words match?" : "Ready to pair"}</h2>
                {phrase?.length ? (
                  <>
                    <ol className="mobile-connect-phrase">
                      {phrase.map((word) => <li key={word}>{word}</li>)}
                    </ol>
                    <p>If any word is different, tap Cancel.</p>
                  </>
                ) : (
                  <p>The secure identity is ready. Continue only if you started this pairing.</p>
                )}
                <div className="mobile-connect-inline-actions">
                  <button type="button" className="mobile-connect-primary is-compact" disabled={busy} onClick={() => void finishPairing()}>
                    {phrase?.length ? "The words match" : "Continue pairing"}
                  </button>
                  <button type="button" className="mobile-connect-quiet-action" disabled={busy} onClick={() => controller?.cancelPairing()}>
                    Cancel
                  </button>
                </div>
              </section>
            )}

            {attempt && connectionState?.phase === "awaiting-host-approval" && (
              <section className="mobile-connect-approval" role="status" aria-live="polite">
                <div className="mobile-connect-approval-orb" aria-hidden="true"><span /></div>
                <strong>Waiting for approval</strong>
                <p>Approve “This phone” on the Polyth computer to finish pairing.</p>
                <button type="button" className="mobile-connect-quiet-action" onClick={() => controller?.cancelPairing()}>
                  Cancel pairing
                </button>
              </section>
            )}
          </section>
        )}

        {!ui.showSecurePairing && ui.preservePendingPair && (
          <p className="mobile-connect-message" role="status">
            This pairing request is ready, but this build has no native secure Polyth Link core.
          </p>
        )}

        {error && !recovery && (
          <div className="mobile-connect-message is-error" role="alert">{error}</div>
        )}

        <button
          type="button"
          className="mobile-connect-advanced-toggle"
          aria-expanded={developer}
          onClick={() => setDeveloper((value) => !value)}
        >
          {developer ? "Hide advanced" : "Advanced"}
        </button>

        {developer && (
          <section className="mobile-connect-advanced" aria-labelledby="mobile-legacy-title">
            <div className="mobile-connect-section-heading">
              <div>
                <h2 id="mobile-legacy-title">Development connections</h2>
                <p>Manual URLs are intentionally separate from trusted Polyth Link connections.</p>
              </div>
            </div>
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
                  className="mobile-connect-secondary"
                  disabled={busy || !isPairingLink(ticket)}
                  onClick={() => void startPair(ticket)}
                >
                  Use pairing link
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
            <button type="button" className="mobile-connect-secondary" disabled={busy} onClick={() => void legacyConnect()}>
              Connect insecurely
            </button>
            {recent.length > 0 && (
              <div className="mobile-connect-dev-recents">
                {recent.map((host) => (
                  <article key={host.url}>
                    <button type="button" onClick={() => setUrl(host.url)}>
                      <strong>{connectionLabel(host)}</strong>
                      <span>{host.url}</span>
                    </button>
                    <button
                      type="button"
                      className="mobile-connect-quiet-action"
                      onClick={() => void forgetMobileHost(host.url).then((state) => setRecent(state.recent))}
                    >
                      Remove
                    </button>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {nativeAvailable && (
          <footer className="mobile-connect-trust-note">
            Private device keys stay in this phone's secure storage.
          </footer>
        )}
      </section>
    </main>
  );
}

/** The hub's short-screen layout (styles.css) as a body attribute. This
 *  stylesheet ships inside the web app's main stylesheet, where a height
 *  media query flips with every phone keyboard and makes the engine rebuild
 *  every rule set and re-lay the whole workspace; evaluated here it styles the
 *  hub alone. */
function watchShortHub(): void {
  if (typeof window.matchMedia !== "function") return;
  const short = window.matchMedia("(max-height: 620px)");
  const publish = () => {
    if (short.matches) document.body.dataset.connectShort = "true";
    else delete document.body.dataset.connectShort;
  };
  short.addEventListener?.("change", publish);
  publish();
}

export function renderMobileConnection(
  launch: ConnectLaunch,
  options: { veil?: LaunchVeil | null } = {},
): void {
  watchShortHub();
  createRoot(document.getElementById("root") as HTMLElement).render(
    <ConnectionScreen launch={launch} veil={options.veil ?? null} />,
  );
}
