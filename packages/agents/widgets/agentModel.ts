// Agent editor state, kept DOM-free so it can be tested directly. A planner
// task is an agent: the draft below is the editor's view of one, and
// `draftToInput` is the only way back to the API shape.
import type { HarnessSelection, ModelRef } from "@polyth/contracts";
import type {
  AgentEventSourceDto,
  AgentEventTriggerDto,
  AgentBudgetDto,
  AgentColorDto,
  AgentDraftDto,
  AgentHeartbeatDto,
  AgentNotifyPolicyDto,
  AgentPermissionLevelDto,
  ScheduleCadenceDto,
  ScheduleTaskDto,
  ScheduleTaskInputDto,
} from "@polyth/session/web-api";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import { estimateTokens } from "../src/agentPrompt.ts";
import { fallbacksFromFile, fallbacksToFile, type AgentFileSpec } from "../src/agentFile.ts";
import {
  cadenceToView,
  defaultWeeklyView,
  localTimeZone,
  validateCadenceView,
  viewToCadence,
  type CadenceView,
} from "../src/cadenceView.ts";
import { cadenceOfTask } from "../src/plannerTask.ts";

export type ContextMode = "fresh" | "rolling" | "session";
export type AgentState = "active" | "paused" | "tripped" | "draft" | "review";
export type ExecutionModel = ModelRef & { harnessId?: string };
/** One backup row. `model` stays empty until the person picks one. */
export interface BackupModelDraft {
  /** Stable row key; never saved. */
  key: string;
  harness: HarnessSelection;
  model?: ExecutionModel;
}
/** "inherit" = the session's default approval level. */
export type PermissionChoice = "inherit" | AgentPermissionLevelDto;
export const MAX_BACKUP_MODELS = 8;

export interface AgentDraftState {
  name: string;
  description: string;
  icon: string;
  color: AgentColorDto;
  projectId: string;
  model?: ExecutionModel;
  harness: HarnessSelection;
  /** Highest priority first. */
  backups: BackupModelDraft[];
  permissions: PermissionChoice;
  charter: string;
  scheduled: boolean;
  view: CadenceView;
  catchUp: "once" | "skip";
  context: ContextMode;
  /** Whole percent, 20–90. */
  rotateAtPercent: number;
  sessionId: string;
  overlap: "skip" | "queue" | "parallel";
  /** Empty string = no limit. Strings keep half-typed numbers editable. */
  runsPerDay: string;
  tokensPerDay: string;
  costPerDay: string;
  /** 0 = never trip on failures. */
  pauseAfterFailures: number;
  eventTriggers: AgentEventTriggerDto[];
  /** What a request that waits for a person does after `approvalMinutes`. */
  approvalAction: "wait" | "reject" | "stop";
  approvalMinutes: number;
  whenFull: "new-session" | "compact";
  keepWarm: "off" | "auto";
  /** Light, frequent checks inside the rolling conversation. */
  heartbeatOn: boolean;
  heartbeatEvery: number;
  heartbeatAllDay: boolean;
  /** Minutes after local midnight. */
  heartbeatFrom: number;
  heartbeatTo: number;
  heartbeatTimeZone: string;
  heartbeatChecklist: string;
  /** Which finished runs notify the person. */
  notify: AgentNotifyPolicyDto;
}

export const AGENT_COLORS: readonly AgentColorDto[] = ["neutral", "blue", "green", "amber", "purple", "red"];
export const DEFAULT_PAUSE_AFTER_FAILURES = 3;

export function emptyDraft(projectId: string): AgentDraftState {
  return {
    name: "",
    description: "",
    icon: "bot",
    color: "blue",
    projectId,
    harness: { mode: "auto" },
    backups: [],
    permissions: "inherit",
    charter: "",
    scheduled: true,
    view: defaultWeeklyView(),
    catchUp: "once",
    context: "rolling",
    rotateAtPercent: 60,
    sessionId: "",
    overlap: "skip",
    runsPerDay: "",
    tokensPerDay: "",
    costPerDay: "",
    pauseAfterFailures: DEFAULT_PAUSE_AFTER_FAILURES,
    eventTriggers: [],
    approvalAction: "wait",
    approvalMinutes: 30,
    whenFull: "new-session",
    keepWarm: "off",
    heartbeatOn: false,
    heartbeatEvery: 30,
    heartbeatAllDay: false,
    heartbeatFrom: 8 * 60,
    heartbeatTo: 22 * 60,
    heartbeatTimeZone: localTimeZone(),
    heartbeatChecklist: "",
    notify: "alerts",
  };
}

const contextOf = (task: ScheduleTaskDto): ContextMode => {
  const mode = task.target?.mode ?? (task.sessionId ? "existing-session" : "new-session-per-run");
  return mode === "dedicated-session" ? "rolling" : mode === "existing-session" ? "session" : "fresh";
};

const limitText = (value: number | undefined): string => value === undefined ? "" : String(value);

export function draftFromTask(task: ScheduleTaskDto, locale: string): AgentDraftState {
  const cadence = cadenceOfTask(task);
  return {
    name: task.title ?? "",
    description: task.description ?? "",
    icon: task.icon ?? "bot",
    color: task.color ?? "neutral",
    projectId: task.projectId,
    ...(task.model ? { model: task.model } : {}),
    harness: task.harness ?? { mode: "auto" },
    backups: backupsOf(task.fallbackModels ?? []),
    permissions: task.permissions ?? "inherit",
    charter: task.prompt,
    scheduled: !task.manualOnly,
    view: cadence ? cadenceToView(cadence, locale) : defaultWeeklyView(),
    catchUp: task.catchUp ?? "once",
    context: contextOf(task),
    rotateAtPercent: Math.round((task.rotateAt ?? 0.6) * 100),
    sessionId: task.target?.sessionId ?? task.sessionId ?? "",
    overlap: task.overlapPolicy ?? "skip",
    runsPerDay: limitText(task.budget?.runsPerDay),
    tokensPerDay: limitText(task.budget?.tokensPerDay),
    costPerDay: limitText(task.budget?.costPerDay),
    pauseAfterFailures: task.pauseAfterFailures ?? 0,
    eventTriggers: task.eventTriggers ?? [],
    approvalAction: task.approvals?.onTimeout ?? "wait",
    approvalMinutes: task.approvals?.timeoutMinutes ?? 30,
    whenFull: task.whenFull ?? "new-session",
    keepWarm: task.keepWarm ?? "off",
    ...heartbeatFields(task.heartbeat),
    notify: task.notify ?? "alerts",
  };
}

let backupSeq = 0;
const backupKey = (): string => `backup-${++backupSeq}`;

const backupsOf = (refs: readonly ExecutionModel[]): BackupModelDraft[] => refs.map((model) => ({
  key: backupKey(),
  harness: model.harnessId ? { mode: "pinned", harnessId: model.harnessId } : { mode: "auto" },
  model,
}));

/** A new, empty backup row on the main route's harness. */
export function newBackup(draft: Pick<AgentDraftState, "harness" | "model">): BackupModelDraft {
  const harnessId = draft.harness.mode === "pinned" ? draft.harness.harnessId : draft.model?.harnessId;
  return { key: backupKey(), harness: harnessId ? { mode: "pinned", harnessId } : { mode: "auto" } };
}

/** Move the row at `index` by `delta` places; out-of-range moves are no-ops. */
export function moveBackup(backups: readonly BackupModelDraft[], index: number, delta: number): BackupModelDraft[] {
  const target = index + delta;
  if (index < 0 || index >= backups.length || target < 0 || target >= backups.length) return [...backups];
  const next = [...backups];
  const [row] = next.splice(index, 1);
  next.splice(target, 0, row!);
  return next;
}

/** Backups as the API takes them: only complete, harness-qualified rows. */
export function backupModelsOf(draft: Pick<AgentDraftState, "backups">): Array<ModelRef & { harnessId: string }> {
  return draft.backups.flatMap((row) => {
    const harnessId = row.model?.harnessId ?? (row.harness.mode === "pinned" ? row.harness.harnessId : undefined);
    return row.model && harnessId ? [{ ...row.model, harnessId }] : [];
  });
}

function heartbeatFields(beat: AgentHeartbeatDto | undefined): Pick<AgentDraftState,
  "heartbeatOn" | "heartbeatEvery" | "heartbeatAllDay" | "heartbeatFrom" | "heartbeatTo" | "heartbeatTimeZone" | "heartbeatChecklist"> {
  return {
    heartbeatOn: !!beat,
    heartbeatEvery: beat?.everyMinutes ?? 30,
    heartbeatAllDay: !!beat && beat.activeFrom === undefined,
    heartbeatFrom: beat?.activeFrom ?? 8 * 60,
    heartbeatTo: beat?.activeTo ?? 22 * 60,
    heartbeatTimeZone: beat?.timeZone ?? localTimeZone(),
    heartbeatChecklist: beat?.checklist ?? "",
  };
}

/** The heartbeat as the API takes it; absent when it is off. */
export function heartbeatOf(draft: AgentDraftState): AgentHeartbeatDto | undefined {
  if (!draft.heartbeatOn) return undefined;
  return {
    everyMinutes: draft.heartbeatEvery,
    ...(draft.heartbeatAllDay ? {} : { activeFrom: draft.heartbeatFrom, activeTo: draft.heartbeatTo }),
    timeZone: draft.heartbeatTimeZone,
    checklist: draft.heartbeatChecklist.trim(),
  };
}

/** A model draft fills an editor draft; the user still reviews every field. */
export function applyModelDraft(base: AgentDraftState, draft: AgentDraftDto, locale: string): AgentDraftState {
  return {
    ...base,
    name: draft.name,
    description: draft.description,
    icon: draft.icon,
    charter: draft.charter,
    scheduled: draft.schedule !== null,
    view: draft.schedule ? cadenceToView(draft.schedule, locale) : base.view,
    context: draft.context,
  };
}

const parseLimit = (text: string, integer: boolean): number | undefined | null => {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) return null;
  return value;
};

export interface BudgetParse {
  budget: AgentBudgetDto;
  invalid: Array<"runsPerDay" | "tokensPerDay" | "costPerDay">;
}

export function parseBudget(draft: Pick<AgentDraftState, "runsPerDay" | "tokensPerDay" | "costPerDay">): BudgetParse {
  const budget: AgentBudgetDto = {};
  const invalid: BudgetParse["invalid"] = [];
  for (const [key, integer] of [["runsPerDay", true], ["tokensPerDay", true], ["costPerDay", false]] as const) {
    const value = parseLimit(draft[key], integer);
    if (value === null) invalid.push(key);
    else if (value !== undefined) budget[key] = value;
  }
  return { budget, invalid };
}

/** Why the agent cannot be saved/activated yet, as visible sentences. */
export function activationBlockers(draft: AgentDraftState): string[] {
  const reasons: string[] = [];
  if (!draft.name.trim()) reasons.push(tr("agents.blockerName"));
  if (!draft.projectId) reasons.push(tr("agents.blockerProject"));
  if (!draft.charter.trim()) reasons.push(tr("agents.blockerCharter"));
  if (draft.scheduled && !validateCadenceView(draft.view).ok) reasons.push(tr("agents.blockerSchedule"));
  if (draft.context === "session" && !draft.sessionId) reasons.push(tr("agents.blockerSession"));
  if (parseBudget(draft).invalid.length) reasons.push(tr("agents.blockerBudget"));
  if (backupModelsOf(draft).length !== draft.backups.length) reasons.push(tr("agents.blockerBackup"));
  if (draft.heartbeatOn && !draft.heartbeatAllDay && draft.heartbeatFrom === draft.heartbeatTo % (24 * 60)) {
    reasons.push(tr("agents.blockerHeartbeatHours"));
  }
  return reasons;
}

export function draftToInput(draft: AgentDraftState, enabled: boolean): ScheduleTaskInputDto {
  const { budget } = parseBudget(draft);
  // A heartbeat lives in the one ongoing conversation.
  const context = draft.heartbeatOn ? "rolling" : draft.context;
  const mode = context === "rolling" ? "dedicated-session" : context === "session" ? "existing-session" : "new-session-per-run";
  const heartbeat = heartbeatOf(draft);
  return {
    projectId: draft.projectId,
    title: draft.name.trim(),
    description: draft.description.trim(),
    icon: draft.icon,
    color: draft.color,
    prompt: draft.charter.trim(),
    cadence: viewToCadence(draft.view) as ScheduleCadenceDto,
    manualOnly: !draft.scheduled,
    catchUp: draft.catchUp,
    target: { mode, ...(mode === "existing-session" && draft.sessionId ? { sessionId: draft.sessionId } : {}) },
    rotateAt: draft.rotateAtPercent / 100,
    overlapPolicy: draft.overlap,
    budget: Object.keys(budget).length ? budget : null,
    pauseAfterFailures: draft.pauseAfterFailures > 0 ? draft.pauseAfterFailures : null,
    eventTriggers: draft.eventTriggers,
    whenFull: draft.whenFull,
    keepWarm: context === "rolling" ? draft.keepWarm : "off",
    approvals: draft.approvalAction === "wait" ? null : { timeoutMinutes: draft.approvalMinutes, onTimeout: draft.approvalAction },
    model: draft.model ?? null,
    harness: draft.harness.mode === "pinned" ? draft.harness : null,
    fallbackModels: backupModelsOf(draft),
    permissions: draft.permissions === "inherit" ? null : draft.permissions,
    heartbeat: heartbeat ?? null,
    notify: draft.notify,
    enabled,
  };
}

export function agentState(task: ScheduleTaskDto & { trustState?: string }): AgentState {
  if (task.source === "loop-file" && task.trustState !== "trusted-current-version") return "review";
  if (task.tripped) return "tripped";
  // Heartbeats and event wakes leave `runs` alone; any history means it ran.
  if (!task.enabled) return task.runs === 0 && !task.lastRunAt && !task.lastBeatAt && !task.history?.length ? "draft" : "paused";
  return "active";
}

export const charterTokens = (charter: string): number => estimateTokens(charter.trim());

export interface AgentTemplate {
  id: string;
  icon: string;
  color: AgentColorDto;
  name: () => string;
  description: () => string;
  charter: () => string;
  /** Weekly days (0 = Sunday) and clock; null = on demand only. */
  schedule: { days: number[]; hour: number; minute: number } | null;
  context: ContextMode;
  /** Run settings that differ from an empty draft. */
  settings?: Partial<Pick<AgentDraftState,
    "runsPerDay" | "pauseAfterFailures" | "approvalAction" | "approvalMinutes" | "notify" | "catchUp" | "overlap">>;
}

export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  {
    id: "nightly-release-captain",
    icon: "review",
    color: "purple",
    name: () => tr("agents.templateNightlyName"),
    description: () => tr("agents.templateNightlyDescription"),
    charter: () => tr("agents.templateNightlyCharter"),
    // The nightly channel builds every day, so this reviews seven nights a week.
    schedule: { days: [0, 1, 2, 3, 4, 5, 6], hour: 2, minute: 30 },
    context: "rolling",
    // Nobody answers at night: an unanswered request is declined after 20
    // minutes so the run still reports by morning, and every run notifies.
    settings: {
      runsPerDay: "2",
      pauseAfterFailures: 2,
      approvalAction: "reject",
      approvalMinutes: 20,
      notify: "updates",
      catchUp: "once",
      overlap: "skip",
    },
  },
  {
    id: "morning-digest",
    icon: "docs",
    color: "blue",
    name: () => tr("agents.templateDigestName"),
    description: () => tr("agents.templateDigestDescription"),
    charter: () => tr("agents.templateDigestCharter"),
    schedule: { days: [1, 2, 3, 4, 5], hour: 8, minute: 30 },
    context: "rolling",
  },
  {
    id: "dependency-watch",
    icon: "shield",
    color: "green",
    name: () => tr("agents.templateDepsName"),
    description: () => tr("agents.templateDepsDescription"),
    charter: () => tr("agents.templateDepsCharter"),
    schedule: { days: [1], hour: 9, minute: 0 },
    context: "fresh",
  },
  {
    id: "on-demand-helper",
    icon: "terminal",
    color: "amber",
    name: () => tr("agents.templateTriageName"),
    description: () => tr("agents.templateTriageDescription"),
    charter: () => tr("agents.templateTriageCharter"),
    schedule: null,
    context: "fresh",
  },
];

export function draftFromTemplate(template: AgentTemplate, projectId: string): AgentDraftState {
  const base = emptyDraft(projectId);
  return {
    ...base,
    name: template.name(),
    description: template.description(),
    icon: template.icon,
    color: template.color,
    charter: template.charter(),
    scheduled: template.schedule !== null,
    view: template.schedule
      ? { mode: "weekly", days: template.schedule.days, hour: template.schedule.hour, minute: template.schedule.minute, timeZone: localTimeZone() }
      : base.view,
    context: template.context,
    ...template.settings,
  };
}

export const DEFAULT_TRIGGER_PACE = { quietMs: 60_000, coalesce: "latest", maxPerHour: 6 } as const;

/** A fresh event wake with a unique id among `existing`. */
export function newEventTrigger(
  kind: "session-failed" | "session-completed" | "agent" | "webhook" | "integration",
  existing: readonly AgentEventTriggerDto[],
  ref = "",
  types: readonly string[] = [],
): AgentEventTriggerDto {
  const base = kind === "agent" ? "after-agent" : kind === "session-failed" ? "session-fails"
    : kind === "session-completed" ? "session-done" : kind === "webhook" ? "webhook" : ref || "integration";
  let id = base;
  for (let n = 2; existing.some((trigger) => trigger.id === id); n += 1) id = `${base}-${n}`;
  const pace = { ...DEFAULT_TRIGGER_PACE };
  if (kind === "agent") return { id, kind: "agent", agentId: ref, on: ["ok"], pace };
  if (kind === "webhook") return { id, kind: "webhook", pace };
  if (kind === "integration") return { id, kind: "integration", source: ref, on: [...types], pace };
  return { id, kind: "session", on: [kind === "session-failed" ? "failed" : "completed"], pace };
}

/** One sentence per event wake, e.g. "When a session in this project fails". */
export function triggerSentence(
  trigger: AgentEventTriggerDto,
  agentName: (id: string) => string,
  sources: readonly AgentEventSourceDto[] = [],
): string {
  if (trigger.kind === "webhook") return tr("agents.wakeWebhook");
  if (trigger.kind === "integration") {
    const source = sources.find((item) => item.id === trigger.source);
    const types = trigger.on.map((type) => source?.types.find((item) => item.id === type)?.label ?? type).join(" / ");
    return tr("agents.wakeIntegrationValue", { source: source?.label ?? trigger.source, types });
  }
  if (trigger.kind === "agent") {
    const name = agentName(trigger.agentId) || tr("agents.untitled");
    return trigger.on.length === 2
      ? tr("agents.wakeAgentAnyValue", { name })
      : trigger.on[0] === "failed" ? tr("agents.wakeAgentFailedValue", { name }) : tr("agents.wakeAgentOkValue", { name });
  }
  const outcomes = trigger.on.map((outcome) => tr(`agents.outcome.${outcome}`)).join(" / ");
  return tr("agents.wakeSessionValue", { outcomes });
}

// ---- Edit as file ------------------------------------------------------------

/** The draft as an agent/v1 spec, or why it cannot be one. Webhook wakes
 *  carry a secret URL and stay out of files; they are kept by `specToDraft`. */
export function draftToSpec(draft: AgentDraftState, id: string): { spec: AgentFileSpec } | { error: string } {
  if (draft.context === "session" && !draft.heartbeatOn) return { error: tr("agents.fileNoSession") };
  const cadence = viewToCadence(draft.view);
  const heartbeat = heartbeatOf(draft);
  const rolling = draft.context === "rolling" || !!heartbeat;
  if (draft.scheduled && cadence.kind !== "cron") return { error: tr("agents.fileNoOnce") };
  const { budget } = parseBudget(draft);
  const model = draft.model ? `${draft.model.providerID}/${draft.model.modelID}${draft.model.variant ? `#${draft.model.variant}` : ""}` : undefined;
  const harness = draft.harness.mode === "pinned" ? draft.harness.harnessId : draft.model?.harnessId;
  const wakes = draft.eventTriggers.filter((trigger) => trigger.kind !== "webhook") as unknown as AgentFileSpec["wakes"];
  return {
    spec: {
      id,
      name: draft.name.trim() || id,
      ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
      icon: draft.icon,
      color: draft.color,
      ...(draft.scheduled && cadence.kind === "cron" ? { schedule: { cron: cadence.expression, timeZone: cadence.timeZone } } : {}),
      enabled: true,
      context: rolling ? "rolling" : "fresh",
      ...(rolling ? { rotateAt: draft.rotateAtPercent / 100 } : {}),
      ...(draft.whenFull === "compact" ? { whenFull: "compact" as const } : {}),
      ...(draft.keepWarm === "auto" && rolling ? { keepWarm: "auto" as const } : {}),
      overlap: draft.overlap,
      catchUp: draft.catchUp,
      ...(model ? { model } : {}),
      ...(harness ? { harness } : {}),
      ...(draft.backups.length ? { fallbackModels: fallbacksToFile(backupModelsOf(draft)) } : {}),
      ...(Object.keys(budget).length ? { budget } : {}),
      ...(draft.pauseAfterFailures > 0 ? { pauseAfterFailures: draft.pauseAfterFailures } : {}),
      ...(draft.approvalAction !== "wait" ? { approvals: { timeoutMinutes: draft.approvalMinutes, onTimeout: draft.approvalAction } } : {}),
      ...(wakes?.length ? { wakes } : {}),
      ...(heartbeat ? { heartbeat } : {}),
      ...(draft.notify !== "alerts" ? { notify: draft.notify } : {}),
      charter: draft.charter,
    },
  };
}

/** A parsed file applied onto `base` (which keeps what files never hold). */
export function specToDraft(spec: AgentFileSpec, base: AgentDraftState, locale: string): AgentDraftState {
  const [ref, variant] = (spec.model ?? "").split("#");
  const slash = ref ? ref.indexOf("/") : -1;
  const model: ExecutionModel | undefined = spec.model && slash > 0
    ? { providerID: ref!.slice(0, slash), modelID: ref!.slice(slash + 1), ...(variant ? { variant } : {}), ...(spec.harness ? { harnessId: spec.harness } : {}) }
    : undefined;
  return {
    ...base,
    name: spec.name,
    description: spec.description ?? "",
    icon: spec.icon ?? "bot",
    color: spec.color ?? "neutral",
    charter: spec.charter,
    scheduled: !!spec.schedule,
    view: spec.schedule ? cadenceToView({ kind: "cron", expression: spec.schedule.cron, timeZone: spec.schedule.timeZone }, locale) : base.view,
    context: spec.context === "rolling" ? "rolling" : "fresh",
    rotateAtPercent: Math.round((spec.rotateAt ?? 0.6) * 100),
    whenFull: spec.whenFull ?? "new-session",
    keepWarm: spec.keepWarm ?? "off",
    overlap: spec.overlap ?? "skip",
    catchUp: spec.catchUp ?? "once",
    ...(model ? { model } : { model: undefined }),
    harness: spec.harness ? { mode: "pinned", harnessId: spec.harness } : { mode: "auto" },
    // Files hold only complete backups; the approval level stays in the app.
    backups: backupsOf(fallbacksFromFile(spec.fallbackModels)),
    runsPerDay: spec.budget?.runsPerDay !== undefined ? String(spec.budget.runsPerDay) : "",
    tokensPerDay: spec.budget?.tokensPerDay !== undefined ? String(spec.budget.tokensPerDay) : "",
    costPerDay: spec.budget?.costPerDay !== undefined ? String(spec.budget.costPerDay) : "",
    pauseAfterFailures: spec.pauseAfterFailures ?? 0,
    approvalAction: spec.approvals?.onTimeout ?? "wait",
    approvalMinutes: spec.approvals?.timeoutMinutes ?? base.approvalMinutes,
    eventTriggers: [
      ...((spec.wakes ?? []) as unknown as AgentEventTriggerDto[]),
      ...base.eventTriggers.filter((trigger) => trigger.kind === "webhook"),
    ],
    ...heartbeatFields(spec.heartbeat),
    notify: spec.notify ?? "alerts",
  };
}
