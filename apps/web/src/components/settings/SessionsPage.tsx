// Session defaults and technical behavior. Session browsing and lifecycle
// actions belong to the sidebar, never to Settings.
import { useEffect, useState } from "react";
import type { ModelRef, ProjectDefaults } from "@polyth/contracts";
import { api } from "../../api.ts";
import {
  applyProjectUpsert, setOverlay, setActiveView, setUiError, updateSettings, useStore,
} from "../../store.ts";
import { friendlyError } from "../../settings.ts";
import { setGlobalDefaultModel, useSessionDefaults } from "../../sessionDefaults.ts";
import { EmptyState, PageHead, Row, Toggle } from "./parts.tsx";

const modelKey = (model: ModelRef): string => `${model.providerID}/${model.modelID}`;

export default function SessionsPage() {
  const activeProjectId = useStore((s) => s.activeProjectId);
  const projects = useStore((s) => s.projectRegistry.projects);
  const models = useStore((s) => s.models);
  const agents = useStore((s) => s.agents);
  const settings = useStore((s) => s.settings);
  const globalDefaults = useSessionDefaults();
  const [selectedProjectId, setSelectedProjectId] = useState(activeProjectId ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (activeProjectId && !selectedProjectId) setSelectedProjectId(activeProjectId);
  }, [activeProjectId, selectedProjectId]);

  const project = projects.find((candidate) => candidate.id === selectedProjectId) ?? null;
  const globalValue = globalDefaults.defaultModel ? modelKey(globalDefaults.defaultModel) : "";
  const projectValue = project?.defaults?.model ? modelKey(project.defaults.model) : "";

  const modelFrom = (value: string): ModelRef | undefined => {
    const model = models.find((candidate) => modelKey(candidate) === value);
    return model ? { providerID: model.providerID, modelID: model.modelID } : undefined;
  };

  const saveProjectDefaults = async (patch: Partial<ProjectDefaults>) => {
    if (!project) return;
    setBusy(true);
    try {
      const updated = await api.patchProject(project.id, {
        defaults: { ...project.defaults, ...patch },
      });
      applyProjectUpsert(updated);
    } catch (e) {
      setUiError(friendlyError("Couldn’t update project defaults", e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead title="Sessions" blurb="Technical behavior and defaults for new sessions. Existing sessions stay in the sidebar." />
      <div className="stat-label">Global defaults</div>
      <Row
        label="Global default model"
        hint="Used for new projects and sessions when the project does not choose its own model."
        itemId="sessions.defaultModel"
      >
        <select
          aria-label="Global default model"
          value={globalValue}
          onChange={(event) => {
            const value = event.target.value;
            const model = modelFrom(value);
            setGlobalDefaultModel(model);
            updateSettings({ defaultModel: value });
          }}
        >
          <option value="">Server default</option>
          {models.map((model) => (
            <option key={modelKey(model)} value={modelKey(model)}>
              {model.providerName ?? model.providerID} / {model.name || model.modelID}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Auto-title new sessions" hint="Derive a title from the first prompt." itemId="sessions.autoTitle">
        <Toggle on={settings.autoTitleSessions} onChange={(autoTitleSessions) => updateSettings({ autoTitleSessions })} label="Auto-title sessions" />
      </Row>
      <Row label="Expand archived sessions" hint="Show archived sessions immediately in the sidebar." itemId="sessions.showArchived">
        <Toggle on={settings.showArchived} onChange={(showArchived) => updateSettings({ showArchived })} label="Expand archived sessions" />
      </Row>

      <div className="stat-label">Per-project defaults</div>
      {projects.length > 0 && (
        <Row label="Project" hint="Choose which project defaults to edit." itemId="sessions.project">
          <select value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}>
            {projects.map((item) => <option key={item.id} value={item.id}>{item.name || item.path}</option>)}
          </select>
        </Row>
      )}
      {!project && (
        <EmptyState
          title="No project selected"
          body="Global defaults still apply. Open a project to override its model and worktree behavior."
        />
      )}
      {project && (
        <>
          <Row
            label="Project default model"
            hint="Use global follows the global choice above; a project override wins for every new session."
            itemId="sessions.projectModel"
          >
            <select
              disabled={busy}
              aria-label="Project default model"
              value={projectValue}
              onChange={(event) => void saveProjectDefaults({
                model: event.target.value ? modelFrom(event.target.value) : null,
              })}
            >
              <option value="">Use global default</option>
              {models.map((model) => (
                <option key={modelKey(model)} value={modelKey(model)}>
                  {model.providerName ?? model.providerID} / {model.name || model.modelID}
                </option>
              ))}
            </select>
          </Row>
          <Row
            label="Worktree behavior"
            hint="Start sessions in the project root or create a fresh worktree automatically."
            itemId="sessions.worktree"
          >
            <select
              disabled={busy}
              value={project.defaults?.worktreeBehavior ?? "project-root"}
              onChange={(event) => void saveProjectDefaults({
                worktreeBehavior: event.target.value as "project-root" | "fresh-worktree",
              })}
            >
              <option value="project-root">Project root</option>
              <option value="fresh-worktree">Fresh worktree</option>
            </select>
          </Row>
          <Row label="Default agent" hint="Use the backend default or choose an agent preset for new sessions.">
            <select
              disabled={busy}
              value={project.defaults?.agent ?? ""}
              onChange={(event) => void saveProjectDefaults({ agent: event.target.value || null })}
            >
              <option value="">Backend default</option>
              {agents.map((agent) => <option key={agent.name} value={agent.name}>{agent.name}</option>)}
            </select>
          </Row>
          <Row label="Sidebar grouping" hint="Technical grouping preference for sessions in this project.">
            <select
              disabled={busy}
              value={project.defaults?.groupingMode ?? "status"}
              onChange={(event) => void saveProjectDefaults({ groupingMode: event.target.value })}
            >
              <option value="status">By status</option>
              <option value="worktree">By worktree</option>
              <option value="none">No grouping</option>
            </select>
          </Row>
        </>
      )}
      <Row label="Scheduled prompts" hint="Automation belongs in Schedule, not in the session defaults list.">
        <button className="small-btn" onClick={() => { setOverlay(null); setActiveView("schedule"); }}>Open Schedule →</button>
      </Row>
    </>
  );
}
