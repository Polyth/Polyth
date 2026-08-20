// Preview + controlled browser: one surface (WP14). With an engine available
// the pane streams a server-owned browser (shared user/agent context, frames
// over /ws with reconnect-at-revision). Without one it stays an honest iframe
// preview and says why control is unavailable.
import { useEffect, useRef, useState } from "react";
import type { PreviewState } from "@polyth/contracts";
import { api, type BrowserSessionDto } from "../api.ts";
import { useStore } from "../store.ts";
import EmptyState from "./EmptyState.tsx";

type InspectorTab = "console" | "activity" | "network";

interface Capability {
  available: boolean;
  engine: "chromium" | "fake" | null;
  reason?: string;
}

export default function PreviewView() {
  const projectId = useStore((s) => s.activeProjectId);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const [state, setState] = useState<PreviewState>({ url: null, status: "off" });
  const [urlInput, setUrlInput] = useState("");
  const [tab, setTab] = useState<InspectorTab>("console");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cap, setCap] = useState<Capability | null>(null);
  const [browser, setBrowser] = useState<BrowserSessionDto | null>(null);
  const [frame, setFrame] = useState<{ revision: number; src: string } | null>(null);
  const [agentPaused, setAgentPaused] = useState(false);
  const [activity, setActivity] = useState<string[]>([]);
  const [consoleLines, setConsoleLines] = useState<Array<{ at: number; level: string; message: string }>>([]);
  const [typeText, setTypeText] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const revisionRef = useRef(0);
  const imgRef = useRef<HTMLImageElement>(null);

  const refresh = async () => {
    if (!projectId) return;
    const got = await api.previewGet(projectId);
    setState(got);
    if (got.url && !urlInput) setUrlInput(got.url);
  };

  useEffect(() => { void refresh(); }, [projectId]);
  useEffect(() => { void api.browserCapability().then(setCap); }, []);
  useEffect(() => {
    if (!projectId || state.status !== "starting") return;
    const t = setInterval(() => void refresh(), 1000);
    return () => clearInterval(t);
  }, [projectId, state.status]);

  // Frame stream: subscribe over /ws; reconnect resumes at the last revision.
  useEffect(() => {
    if (!browser) return;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "browser/subscribe", browserSessionId: browser.id, afterRevision: revisionRef.current }));
      };
      ws.onmessage = (m) => {
        try {
          const msg = JSON.parse(String(m.data)) as {
            type: string; revision?: number; mime?: string; data?: string;
            event?: { kind: string; message?: string; url?: string; actor?: string };
          };
          if (msg.type === "browser/frame" && msg.data) {
            revisionRef.current = msg.revision ?? 0;
            setFrame({ revision: msg.revision ?? 0, src: `data:${msg.mime};base64,${msg.data}` });
          } else if (msg.type === "browser/event" && msg.event) {
            const e = msg.event;
            setActivity((prev) => [...prev.slice(-99), `${e.kind}${e.actor ? ` (${e.actor})` : ""}${e.url ? ` ${e.url}` : ""}${e.message ? ` — ${e.message}` : ""}`]);
            if (e.kind === "navigation" || e.kind === "closed") {
              void api.browserGet(browser.id).then(setBrowser).catch(() => setBrowser(null));
            }
          }
        } catch { /* not for us */ }
      };
      ws.onclose = () => {
        if (!closed) retry = setTimeout(connect, 1000);
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [browser?.id]);

  // Console poll while the inspector shows it.
  useEffect(() => {
    if (!browser || !inspectorOpen || tab !== "console") return;
    const load = () => void api.browserConsole(browser.id).then(setConsoleLines);
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [browser?.id, inspectorOpen, tab]);

  const start = async () => {
    if (!projectId) return;
    setBusy(true);
    setError("");
    try {
      const got = await api.previewStart(projectId);
      setUrlInput(got.url);
      setState({ url: got.url, status: "starting", port: got.port });
      if (browser) await navigate(got.url);
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  };

  const stop = async () => {
    if (!projectId) return;
    setBusy(true);
    await api.previewStop(projectId).catch(() => {});
    await refresh();
    setBusy(false);
  };

  const openBrowser = async () => {
    if (!projectId) return;
    setError("");
    try {
      const dto = await api.browserCreate({
        projectId,
        ...(activeSessionId ? { sessionId: activeSessionId } : {}),
        ...(state.url ? { url: state.url } : {}),
      });
      revisionRef.current = 0;
      setBrowser(dto);
      setActivity([]);
    } catch (e) {
      setError(String(e));
    }
  };

  const closeBrowser = async () => {
    if (!browser) return;
    await api.browserClose(browser.id).catch(() => {});
    setBrowser(null);
    setFrame(null);
    revisionRef.current = 0;
  };

  const navigate = async (raw: string) => {
    if (!browser) return;
    setError("");
    try {
      setBrowser(await api.browserNavigate(browser.id, raw, "user"));
    } catch (e) {
      const msg = String(e);
      if (msg.includes("approval-required") || msg.includes("needs")) {
        if (window.confirm(`This origin is outside the allowed list.\n\n${msg}\n\nApprove it for this run?`)) {
          try {
            await api.browserApprove(raw);
            setBrowser(await api.browserNavigate(browser.id, raw, "user"));
            return;
          } catch (e2) {
            setError(String(e2));
            return;
          }
        }
      }
      setError(msg);
    }
  };

  const act = async (action: Parameters<typeof api.browserAction>[1]) => {
    if (!browser) return;
    setError("");
    try {
      const { session } = await api.browserAction(browser.id, action, "user");
      setBrowser(session);
    } catch (e) {
      setError(String(e));
    }
  };

  const clickFrame = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!browser || !frame || !imgRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    const scaleX = browser.viewport.width / rect.width;
    const scaleY = browser.viewport.height / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    // the click carries the frame revision it was aimed at (stale clicks 409)
    void act({ kind: "click", target: { point: { x, y }, frameRevision: frame.revision } });
  };

  const togglePause = async () => {
    if (!browser) return;
    const next = !agentPaused;
    await api.browserPauseAgent(browser.id, next).catch(() => {});
    setAgentPaused(next);
  };

  if (!projectId) return <EmptyState title="No project selected" description="Open a project to start a live preview." />;

  const frameSrc = urlInput || state.url || "";
  const host = (() => {
    try { return frameSrc ? new URL(frameSrc).host : ""; } catch { return frameSrc; }
  })();
  const statusCopy = state.status === "running"
    ? `running · ${host || (state.port ? `:${state.port}` : "")}`
    : state.status === "starting" ? "starting…" : "off";
  const browserMode = !!browser && browser.status !== "closed";

  return (
    <div className="preview-view">
      <div className="browser-chrome browser-toolbar">
        {browserMode && (
          <span className="browser-history">
            <button className="small-btn" title="Back" aria-label="Back" onClick={() => void act({ kind: "press", key: "Alt+ArrowLeft" })}>←</button>
            <button className="small-btn" title="Forward" aria-label="Forward" onClick={() => void act({ kind: "press", key: "Alt+ArrowRight" })}>→</button>
            <button className="small-btn" title="Reload" aria-label="Reload" onClick={() => browser && void navigate(browser.url)}>↻</button>
          </span>
        )}
        <form
          className="url-pill browser-address"
          onSubmit={(e) => {
            e.preventDefault();
            if (browserMode) void navigate(urlInput);
            else setState((s) => ({ ...s, url: urlInput || s.url }));
          }}
        >
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="localhost:5173"
            aria-label="Address"
          />
        </form>
        {!browserMode && <button className="small-btn" title="Refresh" onClick={() => void refresh()}>↻</button>}
        {frameSrc && (
          <a className="small-btn" href={browserMode && browser ? browser.url : frameSrc} target="_blank" rel="noreferrer" title="Open in a new tab">↗</a>
        )}
        {state.status === "off" ? (
          <button className="primary-btn" onClick={() => void start()} disabled={busy}>Start</button>
        ) : (
          <button className="small-btn danger-btn" onClick={() => void stop()} disabled={busy}>Stop</button>
        )}
        <span className={`preview-status ${state.status}`}>{statusCopy}</span>
        {cap?.available && !browserMode && (
          <button className="small-btn" onClick={() => void openBrowser()} title="Open the controlled browser (shared with the agent)">
            Browser
          </button>
        )}
        {browserMode && (
          <>
            <button className="small-btn" aria-pressed={agentPaused} onClick={() => void togglePause()} title="Pause or resume agent control of this browser">
              {agentPaused ? "Resume agent" : "Pause agent"}
            </button>
            <button className="small-btn danger-btn" onClick={() => void closeBrowser()} title="Close the browser session (context, cookies, and storage are destroyed)">
              Close
            </button>
          </>
        )}
        <button
          className="small-btn"
          aria-pressed={inspectorOpen}
          title="Toggle inspector"
          onClick={() => setInspectorOpen((v) => !v)}
        >
          Inspector
        </button>
      </div>
      {cap && !cap.available && (
        <div className="browser-unavailable" role="note">
          Browser engine unavailable — control disabled, iframe preview only. {cap.reason}
        </div>
      )}
      {error && <div className="form-error" style={{ padding: "6px 12px" }}>{error}</div>}
      <div className="preview-body">
        <div className="preview-stage browser-viewport">
          {browserMode ? (
            frame ? (
              <div className="browser-frame-wrap">
                <img
                  ref={imgRef}
                  src={frame.src}
                  alt={`Browser: ${browser?.title || browser?.url || ""}`}
                  className="browser-frame-img"
                  onClick={clickFrame}
                />
                <div className="browser-frame-bar">
                  <span className="mono">{browser?.url}</span>
                  <span className="muted">rev {frame.revision} · {browser?.engine}</span>
                  <input
                    value={typeText}
                    onChange={(e) => setTypeText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && typeText) {
                        e.preventDefault();
                        void act({ kind: "type", target: { selector: "input, textarea" }, text: typeText, submit: true });
                        setTypeText("");
                      }
                    }}
                    placeholder="Type into the focused field…"
                    aria-label="Type into the page"
                  />
                </div>
              </div>
            ) : (
              <EmptyState title="Connecting to browser" description="Waiting for the first controlled-browser frame." />
            )
          ) : frameSrc ? (
            <iframe title="Preview" src={frameSrc} className="preview-frame" />
          ) : (
            <EmptyState
              title="Preview is inactive"
              description="Start the project dev server and mirror it in this pane."
              actionLabel="Start"
              onAction={() => void start()}
            />
          )}
        </div>
        {inspectorOpen && (
          <aside className="inspector browser-inspector">
            <div className="inspector-tabs">
              {(["console", "activity", "network"] as const).map((t) => (
                <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
                  {t[0]!.toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
            <div className="inspector-body">
              <div className="stat-row"><span className="k">URL</span><span className="mono">{browserMode ? browser?.url : host || "—"}</span></div>
              <div className="stat-row"><span className="k">Port</span><span className="mono">{state.port ?? "—"}</span></div>
              <div className="stat-row"><span className="k">Status</span><span>{statusCopy}</span></div>
              {browserMode && <div className="stat-row"><span className="k">Engine</span><span>{browser?.engine}{agentPaused ? " · agent paused" : ""}</span></div>}
              {tab === "console" && (
                browserMode ? (
                  <div className="browser-console" role="log">
                    {consoleLines.length === 0 && <div className="muted">No console output yet.</div>}
                    {consoleLines.map((l, i) => (
                      <div key={i} className={`browser-console-line ${l.level}`}>
                        <span className="muted">{new Date(l.at).toLocaleTimeString()}</span> {l.message}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="muted">Console capture needs the controlled browser.</div>
                )
              )}
              {tab === "activity" && (
                browserMode ? (
                  <div className="browser-console" role="log">
                    {activity.length === 0 && <div className="muted">No agent/browser activity yet.</div>}
                    {activity.map((a, i) => <div key={i} className="browser-console-line">{a}</div>)}
                  </div>
                ) : (
                  <div className="muted">Activity needs the controlled browser.</div>
                )
              )}
              {tab === "network" && <div className="muted">Network capture is not enabled for this session.</div>}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
