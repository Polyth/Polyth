import { useEffect, useState } from "react";
import type { ModelRef, MultirunDto, MultirunRunDto } from "@polyth/contracts";
import { api } from "../api.ts";
import { useActiveModel, useStore } from "../store.ts";
import { fmtCost, fmtTokens, modelBadge } from "../format.ts";
import { renderMarkdown } from "../markdown.tsx";

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

function RunCard({
  run,
  picked,
  onPick,
}: {
  run: MultirunRunDto;
  picked: boolean;
  onPick: () => void;
}) {
  const badge = modelBadge(run.model);
  const tokens = (run.tokens?.input ?? 0) + (run.tokens?.output ?? 0);
  return (
    <article className={`run-card ${picked ? "picked" : ""} ${run.status}`}>
      <div className="run-card-head">
        <div className="run-card-title">
          <span className={`dot ${run.status === "running" || run.status === "pending" ? "working" : run.status === "completed" ? "idle" : "failed"}`} />
          <span className="run-model-name" style={{ color: badge.color }}>{run.model ? run.model.modelID : "default"}</span>
        </div>
        <span className="run-card-agent">{run.agent ?? "build"} agent</span>
      </div>
      <div className="run-card-body">
        {run.error ? <div className="run-error">{run.error}</div> : renderMarkdown(run.output || (run.status === "running" || run.status === "pending" ? "…" : ""), run.id)}
      </div>
      <div className="run-card-meta">
        <span>{tokens ? `${fmtTokens(tokens)} tok` : "—"}</span>
        <span>{run.cost ? fmtCost(run.cost) : "—"}</span>
      </div>
      <button
        className={`pick-btn ${picked ? "picked" : ""}`}
        disabled={run.status !== "completed" || picked}
        onClick={onPick}
      >
        {picked ? "Picked ✓" : "Pick this run"}
      </button>
    </article>
  );
}

export default function MultiRunView() {
  const sessionId = useStore((s) => s.activeSessionId);
  const models = useStore((s) => s.models);
  const agents = useStore((s) => s.agents);
  const fromLog = useActiveModel().multirun;
  const [live, setLive] = useState<MultirunDto | null>(null);
  const [text, setText] = useState("");
  const [slots, setSlots] = useState<string[]>(["", "", ""]);
  const [agent, setAgent] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const shown = live ?? fromLog;
  const running = shown?.runs.some((r) => r.status === "pending" || r.status === "running") ?? false;

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
  }, [sessionId]);

  const q = modelFilter.toLowerCase();
  const MAX_OPTIONS = 80;
  const groups = new Map<string, typeof models>();
  let shownCount = 0;
  for (const m of models) {
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
      setError("Pick at least one model.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { multirunId } = await api.startMultirun(sessionId, text.trim(), runs);
      const snap = await api.getMultirun(multirunId).catch(() => null);
      if (snap) setLive(snap);
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

  if (!sessionId) return <div className="view-empty">Open a session to run the same prompt across models.</div>;

  return (
    <div className="view-page">
      <div>
        <h1 className="view-title">Multi-Run</h1>
        <p className="view-sub">Same prompt, several backends in parallel — pick the run that becomes canon.</p>
      </div>
      <div className="view-toolbar">
        <textarea
          rows={2}
          value={text}
          placeholder="Prompt to send to every run…"
          onChange={(e) => setText(e.target.value)}
        />
        <input
          className="model-filter-input"
          type="text"
          placeholder="Filter models…"
          value={modelFilter}
          onChange={(e) => setModelFilter(e.target.value)}
        />
        <div className="view-toolbar-row">
          {slots.map((v, i) => (
            <select key={i} value={v} onChange={(e) => setSlots((s) => s.map((x, j) => (j === i ? e.target.value : x)))}>
              <option value="">Model {i + 1}</option>
              {[...groups.entries()].map(([provider, ms]) => (
                <optgroup key={provider} label={provider}>
                  {ms.map((m) => (
                    <option key={`${m.providerID}/${m.modelID}`} value={JSON.stringify({ providerID: m.providerID, modelID: m.modelID })}>
                      {m.name ?? m.modelID}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          ))}
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">Agent: Default</option>
            {agents.map((a) => (
              <option key={a.name} value={a.name}>{a.name}</option>
            ))}
          </select>
          <button className="primary-btn" onClick={() => void start()} disabled={busy || !text.trim()}>
            {busy ? "Starting…" : "Run"}
          </button>
        </div>
        {error && <div className="form-error">{error}</div>}
      </div>

      {shown && (
        <>
          <div className="prompt-echo mono">“{shown.prompt}”</div>
          <div className="multirun-grid">
            {shown.runs.map((run) => (
              <RunCard
                key={run.id}
                run={run}
                picked={shown.pickedRunId === run.id}
                onPick={() => void pick(run.id)}
              />
            ))}
          </div>
        </>
      )}
      {!shown && <div className="view-empty">Pick three models and send a prompt to compare runs.</div>}
    </div>
  );
}
