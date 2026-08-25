import { useEffect, useState } from "react";
import type { FusionDto } from "@polyth/contracts";
import { api } from "../api.ts";
import { useActiveModel, useStore } from "../store.ts";
import { modelBadge } from "../format.ts";
import { renderMarkdown } from "../markdown.tsx";
import EmptyState from "./EmptyState.tsx";
import { modelDisplayName, modelSupportsTextWorkflow } from "../composer/discovery.ts";
import ProviderLogo from "./ProviderLogo.tsx";
import { tr } from "../i18n/index.ts";

const providerIdFromModel = (model: string): string => {
  const slash = model.lastIndexOf("/");
  return slash > 0 ? model.slice(0, slash) : model;
};

export default function FusionView() {
  const sessionId = useStore((s) => s.activeSessionId);
  const models = useStore((s) => s.models);
  const textModels = models.filter(modelSupportsTextWorkflow);
  const reduced = useActiveModel();
  const fromLog = reduced.fusion;
  const promptFromLog = reduced.fusionPrompt;
  const [live, setLive] = useState<FusionDto | null>(null);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [modelFilter, setModelFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const q = modelFilter.toLowerCase();
  const filteredModels = q ? textModels.filter((m) => (m.modelID + m.name + m.providerID).toLowerCase().includes(q)) : textModels;
  const MAX_CHIPS = 36;
  const visibleModels = filteredModels.slice(0, MAX_CHIPS);
  const shownChips = [
    ...textModels.filter((m) => picked.includes(`${m.providerID}/${m.modelID}`) && !visibleModels.includes(m)),
    ...visibleModels,
  ];

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

  if (!sessionId) {
    return <EmptyState title={tr("fusionview.noSessionOpen")} description={tr("fusionview.openASessionToFuseAnswersFrom")} />;
  }

  const weights = shown?.weights ?? [];
  const total = weights.reduce((a, w) => a + w.weight, 0) || 1;

  return (
    <div className="view-page">
      <div>
        <h1 className="view-title">{tr("fusionview.modelFusion")}</h1>
        <p className="view-sub">{tr("fusionview.synthesizeSeveralModelOutputsIntoOneWeighted")}</p>
      </div>
      <div className="view-toolbar">
        <textarea
          rows={2}
          value={text}
          placeholder={tr("fusionview.promptToFuseAcrossModels")}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="fusion-model-picks">
          <input
            className="model-filter-input"
            type="text"
            placeholder={tr("fusionview.filterModels")}
            value={modelFilter}
            onChange={(e) => setModelFilter(e.target.value)}
          />
          {shownChips.map((m) => {
            const key = `${m.providerID}/${m.modelID}`;
            const on = picked.includes(key);
            return (
              <button
                key={key}
                className={`model-chip ${on ? "on" : ""}`}
                onClick={() => toggle(key)}
              >
                <ProviderLogo
                  providerID={m.providerID}
                  providerName={m.providerName}
                  className="model-chip-provider-logo"
                />
                {modelDisplayName(m, textModels)}
              </button>
            );
          })}
          {filteredModels.length > MAX_CHIPS && (
            <span className="muted">{filteredModels.length - MAX_CHIPS} {tr("fusionview.moreRefineFilter")}</span>
          )}
        </div>
        <div className="view-toolbar-row">
          <button className="primary-btn" onClick={() => void start()} disabled={busy || !text.trim() || picked.length === 0}>
            {busy || running ? tr("fusionview.fusing") : tr("fusionview.fuse")}
          </button>
        </div>
        {error && <div className="form-error">{error}</div>}
      </div>

      {shown && (
        <div className="fusion-layout">
          <section className="fusion-contributors">
            <div className="stat-label">{tr("fusionview.contributors")}</div>
            {weights.map((w) => {
              const badge = modelBadge(w.model);
              return (
                <div key={w.model} className="weight-card">
                  <div className="weight-card-row">
                    <span className="weight-name">
                      <ProviderLogo
                        providerID={providerIdFromModel(w.model)}
                        className="model-chip-provider-logo"
                      />
                      {w.model}
                    </span>
                    <span className="weight-pct">{Math.round((w.weight / total) * 100)}%</span>
                  </div>
                  <div className="weight-track">
                    <div className="weight-fill" style={{ width: `${(w.weight / total) * 100}%`, background: badge.color }} />
                  </div>
                </div>
              );
            })}
            {weights.length === 0 && <div className="empty" style={{ padding: 8 }}>{tr("fusionview.waitingForWeights")}</div>}
          </section>

          <section className="fusion-answer">
            <div className="stat-label">{tr("fusionview.fusedAnswer")}</div>
            {(promptFromLog || text) && (
              <div className="prompt-echo">
                <span className="prompt-echo-label">{tr("fusionview.prompt")}</span>
                <span>{promptFromLog || text}</span>
              </div>
            )}
            <div className="fusion-answer-card">
              {shown.error ? <div className="run-error">{shown.error}</div> : shown.answer ? renderMarkdown(shown.answer, shown.id) : <span className="muted">{tr("fusionview.synthesizing")}</span>}
            </div>
            <div className="stat-label">{tr("fusionview.attribution")}</div>
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
          </section>

          <section className="fusion-disagreements">
            <div className="stat-label">{tr("fusionview.disagreements")}</div>
            {shown.disagreements.length === 0 ? (
              <div className="muted" style={{ fontSize: "calc(12.5px * var(--ui-font-scale, 1))" }}>{tr("fusionview.noDisagreementsRecorded")}</div>
            ) : (
              shown.disagreements.map((d, i) => (
                <div key={i} className="disagree-card">{d}</div>
              ))
            )}
          </section>
        </div>
      )}
      {!shown && (
        <EmptyState title={tr("fusionview.nothingFusedYet")} description={tr("fusionview.selectModelsAndFuseAPromptInto")} />
      )}
    </div>
  );
}
