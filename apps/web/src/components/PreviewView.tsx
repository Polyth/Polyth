import { useEffect, useState } from "react";
import type { PreviewState } from "@polyth/contracts";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import EmptyState from "./EmptyState.tsx";

type InspectorTab = "console" | "elements" | "network";

const STATUS_LABEL: Record<string, string> = {
  off: "Inactive",
  starting: "Starting",
  running: "Live",
};

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

  if (!projectId) {
    return <EmptyState title="No project selected" description="Open a project to start a live preview." />;
  }

  const frameSrc = urlInput || state.url || "";

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
          <input value={urlInput} onChange={(e) => setUrlInput(e.target.value)} placeholder="http://127.0.0.1:…" aria-label="Preview URL" />
        </form>
        <button className="small-btn" title="Refresh" aria-label="Refresh preview" onClick={() => void refresh()}>↻</button>
        {state.status === "off" ? (
          <button className="primary-btn" onClick={() => void start()} disabled={busy}>Start</button>
        ) : (
          <button className="small-btn danger-btn" onClick={() => void stop()} disabled={busy}>Stop</button>
        )}
        <span className={`preview-status ${state.status}`}>{STATUS_LABEL[state.status] ?? state.status}</span>
        <button
          className={`small-btn ${inspectorOpen ? "toggled" : ""}`}
          aria-pressed={inspectorOpen}
          onClick={() => setInspectorOpen((v) => !v)}
        >Inspector</button>
      </div>
      {error && <div className="form-error" style={{ padding: "6px 12px" }}>{error}</div>}
      <div className="preview-body">
        <div className="preview-stage">
          {frameSrc ? (
            <iframe title="Preview" src={frameSrc} className="preview-frame" />
          ) : (
            <EmptyState
              title="Preview is inactive"
              description="Start a preview to load the project in this pane."
              actionLabel="Start"
              onAction={() => void start()}
            />
          )}
        </div>
        {inspectorOpen && (
          <aside className="inspector">
            <div className="inspector-tabs">
              {(["console", "elements", "network"] as const).map((t) => (
                <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
                  {t[0]!.toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
            <div className="inspector-body">
              {tab === "console" && <div className="muted">Page logs are not captured yet.</div>}
              {tab === "elements" && <div className="muted">Element picking is not available in this preview yet.</div>}
              {tab === "network" && <div className="muted">Network capture is not available yet.</div>}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
