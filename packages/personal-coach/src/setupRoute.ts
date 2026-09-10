import type { RouteHandler } from "@polyth/contracts";
import { packageWorkspace, type ServerPackageHost } from "@polyth/plugins";
import { configureCoachReminders, type CoachScheduleService } from "./onboarding.ts";
import type { CoachSessionDeps } from "./sessionRoute.ts";
import { completeCoachSetup, parseCoachSetup } from "./setup.ts";

export function personalCoachSetupRoute(
  host: Pick<ServerPackageHost, "pluginId" | "projects" | "spaceStorage">,
  deps: CoachSessionDeps & { schedule(): CoachScheduleService | undefined },
): RouteHandler {
  return async (request) => {
    if (request.path !== "/api/personal-coach/setup" || request.method !== "POST") return false;
    const input = parseCoachSetup(await request.body());
    const store = deps.coach.forSpace(request.space);
    const schedule = deps.schedule();
    // Finishing without reminders requires no model or running backend.
    let configure: ((value: typeof input) => void) | undefined;
    if (schedule) {
      const workspace = await packageWorkspace(host, request.space);
      if (input.dailyCheckIn || input.weeklyReview) {
        await deps.ensureCapabilities(request.space, workspace.projectId, store);
      }
      configure = (value) => { configureCoachReminders(schedule, workspace.projectId, {
        timeZone: value.timeZone,
        dailyCheckIn: { enabled: value.dailyCheckIn, minuteOfDay: value.dailyMinuteOfDay },
        weeklyReview: { enabled: value.weeklyReview, day: value.weeklyDay, minuteOfDay: value.weeklyMinuteOfDay },
      }); };
    }
    request.json(200, completeCoachSetup(store, input, configure));
    return true;
  };
}
