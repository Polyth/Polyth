import { useEffect, useMemo, useState } from "react";
import type { FusionDto } from "@polyth/contracts";
import { api } from "../api.ts";
import { useActiveModel, useStore } from "../store.ts";
import { modelBadge } from "../format.ts";
import { renderMarkdown } from "../markdown.tsx";
import type { PickerItem } from "../picker.ts";
import Picker from "./Picker.tsx";

export default function FusionView() {
  const sessionId = useStore((s) => s.activeSessionId);
  const models = useStore((s) => s.models);
  const reduced = useActiveModel();
  const fromLog = reduced.fusion;
  const promptFromLog = reduced.fusionPrompt;
  const [live, setLive] = useState<FusionDto | null>(null);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);

  const modelItems: PickerItem[] = useMemo(
    () =>
      models.map((m) => ({
        id: `${m.providerID}/${m.modelID}`,
        label: m.name ?? m.modelID,
        group: m.providerID,
      })),
    [models],
  );

  const shown = live ?? fromLog;
  const running = shown?.status === "running";

  useEffect(() => {
    if (!shown?.id || !running) return;
    let stop = false;
    const tick = async () => {
      try {
        const next = await api.getFusion(shown.id);
        if (!stop) setLive(next);
      } catch {
        // event log remains the source of truth
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 800);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [shown?.id, running]);

  useEffect(() => {
    setLive(null);
  }, [sessionId]);

  const toggle = (key: string) => {
    setPicked((prev) => (prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key]));
  };

  const start = async () => {
    if (!sessionId || !text.trim() || picked.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const { fusionId } = await api.startFusion(sessionId, text.trim(), picked);
      const snap = await api.getFusion(fusionId).catch(() => null);
      if (snap) setLive(snap);
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  };

  if (!sessionId) return <div className="view-empty">Open a session to fuse answers from several models.</div>;
  if (models.length === 0) {
    return <div className="view-empty">No models available — connect a backend before fusing answers.</div>;
  }

  const weights = shown?.weights ?? [];
  const total = weights.reduce((a, w) => a + w.weight, 0) || 1;

  return (
    <div className="view-page">
      <div>
        <h1 className="view-title">Model Fusion</h1>
        <p className="view-sub">Synthesizing several model outputs into one weighted answer.</p>
      </div>
      <div className="view-toolbar">
        <textarea
          rows={2}
          value={text}
          placeholder="Prompt to fuse across models…"
          onChange={(e) => setText(e.target.value)}
        />
        <div className="fusion-model-picks">
          <Picker label="Models" items={modelItems} values={picked} placeholder="Choose models" onPick={toggle} />
          {picked.map((key) => {
            const badge = modelBadge(key);
            return (
              <button
                key={key}
                className="model-chip on"
                style={{ borderColor: badge.color }}
                title="Remove from fusion"
                onClick={() => toggle(key)}
              >
                <i style={{ background: badge.color }} />
                {badge.label} ✕
              </button>
            );
          })}
        </div>
        <div className="view-toolbar-row">
          <button className="primary-btn" onClick={() => void start()} disabled={busy || !text.trim() || picked.length === 0}>
            {busy || running ? "Fusing…" : "Fuse"}
          </button>
        </div>
        {error && <div className="form-error">{error}</div>}
      </div>

      {shown && (
        <div className={expanded ? "fusion-layout" : ""}>
          {expanded && (
          <section className="fusion-contributors">
            <div className="stat-label">Contributors</div>
            {weights.map((w) => {
              const badge = modelBadge(w.model);
              return (
                <div key={w.model} className="weight-card">
                  <div className="weight-card-row">
                    <span className="weight-name"><i style={{ background: badge.color }} />{w.model}</span>
                    <span className="weight-pct">{Math.round((w.weight / total) * 100)}%</span>
                  </div>
                  <div className="weight-track">
                    <div className="weight-fill" style={{ width: `${(w.weight / total) * 100}%`, background: badge.color }} />
                  </div>
                </div>
              );
            })}
            {weights.length === 0 && <div className="empty" style={{ padding: 8 }}>Waiting for weights…</div>}
          </section>
          )}

          <section className="fusion-answer">
            <div className="stat-label">Fused answer</div>
            {(promptFromLog || text) && (
              <div className="prompt-echo">
                <span className="prompt-echo-label">Prompt</span>
                <span>{promptFromLog || text}</span>
              </div>
            )}
            <div className="fusion-answer-card">
              {shown.error ? <div className="run-error">{shown.error}</div> : shown.answer ? renderMarkdown(shown.answer, shown.id) : <span className="muted">Synthesizing…</span>}
            </div>
            <button className="goal-toggle" onClick={() => setExpanded((v) => !v)}>
              {expanded
                ? "Hide breakdown"
                : `Synthesized from ${weights.length} ${weights.length === 1 ? "model" : "models"} — show breakdown`}
            </button>
            <div className="attr-bar">
              {weights.map((w) => {
                const badge = modelBadge(w.model);
                return (
                  <div
                    key={w.model}
                    className="attr-seg"
                    title={`${badge.label} ${Math.round((w.weight / total) * 100)}%`}
                    style={{ flex: w.weight, background: badge.color }}
                  />
                );
              })}
            </div>
            {expanded && (
              <div className="muted" style={{ fontSize: 11.5, display: "flex", gap: 10, flexWrap: "wrap" }}>
                {weights.map((w) => (
                  <span key={w.model}>
                    <i style={{ background: modelBadge(w.model).color, display: "inline-block", width: 7, height: 7, borderRadius: 2, marginRight: 5 }} />
                    {modelBadge(w.model).label} · {Math.round((w.weight / total) * 100)}%
                  </span>
                ))}
              </div>
            )}
          </section>

          {expanded && (
          <section className="fusion-disagreements">
            <div className="stat-label">Disagreements</div>
            {shown.disagreements.length === 0 ? (
              <div className="muted" style={{ fontSize: 12.5 }}>No disagreements recorded.</div>
            ) : (
              shown.disagreements.map((d, i) => (
                <div key={i} className="disagree-card">— {d}</div>
              ))
            )}
          </section>
          )}
        </div>
      )}
      {!shown && <div className="view-empty">Select models and fuse a prompt into one weighted answer.</div>}
    </div>
  );
}
