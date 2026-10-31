import { useEffect, useRef, useState } from "react";
import type { FusionDto } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { showSessionChat, useActiveModel, useStore } from "../../../apps/web/src/store.ts";
import { renderMarkdown } from "../../../apps/web/src/markdown.tsx";
import EmptyState from "../../../apps/web/src/components/EmptyState.tsx";
import { modelSupportsTextWorkflow } from "../../../apps/web/src/composer/discovery.ts";
import ModelPicker from "@polyth/models/model-picker";
import ProviderLogo from "../../models/widgets/ProviderLogo.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Badge, Button, Spinner, Textarea } from "../../../apps/web/src/components/ui/index.ts";
import { requestComposerInsert } from "../../../apps/web/src/composerInsert.ts";
import {
  latestFusionTopK,
  latestScoredSources,
  rankTopSources,
} from "./fusionTopK.ts";


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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ignoreLog, setIgnoreLog] = useState(false);
  const [preselection, setPreselection] = useState<{ count: number; topK: number } | null>(null);
  const preselectionDone = useRef<string | null>(null);

  const pickedRefs = picked.map((key) => {
    const slash = key.indexOf("/");
    return { providerID: key.slice(0, slash), modelID: key.slice(slash + 1) };
  });

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

  // Preselect the top-K sources by Multirun rubric score when the use's
  // fusionTopK parameter is on. The person still confirms before fusing.
  useEffect(() => {
    if (!sessionId || !textModels.length || preselectionDone.current === sessionId) return;
    preselectionDone.current = sessionId;
    let stop = false;
    void (async () => {
      try {
        // Newest 200 events; the server recorded the resolved top-K with each score.
        const events = await api.getEvents(sessionId, 0, { limit: 200 });
        if (stop) return;
        const topK = latestFusionTopK(events);
        if (topK <= 0) return;
        const available = textModels.map((model) => `${model.providerID}/${model.modelID}`);
        const ranked = rankTopSources(latestScoredSources(events), topK, available);
        if (!ranked.length) return;
        setPicked(ranked);
        setPreselection({ count: ranked.length, topK });
      } catch {
        // Preselection is optional; leave the selection empty rather than guess.
      }
    })();
    return () => {
      stop = true;
    };
  }, [sessionId, textModels]);

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
            <h2 id="fusion-setup-title">{tr("fusionview.setupTitle")}</h2>
            <p>{tr("fusionview.setupBody")}</p>
          </div>
          <Textarea
            rows={3}
            value={text}
            placeholder={tr("fusionview.promptToFuseAcrossModels")}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="fusion-model-picks">
            <ModelPicker
              models={textModels}
              selection={pickedRefs}
              onToggle={(model) => toggle(`${model.providerID}/${model.modelID}`)}
              onPick={() => setPicked([])}
            />
          </div>
          <div className="fusion-launch">
            <span>{tr("fusionview.sourcesLine", { count: picked.length })}</span>
            <Button variant="primary" busy={busy} onClick={() => void start()} disabled={!text.trim() || picked.length === 0}>
              {busy ? tr("fusionview.fusing") : tr("fusionview.fuse")}
            </Button>
          </div>
          {preselection && (
            <p className="fusion-preselection" role="status">
              {tr("fusionview.preselection", { count: preselection.count, topK: preselection.topK })}
            </p>
          )}
          <p className="fusion-cost-note">{tr("fusionview.costNote")}</p>
          {error && <div className="form-error">{error}</div>}
        </section>
      )}

      {shown && (
        <section className="fusion-result" aria-labelledby="fusion-result-title">
          <header className="fusion-result-head">
            <div>
              <span className="fusion-eyebrow">{tr("fusionview.synthesis")}</span>
              <h2 id="fusion-result-title">{running ? tr("fusionview.buildingOneAnswer") : shown.status === "failed" ? tr("fusionview.synthesisFailed") : tr("fusionview.synthesisReady")}</h2>
            </div>
            <div className="fusion-result-status">
              <Badge tone={running ? "accent" : shown.status === "failed" ? "danger" : "success"} dot>
                {running ? tr("fusionview.working") : shown.status === "failed" ? tr("fusionview.failed") : tr("fusionview.completed")}
              </Badge>
              {!running && <Button size="sm" variant="ghost" onClick={startAnother}>{tr("fusionview.newSynthesis")}</Button>}
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
              <Spinner label={tr("fusionview.collectingLabel")} />
              <div>
                <strong>{tr("fusionview.collecting")}</strong>
                <span>{tr("fusionview.answeringIndependently", { count: weights.length })}</span>
              </div>
            </div>
          ) : shown.error ? (
            <div className="fusion-error">{shown.error}</div>
          ) : (
            <>
              <div className="fusion-answer-card">
                {shown.answer ? renderMarkdown(shown.answer, shown.id) : <span className="muted">{tr("fusionview.noSynthesisReturned")}</span>}
              </div>
              <div className="fusion-answer-actions">
                <Button size="sm" variant="primary" disabled={!shown.answer} onClick={continueSynthesis}>{tr("fusionview.continueInChat")}</Button>
                <span>{tr("fusionview.sourceAnswersProvenance", { count: shown.sources.length })}</span>
              </div>
            </>
          )}

          {!running && shown.status === "completed" && (
            <div className="fusion-evidence">
              <details>
                <summary>{tr("fusionview.sourcesAndProvenance", { count: shown.sources.length })}</summary>
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
                        <Badge tone="neutral">{tr("fusionview.attributed", { percent: weightFor(source.model) })}</Badge>
                      </header>
                      <div>{renderMarkdown(source.answer, `${shown.id}-${source.model}`)}</div>
                    </article>
                  ))}
                </div>
              </details>
              <details>
                <summary>{tr("fusionview.disagreementsCount", { count: shown.disagreements.length })}</summary>
                {shown.disagreements.length > 0 ? (
                  <ul className="fusion-disagreement-list">
                    {shown.disagreements.map((disagreement, index) => <li key={index}>{disagreement}</li>)}
                  </ul>
                ) : (
                  <p className="fusion-agreement">{tr("fusionview.sourcesAgreed")}</p>
                )}
              </details>
            </div>
          )}
          {error && <div className="form-error">{error}</div>}
        </section>
      )}
      {!shown && picked.length === 0 && !busy && (
        <EmptyState title={tr("fusionview.nothingFusedYet")} description={tr("fusionview.emptyDescription")} />
      )}
    </div>
  );
}
