import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { SplashScreen } from "@capacitor/splash-screen";
import {
  checkPolythHost,
  forgetMobileHost,
  navigateToMobileHost,
  normalizePolythHost,
  rememberMobileHost,
  type MobileHost,
  type MobileLaunch,
} from "./runtime.ts";
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
  const [url, setUrl] = useState(launch.preferred ?? launch.recent[0]?.url ?? "");
  const [recent, setRecent] = useState(launch.recent);
  const [error, setError] = useState(launch.error ?? "");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState<"test" | "connect" | null>(null);

  useEffect(() => {
    void SplashScreen.hide();
  }, []);

  const validate = async () => {
    setError("");
    setResult("");
    const checked = await checkPolythHost(url);
    if (!checked.ok) {
      setError(checked.message);
      return checked;
    }
    setResult(checked.authRequired
      ? "Server found. You’ll enter its Polyth password next."
      : "Server found and ready.");
    return checked;
  };

  const test = async () => {
    if (busy) return;
    setBusy("test");
    await validate();
    setBusy(null);
  };

  const connect = async () => {
    if (busy) return;
    setBusy("connect");
    const checked = await validate();
    if (!checked.ok) {
      setBusy(null);
      return;
    }
    const host = await rememberMobileHost(url);
    await Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined);
    navigateToMobileHost(host, launch.deepLinkPath);
  };

  const remove = async (host: MobileHost) => {
    const state = await forgetMobileHost(host.url);
    setRecent(state.recent);
    if (url === host.url) setUrl(state.recent[0]?.url ?? "");
  };

  const valid = (() => {
    try {
      normalizePolythHost(url);
      return true;
    } catch {
      return false;
    }
  })();

  return (
    <main className="mobile-connect">
      <section className="mobile-connect-card" aria-labelledby="mobile-connect-title">
        <div className="mobile-connect-brand" aria-hidden="true">P</div>
        <div className="mobile-connect-copy">
          <span className="mobile-connect-eyebrow">Polyth mobile</span>
          <h1 id="mobile-connect-title">Connect to your Polyth</h1>
          <p>
            Agents and projects stay on your computer or server. This app is a
            secure client for that existing runtime.
          </p>
        </div>

        <label className="mobile-connect-field">
          <span>Server address</span>
          <input
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="https://polyth.example.com"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setError("");
              setResult("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && valid) void connect();
            }}
          />
          <small>Use HTTPS outside a trusted local network.</small>
        </label>

        {error && <div className="mobile-connect-message is-error" role="alert">{error}</div>}
        {result && <div className="mobile-connect-message is-success" role="status">{result}</div>}

        <div className="mobile-connect-actions">
          <button type="button" className="mobile-connect-test" disabled={!valid || busy !== null} onClick={() => void test()}>
            {busy === "test" ? "Testing…" : "Test connection"}
          </button>
          <button type="button" className="mobile-connect-primary" disabled={!valid || busy !== null} onClick={() => void connect()}>
            {busy === "connect" ? "Connecting…" : "Connect"}
          </button>
        </div>

        {recent.length > 0 && (
          <section className="mobile-connect-recents" aria-labelledby="mobile-connect-recents-title">
            <h2 id="mobile-connect-recents-title">Recent servers</h2>
            <div>
              {recent.map((host) => (
                <article key={host.url}>
                  <button
                    type="button"
                    className="mobile-connect-recent"
                    onClick={() => {
                      setUrl(host.url);
                      setError("");
                      setResult("");
                    }}
                  >
                    <strong>{connectionLabel(host)}</strong>
                    <span>{host.url}</span>
                  </button>
                  <button
                    type="button"
                    className="mobile-connect-forget"
                    aria-label={`Forget ${connectionLabel(host)}`}
                    onClick={() => void remove(host)}
                  >
                    Remove
                  </button>
                </article>
              ))}
            </div>
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
