import type {
  AgentCapabilityContributionRegistry,
  Disposable,
  JsonObject,
  SpaceContext,
  ToolExecutionContext,
} from "@polyth/contracts";
import type { CoachStore, CoachTone, CoachInitiative } from "./index.ts";
import { isCoachTimeZone } from "./home.ts";

export interface CoachScheduleTask {
  id: string;
  projectId: string;
  title?: string;
  enabled?: boolean;
  cadence?: {
    kind: string;
    expression?: string;
    timeZone?: string;
  };
}

export interface CoachScheduleService {
  list(projectId?: string): CoachScheduleTask[];
  create(input: {
    projectId: string;
    prompt: string;
    cadence: { kind: "cron"; expression: string; timeZone: string };
    target: { mode: "new-session-per-run" };
    overlapPolicy: "skip";
    title: string;
    enabled: boolean;
  }): CoachScheduleTask;
  update(id: string, patch: {
    prompt?: string;
    cadence?: { kind: "cron"; expression: string; timeZone: string };
    target?: { mode: "new-session-per-run" };
    overlapPolicy?: "skip";
    title?: string;
    enabled?: boolean;
  }): CoachScheduleTask;
  setEnabled(id: string, enabled: boolean): CoachScheduleTask;
  remove(id: string): boolean;
  preview(cadence: { kind: "cron"; expression: string; timeZone: string }, count?: number): unknown;
}

export interface CoachReminderSettings {
  dailyCheckIn: {
    enabled: boolean;
    minuteOfDay: number;
  };
  weeklyReview: {
    enabled: boolean;
    day: number;
    minuteOfDay: number;
  };
  timeZone: string;
}

export interface CoachOnboardingCapabilitySet {
  ids: string[];
  dispose(): void | Promise<void>;
}

const DAILY_TITLE = "Coach · Daily check-in";
const WEEKLY_TITLE = "Coach · Weekly review";
const COACH_SCHEDULE_TITLES = new Set([DAILY_TITLE, WEEKLY_TITLE]);
const DEFAULT_DAILY_MINUTE = 8 * 60;
const DEFAULT_WEEKLY_DAY = 0;
const DEFAULT_WEEKLY_MINUTE = 18 * 60;

const DAILY_PROMPT = `This is a user-enabled Personal Coach daily check-in. Call coach_read_context first. Keep the interaction short and practical. Ask for the user's current energy and focus only if they have not already provided them, then help identify one useful focus for today. Use coach_record_checkin only for values the user actually gives you. Do not invent state, create guilt, or turn this into a questionnaire.`;

const WEEKLY_PROMPT = `This is a user-enabled Personal Coach weekly review. Call coach_read_context first. Review the durable goals, commitments, recent check-ins, reflections, and evidence that actually exist. Summarize what changed, what seems to be working, and what may need adjustment. Treat patterns as hypotheses. Any strategic goal, commitment, routine, or plan change you initiate must be created as a proposal for explicit user approval. After the user has participated and the review conclusions are established, persist one concise summary with coach_record_weekly_review. Create an insight only when there is real recent evidence, using coach_propose_insight with the supporting Coach event sequence numbers.`;

const ONBOARDING = `Personal Coach onboarding is intentionally short. When coach_read_context reports onboardingState "new" or "started":
1. Start with one open question: what would the user like help making progress on?
2. Ask only follow-up questions that materially change the plan, usually no more than 3-5 total.
3. Summarize what you understood: primary outcome, secondary concerns, and real constraints.
4. Use proposal tools for the first strategic goals/commitments/plan changes; do not silently create them.
5. Ask separately whether the user wants a daily check-in and a weekly review, including preferred local times. Never opt them in by assumption.
6. Call coach_finish_onboarding only after the user explicitly confirms those choices. If they decline reminders, pass false. Do not infer consent from silence.

A completed profile stays durable across disposable Coach chats; do not rerun onboarding unless the user asks to revisit setup.`;

const schema = (properties: JsonObject, required: string[] = []): JsonObject => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const integer = (value: unknown, name: string, min: number, max: number): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw Object.assign(new Error(`${name} must be an integer from ${min} to ${max}`), { code: "invalid-input" });
  }
  return n;
};

const bool = (value: unknown, name: string): boolean => {
  if (typeof value !== "boolean") {
    throw Object.assign(new Error(`${name} must be explicitly true or false`), { code: "invalid-input" });
  }
  return value;
};

const clockCron = (minuteOfDay: number, day?: number): string => {
  const minute = minuteOfDay % 60;
  const hour = Math.floor(minuteOfDay / 60);
  return day === undefined ? `${minute} ${hour} * * *` : `${minute} ${hour} * * ${day}`;
};

function syncTask(
  schedule: CoachScheduleService,
  projectId: string,
  title: string,
  enabled: boolean,
  prompt: string,
  expression: string,
  timeZone: string,
): string | undefined {
  const existing = schedule.list(projectId).filter((task) => task.title === title);
  if (!enabled) {
    for (const task of existing) schedule.remove(task.id);
    return undefined;
  }
  const cadence = { kind: "cron" as const, expression, timeZone };
  // Preview goes through Schedule's executor validation path, catching bad
  // expressions/zones before any durable task is changed.
  schedule.preview(cadence, 2);
  const task = existing[0]
    ? schedule.update(existing[0].id, {
        prompt,
        cadence,
        target: { mode: "new-session-per-run" },
        overlapPolicy: "skip",
        title,
        enabled: true,
      })
    : schedule.create({
        projectId,
        prompt,
        cadence,
        target: { mode: "new-session-per-run" },
        overlapPolicy: "skip",
        title,
        enabled: true,
      });
  for (const duplicate of existing.slice(1)) schedule.remove(duplicate.id);
  return task.id;
}

function simpleCron(task: CoachScheduleTask | undefined): { minute: number; hour: number; day?: number } | undefined {
  if (task?.cadence?.kind !== "cron" || typeof task.cadence.expression !== "string") return undefined;
  const fields = task.cadence.expression.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const [minuteRaw, hourRaw, dom, month, dayRaw] = fields;
  if (!/^\d+$/.test(minuteRaw!) || !/^\d+$/.test(hourRaw!) || dom !== "*" || month !== "*") return undefined;
  const minute = Number(minuteRaw);
  const hour = Number(hourRaw);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59 || !Number.isInteger(hour) || hour < 0 || hour > 23) return undefined;
  if (dayRaw === "*") return { minute, hour };
  if (/^[0-6]$/.test(dayRaw!)) return { minute, hour, day: Number(dayRaw) };
  return undefined;
}

/** Read only the two exact Schedule tasks owned by Personal Coach. Unknown or
 * manually-corrupted cadences fall back to safe defaults until the next save. */
export function readCoachReminders(
  schedule: CoachScheduleService,
  projectId: string,
  timeZone: string,
): CoachReminderSettings {
  const tasks = schedule.list(projectId);
  const daily = tasks.find((task) => task.title === DAILY_TITLE);
  const weekly = tasks.find((task) => task.title === WEEKLY_TITLE);
  const dailyCron = simpleCron(daily);
  const weeklyCron = simpleCron(weekly);
  return {
    dailyCheckIn: {
      enabled: daily?.enabled === true,
      minuteOfDay: dailyCron ? dailyCron.hour * 60 + dailyCron.minute : DEFAULT_DAILY_MINUTE,
    },
    weeklyReview: {
      enabled: weekly?.enabled === true,
      day: weeklyCron?.day ?? DEFAULT_WEEKLY_DAY,
      minuteOfDay: weeklyCron ? weeklyCron.hour * 60 + weeklyCron.minute : DEFAULT_WEEKLY_MINUTE,
    },
    timeZone,
  };
}

/** Apply reminder preferences through the existing Schedule service. There is
 * no Coach timer and no LLM work on the idle path. */
export function configureCoachReminders(
  schedule: CoachScheduleService,
  projectId: string,
  settings: CoachReminderSettings,
): { dailyTaskId?: string; weeklyTaskId?: string } {
  if (!isCoachTimeZone(settings.timeZone)) {
    throw Object.assign(new Error("timeZone must be a valid IANA time zone"), { code: "invalid-input" });
  }
  const dailyEnabled = bool(settings.dailyCheckIn.enabled, "dailyCheckIn.enabled");
  const weeklyEnabled = bool(settings.weeklyReview.enabled, "weeklyReview.enabled");
  const dailyMinute = integer(settings.dailyCheckIn.minuteOfDay, "dailyCheckIn.minuteOfDay", 0, 1439);
  const weeklyDay = integer(settings.weeklyReview.day, "weeklyReview.day", 0, 6);
  const weeklyMinute = integer(settings.weeklyReview.minuteOfDay, "weeklyReview.minuteOfDay", 0, 1439);

  const dailyTaskId = syncTask(
    schedule,
    projectId,
    DAILY_TITLE,
    dailyEnabled,
    DAILY_PROMPT,
    clockCron(dailyMinute),
    settings.timeZone,
  );
  const weeklyTaskId = syncTask(
    schedule,
    projectId,
    WEEKLY_TITLE,
    weeklyEnabled,
    WEEKLY_PROMPT,
    clockCron(weeklyMinute, weeklyDay),
    settings.timeZone,
  );
  return {
    ...(dailyTaskId ? { dailyTaskId } : {}),
    ...(weeklyTaskId ? { weeklyTaskId } : {}),
  };
}

/** Package disable is a hard boundary: cross-package scheduled work must not
 * keep running after the capabilities/instructions it depends on disappear.
 * We pause only the two exact tasks Coach itself owns on its internal project. */
export function pauseCoachSchedules(schedule: CoachScheduleService, projectId: string): number {
  let paused = 0;
  for (const task of schedule.list(projectId)) {
    if (!task.title || !COACH_SCHEDULE_TITLES.has(task.title) || task.enabled === false) continue;
    schedule.setEnabled(task.id, false);
    paused++;
  }
  return paused;
}

export function registerCoachOnboardingCapabilities(input: {
  registry: AgentCapabilityContributionRegistry;
  space: Pick<SpaceContext, "spaceId">;
  projectId: string;
  store: CoachStore;
  schedule(): CoachScheduleService | undefined;
}): CoachOnboardingCapabilitySet {
  const suffix = input.projectId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(-16) || "workspace";
  const registrations: Disposable[] = [];
  const ids: string[] = [];
  const register = (contribution: Parameters<AgentCapabilityContributionRegistry["register"]>[1]) => {
    ids.push(contribution.descriptor.id);
    registrations.push(input.registry.register("personal-coach", contribution));
  };
  const assertTarget = (ctx: ToolExecutionContext) => {
    if (ctx.projectId !== input.projectId || (ctx.spaceId && ctx.spaceId !== input.space.spaceId)) {
      throw Object.assign(new Error("Coach onboarding target mismatch"), { code: "forbidden" });
    }
  };

  register({
    descriptor: {
      id: `personal-coach.onboarding-${suffix}`,
      kind: "instruction",
      owner: "personal-coach",
      scope: "project",
      spaceId: input.space.spaceId,
      projectId: input.projectId,
      revision: "1",
      title: "Personal Coach onboarding",
      text: ONBOARDING,
    },
  });

  register({
    descriptor: {
      id: `personal-coach.finish-onboarding-${suffix}`,
      kind: "tool",
      owner: "personal-coach",
      scope: "project",
      spaceId: input.space.spaceId,
      projectId: input.projectId,
      revision: "1",
      name: "coach_finish_onboarding",
      description: "Finish Personal Coach setup after the user explicitly confirms coaching preferences and whether daily/weekly proactive check-ins are enabled. Never infer reminder consent.",
      trust: "workspace",
      mutating: true,
      inputSchema: schema({
        timeZone: { type: "string", description: "Confirmed IANA time zone" },
        tone: { type: "string", enum: ["supportive", "balanced", "direct"] },
        initiative: { type: "string", enum: ["reactive", "balanced", "proactive"] },
        challengeAssumptions: { type: "boolean" },
        dailyCheckIn: { type: "boolean", description: "Explicit user opt-in/out" },
        dailyMinuteOfDay: { type: "number", description: "Local minute 0-1439; required when dailyCheckIn is true" },
        weeklyReview: { type: "boolean", description: "Explicit user opt-in/out" },
        weeklyDay: { type: "number", description: "Sunday=0 through Saturday=6; required when weeklyReview is true" },
        weeklyMinuteOfDay: { type: "number", description: "Local minute 0-1439; required when weeklyReview is true" },
      }, ["timeZone", "dailyCheckIn", "weeklyReview"]),
    },
    execute: async (value, ctx) => {
      assertTarget(ctx);
      const timeZone = String(value.timeZone ?? "").trim();
      if (!isCoachTimeZone(timeZone)) {
        throw Object.assign(new Error("timeZone must be a valid IANA time zone"), { code: "invalid-input" });
      }
      const dailyCheckIn = bool(value.dailyCheckIn, "dailyCheckIn");
      const weeklyReview = bool(value.weeklyReview, "weeklyReview");
      const dailyMinute = dailyCheckIn
        ? integer(value.dailyMinuteOfDay, "dailyMinuteOfDay", 0, 1439)
        : DEFAULT_DAILY_MINUTE;
      const weeklyDay = weeklyReview
        ? integer(value.weeklyDay, "weeklyDay", 0, 6)
        : DEFAULT_WEEKLY_DAY;
      const weeklyMinute = weeklyReview
        ? integer(value.weeklyMinuteOfDay, "weeklyMinuteOfDay", 0, 1439)
        : DEFAULT_WEEKLY_MINUTE;
      const tone = value.tone === undefined ? undefined : String(value.tone) as CoachTone;
      const initiative = value.initiative === undefined ? undefined : String(value.initiative) as CoachInitiative;
      const challenge = value.challengeAssumptions === undefined
        ? undefined
        : bool(value.challengeAssumptions, "challengeAssumptions");

      let reminders: { dailyTaskId?: string; weeklyTaskId?: string } = {};
      const schedule = input.schedule();
      if ((dailyCheckIn || weeklyReview) && !schedule) {
        throw Object.assign(new Error("Schedule package is unavailable; Coach reminders were not enabled"), { code: "unavailable" });
      }
      if (schedule) {
        reminders = configureCoachReminders(schedule, input.projectId, {
          timeZone,
          dailyCheckIn: { enabled: dailyCheckIn, minuteOfDay: dailyMinute },
          weeklyReview: { enabled: weeklyReview, day: weeklyDay, minuteOfDay: weeklyMinute },
        });
      }

      const profile = input.store.updateProfile({
        timeZone,
        onboardingState: "complete",
        ...(tone !== undefined ? { tone } : {}),
        ...(initiative !== undefined ? { initiative } : {}),
        ...(challenge !== undefined ? { challengeAssumptions: challenge } : {}),
      });
      return {
        output: JSON.stringify({
          profile,
          reminders: {
            dailyCheckIn,
            weeklyReview,
            ...reminders,
          },
        }),
      };
    },
  });

  return {
    ids,
    async dispose() {
      for (const registration of registrations.toReversed()) await registration.dispose();
    },
  };
}
