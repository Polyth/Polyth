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
  remove(id: string): boolean;
  preview(cadence: { kind: "cron"; expression: string; timeZone: string }, count?: number): unknown;
}

export interface CoachOnboardingCapabilitySet {
  ids: string[];
  dispose(): void | Promise<void>;
}

const DAILY_TITLE = "Coach · Daily check-in";
const WEEKLY_TITLE = "Coach · Weekly review";

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
        : undefined;
      const weeklyDay = weeklyReview
        ? integer(value.weeklyDay, "weeklyDay", 0, 6)
        : undefined;
      const weeklyMinute = weeklyReview
        ? integer(value.weeklyMinuteOfDay, "weeklyMinuteOfDay", 0, 1439)
        : undefined;
      const tone = value.tone === undefined ? undefined : String(value.tone) as CoachTone;
      const initiative = value.initiative === undefined ? undefined : String(value.initiative) as CoachInitiative;
      const challenge = value.challengeAssumptions === undefined
        ? undefined
        : bool(value.challengeAssumptions, "challengeAssumptions");

      let dailyTaskId: string | undefined;
      let weeklyTaskId: string | undefined;
      if (dailyCheckIn || weeklyReview) {
        const schedule = input.schedule();
        if (!schedule) {
          throw Object.assign(new Error("Schedule package is unavailable; Coach reminders were not enabled"), { code: "unavailable" });
        }
        dailyTaskId = syncTask(
          schedule,
          input.projectId,
          DAILY_TITLE,
          dailyCheckIn,
          DAILY_PROMPT,
          dailyMinute === undefined ? "0 8 * * *" : clockCron(dailyMinute),
          timeZone,
        );
        weeklyTaskId = syncTask(
          schedule,
          input.projectId,
          WEEKLY_TITLE,
          weeklyReview,
          WEEKLY_PROMPT,
          weeklyMinute === undefined || weeklyDay === undefined ? "0 18 * * 0" : clockCron(weeklyMinute, weeklyDay),
          timeZone,
        );
      } else {
        // Explicit opt-out also removes earlier Coach-created tasks when the
        // scheduler is available; setup completion itself must not depend on it.
        const schedule = input.schedule();
        if (schedule) {
          syncTask(schedule, input.projectId, DAILY_TITLE, false, DAILY_PROMPT, "0 8 * * *", timeZone);
          syncTask(schedule, input.projectId, WEEKLY_TITLE, false, WEEKLY_PROMPT, "0 18 * * 0", timeZone);
        }
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
            ...(dailyTaskId ? { dailyTaskId } : {}),
            ...(weeklyTaskId ? { weeklyTaskId } : {}),
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
