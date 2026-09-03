import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { SplashScreen } from "@capacitor/splash-screen";
import {
  checkPolythHost,
  forgetMobileHost,
  navigateToMobileHost,
  rememberMobileHost,
  type MobileHost,
  type MobileLaunch,
} from "./runtime.ts";
import { polythLink } from "./polythLink.ts";
import { isPairingLink, previewPairingLink } from "@polyth/pairing-qr";
import "./styles.css";

type ConnectLaunch = Extract<MobileLaunch, { kind: "connect" }>;

function connectionLabel(host: MobileHost): string {
  try {
    return new URL(host.url).host;
  } catch {
    return host.url;
  }
}

function ConnectionScreen({ launch }: { launch: ConnectLaunch }) {
  const [ticket, setTicket] = useState(launch.pendingPair ?? "");
  const [phrase, setPhrase] = useState<string[] | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [stage, setStage] = useState("Connect to your Polyth");
  const [url, setUrl] = useState(launch.preferred ?? launch.recent[0]?.url ?? "");
  const [recent, setRecent] = useState(launch.recent);
  const [error, setError] = useState(launch.error ?? "");
  const [busy, setBusy] = useState(false);
  const [developer, setDeveloper] = useState(false);

  useEffect(() => {
    void SplashScreen.hide();
    if (launch.pendingPair) void startPair(launch.pendingPair);
  }, [launch.pendingPair]);

  const scanQr = async () => {
    setError("");
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
    const video = document.createElement("video");
    video.setAttribute("playsinline", "true");
    video.muted = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      const detector = new Detector({ formats: ["qr_code"] });
      const started = Date.now();
      while (Date.now() - started < 20_000) {
        const codes = await detector.detect(video);
        const raw = codes.find((code) => code.rawValue && isPairingLink(code.rawValue))?.rawValue;
        if (raw) {
          setTicket(raw);
          await startPair(raw);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      setError("No pairing QR was found. Paste the pairing code instead.");
    } catch (cause) {
      const denied = cause instanceof Error && /denied|permission|notallowed/i.test(cause.message);
      setError(denied
        ? "Camera permission is required to scan. You can also paste the pairing code."
        : "Camera scanning failed. Paste the pairing code instead.");
    } finally {
      stream?.getTracks().forEach((item) => item.stop());
      video.remove();
    }
  };

  const startPair = async (raw: string) => {
    setError("");
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
    setBusy(true);
    setStage("Waiting for approval on your computer…");
    try {
      const launched = await polythLink().confirmPairing(attemptId);
      setStage("Connected");
      location.replace(`${launched.origin}${launch.deepLinkPath ?? "/"}`);
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
          <p>Scan a QR from Settings → Polyth Link. Compare the four words, then allow the device on your computer.</p>
        </div>

        {!phrase && (
          <label className="mobile-connect-field">
            <span>Pairing code</span>
            <textarea
              rows={3}
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="polyth://pair?v=1&t=…"
              value={ticket}
              onChange={(event) => setTicket(event.target.value)}
            />
          </label>
        )}

        {phrase && (
          <ol className="mobile-connect-phrase">
            {phrase.map((word) => <li key={word}>{word}</li>)}
          </ol>
        )}

        {error && <div className="mobile-connect-message is-error" role="alert">{error}</div>}

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
              <button type="button" className="mobile-connect-test" disabled={busy} onClick={() => {
                if (attemptId) void polythLink().cancelPairing(attemptId).catch(() => undefined);
                setPhrase(null);
                setAttemptId(null);
                setStage("Connect to your Polyth");
              }}>
                Cancel
              </button>
            </>
          )}
        </div>

        <button type="button" className="mobile-connect-forget" onClick={() => setDeveloper((value) => !value)}>
          {developer ? "Hide developer connections" : "Advanced → Developer connections"}
        </button>

        {developer && (
          <section className="mobile-connect-recents" aria-labelledby="mobile-legacy-title">
            <h2 id="mobile-legacy-title">Insecure development connection</h2>
            <p>Raw URL mode is not Polyth Link. It does not create a paired device identity.</p>
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
                  <span>Legacy connection · {host.url}</span>
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
