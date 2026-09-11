import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoachHomeDto } from "../widgets/api.ts";
import { coachNavStatus } from "../widgets/navStatus.ts";

const home = (patch: Partial<CoachHomeDto> = {}): CoachHomeDto => ({
  revision: 1,
  date: "2026-09-10",
  profile: {
    tone: "balanced",
    initiative: "balanced",
    timeZone: "Europe/Kyiv",
    challengeAssumptions: false,
    onboardingState: "complete",
    updatedAt: 1,
  },
  today: { actions: [], total: 0, routines: [] },
  attention: { overdue: [], overdueTotal: 0, overloaded: false },
  upcoming: { items: [], total: 0 },
  activeGoals: [],
  activeGoalTotal: 0,
  suggestionCount: 0,
  reviewDue: false,
  ...patch,
});

test("the sidebar shows one short line, not a dashboard", () => {
  assert.equal(coachNavStatus(undefined), null, "nothing is claimed before Home loads");
  assert.equal(
    coachNavStatus(home({ profile: { ...home().profile, onboardingState: "new" } })),
    null,
    "an un-onboarded Coach advertises no state",
  );

  // Priority order: replanning first, then things waiting on the user, then
  // what the day actually holds. Exactly one of these is ever rendered.
  assert.match(
    coachNavStatus(home({
      attention: { overdue: [], overdueTotal: 2, overloaded: false },
      suggestionCount: 3,
      reviewDue: true,
    })) ?? "",
    /2/,
  );
  assert.match(coachNavStatus(home({ suggestionCount: 3, reviewDue: true })) ?? "", /3/);
  assert.match(coachNavStatus(home({ reviewDue: true })) ?? "", /[Ww]eekly/);

  const focus = { id: "c1", title: "Write the changelog", status: "open" as const };
  assert.equal(
    coachNavStatus(home({ today: { focus, actions: [focus], total: 1, routines: [] } })),
    "Write the changelog",
  );

  assert.equal(
    coachNavStatus(home({
      today: {
        actions: [],
        total: 0,
        routines: [{
          routine: { id: "r1", title: "Morning workout", cadence: { kind: "daily" }, preferredMinuteOfDay: 360, status: "active" },
          dateKey: "2026-09-10",
        }],
      },
    })),
    "Morning workout · 06:00",
  );

  assert.equal(coachNavStatus(home()), "You’re clear today.");
});
