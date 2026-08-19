import { useEffect, useMemo, useState } from "react";
import type { ModelRef, MultirunDto, MultirunRunDto } from "@polyth/contracts";
import { api } from "../api.ts";
import { setActiveView, useActiveModel, useStore } from "../store.ts";
import { registerSlot } from "../slots.ts";
import { fmtCost, fmtTokens, modelBadge } from "../format.ts";
import { renderMarkdown } from "../markdown.tsx";
import type { PickerItem } from "../picker.ts";
import Picker from "./Picker.tsx";

registerSlot("composer.trailing", "builtin.multirun", () => (
  <button className="small-btn" onClick={() => setActiveView("multirun")}>Compare models</button>
), 10);

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
        {picked ? "Picked ✓" : "Use this"}
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

  const modelItems: PickerItem[] = useMemo(
    () =>
      models.map((m) => ({
        id: JSON.stringify({ providerID: m.providerID, modelID: m.modelID }),
        label: m.name ?? m.modelID,
        group: m.providerID,
      })),
    [models],
  );
  const agentItems: PickerItem[] = useMemo(
    () => [
      { id: "", label: "Default", group: "" },
      ...agents.map((a) => ({
        id: a.name,
        label: a.name,
        group: "",
        ...(a.description ? { detail: a.description } : {}),
      })),
    ],
    [agents],
  );

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
  if (models.length === 0) {
    return <div className="view-empty">No models available — connect a backend before comparing runs.</div>;
  }

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
        <div className="view-toolbar-row">
          {slots.map((v, i) => (
            <Picker
              key={i}
              label={`Model ${i + 1}`}
              items={modelItems}
              value={v}
              placeholder="None"
              onPick={(id) => setSlots((s) => s.map((x, j) => (j === i ? (x === id ? "" : id) : x)))}
            />
          ))}
          <Picker label="Agent" items={agentItems} value={agent} placeholder="Default" onPick={setAgent} />
          <button className="primary-btn" onClick={() => void start()} disabled={busy || !text.trim()}>
            {busy ? "Starting…" : "Run"}
          </button>
        </div>
        {error && <div className="form-error">{error}</div>}
      </div>

      {shown && (
        <>
          <div className="prompt-echo">
            <span className="prompt-echo-label">
              Comparing {shown.runs.length} {shown.runs.length === 1 ? "model" : "models"}
              {running ? " · running" : shown.pickedRunId ? " · picked" : " · done"}
            </span>
            <span className="mono">{shown.prompt}</span>
          </div>
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
