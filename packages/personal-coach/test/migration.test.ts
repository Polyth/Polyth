import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCoachStore } from "../src/index.ts";
import { createCoachProposalReviewStore } from "../src/proposals.ts";
import { buildCoachHome } from "../src/home.ts";

const file = (): string => join(mkdtempSync(join(tmpdir(), "polyth-coach-migrate-")), "coach.db");

/**
 * Build a database exactly as schema version 1 shipped it, including the
 * proposal/plan tables that `proposals.ts` used to create ad hoc, then put real
 * user rows in it. Every migration assertion below runs against this, not
 * against a freshly created v2 file.
 */
function legacyDatabase(path: string, at: number): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE coach_meta (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);
    INSERT INTO coach_meta (id, revision) VALUES (1, 7);
    CREATE TABLE coach_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1), tone TEXT NOT NULL, initiative TEXT NOT NULL,
      time_zone TEXT NOT NULL, challenge_assumptions INTEGER NOT NULL,
      onboarding_state TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE coach_areas (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, sort_order INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE coach_goals (
      id TEXT PRIMARY KEY, area_id TEXT REFERENCES coach_areas(id) ON DELETE SET NULL,
      title TEXT NOT NULL, desired_outcome TEXT, why TEXT, status TEXT NOT NULL,
      priority INTEGER NOT NULL, target_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE coach_milestones (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES coach_goals(id) ON DELETE CASCADE, title TEXT NOT NULL, status TEXT NOT NULL, due_at INTEGER, sort_order INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE coach_commitments (
      id TEXT PRIMARY KEY, goal_id TEXT REFERENCES coach_goals(id) ON DELETE SET NULL,
      title TEXT NOT NULL, status TEXT NOT NULL, planned_for INTEGER, due_at INTEGER,
      estimate_minutes INTEGER, source TEXT NOT NULL, source_session_id TEXT,
      completed_at INTEGER, last_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE coach_routines (id TEXT PRIMARY KEY, goal_id TEXT REFERENCES coach_goals(id) ON DELETE SET NULL, title TEXT NOT NULL, cadence TEXT NOT NULL, preferred_minute_of_day INTEGER, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE coach_checkins (id TEXT PRIMARY KEY, energy INTEGER NOT NULL, focus INTEGER NOT NULL, note TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE coach_reflections (id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, source_session_id TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE coach_insights (id TEXT PRIMARY KEY, statement TEXT NOT NULL, confidence TEXT NOT NULL, evidence TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE coach_proposals (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, reason TEXT, status TEXT NOT NULL, source_session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE coach_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX idx_coach_goals_status_priority ON coach_goals(status, priority, updated_at);
    CREATE INDEX idx_coach_commitments_status_planned ON coach_commitments(status, planned_for, created_at);
    CREATE INDEX idx_coach_routines_status ON coach_routines(status, updated_at);
    CREATE INDEX idx_coach_events_created ON coach_events(created_at, seq);
    CREATE INDEX idx_coach_events_entity ON coach_events(entity_type, entity_id, seq);

    CREATE TABLE coach_proposal_applications (proposal_id TEXT PRIMARY KEY REFERENCES coach_proposals(id) ON DELETE CASCADE, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, applied_at INTEGER NOT NULL);
    CREATE TABLE coach_plans (id TEXT PRIMARY KEY, goal_id TEXT REFERENCES coach_goals(id) ON DELETE SET NULL, title TEXT NOT NULL, current_revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE coach_plan_revisions (plan_id TEXT NOT NULL REFERENCES coach_plans(id) ON DELETE CASCADE, revision INTEGER NOT NULL, summary TEXT NOT NULL, patch TEXT NOT NULL, source_proposal_id TEXT REFERENCES coach_proposals(id) ON DELETE SET NULL, created_at INTEGER NOT NULL, PRIMARY KEY (plan_id, revision));
    PRAGMA user_version = 1;
  `);
  db.prepare("INSERT INTO coach_profile (id, tone, initiative, time_zone, challenge_assumptions, onboarding_state, updated_at) VALUES (1, 'direct', 'proactive', 'Europe/Kyiv', 1, 'complete', ?)")
    .run(at);
  db.prepare("INSERT INTO coach_goals (id, area_id, title, desired_outcome, why, status, priority, target_at, created_at, updated_at) VALUES ('g1', NULL, 'Ship the beta', 'Real users on it', NULL, 'active', 3, NULL, ?, ?)")
    .run(at, at);
  db.prepare("INSERT INTO coach_commitments (id, goal_id, title, status, planned_for, due_at, estimate_minutes, source, source_session_id, completed_at, last_reason, created_at, updated_at) VALUES ('c1', 'g1', 'Write the changelog', 'open', ?, NULL, 30, 'user', NULL, NULL, NULL, ?, ?)")
    .run(at, at, at);
  db.prepare("INSERT INTO coach_plans (id, goal_id, title, current_revision, created_at, updated_at) VALUES ('p1', 'g1', 'Legacy plan', 1, ?, ?)")
    .run(at, at);
  db.prepare("INSERT INTO coach_plan_revisions (plan_id, revision, summary, patch, source_proposal_id, created_at) VALUES ('p1', 1, 'Original plan', '{}', NULL, ?)")
    .run(at);
  db.close();
}

test("a version 1 database upgrades in place without losing user data", () => {
  const path = file();
  const at = Date.parse("2026-09-01T12:00:00Z");
  legacyDatabase(path, at);

  const store = createCoachStore(path);
  const version = (): number => {
    const db = new DatabaseSync(path);
    const value = Number((db.prepare("PRAGMA user_version").get() as unknown as { user_version: number }).user_version);
    db.close();
    return value;
  };
  assert.equal(version(), 2);

  // Nothing the user owned was dropped or rewritten.
  assert.equal(store.revision(), 7);
  assert.equal(store.profile().tone, "direct");
  assert.equal(store.profile().timeZone, "Europe/Kyiv");
  assert.equal(store.getGoal("g1")?.title, "Ship the beta");
  assert.equal(store.getCommitment("c1")?.estimateMinutes, 30);

  // The review anchor is backfilled from the best evidence the old schema had.
  assert.equal(store.profile().onboardingCompletedAt, at);
  // Legacy plan rows survive: phasing the concept out of the product must not
  // delete what an existing installation already stored.
  assert.equal(createCoachProposalReviewStore(path).getPlan("p1")?.revisions.length, 1);

  // New durable state is usable immediately.
  const routine = store.createRoutine({ title: "Morning workout", cadence: { kind: "weekly", days: [1, 2, 3, 4, 5] } });
  store.setRoutineOccurrence({ routineId: routine.id, dateKey: "2026-09-01", status: "done" });
  assert.equal(store.getRoutineOccurrence(routine.id, "2026-09-01")?.status, "done");
  assert.equal(store.canonicalSessionId(), undefined);
  store.setCanonicalSessionId("session-1");
  assert.equal(store.canonicalSessionId(), "session-1");
  store.close();
});

test("reopening an upgraded database is a no-op and stays restart-safe", () => {
  const path = file();
  const at = Date.parse("2026-09-01T12:00:00Z");
  legacyDatabase(path, at);

  const first = createCoachStore(path);
  first.setCanonicalSessionId("session-1");
  const revision = first.revision();
  first.close();

  const second = createCoachStore(path);
  assert.equal(second.revision(), revision, "re-running the migration must not touch user state");
  assert.equal(second.canonicalSessionId(), "session-1");
  assert.equal(second.profile().onboardingCompletedAt, at);
  second.close();
});

test("a fresh database and an upgraded one expose the same behavior", () => {
  const upgradedPath = file();
  const at = Date.parse("2026-09-10T09:00:00Z");
  legacyDatabase(upgradedPath, at);
  const upgraded = createCoachStore(upgradedPath);
  const fresh = createCoachStore(file());
  fresh.updateProfile({ timeZone: "Europe/Kyiv", onboardingState: "complete" });
  const goal = fresh.createGoal({ title: "Ship the beta" });
  fresh.setPrimaryGoal(goal.id);
  fresh.createCommitment({ goalId: goal.id, title: "Write the changelog", plannedFor: at, estimateMinutes: 30 });

  const now = Date.parse("2026-09-10T15:00:00Z");
  const a = buildCoachHome(upgraded, { now });
  const b = buildCoachHome(fresh, { now });
  assert.equal(a.date, b.date);
  assert.equal(a.today.focus?.title, "Write the changelog");
  assert.equal(b.today.focus?.title, "Write the changelog");
  assert.equal(a.today.total, b.today.total);
  upgraded.close();
  fresh.close();
});

test("the proposal store refuses a database that never ran the migration", () => {
  const path = file();
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
  db.close();
  assert.throws(
    () => createCoachProposalReviewStore(path),
    (error: { code?: string }) => error.code === "unsupported-schema",
  );
});
