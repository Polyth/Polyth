import { useEffect, useMemo, useState } from "react";
import type { ModelRef } from "@polyth/contracts";
import { api } from "../../api.ts";
import { setUiError, updateSettings, useStore } from "../../store.ts";
import { friendlyError } from "../../settings.ts";
import { setGlobalDefaultModel, setSessionDefaults, useSessionDefaults } from "../../sessionDefaults.ts";
import { PageHead, Row } from "./parts.tsx";
import { modelDisplayName, modelSupportsTextWorkflow } from "../../composer/discovery.ts";
import { roleKind, useRolePrefs } from "../../rolePrefs.ts";

const modelKey = (model: ModelRef): string => `${model.providerID}/${model.modelID}`;

export default function SessionsPage() {
  const models = useStore((s) => s.models);
  const textModels = useMemo(() => models.filter(modelSupportsTextWorkflow), [models]);
  const agents = useStore((s) => s.agents);
  const rolePrefs = useRolePrefs();
  const mainAgents = agents.filter((agent) =>
    roleKind(agent, rolePrefs) === "main" && agent.name.toLowerCase() !== "compaction");
  const defaults = useSessionDefaults();
  const retentionDays = defaults.retentionDays ?? 30;
  const defaultAgent = defaults.defaultAgent
    && mainAgents.some((agent) => agent.name === defaults.defaultAgent)
    ? defaults.defaultAgent
    : mainAgents.find((agent) => agent.name.toLowerCase() === "build")?.name
      ?? mainAgents[0]?.name
    ?? "";
  const thinkingOptions = [...new Set(models.flatMap((model) => model.variants ?? []))];
  const [eligible, setEligible] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setEligible(null);
    void api.sessionRetention(retentionDays)
      .then((summary) => {
        if (live) setEligible(typeof summary.eligibleCount === "number" ? summary.eligibleCount : 0);
      })
      .catch(() => { if (live) setEligible(0); });
    return () => { live = false; };
  }, [retentionDays]);

  const modelFrom = (value: string): ModelRef | undefined => {
    const model = textModels.find((candidate) => modelKey(candidate) === value);
    return model ? { providerID: model.providerID, modelID: model.modelID } : undefined;
  };

  const cleanup = async () => {
    setBusy(true);
    try {
      const result = await api.runSessionRetention(retentionDays);
      setEligible(Math.max(0, result.eligibleCount - result.succeeded.length));
      if (result.failed.length > 0) {
        setUiError(`${result.failed.length} eligible session(s) could not be archived.`);
      }
    } catch (e) {
      setUiError(friendlyError("Couldn’t clean up expired sessions", e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead title="Sessions" blurb="Set defaults and retention for sessions." />
      <div className="stat-label session-settings-heading">Session Defaults</div>
      <p className="session-default-summary">
        New sessions will start with: <strong>OpenCode agent default</strong>
        {defaultAgent && <> / <strong>{defaultAgent}</strong></>}
      </p>
      <Row label="Default Model" hint="The model selected when a project does not provide an override." itemId="sessions.defaultModel">
        <select
          aria-label="Default Model"
          value={defaults.defaultModel ? modelKey(defaults.defaultModel) : ""}
          onChange={(event) => {
            const model = modelFrom(event.target.value);
            setGlobalDefaultModel(model);
            updateSettings({ defaultModel: event.target.value });
          }}
        >
          <option value="">Not selected</option>
          {textModels.map((model) => (
            <option key={modelKey(model)} value={modelKey(model)}>
              {modelDisplayName(model, textModels)}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Default Thinking" hint="Applied to models that offer thinking variants.">
        <select
          aria-label="Default Thinking"
          value={defaults.defaultThinking ?? ""}
          onChange={(event) => setSessionDefaults({ defaultThinking: event.target.value || undefined })}
        >
          <option value="">Default</option>
          {thinkingOptions.map((thinking) => <option key={thinking} value={thinking}>{thinking}</option>)}
        </select>
      </Row>
      <Row label="Default Agent" hint="OpenCode role used when no project or session override is selected.">
        <select
          aria-label="Default Agent"
          value={defaultAgent}
          onChange={(event) => setSessionDefaults({ defaultAgent: event.target.value || undefined })}
        >
          <option value="">OpenCode agent default</option>
          {mainAgents.map((agent) => <option key={agent.name} value={agent.name}>{agent.name}</option>)}
        </select>
      </Row>
      <Row label="Small Model" hint="Override model for lightweight summaries and generated metadata.">
        <select
          aria-label="Small Model"
          value={defaults.smallModel ? modelKey(defaults.smallModel) : ""}
          onChange={(event) => setSessionDefaults({ smallModel: modelFrom(event.target.value) })}
        >
          <option value="">Not selected</option>
          {textModels.map((model) => <option key={modelKey(model)} value={modelKey(model)}>{modelDisplayName(model, textModels)}</option>)}
        </select>
      </Row>
      <Row label="Changes Walkthrough Model" hint="Model used when generating a changes walkthrough.">
        <select
          aria-label="Changes Walkthrough Model"
          value={defaults.walkthroughModel ? modelKey(defaults.walkthroughModel) : ""}
          onChange={(event) => setSessionDefaults({ walkthroughModel: modelFrom(event.target.value) })}
        >
          <option value="">Not selected</option>
          {textModels.map((model) => <option key={modelKey(model)} value={modelKey(model)}>{modelDisplayName(model, textModels)}</option>)}
        </select>
      </Row>

      <div className="stat-label session-settings-heading">Session Retention</div>
      <Row label="Retention Period" hint="Idle completed sessions older than this become eligible for cleanup.">
        <label className="retention-days">
          <input
            type="number"
            min={1}
            max={3650}
            value={retentionDays}
            aria-label="Retention Period"
            onChange={(event) => setSessionDefaults({ retentionDays: Number(event.target.value) || 1 })}
          />
          <span>days</span>
        </label>
      </Row>
      <p className="session-retention-note">
        Expired sessions are archived only when you run manual cleanup. Running, waiting, and already archived sessions are skipped.
      </p>
      <Row label="Manual Cleanup" hint="Archive every session that currently meets the retention rule.">
        <button className="small-btn" disabled={busy || !eligible} onClick={() => void cleanup()}>
          {busy ? "Archiving…" : "Archive eligible sessions"}
        </button>
      </Row>
      <div className="retention-eligible" role="status">
        Eligible for archiving right now: <strong>{eligible ?? "…"}</strong>
      </div>
    </>
  );
}
