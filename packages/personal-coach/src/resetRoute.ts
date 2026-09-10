import type { RouteHandler } from "@polyth/contracts";
import { packageWorkspace, type ServerPackageHost } from "@polyth/plugins";
import {
  configureCoachReminders,
  type CoachScheduleService,
} from "./onboarding.ts";
import type { PersonalCoachService } from "./service.ts";

/**
 * Reset package-owned durable coaching state. Existing Polyth session
 * transcripts are deliberately not deleted by this endpoint.
 */
export function personalCoachResetRoute(
  host: Pick<ServerPackageHost, "pluginId" | "projects" | "spaceStorage">,
  deps: {
    coach: PersonalCoachService;
    schedule(): CoachScheduleService | undefined;
  },
): RouteHandler {
  return async (request) => {
    if (request.path !== "/api/personal-coach/reset" || request.method !== "POST") return false;

    const profile = deps.coach.forSpace(request.space).profile();
    const schedule = deps.schedule();
    if (schedule) {
      // Remove proactive work first. A failed DB reset may leave data intact,
      // but it must never leave old scheduled prompts running after a reset
      // request was accepted far enough to mutate cross-package state.
      const workspace = await packageWorkspace(host, request.space);
      configureCoachReminders(schedule, workspace.projectId, {
        timeZone: profile.timeZone,
        dailyCheckIn: { enabled: false, minuteOfDay: 8 * 60 },
        weeklyReview: { enabled: false, day: 0, minuteOfDay: 18 * 60 },
      });
    }

    request.json(200, deps.coach.resetForSpace(request.space));
    return true;
  };
}
