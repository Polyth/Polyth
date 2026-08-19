import { useEffect, useState } from "react";
import type { PreviewState } from "@polyth/contracts";
import { api } from "../api.ts";
import { useStore } from "../store.ts";

type InspectorTab = "console" | "network";

export default function PreviewView() {
  const projectId = useStore((s) => s.activeProjectId);
  const [state, setState] = useState<PreviewState>({ url: null, status: "off" });
  const [urlInput, setUrlInput] = useState("");
  const [tab, setTab] = useState<InspectorTab>("console");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    if (!projectId) return;
    const got = await api.previewGet(projectId);
    setState(got);
    if (got.url) setUrlInput(got.url);
  };

  useEffect(() => { void refresh(); }, [projectId]);
  useEffect(() => {
    if (!projectId || state.status !== "starting") return;
    const t = setInterval(() => void refresh(), 1000);
    return () => clearInterval(t);
  }, [projectId, state.status]);

  const start = async () => {
    if (!projectId) return;
    setBusy(true);
    setError("");
    try {
      const got = await api.previewStart(projectId);
      setUrlInput(got.url);
      setState({ url: got.url, status: "starting", port: got.port });
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

  if (!projectId) return <div className="view-empty">Select a project to start a live preview.</div>;

  const frameSrc = urlInput || state.url || "";
  // Mockup shows the short authority (localhost:5173), not the full URL.
  const host = (() => {
    try { return frameSrc ? new URL(frameSrc).host : ""; } catch { return frameSrc; }
  })();
  const statusCopy = state.status === "running"
    ? `running · ${host || (state.port ? `:${state.port}` : "")}`
    : state.status === "starting" ? "starting…" : "off";

  return (
    <div className="preview-view">
      <div className="browser-chrome">
        <form
          className="url-pill"
          onSubmit={(e) => {
            e.preventDefault();
            setState((s) => ({ ...s, url: urlInput || s.url }));
          }}
        >
          <input value={urlInput} onChange={(e) => setUrlInput(e.target.value)} placeholder="localhost:5173" />
        </form>
        <button className="small-btn" title="Refresh" onClick={() => void refresh()}>↻</button>
        {frameSrc && (
          <a className="small-btn" href={frameSrc} target="_blank" rel="noreferrer" title="Open in a new tab">↗</a>
        )}
        {state.status === "off" ? (
          <button className="primary-btn" onClick={() => void start()} disabled={busy}>Start</button>
        ) : (
          <button className="small-btn danger-btn" onClick={() => void stop()} disabled={busy}>Stop</button>
        )}
        <span className={`preview-status ${state.status}`}>{statusCopy}</span>
        <button
          className="small-btn"
          aria-pressed={inspectorOpen}
          title="Toggle inspector"
          onClick={() => setInspectorOpen((v) => !v)}
        >
          Inspector
        </button>
      </div>
      {error && <div className="form-error" style={{ padding: "6px 12px" }}>{error}</div>}
      <div className="preview-body">
        <div className="preview-stage">
          {frameSrc ? (
            <iframe title="Preview" src={frameSrc} className="preview-frame" />
          ) : (
            <div className="view-empty">Live preview — Start boots this project's dev server and mirrors it here.</div>
          )}
        </div>
        {inspectorOpen && (
          <aside className="inspector">
            <div className="inspector-tabs">
              {(["console", "network"] as const).map((t) => (
                <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
                  {t[0]!.toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
            <div className="inspector-body">
              <div className="stat-row"><span className="k">URL</span><span className="mono">{host || "—"}</span></div>
              <div className="stat-row"><span className="k">Port</span><span className="mono">{state.port ?? "—"}</span></div>
              <div className="stat-row"><span className="k">Status</span><span>{statusCopy}</span></div>
              {tab === "console" && <div className="muted">Console needs page logs proxied through the preview server.</div>}
              {tab === "network" && <div className="muted">Network needs request capture in GET /api/preview.</div>}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
