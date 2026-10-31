import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { HarnessSelection, Project } from "@polyth/contracts";
import type { WebPackageHost } from "@polyth/web-sdk";
import { api, type AgentEventSourceDto, type AgentEventLogEntryDto, type AgentEventTriggerDto, type ScheduleTaskDto } from "@polyth/session/web-api";
import ModelPicker from "@polyth/models/model-picker";
import { useRuntimeCatalog } from "@polyth/models/runtime-catalog";
import { useStore } from "../../../apps/web/src/store.ts";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import {
  Button,
  CodeIcon,
  EditIcon,
  HeartbeatIcon,
  Icon,
  Menu,
  Notice,
  PlusIcon,
  type MenuEntry,
  Select,
  Switch,
  Tabs,
  Textarea,
  TextInput,
} from "../../../apps/web/src/components/ui/index.ts";
import { composeAgentPrompt } from "../src/agentPrompt.ts";
import { AGENT_ICON_IDS } from "../src/agentPrompt.ts";
import { beatsPerDay, CHECKLIST_LIMIT, clockOf, HEARTBEAT_STEPS } from "../src/agentHeartbeat.ts";
import { intervalLabel } from "./agentText.ts";
import { defaultWeeklyView, validateCadenceView, viewToCadence } from "../src/cadenceView.ts";
import AgentGlyph from "./AgentGlyph.tsx";
import { formatWake } from "./agentTime.ts";
import {
  AGENT_COLORS,
  charterTokens,
  heartbeatOf,
  parseBudget,
  newEventTrigger,
  type AgentDraftState,
  type ContextMode,
  type ExecutionModel,
  type PermissionChoice,
} from "./agentModel.ts";
import PlannerProjectPicker from "./PlannerProjectPicker.tsx";
import EventTriggerRow from "./EventTriggerRow.tsx";
import BackupModels from "./BackupModels.tsx";
import AgentFileEditor from "./AgentFileEditor.tsx";
import PlannerScheduleFields, { type EditableCadenceView } from "./PlannerScheduleFields.tsx";
import { recurrenceSummary } from "./plannerShared.ts";

type SectionId = "identity" | "charter" | "wakes" | "reports" | "skills" | "context" | "budget";

/** "08:00" → 480; anything else → undefined. */
const minutesOf = (value: string): number | undefined => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : undefined;
};

const PERMISSION_CHOICES: readonly PermissionChoice[] = ["inherit", "ask", "routine", "all"];
const permissionLabel = (choice: PermissionChoice): string => tr(`agents.permission.${choice}`);

// Advanced settings: one choice for every agent, kept in this browser.
const ADVANCED_KEY = "polyth.agents.advancedSettings";
const advancedListeners = new Set<() => void>();
function readAdvanced(): boolean {
  try { return globalThis.localStorage?.getItem(ADVANCED_KEY) === "1"; } catch { return false; }
}
function writeAdvanced(on: boolean): void {
  try {
    if (on) globalThis.localStorage?.setItem(ADVANCED_KEY, "1");
    else globalThis.localStorage?.removeItem(ADVANCED_KEY);
  } catch { /* private mode: this window only */ }
  for (const listener of advancedListeners) listener();
}
function useAdvanced(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    (listener) => { advancedListeners.add(listener); return () => { advancedListeners.delete(listener); }; },
    readAdvanced,
    () => false,
  );
  return [on, writeAdvanced];
}

/** One part of the settings, always open: a heading, a sentence on what it
 *  decides, and its fields. */
function Section({
  id,
  title,
  lead,
  children,
}: {
  id: SectionId;
  title: string;
  lead?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section className="agent-section" data-section={id} aria-labelledby={headingId}>
      <header className="agent-section-header">
        <h2 className="agent-section-title" id={headingId}>{title}</h2>
        {lead && <p className="agent-section-lead">{lead}</p>}
      </header>
      <div className="agent-section-body">{children}</div>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="agent-field">
      <span className="agent-field-label">{label}</span>
      {children}
      {hint && <span className="agent-field-hint">{hint}</span>}
    </label>
  );
}

function eventLogLabel(entry: AgentEventLogEntryDto): string {
  const count = entry.count;
  if (entry.outcome === "fired") return tr("agents.logFiredValue", { count });
  if (entry.outcome === "rate-limited") return tr("agents.logRateLimitedValue", { count });
  if (entry.outcome === "chain-limit") return tr("agents.logChainLimit");
  if (entry.outcome === "budget") return tr("agents.logBudget");
  if (entry.outcome === "script-skip") return tr("agents.logScriptSkip") + (entry.text ? ` — ${entry.text}` : "");
  if (entry.outcome === "script-pause") return tr("agents.logScriptPause") + (entry.text ? ` — ${entry.text}` : "");
  if (entry.outcome === "script-error") return tr("agents.logScriptErrorValue", { error: entry.text ?? "" });
  return tr("agents.logBusy");
}

export default function AgentEditor({
  draft,
  onChange,
  projects,
  task,
  readOnly,
  host,
  footer,
  otherAgents = [],
  sources = [],
  hookUrls = {},
  fileId,
  onFileError,
  onRenewHook,
}: {
  draft: AgentDraftState;
  onChange: (next: AgentDraftState) => void;
  projects: readonly Project[];
  /** The saved agent when editing; drives the preview's journal context. */
  task: ScheduleTaskDto | null;
  /** Repository-managed agents: their definition lives in a file. */
  readOnly?: boolean;
  host?: WebPackageHost;
  footer: ReactNode;
  /** Agents this one may wake after (never itself). */
  otherAgents?: ReadonlyArray<{ id: string; name: string }>;
  /** Registered integration sources. */
  sources?: readonly AgentEventSourceDto[];
  /** Webhook URLs issued by the last save, by wake id (shown once). */
  hookUrls?: Readonly<Record<string, string>>;
  /** Id the agent has (or would have) as `.agents/agents/<id>.md`. */
  fileId: string;
  /** An invalid "Edit as file" text, which blocks saving; "" when valid. */
  onFileError: (error: string) => void;
  /** Issue a new address for a saved webhook wake. */
  onRenewHook?: (triggerId: string) => Promise<void>;
}) {
  const [view, setView] = useState<"form" | "file">("form");
  const [advanced, setAdvanced] = useAdvanced();
  const advancedId = useId();
  // A freshly issued webhook URL is shown once: bring it into view.
  const wakesRef = useRef<HTMLDivElement>(null);
  const hookKey = Object.keys(hookUrls).join(",");
  useEffect(() => {
    // Only the settings' own scroller moves: scrollIntoView would also shift
    // the page's clipped ancestors.
    const hook = hookKey ? wakesRef.current?.querySelector<HTMLElement>(".agent-hook") : null;
    const scroller = hook?.closest<HTMLElement>(".agents-scroll");
    if (!hook || !scroller) return;
    const offset = hook.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop += offset - scroller.clientHeight / 3;
  }, [hookKey]);
  const set = <K extends keyof AgentDraftState>(key: K, value: AgentDraftState[K]) => onChange({ ...draft, [key]: value });

  const project = projects.find((item) => item.id === draft.projectId);
  const allSessions = useStore((state) => state.sessions);
  const projectSessions = useMemo(
    () => allSessions.filter((session) => session.projectId === draft.projectId && session.status !== "archived"),
    [allSessions, draft.projectId],
  );

  // Execution route: the same catalog and picker the composer uses.
  const globalModels = useStore((state) => state.models);
  const globalAgents = useStore((state) => state.agents);
  const spaceId = project?.spaceId;
  const selectedHarnessId = draft.harness.mode === "pinned" ? draft.harness.harnessId : undefined;
  const routeCatalog = useRuntimeCatalog(null, globalModels, globalAgents, {
    ...(spaceId ? { spaceId } : {}),
    ...(draft.projectId ? { projectId: draft.projectId } : {}),
    ...(selectedHarnessId ? { harnessId: selectedHarnessId } : {}),
  });
  const catalogHarnessId = selectedHarnessId ?? routeCatalog.harnessId ?? draft.model?.harnessId;
  const executionModels = useMemo(
    () => catalogHarnessId
      ? routeCatalog.models.filter((candidate) => !candidate.harnessId || candidate.harnessId === catalogHarnessId)
      : routeCatalog.models,
    [routeCatalog.models, catalogHarnessId],
  );
  const pickModel = (ref?: ExecutionModel) => {
    if (!ref) return;
    onChange({ ...draft, model: ref, ...(ref.harnessId ? { harness: { mode: "pinned", harnessId: ref.harnessId } } : {}) });
  };

  const editableView: EditableCadenceView | null = draft.view.mode === "once" || draft.view.mode === "weekly" || draft.view.mode === "monthly"
    ? draft.view
    : null;
  const cadenceOk = validateCadenceView(draft.view).ok;
  const wakeSummary = draft.scheduled
    ? cadenceOk ? recurrenceSummary(viewToCadence(draft.view)) : tr("agents.blockerSchedule")
    : tr("agents.onDemand");
  const heartbeat = heartbeatOf(draft);
  const setHeartbeat = (on: boolean) => onChange({
    ...draft,
    heartbeatOn: on,
    // A heartbeat continues one ongoing conversation.
    ...(on && draft.context !== "rolling" ? { context: "rolling" as ContextMode } : {}),
  });
  const agentName = (id: string) => otherAgents.find((agent) => agent.id === id)?.name ?? "";
  const setTriggers = (eventTriggers: AgentEventTriggerDto[]) => onChange({ ...draft, eventTriggers });
  const addEntries: MenuEntry[] = [
    { id: "session-failed", label: tr("agents.addWakeSessionFailed"), onSelect: () => setTriggers([...draft.eventTriggers, newEventTrigger("session-failed", draft.eventTriggers)]) },
    { id: "session-completed", label: tr("agents.addWakeSessionCompleted"), onSelect: () => setTriggers([...draft.eventTriggers, newEventTrigger("session-completed", draft.eventTriggers)]) },
    {
      id: "agent",
      label: tr("agents.addWakeAgent"),
      disabled: otherAgents.length === 0,
      ...(otherAgents.length === 0 ? { detail: tr("agents.noOtherAgents") } : {}),
      onSelect: () => setTriggers([...draft.eventTriggers, newEventTrigger("agent", draft.eventTriggers, otherAgents.length === 1 ? otherAgents[0]!.id : "")]),
    },
    { id: "webhook", label: tr("agents.addWakeWebhook"), onSelect: () => setTriggers([...draft.eventTriggers, newEventTrigger("webhook", draft.eventTriggers)]) },
    ...(sources.length ? ["separator" as const] : []),
    ...sources.map((source): MenuEntry => ({
      id: `source-${source.id}`,
      label: tr("agents.addWakeSourceValue", { source: source.label }),
      onSelect: () => setTriggers([...draft.eventTriggers, newEventTrigger("integration", draft.eventTriggers, source.id, source.types.map((type) => type.id))]),
    })),
  ];

  // Next wakes, from the same cadence path the executor uses.
  const [upcoming, setUpcoming] = useState<number[]>([]);
  const cadenceKey = draft.scheduled && cadenceOk ? JSON.stringify(viewToCadence(draft.view)) : "";
  useEffect(() => {
    if (!cadenceKey) { setUpcoming([]); return; }
    let live = true;
    const timer = setTimeout(() => {
      void api.schedulePreview(JSON.parse(cadenceKey), 5)
        .then((preview) => { if (live) setUpcoming(Array.isArray(preview?.runs) ? preview.runs : []); })
        .catch(() => { if (live) setUpcoming([]); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [cadenceKey]);

  const tokens = charterTokens(draft.charter);
  const firstRun = useMemo(() => composeAgentPrompt(
    {
      prompt: draft.charter || "…",
      cadence: viewToCadence(draft.view),
      history: task?.history ?? [],
      ...(task?.notebook ? { notebook: task.notebook } : {}),
      ...(heartbeat ? { heartbeat } : {}),
    },
    { trigger: draft.scheduled ? "schedule" : heartbeat ? "heartbeat" : "manual", at: upcoming[0] ?? Date.now() },
    { continuing: false },
  ), [draft.charter, draft.view, draft.scheduled, task?.history, task?.notebook, upcoming, JSON.stringify(heartbeat)]);
  const budgetInvalid = new Set(parseBudget(draft).invalid);

  const contextHint = draft.context === "rolling"
    ? tr("agents.contextRollingHint")
    : draft.context === "session"
      ? tr("agents.contextSessionHint")
      : tr("agents.contextFreshHint");

  const permissionWarning = draft.permissions === "all" && <Notice tone="warning">{tr("agents.permissionAllWarning")}</Notice>;

  return (
    <div className="agent-editor" data-advanced={advanced || undefined}>
      <div className="agent-form-column">
      <div className="agent-editor-bar">
        <p className="agent-editor-note">
          {readOnly ? tr("agents.fileReadOnly") : task ? tr("scheduleview.changesApplyToFutureRuns") : tr("agents.newAgentNote")}
        </p>
        <div className="agent-editor-tools">
          {advanced && (
            <Button size="sm" variant="ghost" iconStart={view === "form" ? CodeIcon : EditIcon} onClick={() => setView(view === "form" ? "file" : "form")}>
              {view === "form" ? tr("agents.openAsFile") : tr("agents.openAsForm")}
            </Button>
          )}
          <span className="agent-advanced-switch">
            <span id={advancedId}>{tr("agents.advancedSettings")}</span>
            <Switch
              checked={advanced}
              labelledBy={advancedId}
              onChange={(on) => {
                setAdvanced(on);
                if (!on) setView("form");
              }}
            />
          </span>
        </div>
      </div>
      {view === "file" && advanced ? (
        <AgentFileEditor draft={draft} fileId={fileId} readOnly={readOnly} onChange={onChange} onError={onFileError} />
      ) : (
      <fieldset className="agent-form" disabled={readOnly}>
        <Section id="identity" title={tr("agents.sectionIdentity")} lead={tr("agents.leadIdentity")}>
          <Field label={tr("agents.name")}>
            <TextInput
              value={draft.name}
              invalid={!draft.name.trim()}
              placeholder={tr("agents.namePlaceholder")}
              onChange={(event) => set("name", event.target.value)}
            />
          </Field>
          <Field label={tr("agents.purpose")}>
            <TextInput
              value={draft.description}
              placeholder={tr("agents.purposePlaceholder")}
              onChange={(event) => set("description", event.target.value)}
            />
          </Field>
          <div className="agent-field">
            <span className="agent-field-label" id="agent-look-label">{tr("agents.look")}</span>
            <div className="agent-look" role="group" aria-labelledby="agent-look-label">
              <div className="agent-icon-grid">
                {AGENT_ICON_IDS.map((icon) => (
                  <button
                    key={icon}
                    type="button"
                    className="agent-icon-choice"
                    aria-pressed={draft.icon === icon}
                    aria-label={tr("agents.iconValue", { icon })}
                    onClick={() => set("icon", icon)}
                  >
                    <AgentGlyph icon={icon} color={draft.icon === icon ? draft.color : "neutral"} size="sm" />
                  </button>
                ))}
              </div>
              <div className="agent-color-row">
                {AGENT_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className="agent-color-choice"
                    data-color={color}
                    aria-pressed={draft.color === color}
                    aria-label={tr(`agents.color.${color}`)}
                    onClick={() => set("color", color)}
                  />
                ))}
              </div>
            </div>
          </div>
          <div className="agent-field-row">
            <Field label={tr("scheduleview.project")}>
              <PlannerProjectPicker
                label={tr("scheduleview.project")}
                projects={projects}
                value={draft.projectId || null}
                onChange={(id) => {
                  if (!id || id === draft.projectId) return;
                  onChange({ ...draft, projectId: id, model: undefined, sessionId: "" });
                }}
              />
            </Field>
            <div className="agent-field">
              <span className="agent-field-label">{tr("agents.model")}</span>
              <div className="agent-model">
                <ModelPicker
                  models={executionModels}
                  {...(catalogHarnessId ? { harnessId: catalogHarnessId } : {})}
                  {...(draft.model ? { value: draft.model } : {})}
                  catalogLoading={routeCatalog.discovery.state === "pending"}
                  header={host ? (
                    <host.ui.Slot
                      slot="modelPicker.header"
                      context={{
                        ...(spaceId ? { spaceId } : {}),
                        ...(draft.projectId ? { projectId: draft.projectId } : {}),
                        harnessSelection: draft.harness,
                        ...(catalogHarnessId ? { resolvedHarnessId: catalogHarnessId } : {}),
                        pendingHarnessSelection: draft.harness,
                        onSelectHarness: (selection: HarnessSelection) => set("harness", selection),
                      }}
                    />
                  ) : undefined}
                  onPick={pickModel}
                />
              </div>
            </div>
          </div>
          {advanced && (
            <BackupModels
              draft={draft}
              {...(spaceId ? { spaceId } : {})}
              {...(host ? { host } : {})}
              onChange={(backups) => set("backups", backups)}
            />
          )}
        </Section>

        <Section id="charter" title={tr("agents.sectionCharter")} lead={tr("agents.leadCharter")}>
          <Textarea
            className="agent-charter"
            aria-label={tr("agents.sectionCharter")}
            autoGrow
            minRows={6}
            maxRows={24}
            value={draft.charter}
            invalid={!draft.charter.trim()}
            placeholder={tr("agents.charterPlaceholder")}
            onChange={(event) => set("charter", event.target.value)}
          />
          {advanced && (
            <>
              <p className="agent-field-hint">
                {tr("agents.tokensValue", { count: tokens.toLocaleString(getLocale()) })}
                {" · "}
                {draft.context === "rolling" ? tr("agents.charterRollingNote") : tr("agents.charterFreshNote")}
              </p>
              <details className="agent-dry-run">
                <summary>
                  {tr("agents.firstRunSends")}
                  <span>{tr("agents.firstRunTokensValue", { count: charterTokens(firstRun).toLocaleString(getLocale()) })}</span>
                </summary>
                <pre>{firstRun}</pre>
              </details>
            </>
          )}
        </Section>

        <Section id="wakes" title={tr("agents.sectionWakes")} lead={tr("agents.leadWakes")}>
          <div className="agent-wakes" ref={wakesRef}>
          <div className="agent-wake">
            <div className="agent-wake-head">
              <span className="agent-wake-title">{tr("agents.onSchedule")}</span>
              <Switch checked={draft.scheduled} onChange={(next) => set("scheduled", next)} label={tr("agents.onSchedule")} />
            </div>
            {draft.scheduled && (
              <div className="agent-wake-body">
                {editableView ? (
                  <PlannerScheduleFields view={editableView} onChange={(view) => set("view", view)} />
                ) : (
                  <div className="agent-wake-legacy">
                    <span>{wakeSummary}</span>
                    <Button size="sm" onClick={() => set("view", defaultWeeklyView())}>{tr("scheduleview.changeSchedule")}</Button>
                  </div>
                )}
                {upcoming.length > 0 && (
                  <p className="agent-upcoming">
                    <span>{tr("agents.nextWakes")}</span>
                    {upcoming.slice(0, 3).map((at) => <time key={at} dateTime={new Date(at).toISOString()}>{formatWake(at)}</time>)}
                  </p>
                )}
                {advanced && (
                  <Field label={tr("scheduleview.ifMissed")}>
                    <Select
                      label={tr("scheduleview.ifMissed")}
                      value={draft.catchUp}
                      options={[
                        { value: "once", label: tr("scheduleview.catchUpOnce") },
                        { value: "skip", label: tr("scheduleview.catchUpSkip") },
                      ]}
                      onChange={(value) => set("catchUp", value as AgentDraftState["catchUp"])}
                    />
                  </Field>
                )}
              </div>
            )}
          </div>
          <div className="agent-wake" data-kind="heartbeat">
            <div className="agent-wake-head">
              <span className="agent-wake-title"><Icon icon={HeartbeatIcon} size="sm" />{tr("agents.heartbeat")}</span>
              <Switch checked={draft.heartbeatOn} onChange={setHeartbeat} label={tr("agents.heartbeat")} />
            </div>
            <p className="agent-wake-note">{tr("agents.heartbeatHint")}</p>
            {draft.heartbeatOn && (
              <div className="agent-wake-body">
                <div className="agent-field-row">
                  <Field label={tr("agents.heartbeatEvery")}>
                    <Select
                      label={tr("agents.heartbeatEvery")}
                      value={String(draft.heartbeatEvery)}
                      options={[...new Set([...HEARTBEAT_STEPS, draft.heartbeatEvery])].sort((a, b) => a - b)
                        .map((minutes) => ({ value: String(minutes), label: intervalLabel(minutes) }))}
                      onChange={(value) => set("heartbeatEvery", Number(value))}
                    />
                  </Field>
                  <Field label={tr("agents.heartbeatActive")}>
                    <Select
                      label={tr("agents.heartbeatActive")}
                      value={draft.heartbeatAllDay ? "all" : "hours"}
                      options={[
                        { value: "hours", label: tr("agents.heartbeatHours") },
                        { value: "all", label: tr("agents.heartbeatAllDay") },
                      ]}
                      onChange={(value) => set("heartbeatAllDay", value === "all")}
                    />
                  </Field>
                </div>
                {!draft.heartbeatAllDay && (
                  <div className="agent-field-row">
                    <Field label={tr("agents.heartbeatFrom")}>
                      <TextInput
                        type="time"
                        value={clockOf(draft.heartbeatFrom)}
                        onChange={(event) => {
                          const minutes = minutesOf(event.target.value);
                          if (minutes !== undefined) set("heartbeatFrom", minutes);
                        }}
                      />
                    </Field>
                    <Field label={tr("agents.heartbeatTo")}>
                      <TextInput
                        type="time"
                        value={clockOf(draft.heartbeatTo % (24 * 60))}
                        onChange={(event) => {
                          const minutes = minutesOf(event.target.value);
                          if (minutes !== undefined) set("heartbeatTo", minutes === 0 ? 24 * 60 : minutes);
                        }}
                      />
                    </Field>
                  </div>
                )}
                {advanced && (
                  <Field
                    label={tr("agents.heartbeatChecklist")}
                    hint={`${tr("agents.heartbeatPerDayValue", { count: beatsPerDay(heartbeat!) })} · ${draft.heartbeatTimeZone}`}
                  >
                    <Textarea
                      autoGrow
                      minRows={3}
                      maxRows={12}
                      maxLength={CHECKLIST_LIMIT}
                      value={draft.heartbeatChecklist}
                      placeholder={tr("agents.heartbeatChecklistPlaceholder")}
                      onChange={(event) => set("heartbeatChecklist", event.target.value)}
                    />
                  </Field>
                )}
              </div>
            )}
          </div>
          {draft.eventTriggers.map((trigger, index) => (
            <EventTriggerRow
              key={trigger.id}
              trigger={trigger}
              projectId={draft.projectId}
              {...(task ? { agentId: task.id } : {})}
              agents={otherAgents}
              sources={sources}
              advanced={advanced}
              {...(hookUrls[trigger.id] ? { hookUrl: hookUrls[trigger.id] } : {})}
              {...(task && onRenewHook && task.eventTriggers?.some((saved) => saved.id === trigger.id)
                ? { onRenewHook: () => onRenewHook(trigger.id) }
                : {})}
              onChange={(next) => setTriggers(draft.eventTriggers.map((item, i) => i === index ? next : item))}
              onRemove={() => setTriggers(draft.eventTriggers.filter((_, i) => i !== index))}
            />
          ))}
          <div className="agent-wake is-static">
            <div className="agent-wake-head">
              <span className="agent-wake-title">{tr("agents.byHand")}</span>
              <span className="agent-wake-note">{tr("agents.byHandNote")}</span>
            </div>
          </div>
          </div>
          {draft.eventTriggers.length < 8 && (
            <Menu label={tr("agents.addWake")} align="start" entries={addEntries}>
              {(trigger) => (
                <span><Button size="sm" iconStart={PlusIcon} {...trigger}>{tr("agents.addWake")}</Button></span>
              )}
            </Menu>
          )}
          {advanced && task?.eventLog?.length ? (
            <div className="agent-event-log">
              <h3 className="agent-field-label">{tr("agents.recentEventWakes")}</h3>
              <ol>
                {task.eventLog.slice(0, 8).map((entry, index) => (
                  <li key={`${entry.at}-${index}`} data-outcome={entry.outcome}>
                    <time dateTime={new Date(entry.at).toISOString()}>{formatWake(entry.at)}</time>
                    <span>{eventLogLabel(entry)}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </Section>

        <Section id="reports" title={tr("agents.sectionReports")} lead={tr("agents.leadReports")}>
          <Field label={tr("agents.notifyLabel")}>
            <Select
              label={tr("agents.notifyLabel")}
              value={draft.notify}
              options={[
                { value: "alerts", label: tr("agents.notifyAlerts") },
                { value: "updates", label: tr("agents.notifyUpdates") },
                { value: "off", label: tr("agents.notifyOff") },
              ]}
              onChange={(value) => set("notify", value as AgentDraftState["notify"])}
            />
          </Field>
          {advanced && <p className="agent-field-hint">{tr("agents.reportsBody")}</p>}
        </Section>

        <Section id="skills" title={tr("agents.sectionSkills")} lead={tr("agents.leadSkills")}>
          <Field label={tr("agents.permissions")} hint={tr(`agents.permissionHint.${draft.permissions}`)}>
            <Select
              label={tr("agents.permissions")}
              value={draft.permissions}
              searchable={false}
              options={PERMISSION_CHOICES.map((choice) => ({ value: choice, label: permissionLabel(choice), detail: tr(`agents.permissionHint.${choice}`) }))}
              onChange={(value) => set("permissions", value as PermissionChoice)}
            />
          </Field>
          {permissionWarning}
          {advanced && (
            <>
              <p className="agent-field-hint">{tr("agents.skillsBody")}</p>
              <div className="agent-field-row">
                <Field label={tr("agents.ifRequestWaits")}>
                  <Select
                    label={tr("agents.ifRequestWaits")}
                    value={draft.approvalAction}
                    options={[
                      { value: "wait", label: tr("agents.approvalWait") },
                      { value: "reject", label: tr("agents.approvalReject") },
                      { value: "stop", label: tr("agents.approvalStop") },
                    ]}
                    onChange={(value) => set("approvalAction", value as AgentDraftState["approvalAction"])}
                  />
                </Field>
                {draft.approvalAction !== "wait" && (
                  <Field label={tr("agents.approvalAfter")}>
                    <Select
                      label={tr("agents.approvalAfter")}
                      value={String(draft.approvalMinutes)}
                      options={[5, 15, 30, 60, 240].map((minutes) => ({ value: String(minutes), label: tr("agents.minutesValue", { count: minutes }) }))}
                      onChange={(value) => set("approvalMinutes", Number(value))}
                    />
                  </Field>
                )}
              </div>
            </>
          )}
        </Section>

        {advanced && (
        <Section id="context" title={tr("agents.sectionContext")} lead={tr("agents.leadContext")}>
          <Tabs
            size="sm"
            label={tr("agents.sectionContext")}
            value={draft.context}
            tabs={[
              { id: "fresh", label: tr("agents.contextFresh"), disabled: draft.heartbeatOn },
              { id: "rolling", label: tr("agents.contextRolling") },
              { id: "session", label: tr("agents.contextSession"), disabled: draft.heartbeatOn },
            ]}
            onChange={(id) => set("context", id as ContextMode)}
          />
          <p className="agent-prose">{contextHint}</p>
          {draft.heartbeatOn && <p className="agent-field-hint">{tr("agents.heartbeatNeedsRolling")}</p>}
          {draft.context === "rolling" && (
            <>
            <div className="agent-field">
              <span className="agent-field-label">{tr("agents.whenFull")}</span>
              <Tabs
                size="sm"
                label={tr("agents.whenFull")}
                value={draft.whenFull}
                tabs={[
                  { id: "new-session", label: tr("agents.whenFullNew") },
                  { id: "compact", label: tr("agents.whenFullCompact") },
                ]}
                onChange={(id) => set("whenFull", id as AgentDraftState["whenFull"])}
              />
              <span className="agent-field-hint">{draft.whenFull === "compact" ? tr("agents.whenFullCompactHint") : tr("agents.whenFullNewHint")}</span>
            </div>
            <div className="agent-field">
              <span className="agent-field-label">{tr("agents.keepWarm")}</span>
              <Tabs
                size="sm"
                label={tr("agents.keepWarm")}
                value={draft.keepWarm}
                tabs={[
                  { id: "off", label: tr("agents.keepWarmOff") },
                  { id: "auto", label: tr("agents.keepWarmAuto") },
                ]}
                onChange={(id) => set("keepWarm", id as AgentDraftState["keepWarm"])}
              />
              <span className="agent-field-hint">{tr("agents.keepWarmHint")}</span>
            </div>
            <Field label={tr("agents.rotateAt")} hint={tr("agents.rotateAtHint")}>
              <span className="agent-range">
                <input
                  type="range"
                  min={30}
                  max={90}
                  step={5}
                  value={draft.rotateAtPercent}
                  aria-valuetext={`${draft.rotateAtPercent}%`}
                  onChange={(event) => set("rotateAtPercent", Number(event.target.value))}
                />
                <output>{draft.rotateAtPercent}%</output>
              </span>
            </Field>
            </>
          )}
          {draft.context === "session" && (
            <Field label={tr("agents.targetSession")}>
              <Select
                label={tr("agents.targetSession")}
                value={draft.sessionId}
                placeholder={tr("agents.chooseSession")}
                options={projectSessions.map((session) => ({ value: session.id, label: session.title || session.id }))}
                onChange={(value) => set("sessionId", value)}
              />
            </Field>
          )}
        </Section>
        )}

        {advanced && (
        <Section id="budget" title={tr("agents.sectionBudget")} lead={tr("agents.leadBudget")}>
          <div className="agent-budget-grid">
            <Field label={tr("agents.runsPerDay")}>
              <TextInput
                inputMode="numeric"
                value={draft.runsPerDay}
                invalid={budgetInvalid.has("runsPerDay")}
                placeholder={tr("agents.noLimit")}
                onChange={(event) => set("runsPerDay", event.target.value)}
              />
            </Field>
            <Field label={tr("agents.tokensPerDay")}>
              <TextInput
                inputMode="numeric"
                value={draft.tokensPerDay}
                invalid={budgetInvalid.has("tokensPerDay")}
                placeholder={tr("agents.noLimit")}
                onChange={(event) => set("tokensPerDay", event.target.value)}
              />
            </Field>
            <Field label={tr("agents.costPerDay")} hint={tr("agents.costHint")}>
              <TextInput
                inputMode="decimal"
                value={draft.costPerDay}
                invalid={budgetInvalid.has("costPerDay")}
                placeholder={tr("agents.noLimit")}
                onChange={(event) => set("costPerDay", event.target.value)}
              />
            </Field>
          </div>
          <div className="agent-field-row">
            <Field label={tr("agents.stopAfterFailures")}>
              <Select
                label={tr("agents.stopAfterFailures")}
                value={String(draft.pauseAfterFailures)}
                options={[
                  { value: "0", label: tr("agents.never") },
                  { value: "2", label: tr("agents.failuresValue", { count: 2 }) },
                  { value: "3", label: tr("agents.failuresValue", { count: 3 }) },
                  { value: "5", label: tr("agents.failuresValue", { count: 5 }) },
                ]}
                onChange={(value) => set("pauseAfterFailures", Number(value))}
              />
            </Field>
            <Field label={tr("agents.ifStillRunning")}>
              <Select
                label={tr("agents.ifStillRunning")}
                value={draft.overlap}
                options={[
                  { value: "skip", label: tr("agents.overlapSkip") },
                  { value: "queue", label: tr("agents.overlapQueue") },
                  { value: "parallel", label: tr("agents.overlapParallel") },
                ]}
                onChange={(value) => set("overlap", value as AgentDraftState["overlap"])}
              />
            </Field>
          </div>
          <p className="agent-field-hint">{tr("agents.budgetNote")}</p>
        </Section>
        )}

        {!advanced && (
          <div className="agent-more">
            <p className="agent-more-copy">
              <span>{tr("agents.moreSettings")}</span>
              <span className="agent-field-hint">{tr("agents.moreSettingsHint")}</span>
            </p>
            <Button size="sm" onClick={() => setAdvanced(true)}>{tr("agents.showAdvanced")}</Button>
          </div>
        )}
      </fieldset>
      )}
      </div>

      <div className="agent-footer">{footer}</div>
    </div>
  );
}
