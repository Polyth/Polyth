import { useEffect, useState } from "react";
import type { ModelRef, MultirunDto, MultirunRunDto } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
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
  TextInput,
} from "../../../apps/web/src/components/ui/index.ts";
import { requestComposerInsert } from "../../../apps/web/src/composerInsert.ts";
import { useShellMode } from "../../../apps/web/src/responsiveShell.ts";
import {
  multirunDuration,
  preferredRunId,
  summarizeMultirun,
} from "./multirunView.ts";

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
  status === "pending" ? "Waiting" : status[0]!.toUpperCase() + status.slice(1);

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
  run: MultirunRunDto;
  modelLabel: string;
  picked: boolean;
  now: number;
  onPick: () => void;
  onContinue: () => void;
}) {
  const tokens = (run.tokens?.input ?? 0) + (run.tokens?.output ?? 0);
  const duration = multirunDuration(run, now);
  return (
    <article className={`multirun-detail ${picked ? "is-picked" : ""}`}>
      <header className="multirun-detail-head">
        <RunIdentity run={run} modelLabel={modelLabel} />
        <RunStatus status={run.status} />
      </header>
      <div className="multirun-detail-meta" aria-label="Run details">
        {duration !== null && <span>{fmtDuration(duration)}</span>}
        {tokens > 0 && <span>{tr("multirunview.valueTok", { value: fmtTokens(tokens) })}</span>}
        {run.cost !== undefined && run.cost > 0 && <span>{fmtCost(run.cost)}</span>}
      </div>
      <div className="multirun-output">
        {run.error
          ? <div className="multirun-error">{run.error}</div>
          : run.output
            ? renderMarkdown(run.output, run.id)
            : <span className="muted">{run.status === "pending" ? "Waiting to start…" : run.status === "running" ? "Generating response…" : "No response returned."}</span>}
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
          Continue in chat
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
  const [live, setLive] = useState<MultirunDto | null>(null);
  const [text, setText] = useState("");
  const [slots, setSlots] = useState<string[]>(["", "", ""]);
  const [agent, setAgent] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectedRunId, setSelectedRunId] = useState("");
  const [phoneDetail, setPhoneDetail] = useState(false);
  const [ignoreLog, setIgnoreLog] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const shown = live ?? (ignoreLog ? null : fromLog);
  const running = shown?.runs.some((r) => r.status === "pending" || r.status === "running") ?? false;
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

  const q = modelFilter.toLowerCase();
  const MAX_OPTIONS = 80;
  const groups = new Map<string, typeof textModels>();
  let shownCount = 0;
  for (const m of textModels) {
    const key = JSON.stringify({ providerID: m.providerID, modelID: m.modelID });
    const selected = slots.includes(key);
    const hit = !q || `${m.modelID} ${m.name ?? ""} ${m.providerID}`.toLowerCase().includes(q) || selected;
    if (!hit) continue;
    if (!selected && shownCount >= MAX_OPTIONS) continue;
    shownCount += 1;
    const g = groups.get(m.providerID) ?? [];
    g.push(m);
    groups.set(m.providerID, g);
  }

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
            <h2 id="multirun-setup-title">Set up comparison</h2>
            <p>Every selected model receives the same prompt at the same time. Each run is independent.</p>
          </div>
          <Textarea
            className="multirun-prompt"
            rows={3}
            value={text}
            placeholder={tr("multirunview.promptToSendToEveryRun")}
            onChange={(e) => setText(e.target.value)}
          />
          <TextInput
            uiSize="sm"
            className="multirun-model-filter"
            placeholder={tr("multirunview.filterModels")}
            value={modelFilter}
            onChange={(e) => setModelFilter(e.target.value)}
          />
          <div className="multirun-controls">
            {slots.map((v, i) => (
              <Select
                key={i}
                value={v}
                label={v ? modelLabelFor(modelRefFromValue(v)) : `${tr("multirunview.model")} ${i + 1}`}
                placeholder={`${tr("multirunview.model")} ${i + 1}`}
                options={[
                  { value: "", label: `${tr("multirunview.model")} ${i + 1}` },
                  ...[...groups.entries()].flatMap(([provider, providerModels]) =>
                    providerModels.map((model) => ({
                      value: JSON.stringify({ providerID: model.providerID, modelID: model.modelID }),
                      label: modelDisplayName(model, textModels),
                      group: provider,
                    }))),
                ]}
                onChange={(value) => setSlots((current) => current.map((slot, slotIndex) => slotIndex === i ? value : slot))}
              />
            ))}
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
              {slots.filter(Boolean).length || "No"} runs · parallel · shared prompt
              {agent ? ` · ${agent} agent` : " · workspace default agent"}
            </span>
            <Button variant="primary" busy={busy} onClick={() => void start()} disabled={!text.trim()}>
              {busy ? tr("multirunview.starting") : tr("common.run")}
            </Button>
          </div>
          <p className="multirun-cost-note">Cost appears as each provider reports usage; no unsupported estimate is shown before the run.</p>
          {error && <div className="form-error">{error}</div>}
        </section>
      )}

      {shown && (
        <section className="multirun-results" aria-labelledby="multirun-results-title">
          <header className="multirun-results-head">
            <div>
              <h2 id="multirun-results-title">{running ? "Comparison in progress" : "Comparison ready"}</h2>
              <p className="multirun-prompt-echo">“{shown.prompt}”</p>
            </div>
            {!running && <Button size="sm" variant="ghost" onClick={startAnother}>New comparison</Button>}
          </header>
          <div className="multirun-summary">
            <Progress
              value={summary.total ? summary.finished / summary.total : 0}
              label={`${summary.finished} of ${summary.total} runs finished`}
            />
            <div className="multirun-summary-states">
              {summary.running > 0 && <Badge tone="accent" dot>{summary.running} running</Badge>}
              {summary.waiting > 0 && <Badge tone="neutral" dot>{summary.waiting} waiting</Badge>}
              {summary.completed > 0 && <Badge tone="success" dot>{summary.completed} completed</Badge>}
              {summary.failed > 0 && <Badge tone="danger" dot>{summary.failed} failed</Badge>}
              {summary.cost !== undefined && <span className="multirun-total-cost">{fmtCost(summary.cost)}</span>}
            </div>
          </div>

          {shellMode === "phone" ? (
            phoneDetail && selectedRun ? (
              <div className="multirun-phone-detail">
                <Button size="sm" variant="ghost" onClick={() => setPhoneDetail(false)}>← {tr("common.back")} to overview</Button>
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
              <div className="multirun-overview" aria-label="Run overview">
                {shown.runs.map((run) => {
                  const duration = multirunDuration(run, now);
                  return (
                    <button key={run.id} type="button" className="multirun-overview-row" onClick={() => selectRun(run.id)}>
                      <RunIdentity run={run} modelLabel={modelLabelFor(run.model)} />
                      <span className="multirun-overview-status">
                        <RunStatus status={run.status} />
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
                label="Comparison runs"
                value={selectedRun?.id ?? ""}
                onChange={selectRun}
                tabs={shown.runs.map((run) => ({
                  id: run.id,
                  label: (
                    <span className="multirun-tab-label">
                      {modelLabelFor(run.model)}
                      <small>{statusLabel(run.status)}</small>
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
        <div className="multirun-pending" role="status">Preparing parallel runs…</div>
      )}
      {!shown && !busy && slots.every((slot) => !slot) && (
        <EmptyState title={tr("multirunview.noRunsYet")} description="Choose at least one model to begin a comparison." />
      )}
    </div>
  );
}
