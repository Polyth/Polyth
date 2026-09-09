import { useEffect, useState } from "react";
import type { FusionDto } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { showSessionChat, useActiveModel, useStore } from "../../../apps/web/src/store.ts";
import { renderMarkdown } from "../../../apps/web/src/markdown.tsx";
import EmptyState from "../../../apps/web/src/components/EmptyState.tsx";
import { modelDisplayName, modelSupportsTextWorkflow } from "../../../apps/web/src/composer/discovery.ts";
import ProviderLogo from "../../models/widgets/ProviderLogo.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Badge, Button, Spinner, Textarea, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { requestComposerInsert } from "../../../apps/web/src/composerInsert.ts";

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
  const [ignoreLog, setIgnoreLog] = useState(false);

  const q = modelFilter.toLowerCase();
  const filteredModels = q ? textModels.filter((m) => (m.modelID + m.name + m.providerID).toLowerCase().includes(q)) : textModels;
  const MAX_CHIPS = 36;
  const visibleModels = filteredModels.slice(0, MAX_CHIPS);
  const shownChips = [
    ...textModels.filter((m) => picked.includes(`${m.providerID}/${m.modelID}`) && !visibleModels.includes(m)),
    ...visibleModels,
  ];

  const shown = live ?? (ignoreLog ? null : fromLog);
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
    setIgnoreLog(false);
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
      setIgnoreLog(false);
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
  const weightFor = (model: string): number =>
    Math.round(((weights.find((weight) => weight.model === model)?.weight ?? 0) / total) * 100);
  const continueSynthesis = () => {
    if (!shown?.answer) return;
    requestComposerInsert(`Continue from this synthesis:\n\n${shown.answer}`);
    showSessionChat();
  };
  const startAnother = () => {
    setLive(null);
    setIgnoreLog(true);
    setError("");
  };

  return (
    <div className="fusion-view">
      {/* Header + close come from the shared ModuleView frame. */}
      {!shown && (
        <section className="fusion-setup" aria-labelledby="fusion-setup-title">
          <div>
            <h2 id="fusion-setup-title">Choose synthesis sources</h2>
            <p>Each model answers independently. A separate synthesis pass combines the strongest supported points.</p>
          </div>
          <Textarea
            rows={3}
            value={text}
            placeholder={tr("fusionview.promptToFuseAcrossModels")}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="fusion-model-picks">
            <TextInput
              uiSize="sm"
              className="fusion-model-filter"
              placeholder={tr("fusionview.filterModels")}
              value={modelFilter}
              onChange={(e) => setModelFilter(e.target.value)}
            />
            {shownChips.map((m) => {
              const key = `${m.providerID}/${m.modelID}`;
              const on = picked.includes(key);
              return (
                <Button
                  size="sm"
                  variant="ghost"
                  key={key}
                  className={`fusion-model-chip ${on ? "is-selected" : ""}`}
                  aria-pressed={on}
                  onClick={() => toggle(key)}
                >
                  <ProviderLogo
                    providerID={m.providerID}
                    providerName={m.providerName}
                    harnessId={m.harnessId}
                    className="fusion-provider-logo"
                  />
                  {modelDisplayName(m, textModels)}
                </Button>
              );
            })}
            {filteredModels.length > MAX_CHIPS && (
              <span className="muted">{filteredModels.length - MAX_CHIPS} {tr("fusionview.moreRefineFilter")}</span>
            )}
          </div>
          <div className="fusion-launch">
            <span>{picked.length || "No"} sources · parallel collection · one synthesis</span>
            <Button variant="primary" busy={busy} onClick={() => void start()} disabled={!text.trim() || picked.length === 0}>
              {busy ? tr("fusionview.fusing") : tr("fusionview.fuse")}
            </Button>
          </div>
          <p className="fusion-cost-note">The current fusion runner does not report utility-run cost, so no estimate is shown.</p>
          {error && <div className="form-error">{error}</div>}
        </section>
      )}

      {shown && (
        <section className="fusion-result" aria-labelledby="fusion-result-title">
          <header className="fusion-result-head">
            <div>
              <span className="fusion-eyebrow">Synthesis</span>
              <h2 id="fusion-result-title">{running ? "Building one answer" : shown.status === "failed" ? "Synthesis failed" : "Synthesis ready"}</h2>
            </div>
            <div className="fusion-result-status">
              <Badge tone={running ? "accent" : shown.status === "failed" ? "danger" : "success"} dot>
                {running ? "Working" : shown.status === "failed" ? "Failed" : "Completed"}
              </Badge>
              {!running && <Button size="sm" variant="ghost" onClick={startAnother}>New synthesis</Button>}
            </div>
          </header>
          {(promptFromLog || text) && (
            <div className="fusion-prompt">
              <span>{tr("fusionview.prompt")}</span>
              <p>{promptFromLog || text}</p>
            </div>
          )}
          {running ? (
            <div className="fusion-working" role="status">
              <Spinner label="Collecting source answers and synthesizing" />
              <div>
                <strong>Collecting and synthesizing</strong>
                <span>{weights.length} sources are answering independently.</span>
              </div>
            </div>
          ) : shown.error ? (
            <div className="fusion-error">{shown.error}</div>
          ) : (
            <>
              <div className="fusion-answer-card">
                {shown.answer ? renderMarkdown(shown.answer, shown.id) : <span className="muted">No synthesis returned.</span>}
              </div>
              <div className="fusion-answer-actions">
                <Button size="sm" variant="primary" disabled={!shown.answer} onClick={continueSynthesis}>Continue in chat</Button>
                <span>{shown.sources.length} source answers · provenance available below</span>
              </div>
            </>
          )}

          {!running && shown.status === "completed" && (
            <div className="fusion-evidence">
              <details>
                <summary>Sources and provenance ({shown.sources.length})</summary>
                <div className="fusion-source-list">
                  {shown.sources.map((source) => (
                    <article key={source.model} className="fusion-source">
                      <header>
                        <span>
                          <ProviderLogo
                            providerID={providerIdFromModel(source.model)}
                            harnessId={textModels.find((item) => `${item.providerID}/${item.modelID}` === source.model)?.harnessId}
                            className="fusion-provider-logo"
                          />
                          <strong>{source.model}</strong>
                        </span>
                        <Badge tone="neutral">{weightFor(source.model)}% attributed</Badge>
                      </header>
                      <div>{renderMarkdown(source.answer, `${shown.id}-${source.model}`)}</div>
                    </article>
                  ))}
                </div>
              </details>
              <details>
                <summary>Disagreements ({shown.disagreements.length})</summary>
                {shown.disagreements.length > 0 ? (
                  <ul className="fusion-disagreement-list">
                    {shown.disagreements.map((disagreement, index) => <li key={index}>{disagreement}</li>)}
                  </ul>
                ) : (
                  <p className="fusion-agreement">The sources agreed on the material points captured by the synthesis.</p>
                )}
              </details>
            </div>
          )}
          {error && <div className="form-error">{error}</div>}
        </section>
      )}
      {!shown && picked.length === 0 && !busy && (
        <EmptyState title={tr("fusionview.nothingFusedYet")} description="Select source models to create one traceable synthesis." />
      )}
    </div>
  );
}
