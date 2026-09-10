import { buildCoachHome } from "./home.ts";
import type { CoachEvent, CoachStore } from "./index.ts";

export const COACH_CONTEXT_MAX_CHARS = 12_000;

const clip = (value: string | undefined, max: number): string | undefined => {
  if (!value) return undefined;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
};

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
    schema: "polyth.personal-coach.context.v1",
    generatedAt: opts.now ?? Date.now(),
    date: home.date,
    preferences: {
      tone: home.profile.tone,
      initiative: home.profile.initiative,
      challengeAssumptions: home.profile.challengeAssumptions,
      timeZone: home.profile.timeZone,
    },
    activeGoals: store.listGoals("active").slice(0, 6).map((goal) => ({
      id: goal.id,
      title: clip(goal.title, 240),
      desiredOutcome: clip(goal.desiredOutcome, 500),
      why: clip(goal.why, 500),
      priority: goal.priority,
      targetAt: goal.targetAt,
    })),
    today: {
      mainFocusId: home.today.mainFocus?.id,
      commitments: home.today.commitments.map((item) => ({
        id: item.id,
        goalId: item.goalId,
        title: clip(item.title, 240),
        plannedFor: item.plannedFor,
        dueAt: item.dueAt,
        estimateMinutes: item.estimateMinutes,
      })),
      overdueCount: home.today.overdueCount,
      overflowCount: home.today.overflowCount,
      dueRoutines: home.today.dueRoutines.map((routine) => ({
        id: routine.id,
        goalId: routine.goalId,
        title: clip(routine.title, 240),
        cadence: routine.cadence,
        preferredMinuteOfDay: routine.preferredMinuteOfDay,
      })),
    },
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
    preferences: state.preferences,
    activeGoals: state.activeGoals.slice(0, 3).map((goal) => ({
      id: goal.id,
      title: goal.title,
      priority: goal.priority,
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
    activeGoalCount: state.activeGoals.length,
    todayCommitmentCount: state.today.commitments.length,
    omitted: true,
    hint: "Use Personal Coach tools to read focused current state.",
  });
}
