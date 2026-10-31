import { useEffect, useState } from "react";
import type { ModelRef, MultirunDto, MultirunRunDto } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import ModelPicker from "@polyth/models/model-picker";
import { showSessionChat, useActiveModel, useStore } from "../../../apps/web/src/store.ts";
import { fmtCost, fmtDuration, fmtTokens } from "../../../apps/web/src/format.ts";
import { renderMarkdown } from "../../../apps/web/src/markdown.tsx";
import EmptyState from "../../../apps/web/src/components/EmptyState.tsx";
import { modelDisplayName, modelSupportsTextWorkflow } from "../../../apps/web/src/composer/discovery.ts";
import { consumeMultiRunPrompt } from "./multirunSeed.ts";
import ProviderLogo from "../../models/widgets/ProviderLogo.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import {
  Badge,
  Button,
  Progress,
  Select,
  TabPanel,
  Tabs,
  Textarea,
} from "../../../apps/web/src/components/ui/index.ts";
import { requestComposerInsert } from "../../../apps/web/src/composerInsert.ts";
import { useShellMode } from "../../../apps/web/src/responsiveShell.ts";
import {
  multirunDuration,
  preferredRunId,
  scoreFieldsFromEvents,
  summarizeMultirun,
  type ScoredMultirunDto,
  type ScoredMultirunRun,
} from "./multirunView.ts";
import { formatScore, isLowScoreConfidence, type MultirunRunScoreFields } from "../src/rubric.ts";

function modelRefFromValue(value: string): ModelRef | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as { providerID?: unknown; modelID?: unknown };
    if (typeof parsed.providerID === "string" && typeof parsed.modelID === "string") {
      return { providerID: parsed.providerID, modelID: parsed.modelID };
    }
  } catch {
    // ignore
  }
  return undefined;
}

const statusLabel = (status: MultirunRunDto["status"]): string =>
  status === "pending"
    ? tr("multirunview.statusWaiting")
    : status === "running"
      ? tr("multirunview.statusRunning")
      : status === "completed"
        ? tr("multirunview.statusCompleted")
        : tr("multirunview.statusFailed");

function RunStatus({ status }: { status: MultirunRunDto["status"] }) {
  const tone = status === "completed"
    ? "success"
    : status === "failed"
      ? "danger"
      : status === "running"
        ? "accent"
        : "neutral";
  return <Badge tone={tone} dot>{statusLabel(status)}</Badge>;
}

function RunIdentity({
  run,
  modelLabel,
}: {
  run: MultirunRunDto;
  modelLabel: string;
}) {
  return (
    <span className="multirun-run-identity">
      {run.model && <ProviderLogo providerID={run.model.providerID} className="multirun-provider-logo" />}
      <span>
        <strong>{modelLabel}</strong>
        <small>{run.agent ?? tr("composer.build")} {tr("multirunview.agent")}</small>
      </span>
    </span>
  );
}

function RunDetail({
  run,
  modelLabel,
  picked,
  now,
  onPick,
  onContinue,
}: {
  run: ScoredMultirunRun;
  modelLabel: string;
  picked: boolean;
  now: number;
  onPick: () => void;
  onContinue: () => void;
}) {
  const tokens = (run.tokens?.input ?? 0) + (run.tokens?.output ?? 0);
  const duration = multirunDuration(run, now);
  const scored = run.score !== undefined && run.scoreLevels !== undefined && run.scoreConfidence !== undefined;
  const lowConfidence = scored && isLowScoreConfidence(run.scoreConfidence!);
  return (
    <article className={`multirun-detail ${picked ? "is-picked" : ""}`}>
      <header className="multirun-detail-head">
        <RunIdentity run={run} modelLabel={modelLabel} />
        <RunStatus status={run.status} />
      </header>
      <div className="multirun-detail-meta" aria-label={tr("multirunview.runDetails")}>
        {scored && (
          <span
            className={`multirun-score ${lowConfidence ? "is-low" : ""}`}
            title={lowConfidence ? tr("multirunview.lowConfidenceTitle") : tr("multirunview.rubricScore")}
          >
            {formatScore(run.score!, run.scoreLevels!, run.scoreConfidence!)}
            {lowConfidence ? ` · ${tr("multirunview.lowConfidence")}` : ""}
          </span>
        )}
        {run.scoreNote && <span className="multirun-score-note">{run.scoreNote}</span>}
        {duration !== null && <span>{fmtDuration(duration)}</span>}
        {tokens > 0 && <span>{tr("multirunview.valueTok", { value: fmtTokens(tokens) })}</span>}
        {run.cost !== undefined && run.cost > 0 && <span>{fmtCost(run.cost)}</span>}
      </div>
      <div className="multirun-output">
        {run.error
          ? <div className="multirun-error">{run.error}</div>
          : run.output
            ? renderMarkdown(run.output, run.id)
            : <span className="muted">{run.status === "pending" ? tr("multirunview.waitingToStart") : run.status === "running" ? tr("multirunview.generatingResponse") : tr("multirunview.noResponseReturned")}</span>}
      </div>
      <div className="multirun-detail-actions">
        <Button
          size="sm"
          variant={picked ? "primary" : "quiet"}
          disabled={run.status !== "completed" || picked}
          onClick={onPick}
        >
          {picked ? tr("multirunview.picked") : tr("multirunview.pickThisRun")}
        </Button>
        <Button size="sm" variant="ghost" disabled={!run.output} onClick={onContinue}>
          {tr("multirunview.continueInChat")}
        </Button>
      </div>
    </article>
  );
}

export default function MultiRunView() {
  const shellMode = useShellMode();
  const sessionId = useStore((s) => s.activeSessionId);
  const models = useStore((s) => s.models);
  const textModels = models.filter(modelSupportsTextWorkflow);
  const agents = useStore((s) => s.agents);
  const fromLog = useActiveModel().multirun;
  const [live, setLive] = useState<ScoredMultirunDto | null>(null);
  const [logScores, setLogScores] = useState<Record<string, MultirunRunScoreFields>>({});
  const [text, setText] = useState("");
  const [slots, setSlots] = useState<string[]>(["", "", ""]);
  const [agent, setAgent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectedRunId, setSelectedRunId] = useState("");
  const [phoneDetail, setPhoneDetail] = useState(false);
  const [ignoreLog, setIgnoreLog] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const base = live ?? (ignoreLog ? null : fromLog);
  const shown: ScoredMultirunDto | null = base
    ? { ...base, runs: base.runs.map((run) => ({ ...run, ...logScores[run.id] })) }
    : null;
  const running = (shown?.runs.some((r) => r.status === "pending" || r.status === "running") ?? false)
    || shown?.scoring === true;
  const selectedRun = shown?.runs.find((run) => run.id === selectedRunId)
    ?? shown?.runs[0];
  const summary = summarizeMultirun(shown?.runs ?? []);

  useEffect(() => {
    if (!shown?.id || !running) return;
    let stop = false;
    const tick = async () => {
      try {
        const next = await api.getMultirun(shown.id);
        if (!stop) setLive(next);
      } catch {
        // in-memory snapshot may be gone after restart — event log is source of truth
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
    setPhoneDetail(false);
    const seeded = consumeMultiRunPrompt();
    if (seeded) setText(seeded);
  }, [sessionId]);

  // The live snapshot already carries scores. After a reload only the canonical
  // event log survives, so rebuild the per-run score fields from it.
  useEffect(() => {
    if (!sessionId || !shown?.id || live) {
      setLogScores({});
      return;
    }
    let stop = false;
    void api.getEvents(sessionId, 0, { limit: 200 })
      .then((events) => {
        if (!stop) setLogScores(scoreFieldsFromEvents(events, shown.id));
      })
      .catch(() => {
        // scoring evidence is optional; a log read failure leaves today's view
      });
    return () => {
      stop = true;
    };
  }, [sessionId, shown?.id, live]);

  useEffect(() => {
    if (!shown) {
      setSelectedRunId("");
      return;
    }
    setSelectedRunId((current) => preferredRunId(shown.runs, current));
  }, [shown?.id]);

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const start = async () => {
    if (!sessionId || !text.trim()) return;
    const runs = slots
      .map((v) => {
        const model = modelRefFromValue(v);
        return { ...(model ? { model } : {}), ...(agent ? { agent } : {}) };
      })
      .filter((r) => r.model);
    if (runs.length === 0) {
      setError(tr("multirunview.pickAtLeastOneModel"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { multirunId } = await api.startMultirun(sessionId, text.trim(), runs);
      const snap = await api.getMultirun(multirunId).catch(() => null);
      setIgnoreLog(false);
      if (snap) {
        setLive(snap);
        setSelectedRunId(preferredRunId(snap.runs));
      }
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  };

  const pick = async (runId: string) => {
    if (!shown) return;
    try {
      await api.pickMultirun(shown.id, runId);
      setLive((prev) => (prev ? { ...prev, pickedRunId: runId } : prev));
    } catch (e) {
      setError(String(e));
    }
  };
  const modelLabelFor = (model?: ModelRef): string => {
    if (!model) return tr("format.default");
    const descriptor = textModels.find((candidate) =>
      candidate.providerID === model.providerID && candidate.modelID === model.modelID);
    return descriptor
      ? modelDisplayName(descriptor, textModels)
      : `${model.providerID}/${model.modelID}`;
  };
  const continueRun = (run: MultirunRunDto) => {
    if (!run.output) return;
    requestComposerInsert(`Continue from this response:\n\n${run.output}`);
    showSessionChat();
  };
  const selectRun = (runId: string) => {
    setSelectedRunId(runId);
    if (shellMode === "phone") setPhoneDetail(true);
  };
  const startAnother = () => {
    setLive(null);
    setIgnoreLog(true);
    setSelectedRunId("");
    setPhoneDetail(false);
    setError("");
  };

  if (!sessionId) {
    return <EmptyState title={tr("multirunview.noSessionOpen")} description={tr("multirunview.openASessionToRunTheSame")} />;
  }

  return (
    <div className="multirun-view">
      {/* Header + close come from the shared ModuleView frame. */}
      {!shown && (
        <section className="multirun-setup" aria-labelledby="multirun-setup-title">
          <div>
            <h2 id="multirun-setup-title">{tr("multirunview.setupTitle")}</h2>
            <p>{tr("multirunview.setupBody")}</p>
          </div>
          <Textarea
            className="multirun-prompt"
            rows={3}
            value={text}
            placeholder={tr("multirunview.promptToSendToEveryRun")}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="multirun-controls">
            {slots.map((v, i) => {
              const selected = modelRefFromValue(v);
              return (
                <ModelPicker
                  key={i}
                  models={textModels}
                  {...(selected ? { value: selected } : {})}
                  direction="down"
                  emptyLabel={`${tr("multirunview.model")} ${i + 1}`}
                  onPick={(picked) => setSlots((current) => current.map((slot, slotIndex) => slotIndex === i
                    ? (picked ? JSON.stringify({ providerID: picked.providerID, modelID: picked.modelID }) : "")
                    : slot))}
                />
              );
            })}
            <Select
              value={agent}
              label={agent || tr("multirunview.agentDefault")}
              options={[
                { value: "", label: tr("multirunview.agentDefault") },
                ...agents.map((candidate) => ({ value: candidate.name, label: candidate.name })),
              ]}
              onChange={setAgent}
            />
          </div>
          <div className="multirun-launch">
            <span>
              {agent
                ? tr("multirunview.runsLineAgent", { count: slots.filter(Boolean).length, agent })
                : tr("multirunview.runsLineDefault", { count: slots.filter(Boolean).length })}
            </span>
            <Button variant="primary" busy={busy} onClick={() => void start()} disabled={!text.trim()}>
              {busy ? tr("multirunview.starting") : tr("common.run")}
            </Button>
          </div>
          <p className="multirun-cost-note">{tr("multirunview.costNote")}</p>
          {error && <div className="form-error">{error}</div>}
        </section>
      )}

      {shown && (
        <section className="multirun-results" aria-labelledby="multirun-results-title">
          <header className="multirun-results-head">
            <div>
              <h2 id="multirun-results-title">{running ? tr("multirunview.inProgress") : tr("multirunview.ready")}</h2>
              <p className="multirun-prompt-echo">“{shown.prompt}”</p>
            </div>
            {!running && <Button size="sm" variant="ghost" onClick={startAnother}>{tr("multirunview.newComparison")}</Button>}
          </header>
          <div className="multirun-summary">
            <Progress
              value={summary.total ? summary.finished / summary.total : 0}
              label={tr("multirunview.finishedOf", { finished: summary.finished, total: summary.total })}
            />
            <div className="multirun-summary-states">
              {summary.running > 0 && <Badge tone="accent" dot>{tr("multirunview.countRunning", { count: summary.running })}</Badge>}
              {shown.scoring === true && <Badge tone="accent" dot>{tr("multirunview.scoringAnswers")}</Badge>}
              {summary.waiting > 0 && <Badge tone="neutral" dot>{tr("multirunview.countWaiting", { count: summary.waiting })}</Badge>}
              {summary.completed > 0 && <Badge tone="success" dot>{tr("multirunview.countCompleted", { count: summary.completed })}</Badge>}
              {summary.failed > 0 && <Badge tone="danger" dot>{tr("multirunview.countFailed", { count: summary.failed })}</Badge>}
              {summary.cost !== undefined && <span className="multirun-total-cost">{fmtCost(summary.cost)}</span>}
            </div>
          </div>

          {shellMode === "phone" ? (
            phoneDetail && selectedRun ? (
              <div className="multirun-phone-detail">
                <Button size="sm" variant="ghost" onClick={() => setPhoneDetail(false)}>← {tr("multirunview.backToOverview")}</Button>
                <RunDetail
                  run={selectedRun}
                  modelLabel={modelLabelFor(selectedRun.model)}
                  picked={shown.pickedRunId === selectedRun.id}
                  now={now}
                  onPick={() => void pick(selectedRun.id)}
                  onContinue={() => continueRun(selectedRun)}
                />
              </div>
            ) : (
              <div className="multirun-overview" aria-label={tr("multirunview.runOverview")}>
                {shown.runs.map((run) => {
                  const duration = multirunDuration(run, now);
                  return (
                    <button key={run.id} type="button" className="multirun-overview-row" onClick={() => selectRun(run.id)}>
                      <RunIdentity run={run} modelLabel={modelLabelFor(run.model)} />
                      <span className="multirun-overview-status">
                        <RunStatus status={run.status} />
                        {run.score !== undefined && run.scoreLevels !== undefined && run.scoreConfidence !== undefined && (
                          <small className={`multirun-score ${isLowScoreConfidence(run.scoreConfidence) ? "is-low" : ""}`}>
                            {formatScore(run.score, run.scoreLevels, run.scoreConfidence)}
                          </small>
                        )}
                        {duration !== null && <small>{fmtDuration(duration)}</small>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )
          ) : (
            <>
              <Tabs
                idBase="multirun-runs"
                className="multirun-tabs"
                size="sm"
                label={tr("multirunview.comparisonRuns")}
                value={selectedRun?.id ?? ""}
                onChange={selectRun}
                tabs={shown.runs.map((run) => ({
                  id: run.id,
                  label: (
                    <span className="multirun-tab-label">
                      {modelLabelFor(run.model)}
                      <small>{statusLabel(run.status)}</small>
                      {run.score !== undefined && run.scoreLevels !== undefined && run.scoreConfidence !== undefined && (
                        <small className={`multirun-score ${isLowScoreConfidence(run.scoreConfidence) ? "is-low" : ""}`}>
                          {formatScore(run.score, run.scoreLevels, run.scoreConfidence)}
                        </small>
                      )}
                    </span>
                  ),
                }))}
              />
              {selectedRun && (
                <TabPanel idBase="multirun-runs" tabId={selectedRun.id} active className="multirun-tab-panel">
                  <RunDetail
                    run={selectedRun}
                    modelLabel={modelLabelFor(selectedRun.model)}
                    picked={shown.pickedRunId === selectedRun.id}
                    now={now}
                    onPick={() => void pick(selectedRun.id)}
                    onContinue={() => continueRun(selectedRun)}
                  />
                </TabPanel>
              )}
            </>
          )}
          {error && <div className="form-error">{error}</div>}
        </section>
      )}
      {!shown && busy && (
        <div className="multirun-pending" role="status">{tr("multirunview.preparing")}</div>
      )}
      {!shown && !busy && slots.every((slot) => !slot) && (
        <EmptyState title={tr("multirunview.noRunsYet")} description={tr("multirunview.chooseModelDescription")} />
      )}
    </div>
  );
}
