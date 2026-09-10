import type { RouteHandler, SpaceContext } from "@polyth/contracts";
import { packageWorkspace, type ServerPackageHost } from "@polyth/plugins";
import type { CoachStore } from "./index.ts";
import {
  configureCoachReminders,
  readCoachReminders,
  type CoachReminderSettings,
  type CoachScheduleService,
} from "./onboarding.ts";
import type { PersonalCoachService } from "./service.ts";

const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code });

const bool = (value: unknown, name: string): boolean => {
  if (typeof value !== "boolean") throw fail("invalid-input", `${name} must be a boolean`);
  return value;
};

const integer = (value: unknown, name: string, min: number, max: number): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw fail("invalid-input", `${name} must be an integer from ${min} to ${max}`);
  }
  return n;
};

export interface CoachReminderRouteDeps {
  coach: PersonalCoachService;
  schedule(): CoachScheduleService | undefined;
  ensureCapabilities(
    space: Pick<SpaceContext, "spaceId">,
    projectId: string,
    store: CoachStore,
  ): void | Promise<void>;
}

/** User-facing reminder control. The route never exposes the internal package
 * project id and can only address the calling package's validated workspace. */
export function personalCoachReminderRoutes(
  host: Pick<ServerPackageHost, "pluginId" | "projects" | "spaceStorage">,
  deps: CoachReminderRouteDeps,
): RouteHandler {
  return async (request) => {
    if (request.path !== "/api/personal-coach/reminders") return false;
    const schedule = deps.schedule();
    if (request.method === "GET") {
      if (!schedule) {
        request.json(200, { available: false });
        return true;
      }
      const workspace = await packageWorkspace(host, request.space);
      const profile = deps.coach.forSpace(request.space).profile();
      request.json(200, {
        available: true,
        settings: readCoachReminders(schedule, workspace.projectId, profile.timeZone),
      });
      return true;
    }
    if (request.method !== "PUT") return false;
    if (!schedule) throw fail("unavailable", "Schedule package is unavailable");

    const store = deps.coach.forSpace(request.space);
    const profile = store.profile();
    if (profile.onboardingState !== "complete") {
      throw fail("conflict", "Finish Personal Coach setup before enabling scheduled check-ins");
    }
    const input = await request.body();
    const settings: CoachReminderSettings = {
      timeZone: profile.timeZone,
      dailyCheckIn: {
        enabled: bool(input.dailyCheckIn, "dailyCheckIn"),
        minuteOfDay: integer(input.dailyMinuteOfDay, "dailyMinuteOfDay", 0, 1439),
      },
      weeklyReview: {
        enabled: bool(input.weeklyReview, "weeklyReview"),
        day: integer(input.weeklyDay, "weeklyDay", 0, 6),
        minuteOfDay: integer(input.weeklyMinuteOfDay, "weeklyMinuteOfDay", 0, 1439),
      },
    };

    const workspace = await packageWorkspace(host, request.space);
    // A Settings-only user can enable reminders before opening another Coach
    // chat. Register the workspace capabilities before Schedule can fire.
    await deps.ensureCapabilities(request.space, workspace.projectId, store);
    configureCoachReminders(schedule, workspace.projectId, settings);
    request.json(200, {
      available: true,
      settings: readCoachReminders(schedule, workspace.projectId, profile.timeZone),
    });
    return true;
  };
}
