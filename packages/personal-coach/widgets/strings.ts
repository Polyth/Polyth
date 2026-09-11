/**
 * Every user-facing string the Coach UI renders, in one place.
 *
 * Shape and key style deliberately match the per-package catalogues the rest of
 * the repository feeds into `apps/web/src/i18n` (`<owner>.<key>` → message,
 * `{placeholder}` interpolation). Coach is not registered with that loader yet
 * — doing so requires complete catalogues for all twelve supported locales —
 * so this module is the single seam that has to change when it is, instead of
 * English being scattered through a dozen components.
 *
 * Keep entries alphabetical within their group and keep the group prefix equal
 * to the surface that renders them.
 */
export const coachStrings = {
  "coach.workspace.title": "Coach",
  "coach.workspace.loading": "Loading Coach…",
  "coach.workspace.refreshFailed": "Coach couldn’t refresh",
  "coach.workspace.retry": "Retry",
  "coach.workspace.settings": "Coach settings",
  "coach.workspace.views": "Coach views",

  "coach.tab.overview": "Overview",
  "coach.tab.today": "Today",
  "coach.tab.goals": "Goals",
  "coach.tab.review": "Review",

  "coach.ask.label": "Ask Coach",
  "coach.ask.opening": "Opening conversation…",
  "coach.ask.aboutAction": "Ask Coach about “{title}”",
  "coach.ask.aboutGoal": "Ask Coach about “{title}”",
  "coach.ask.aboutSuggestion": "Discuss this suggestion",

  "coach.greeting.morning": "Good morning",
  "coach.greeting.afternoon": "Good afternoon",
  "coach.greeting.evening": "Good evening",

  "coach.today.focus": "Today’s focus",
  "coach.today.clear": "You’re clear today.",
  "coach.today.clearHint": "Nothing is scheduled. Add one small step, or leave the day open.",
  "coach.today.alsoToday": "Also today",
  "coach.today.moreCount": "+{count} more today",
  "coach.today.addLabel": "Add something for today",
  "coach.today.addPlaceholder": "Something you can actually do today",
  "coach.today.add": "Add for today",
  "coach.today.towards": "Toward {title}",

  "coach.action.done": "Done",
  "coach.action.move": "Move",
  "coach.action.more": "More",
  "coach.action.moreFor": "More actions for {title}",
  "coach.action.moveFor": "Reschedule {title}",
  "coach.action.moveHour": "Later today",
  "coach.action.moveTomorrow": "Tomorrow",
  "coach.action.moveWeek": "Next week",
  "coach.action.unblock": "Help me get unstuck",
  "coach.action.skipReason": "Skip · {reason}",
  "coach.action.skip": "Skip without a reason",
  "coach.action.reasonNoTime": "No time",
  "coach.action.reasonTooLarge": "Too large",
  "coach.action.reasonPriorities": "Priorities changed",

  "coach.attention.title": "Needs replanning",
  "coach.attention.overdue": "{count} from an earlier day",
  "coach.attention.overloaded": "A lot landed on today. Keep what matters and move what can wait.",

  "coach.upcoming.title": "Next up",
  "coach.upcoming.empty": "Nothing queued.",
  "coach.upcoming.unscheduled": "Unscheduled",
  "coach.upcoming.moveToToday": "Move to today",
  "coach.upcoming.count": "{count} ahead",

  "coach.routines.title": "Routines today",
  "coach.routines.done": "Done",
  "coach.routines.skip": "Skip",
  "coach.routines.reopen": "Reopen",
  "coach.routines.doneState": "Done today",
  "coach.routines.skippedState": "Skipped today",

  "coach.goals.title": "Goals",
  "coach.goals.heading": "Where you’re heading",
  "coach.goals.empty": "Start with one meaningful direction. You don’t need a perfect plan.",
  "coach.goals.emptyFiltered": "No goals in this view.",
  "coach.goals.addLabel": "A direction that matters",
  "coach.goals.addPlaceholder": "For example, ship a first public beta",
  "coach.goals.add": "Add goal",
  "coach.goals.filter": "Goal status",
  "coach.goals.statusActive": "Active",
  "coach.goals.statusPaused": "Paused",
  "coach.goals.statusCompleted": "Completed",
  "coach.goals.statusAll": "All goals",
  "coach.goals.primary": "Primary",
  "coach.goals.makePrimary": "Make primary goal",
  "coach.goals.clearPrimary": "Clear primary goal",
  "coach.goals.open": "Open {title}",
  "coach.goals.back": "All goals",
  "coach.goals.count": "{count} active",

  "coach.goal.outcome": "What success looks like",
  "coach.goal.why": "Why it matters",
  "coach.goal.nextAction": "Next action",
  "coach.goal.nextActionLabel": "A next action toward this goal",
  "coach.goal.nextActionPlaceholder": "The next concrete step",
  "coach.goal.addNextAction": "Add next action",
  "coach.goal.nextActionHint": "Unscheduled until you move it to a day.",
  "coach.goal.upcomingActions": "Upcoming actions",
  "coach.goal.noActions": "No open actions yet.",
  "coach.goal.routines": "Linked routines",
  "coach.goal.edit": "Edit goal",
  "coach.goal.save": "Save",
  "coach.goal.cancel": "Cancel",
  "coach.goal.pause": "Pause",
  "coach.goal.resume": "Resume",
  "coach.goal.complete": "Mark complete",
  "coach.goal.archive": "Archive",
  "coach.goal.titleLabel": "Goal",

  "coach.review.title": "Review",
  "coach.review.suggestions": "Suggestions",
  "coach.review.empty": "Nothing needs your review.",
  "coach.review.emptyHint": "Coach proposes changes here. Nothing is applied without you.",
  "coach.review.weeklyTitle": "Weekly review is ready",
  "coach.review.weeklyBody": "Look at what worked, then change only what needs changing.",
  "coach.review.weeklyAction": "Start weekly review",
  "coach.review.insight": "Worth noticing — a hypothesis",
  "coach.review.confidence": "{confidence} confidence",
  "coach.review.badge": "{count}",

  "coach.checkin.title": "Check-in",
  "coach.checkin.prompt": "How are you arriving today?",
  "coach.checkin.optional": "Optional",
  "coach.checkin.energy": "Energy",
  "coach.checkin.focus": "Focus",
  "coach.checkin.save": "Save check-in",
  "coach.checkin.edit": "Update",
  "coach.checkin.recorded": "{energy}/5 energy · {focus}/5 focus",
  "coach.checkin.note": "A self-report, not a measurement.",

  "coach.error.addAction": "Add action",
  "coach.error.addGoal": "Add goal",
  "coach.error.loadGoals": "Load goals",
  "coach.error.loadReview": "Load review",
  "coach.error.saveGoal": "Save goal",
  "coach.error.updateGoal": "Update goal",
  "coach.error.resolveRoutine": "Update routine",
  "coach.error.setPrimary": "Set primary goal",
} as const;

export type CoachStringKey = keyof typeof coachStrings;

/**
 * Resolve one Coach string, substituting `{name}` placeholders. Missing values
 * leave the placeholder visible rather than printing "undefined", so a broken
 * call site is obvious in review instead of shipping silently.
 */
export function t(key: CoachStringKey, values?: Record<string, string | number>): string {
  const message: string = coachStrings[key];
  if (!values) return message;
  return message.replace(/\{(\w+)\}/g, (whole, name: string) =>
    values[name] === undefined ? whole : String(values[name]));
}
