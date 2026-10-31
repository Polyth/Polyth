import { buildCoachHome } from "./home.ts";
import type { CoachCommitment, CoachEvent, CoachStore } from "./index.ts";

export const COACH_CONTEXT_MAX_CHARS = 12_000;

const clip = (value: string | undefined, max: number): string | undefined => {
  if (!value) return undefined;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
};

const commitmentFact = (item: CoachCommitment) => ({
  id: item.id,
  goalId: item.goalId,
  title: clip(item.title, 240),
  plannedFor: item.plannedFor,
  dueAt: item.dueAt,
  estimateMinutes: item.estimateMinutes,
});

const compactEvent = (event: CoachEvent) => ({
  seq: event.seq,
  type: event.eventType,
  entity: `${event.entityType}:${event.entityId}`,
  at: event.createdAt,
  payload: clip(JSON.stringify(event.payload), 320),
});

/**
 * Small durable-state snapshot injected when a Coach session is created and
 * returned by the read-context tool. Old history stays queryable through
 * focused tools instead of living in every prompt.
 */
export function buildCoachContext(
  store: CoachStore,
  opts: { now?: number; maxChars?: number } = {},
): string {
  const maxChars = Math.max(2_000, Math.min(opts.maxChars ?? COACH_CONTEXT_MAX_CHARS, COACH_CONTEXT_MAX_CHARS));
  const home = buildCoachHome(store, { ...(opts.now !== undefined ? { now: opts.now } : {}) });
  const state = {
    schema: "polyth.personal-coach.context.v2",
    generatedAt: opts.now ?? Date.now(),
    date: home.date,
    reviewDue: home.reviewDue,
    preferences: {
      tone: home.profile.tone,
      initiative: home.profile.initiative,
      challengeAssumptions: home.profile.challengeAssumptions,
      timeZone: home.profile.timeZone,
      onboardingState: home.profile.onboardingState,
    },
    activeGoals: store.listGoals("active").slice(0, 6).map((goal) => ({
      id: goal.id,
      title: clip(goal.title, 240),
      desiredOutcome: clip(goal.desiredOutcome, 500),
      why: clip(goal.why, 500),
      // The user's visible concept is "primary goal", not a 1-3 number.
      primary: goal.priority === 3,
      targetAt: goal.targetAt,
    })),
    // Today, overdue and upcoming stay separate here for the same reason they
    // are separate in the UI: a future commitment is not today's work, and the
    // model must not infer otherwise from a flattened list.
    today: {
      focusId: home.today.focus?.id,
      total: home.today.total,
      actions: home.today.actions.map(commitmentFact),
      routines: home.today.routines.map((due) => ({
        id: due.routine.id,
        goalId: due.routine.goalId,
        title: clip(due.routine.title, 240),
        cadence: due.routine.cadence,
        preferredMinuteOfDay: due.routine.preferredMinuteOfDay,
        status: due.status ?? "open",
      })),
    },
    attention: {
      overdueTotal: home.attention.overdueTotal,
      overdue: home.attention.overdue.map(commitmentFact),
      overloaded: home.attention.overloaded,
    },
    upcoming: {
      total: home.upcoming.total,
      next: home.upcoming.next ? commitmentFact(home.upcoming.next) : undefined,
      items: home.upcoming.items.map(commitmentFact),
    },
    pendingSuggestions: home.suggestionCount,
    recentCheckIns: store.listCheckIns({ limit: 3 }).map((item) => ({
      energy: item.energy,
      focus: item.focus,
      note: clip(item.note, 300),
      at: item.createdAt,
    })),
    acceptedInsights: store.listInsights("accepted").slice(0, 5).map((item) => ({
      id: item.id,
      statement: clip(item.statement, 600),
      confidence: item.confidence,
      evidence: item.evidence.slice(0, 8),
    })),
    recentReflections: store.listReflections(4).map((item) => ({
      kind: item.kind,
      text: clip(item.text, 900),
      at: item.createdAt,
    })),
    recentEvents: store.listEvents({ limit: 16 }).map(compactEvent),
  };

  let text = JSON.stringify(state);
  if (text.length <= maxChars) return text;

  // Drop least-useful historical context before touching current state.
  const reduced = {
    ...state,
    recentEvents: state.recentEvents.slice(0, 6),
    recentReflections: state.recentReflections.slice(0, 2),
    acceptedInsights: state.acceptedInsights.slice(0, 3),
  };
  text = JSON.stringify(reduced);
  if (text.length <= maxChars) return text;

  const minimal = {
    schema: state.schema,
    generatedAt: state.generatedAt,
    date: state.date,
    reviewDue: state.reviewDue,
    preferences: state.preferences,
    activeGoals: state.activeGoals.slice(0, 3).map((goal) => ({
      id: goal.id,
      title: goal.title,
      primary: goal.primary,
      targetAt: goal.targetAt,
    })),
    today: state.today,
  };
  text = JSON.stringify(minimal);
  if (text.length <= maxChars) return text;

  // Keep the hard budget and valid JSON even under an intentionally tiny
  // caller budget. Focused tools can retrieve the omitted records on demand.
  return JSON.stringify({
    schema: state.schema,
    generatedAt: state.generatedAt,
    date: state.date,
    reviewDue: state.reviewDue,
    onboardingState: state.preferences.onboardingState,
    activeGoalCount: state.activeGoals.length,
    todayCommitmentCount: state.today.total,
    omitted: true,
    hint: "Use Personal Coach tools to read focused current state.",
  });
}
