import { DatabaseSync } from "node:sqlite";

export interface CoachResetResult {
  revision: number;
  resetAt: number;
}

/**
 * Clear durable Coach state without deleting the SQLite file or changing the
 * user's communication/time-zone preferences. Existing Polyth chat transcripts
 * are session-owned and intentionally outside this package-state reset.
 */
export function resetCoachData(file: string, opts: { now?: () => number } = {}): CoachResetResult {
  const db = new DatabaseSync(file);
  const now = opts.now ?? Date.now;
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 2000");

  const tableExists = (name: string): boolean => Boolean(
    db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
  const clear = (name: string): void => {
    if (tableExists(name)) db.exec(`DELETE FROM ${name}`);
  };

  db.exec("BEGIN IMMEDIATE");
  try {
    const at = now();
    // Additive proposal/plan tables may not exist in a Space that never opened
    // a proposal. Clear them first when present, then the base FK graph.
    clear("coach_proposal_applications");
    clear("coach_plan_revisions");
    clear("coach_plans");
    clear("coach_milestones");
    clear("coach_commitments");
    clear("coach_routine_occurrences");
    clear("coach_routines");
    clear("coach_insights");
    clear("coach_proposals");
    clear("coach_reflections");
    clear("coach_checkins");
    clear("coach_goals");
    clear("coach_areas");
    clear("coach_events");

    // Keep tone/initiative/timezone/challenge preference: reset means "what
    // Coach knows and plans", not "forget how I configured the UI".
    db.prepare("UPDATE coach_profile SET onboarding_state = 'new', onboarding_completed_at = NULL, updated_at = ? WHERE id = 1").run(at);
    // The next "Ask Coach" starts a fresh conversation: a reset must not resume
    // a chat whose context describes state that no longer exists.
    db.prepare("UPDATE coach_meta SET revision = revision + 1, canonical_session_id = NULL WHERE id = 1").run();
    db.prepare("INSERT INTO coach_events (event_type, entity_type, entity_id, payload, created_at) VALUES ('coach.reset', 'coach', 'state', ?, ?)")
      .run(JSON.stringify({ preservedPreferences: true }), at);
    const revision = Number(
      (db.prepare("SELECT revision FROM coach_meta WHERE id = 1").get() as unknown as { revision: number }).revision,
    );
    db.exec("COMMIT");
    db.close();
    return { revision, resetAt: at };
  } catch (cause) {
    try { db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
    db.close();
    throw cause;
  }
}
