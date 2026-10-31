import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import { api, type AgentDraftDto, type AgentEventSourceDto, type ScheduleTaskDto } from "@polyth/session/web-api";
import { openSettingsPage, useStore } from "../../../apps/web/src/store.ts";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import { useShellMode } from "../../../apps/web/src/responsiveShell.ts";
import EmptyState from "../../../apps/web/src/components/EmptyState.tsx";
import { Button, confirmAlert, Notice, Skeleton } from "../../../apps/web/src/components/ui/index.ts";
import { cadencesEqual } from "../src/cadenceView.ts";
import { cadenceOfTask } from "../src/plannerTask.ts";
import { agentIdFrom } from "../src/agentFile.ts";
import AgentEditor from "./AgentEditor.tsx";
import AgentStart from "./AgentStart.tsx";
import AgentScreen from "./AgentScreen.tsx";
import AgentsHome from "./AgentsHome.tsx";
import PageBar from "./PageBar.tsx";
import {
  activationBlockers,
  applyModelDraft,
  draftFromTask,
  draftFromTemplate,
  draftToInput,
  emptyDraft,
  type AgentDraftState,
  type AgentTemplate,
} from "./agentModel.ts";
import { onAgentSeed, takeAgentSeed, type AgentSeed } from "./agentSeed.ts";
import { reviewLoopVersion } from "./plannerTaskActions.ts";
import { resolveScheduleProjectId } from "./scheduleData.ts";
import { agentsSnapshot, putAgent, refreshAgents, useAgents } from "./agentsStore.ts";
import { AGENTS_PAGE_ID, NEW_AGENT_RESOURCE, openAgent } from "./agentActions.ts";

const message = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

// Unsaved settings outlive leaving the page: navigation belongs to the
// navigator, which never asks, so a half-edited agent waits here instead of
// being lost. Kept in memory for this window only.
const unsaved = new Map<string, { draft: AgentDraftState; baseline: string }>();

/** Webhook URLs issued by the last save; shown once, never refetchable. */
type HookUrls = Record<string, string>;

/** The agents' page in place of Chat: an agent's own screen, the start of a
 *  new agent, or (without a resource) what waits for the person across all
 *  agents. Which one comes from the navigator, like a chat. */
export default function AgentsPage({ host, resource }: { host?: WebPackageHost; resource: string | null }) {
  const shellMode = useShellMode();
  const projects = useStore((state) => state.projectRegistry.projects);
  const activeProjectId = useStore((state) => state.activeProjectId);
  const { agents, loopErrors, error: loadError } = useAgents();
  const [sources, setSources] = useState<AgentEventSourceDto[]>([]);
  const [seed, setSeed] = useState<AgentSeed | null>(() => takeAgentSeed());
  const [newDraft, setNewDraft] = useState<{ draft: AgentDraftState; drafted: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fileError, setFileError] = useState("");
  // Webhook URLs issued by the last save belong to the agent they were issued for.
  const [hooks, setHooks] = useState<{ agentId: string; urls: HookUrls } | null>(null);

  useEffect(() => {
    void api.scheduleSources().then(setSources).catch(() => setSources([]));
  }, []);
  // "Make an agent" from a chat lands on the start page with that chat.
  useEffect(() => onAgentSeed(() => {
    const next = takeAgentSeed();
    if (!next) return;
    setSeed(next);
    setNewDraft(null);
    host?.navigation.openPage?.(AGENTS_PAGE_ID, NEW_AGENT_RESOURCE, { projectId: next.projectId });
  }), [host]);

  const isNew = resource === NEW_AGENT_RESOURCE;
  const agentId = resource && !isNew ? resource : null;
  const agent = agentId ? agents?.find((item) => item.id === agentId) : undefined;
  const defaultProjectId = resolveScheduleProjectId(projects, activeProjectId, null) || projects[0]?.id || "";

  // Leaving the new-agent page forgets its unsaved start.
  useEffect(() => {
    if (!isNew) setNewDraft(null);
    setError("");
    setFileError("");
  }, [isNew, agentId]);
  // An agent deleted elsewhere takes its page with it — once a fresh list
  // confirms it is gone, never on a list read before the page opened.
  const missing = !!agentId && !!agents && !agent;
  useEffect(() => {
    if (!missing || !agentId) return;
    let live = true;
    void refreshAgents().then(() => {
      if (live && !agentsSnapshot().agents?.some((item) => item.id === agentId)) host?.navigation.closePage?.();
    });
    return () => { live = false; };
  }, [missing, agentId, host]);

  const act = async (work: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError("");
    try {
      await work();
      return true;
    } catch (cause) {
      setError(message(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const rememberHooks = (forAgent: string, tokens: Record<string, string> | undefined) => {
    if (!tokens || !Object.keys(tokens).length) return;
    const base = typeof window !== "undefined" ? window.location.origin : "";
    const urls = Object.fromEntries(Object.entries(tokens).map(([id, token]) => [id, `${base}/hooks/schedule/${token}`]));
    setHooks((current) => ({ agentId: forAgent, urls: current?.agentId === forAgent ? { ...current.urls, ...urls } : urls }));
  };

  // ---- an existing agent's settings ------------------------------------------
  const [, bumpSettings] = useState(0);
  const settingsOf = useCallback((task: ScheduleTaskDto) => {
    const saved = unsaved.get(task.id);
    if (saved) return saved;
    const draft = draftFromTask(task, getLocale());
    return { draft, baseline: JSON.stringify(draft) };
  }, []);
  const setSettingsDraft = (task: ScheduleTaskDto, next: AgentDraftState) => {
    const baseline = settingsOf(task).baseline;
    if (JSON.stringify(next) === baseline) unsaved.delete(task.id);
    else unsaved.set(task.id, { draft: next, baseline });
    bumpSettings((value) => value + 1);
  };
  const resetSettings = (task: ScheduleTaskDto) => {
    unsaved.delete(task.id);
    bumpSettings((value) => value + 1);
  };
  const otherAgents = useMemo(
    () => (agents ?? [])
      .filter((item) => item.id !== agentId)
      .map((item) => ({ id: item.id, name: item.title?.trim() || item.prompt.split("\n")[0]!.slice(0, 60) })),
    [agents, agentId],
  );

  const saveSettings = async (task: ScheduleTaskDto, enabled: boolean) => {
    const { draft } = settingsOf(task);
    if (activationBlockers(draft).length || fileError) return;
    const input = draftToInput(draft, enabled);
    // Re-sending an unchanged one-shot cadence would re-arm a finished run.
    const original = cadenceOfTask(task);
    if (original && input.cadence && cadencesEqual(original, input.cadence)) delete input.cadence;
    let saved: (ScheduleTaskDto & { webhookTokens?: Record<string, string> }) | null = null;
    if (!await act(async () => { saved = await api.scheduleUpdate(task.id, input); }) || !saved) return;
    const next: ScheduleTaskDto & { webhookTokens?: Record<string, string> } = saved;
    rememberHooks(next.id, next.webhookTokens);
    unsaved.delete(task.id);
    putAgent(next);
    bumpSettings((value) => value + 1);
    void refreshAgents();
  };

  // A webhook address is stored only as a fingerprint: a lost one is replaced
  // by saving the wake under a new id, which issues a new address. Only the
  // saved wakes are sent, so unsaved edits stay unsaved.
  const renewHook = async (task: ScheduleTaskDto, triggerId: string) => {
    const ok = await confirmAlert(tr("agents.webhookNewConfirm"), {
      title: tr("agents.webhookNewTitle"),
      confirmLabel: tr("agents.webhookNew"),
    });
    if (!ok) return;
    // A new id, unused by the saved wakes and by any unsaved one.
    const taken = new Set([...(task.eventTriggers ?? []), ...(unsaved.get(task.id)?.draft.eventTriggers ?? [])].map((trigger) => trigger.id));
    const base = triggerId.replace(/-r\d+$/, "").slice(0, 34);
    let id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base}-r${n}`;
    const renamed = (list: readonly NonNullable<ScheduleTaskDto["eventTriggers"]>[number][]) =>
      list.map((trigger) => trigger.id !== triggerId ? trigger : (({ hasToken: _drop, ...rest }) => ({ ...rest, id }))(trigger as typeof trigger & { hasToken?: boolean }));
    let saved: (ScheduleTaskDto & { webhookTokens?: Record<string, string> }) | null = null;
    if (!await act(async () => { saved = await api.scheduleUpdate(task.id, { eventTriggers: renamed(task.eventTriggers ?? []) }); }) || !saved) return;
    const next: ScheduleTaskDto & { webhookTokens?: Record<string, string> } = saved;
    // An unsaved draft follows the wake to its new id.
    const pending = unsaved.get(task.id);
    if (pending) {
      const draft = { ...pending.draft, eventTriggers: renamed(pending.draft.eventTriggers) };
      const baseline = JSON.parse(pending.baseline) as AgentDraftState;
      unsaved.set(task.id, { draft, baseline: JSON.stringify({ ...baseline, eventTriggers: renamed(baseline.eventTriggers) }) });
    }
    rememberHooks(next.id, next.webhookTokens);
    putAgent(next);
    bumpSettings((value) => value + 1);
    void refreshAgents();
  };

  // ---- a new agent -----------------------------------------------------------
  const createAgent = async (enabled: boolean) => {
    if (!newDraft || activationBlockers(newDraft.draft).length || fileError) return;
    let created: (ScheduleTaskDto & { webhookTokens?: Record<string, string> }) | null = null;
    if (!await act(async () => { created = await api.scheduleCreate(draftToInput(newDraft.draft, enabled)); }) || !created) return;
    const saved: ScheduleTaskDto & { webhookTokens?: Record<string, string> } = created;
    putAgent(saved);
    setNewDraft(null);
    setSeed(null);
    const issued = Object.keys(saved.webhookTokens ?? {}).length > 0;
    if (host) openAgent(host, saved, issued ? "settings" : undefined);
    rememberHooks(saved.id, saved.webhookTokens);
    void refreshAgents();
  };
  const startFromTemplate = (template: AgentTemplate) => {
    setNewDraft({ draft: draftFromTemplate(template, defaultProjectId), drafted: false });
    if (!isNew) host?.navigation.openPage?.(AGENTS_PAGE_ID, NEW_AGENT_RESOURCE, { projectId: defaultProjectId });
  };

  const review = async (task: ScheduleTaskDto, action: "trust-current" | "run-once" | "reject") => {
    if (await reviewLoopVersion(task.id, action)) void refreshAgents();
  };
  const writeFile = async (task: ScheduleTaskDto, action: "export" | "convert") => {
    let written: (ScheduleTaskDto & { filePath: string }) | null = null;
    if (await act(async () => { written = await api.scheduleFileAction(task.id, action); }) && written) {
      const saved: ScheduleTaskDto & { filePath: string } = written;
      unsaved.delete(task.id);
      putAgent(saved);
      void refreshAgents();
    }
  };

  // ---- render ------------------------------------------------------------------
  const frame = (content: ReactNode, page: string, title?: string) => (
    <div className="agents-page" data-shell-mode={shellMode} data-page={page}>
      {title !== undefined && <PageBar title={title} />}
      {content}
    </div>
  );

  if (projects.length === 0) {
    return frame(
      <EmptyState
        title={tr("scheduleview.noProjectsYet")}
        description={tr("agents.needProject")}
        actionLabel={tr("scheduleview.openProjects")}
        onAction={() => openSettingsPage("projects")}
      />,
      "empty",
      tr("agents.navSection"),
    );
  }

  if (isNew) {
    if (!newDraft) {
      return frame(
        <div className="agents-scroll">
          <div className="agents-column">
            <AgentStart
              projects={projects}
              projectId={seed?.projectId ?? defaultProjectId}
              seed={seed}
              onTemplate={startFromTemplate}
              onDrafted={(result: AgentDraftDto, projectId) => {
                const base = { ...emptyDraft(projectId), ...(seed?.model ? { model: seed.model } : {}), ...(seed?.harness ? { harness: seed.harness } : {}) };
                setNewDraft({ draft: applyModelDraft(base, result, getLocale()), drafted: true });
              }}
              onScratch={(projectId, description) => {
                const base = { ...emptyDraft(projectId), ...(seed?.model ? { model: seed.model } : {}) };
                setNewDraft({ draft: { ...base, charter: description }, drafted: false });
              }}
            />
          </div>
        </div>,
        "start",
        tr("agents.newAgent"),
      );
    }
    const blockers = [...(fileError ? [tr("agents.blockerFile")] : []), ...activationBlockers(newDraft.draft)];
    return frame(
      <div className="agents-scroll">
        <div className="agents-column agents-new">
          {newDraft.drafted && <Notice tone="info">{tr("agents.draftedNotice")}</Notice>}
          {error && <Notice tone="error">{error}</Notice>}
          <AgentEditor
            draft={newDraft.draft}
            onChange={(draft) => setNewDraft({ ...newDraft, draft })}
            projects={projects}
            task={null}
            otherAgents={otherAgents}
            sources={sources}
            fileId={agentIdFrom(newDraft.draft.name)}
            onFileError={setFileError}
            {...(host ? { host } : {})}
            footer={(
              <>
                {blockers.length > 0 && <span className="agent-footer-reason">{blockers[0]}</span>}
                <Button variant="ghost" disabled={busy} onClick={() => setNewDraft(null)}>{tr("common.back")}</Button>
                <Button disabled={busy || blockers.length > 0} onClick={() => void createAgent(false)}>{tr("agents.saveDraft")}</Button>
                <Button variant="primary" busy={busy} disabled={busy || blockers.length > 0} onClick={() => void createAgent(true)}>
                  {tr("scheduleview.activate")}
                </Button>
              </>
            )}
          />
        </div>
      </div>,
      "new",
      newDraft.draft.name.trim() || tr("agents.newAgent"),
    );
  }

  if (agentId) {
    if (!agent) {
      return frame(
        <div className="agents-loading" role="status" aria-label={tr("agents.loading")}>
          <Skeleton shape="text" />
          <Skeleton shape="block" />
        </div>,
        "loading",
      );
    }
    const settings = settingsOf(agent);
    const dirty = unsaved.has(agent.id);
    const blockers = [...(fileError ? [tr("agents.blockerFile")] : []), ...activationBlockers(settings.draft)];
    const project = projects.find((item) => item.id === agent.projectId);
    return frame(
      <AgentScreen
        host={host}
        agent={agent}
        error={error}
        onDismissError={() => setError("")}
        onReview={(action) => void review(agent, action)}
        {...(agent.source !== "loop-file" && !project?.remote ? { onExport: () => void writeFile(agent, "export") } : {})}
        {...(agent.source === "loop-file" && /[\\/]\.agents[\\/]loops[\\/]/.test(agent.sourcePath ?? "")
          && (agent as ScheduleTaskDto & { trustState?: string }).trustState === "trusted-current-version"
          ? { onConvert: () => void writeFile(agent, "convert") } : {})}
        settingsDirty={dirty}
        settings={(
          <AgentEditor
            draft={settings.draft}
            onChange={(next) => setSettingsDraft(agent, next)}
            projects={projects}
            task={agent}
            readOnly={agent.source === "loop-file"}
            otherAgents={otherAgents}
            sources={sources}
            hookUrls={hooks?.agentId === agent.id ? hooks.urls : {}}
            fileId={agent.loopId ?? agentIdFrom(settings.draft.name)}
            onFileError={setFileError}
            onRenewHook={(triggerId) => renewHook(agent, triggerId)}
            {...(host ? { host } : {})}
            footer={agent.source === "loop-file" || !dirty ? null : (
              <>
                <span className="agent-footer-reason">{blockers[0] ?? tr("agents.unsavedChanges")}</span>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => resetSettings(agent)}>{tr("agents.discardChanges")}</Button>
                <Button size="sm" variant="primary" busy={busy} disabled={busy || blockers.length > 0} onClick={() => void saveSettings(agent, agent.enabled)}>
                  {tr("agents.applyToNextRuns")}
                </Button>
              </>
            )}
          />
        )}
      />,
      "agent",
    );
  }

  // The agents' home.
  if (agents === null && !loadError) {
    return frame(
      <div className="agents-loading" role="status" aria-label={tr("agents.loading")}>
        <Skeleton shape="text" />
        <Skeleton shape="block" />
      </div>,
      "home",
      tr("agents.navSection"),
    );
  }
  return frame(
    <AgentsHome
      host={host}
      agents={agents ?? []}
      projects={projects}
      loopErrors={loopErrors}
      loadError={loadError}
      onTemplate={startFromTemplate}
    />,
    "home",
    tr("agents.navSection"),
  );
}
