import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { JsonObject } from "@polyth/contracts";
import type {
  CoachProposal,
  CoachProposalStatus,
  CoachProposalType,
  CoachRoutineCadence,
} from "./index.ts";

export type CoachProposalApplicationType = "goal" | "commitment" | "routine" | "plan";

export interface CoachProposalApplication {
  type: CoachProposalApplicationType;
  id: string;
  appliedAt: number;
}

export interface CoachProposalDecision {
  proposal: CoachProposal;
  application?: CoachProposalApplication;
}

export interface CoachPlanRevision {
  revision: number;
  summary: string;
  patch: JsonObject;
  sourceProposalId?: string;
  createdAt: number;
}

export interface CoachPlan {
  id: string;
  goalId?: string;
  title: string;
  currentRevision: number;
  createdAt: number;
  updatedAt: number;
}

export interface CoachPlanDetail extends CoachPlan {
  revisions: CoachPlanRevision[];
}

export interface CoachProposalReviewStore {
  getProposal(id: string): CoachProposal | undefined;
  listProposals(status?: CoachProposalStatus, limit?: number): CoachProposal[];
  accept(id: string): CoachProposalDecision;
  reject(id: string): CoachProposalDecision;
  listPlans(limit?: number): CoachPlan[];
  getPlan(id: string): CoachPlanDetail | undefined;
  close(): void;
}

interface ProposalRow {
  id: string;
  type: string;
  payload: string;
  reason: string | null;
  status: string;
  source_session_id: string | null;
  created_at: number;
  updated_at: number;
}

interface ApplicationRow {
  entity_type: string;
  entity_id: string;
  applied_at: number;
}

interface PlanRow {
  id: string;
  goal_id: string | null;
  title: string;
  current_revision: number;
  created_at: number;
  updated_at: number;
}

interface PlanRevisionRow {
  revision: number;
  summary: string;
  patch: string;
  source_proposal_id: string | null;
  created_at: number;
}

const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code });

const requiredText = (value: unknown, name: string, max = 2_000): string => {
  if (typeof value !== "string" || !value.trim()) throw fail("invalid-input", `${name} is required`);
  const text = value.trim();
  if (text.length > max) throw fail("invalid-input", `${name} exceeds ${max} characters`);
  return text;
};

const optionalText = (value: unknown, name: string, max = 2_000): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw fail("invalid-input", `${name} must be a string`);
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > max) throw fail("invalid-input", `${name} exceeds ${max} characters`);
  return text;
};

const optionalTime = (value: unknown, name: string): number | undefined => {
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw fail("invalid-input", `${name} must be epoch milliseconds`);
  return Math.trunc(number);
};

const integer = (value: unknown, name: string, min: number, max: number): number => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw fail("invalid-input", `${name} must be an integer from ${min} to ${max}`);
  }
  return number;
};

const object = (value: unknown, name: string): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail("invalid-input", `${name} must be an object`);
  }
  JSON.stringify(value);
  return value as JsonObject;
};

const cadence = (value: unknown): CoachRoutineCadence => {
  const raw = object(value, "cadence");
  if (raw.kind === "daily") return { kind: "daily" };
  if (raw.kind === "interval") return { kind: "interval", everyDays: integer(raw.everyDays, "everyDays", 1, 365) };
  if (raw.kind === "weekly") {
    if (!Array.isArray(raw.days) || raw.days.length === 0) throw fail("invalid-input", "weekly cadence needs days");
    const days = [...new Set(raw.days.map((day) => integer(day, "day", 0, 6)))].sort((a, b) => a - b);
    return { kind: "weekly", days };
  }
  throw fail("invalid-input", "unsupported cadence kind");
};

const proposalOf = (row: ProposalRow): CoachProposal => ({
  id: row.id,
  type: row.type as CoachProposalType,
  payload: JSON.parse(row.payload) as JsonObject,
  ...(row.reason ? { reason: row.reason } : {}),
  status: row.status as CoachProposalStatus,
  ...(row.source_session_id ? { sourceSessionId: row.source_session_id } : {}),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
});

const applicationOf = (row: ApplicationRow | undefined): CoachProposalApplication | undefined => row ? ({
  type: row.entity_type as CoachProposalApplicationType,
  id: row.entity_id,
  appliedAt: Number(row.applied_at),
}) : undefined;

const planOf = (row: PlanRow): CoachPlan => ({
  id: row.id,
  ...(row.goal_id ? { goalId: row.goal_id } : {}),
  title: row.title,
  currentRevision: Number(row.current_revision),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
});

export function createCoachProposalReviewStore(file: string, opts: { now?: () => number } = {}): CoachProposalReviewStore {
  const db = new DatabaseSync(file);
  const now = opts.now ?? Date.now;
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 2000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS coach_proposal_applications (
      proposal_id TEXT PRIMARY KEY REFERENCES coach_proposals(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS coach_plans (
      id TEXT PRIMARY KEY,
      goal_id TEXT REFERENCES coach_goals(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      current_revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS coach_plan_revisions (
      plan_id TEXT NOT NULL REFERENCES coach_plans(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      summary TEXT NOT NULL,
      patch TEXT NOT NULL,
      source_proposal_id TEXT REFERENCES coach_proposals(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (plan_id, revision)
    );
    CREATE INDEX IF NOT EXISTS idx_coach_plan_revisions_proposal
      ON coach_plan_revisions(source_proposal_id);
  `);

  const transaction = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (cause) {
      try { db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      throw cause;
    }
  };

  const proposalRow = (id: string): ProposalRow | undefined =>
    db.prepare("SELECT * FROM coach_proposals WHERE id = ?").get(id) as unknown as ProposalRow | undefined;
  const requireProposal = (id: string): ProposalRow => {
    const row = proposalRow(id);
    if (!row) throw fail("not-found", "proposal not found");
    return row;
  };
  const application = (id: string): CoachProposalApplication | undefined => applicationOf(
    db.prepare("SELECT entity_type, entity_id, applied_at FROM coach_proposal_applications WHERE proposal_id = ?")
      .get(id) as unknown as ApplicationRow | undefined,
  );
  const requireGoal = (id: string): void => {
    if (!db.prepare("SELECT 1 AS ok FROM coach_goals WHERE id = ?").get(id)) throw fail("not-found", "goal not found");
  };
  const requireArea = (id: string): void => {
    if (!db.prepare("SELECT 1 AS ok FROM coach_areas WHERE id = ?").get(id)) throw fail("not-found", "area not found");
  };
  const bumpRevision = (): void => {
    db.prepare("UPDATE coach_meta SET revision = revision + 1 WHERE id = 1").run();
  };
  const audit = (eventType: string, entityType: string, entityId: string, payload: JsonObject, at: number): void => {
    db.prepare("INSERT INTO coach_events (event_type, entity_type, entity_id, payload, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(eventType, entityType, entityId, JSON.stringify(payload), at);
  };

  const createGoal = (row: ProposalRow, payload: JsonObject, at: number): CoachProposalApplication => {
    const areaId = optionalText(payload.areaId, "areaId", 200);
    if (areaId) requireArea(areaId);
    const title = requiredText(payload.title, "title", 240);
    const desiredOutcome = optionalText(payload.desiredOutcome, "desiredOutcome");
    const why = optionalText(payload.why, "why");
    const priority = payload.priority === undefined ? 2 : integer(payload.priority, "priority", 1, 3);
    const targetAt = optionalTime(payload.targetAt, "targetAt");
    const id = randomUUID();
    db.prepare("INSERT INTO coach_goals (id, area_id, title, desired_outcome, why, status, priority, target_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)")
      .run(id, areaId ?? null, title, desiredOutcome ?? null, why ?? null, priority, targetAt ?? null, at, at);
    audit("goal.created", "goal", id, { title, proposalId: row.id }, at);
    return { type: "goal", id, appliedAt: at };
  };

  const createCommitment = (row: ProposalRow, payload: JsonObject, at: number): CoachProposalApplication => {
    const goalId = optionalText(payload.goalId, "goalId", 200);
    if (goalId) requireGoal(goalId);
    const title = requiredText(payload.title, "title", 240);
    const plannedFor = optionalTime(payload.plannedFor, "plannedFor");
    const dueAt = optionalTime(payload.dueAt, "dueAt");
    const estimate = payload.estimateMinutes === undefined
      ? undefined
      : integer(payload.estimateMinutes, "estimateMinutes", 1, 24 * 60);
    const id = randomUUID();
    db.prepare("INSERT INTO coach_commitments (id, goal_id, title, status, planned_for, due_at, estimate_minutes, source, source_session_id, completed_at, last_reason, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?, ?, 'agent', ?, NULL, NULL, ?, ?)")
      .run(id, goalId ?? null, title, plannedFor ?? null, dueAt ?? null, estimate ?? null, row.source_session_id, at, at);
    audit("commitment.created", "commitment", id, { title, proposalId: row.id }, at);
    return { type: "commitment", id, appliedAt: at };
  };

  const createRoutine = (row: ProposalRow, payload: JsonObject, at: number): CoachProposalApplication => {
    const goalId = optionalText(payload.goalId, "goalId", 200);
    if (goalId) requireGoal(goalId);
    const title = requiredText(payload.title, "title", 240);
    const schedule = cadence(payload.cadence);
    const preferred = payload.preferredMinuteOfDay === undefined
      ? undefined
      : integer(payload.preferredMinuteOfDay, "preferredMinuteOfDay", 0, 1439);
    const id = randomUUID();
    db.prepare("INSERT INTO coach_routines (id, goal_id, title, cadence, preferred_minute_of_day, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)")
      .run(id, goalId ?? null, title, JSON.stringify(schedule), preferred ?? null, at, at);
    audit("routine.created", "routine", id, { title, proposalId: row.id }, at);
    return { type: "routine", id, appliedAt: at };
  };

  const applyPlanChange = (row: ProposalRow, payload: JsonObject, at: number): CoachProposalApplication => {
    const summary = requiredText(payload.summary, "summary", 500);
    const patch = object(payload.changes, "changes");
    const requestedId = optionalText(payload.planId, "planId", 200);
    let plan = requestedId
      ? db.prepare("SELECT * FROM coach_plans WHERE id = ?").get(requestedId) as unknown as PlanRow | undefined
      : undefined;
    if (requestedId && !plan) throw fail("not-found", "plan not found");
    if (!plan) {
      const goalId = optionalText(payload.goalId, "goalId", 200);
      if (goalId) requireGoal(goalId);
      const id = randomUUID();
      const title = optionalText(payload.title, "title", 240) ?? summary;
      db.prepare("INSERT INTO coach_plans (id, goal_id, title, current_revision, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)")
        .run(id, goalId ?? null, title, at, at);
      plan = db.prepare("SELECT * FROM coach_plans WHERE id = ?").get(id) as unknown as PlanRow;
    }
    const revision = Number(plan.current_revision) + 1;
    db.prepare("INSERT INTO coach_plan_revisions (plan_id, revision, summary, patch, source_proposal_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(plan.id, revision, summary, JSON.stringify(patch), row.id, at);
    db.prepare("UPDATE coach_plans SET current_revision = ?, updated_at = ? WHERE id = ?").run(revision, at, plan.id);
    audit("plan.revised", "plan", plan.id, { revision, summary, proposalId: row.id }, at);
    return { type: "plan", id: plan.id, appliedAt: at };
  };

  const materialize = (row: ProposalRow, at: number): CoachProposalApplication => {
    const payload = JSON.parse(row.payload) as JsonObject;
    if (row.type === "goal") return createGoal(row, payload, at);
    if (row.type === "commitment") return createCommitment(row, payload, at);
    if (row.type === "routine") return createRoutine(row, payload, at);
    if (row.type === "plan-change") return applyPlanChange(row, payload, at);
    throw fail("invalid-input", `unsupported proposal type ${row.type}`);
  };

  const decide = (id: string, target: "accepted" | "rejected"): CoachProposalDecision => transaction(() => {
    const row = requireProposal(id);
    if (row.status === target) {
      return { proposal: proposalOf(row), ...(application(id) ? { application: application(id)! } : {}) };
    }
    if (row.status !== "pending") throw fail("conflict", `proposal is already ${row.status}`);
    const at = now();
    const applied = target === "accepted" ? materialize(row, at) : undefined;
    if (applied) {
      db.prepare("INSERT INTO coach_proposal_applications (proposal_id, entity_type, entity_id, applied_at) VALUES (?, ?, ?, ?)")
        .run(id, applied.type, applied.id, applied.appliedAt);
    }
    db.prepare("UPDATE coach_proposals SET status = ?, updated_at = ? WHERE id = ?").run(target, at, id);
    audit("proposal.status-changed", "proposal", id, {
      status: target,
      ...(applied ? { application: { type: applied.type, id: applied.id } } : {}),
    }, at);
    bumpRevision();
    return {
      proposal: proposalOf(requireProposal(id)),
      ...(applied ? { application: applied } : {}),
    };
  });

  return {
    getProposal(id) {
      const row = proposalRow(id);
      return row ? proposalOf(row) : undefined;
    },
    listProposals(status, limit = 100) {
      const bounded = integer(limit, "limit", 1, 500);
      const rows = (status
        ? db.prepare("SELECT * FROM coach_proposals WHERE status = ? ORDER BY updated_at DESC LIMIT ?").all(status, bounded)
        : db.prepare("SELECT * FROM coach_proposals ORDER BY updated_at DESC LIMIT ?").all(bounded)) as unknown as ProposalRow[];
      return rows.map(proposalOf);
    },
    accept: (id) => decide(id, "accepted"),
    reject: (id) => decide(id, "rejected"),
    listPlans(limit = 100) {
      const bounded = integer(limit, "limit", 1, 500);
      return (db.prepare("SELECT * FROM coach_plans ORDER BY updated_at DESC LIMIT ?").all(bounded) as unknown as PlanRow[])
        .map(planOf);
    },
    getPlan(id) {
      const row = db.prepare("SELECT * FROM coach_plans WHERE id = ?").get(id) as unknown as PlanRow | undefined;
      if (!row) return undefined;
      const revisions = (db.prepare("SELECT revision, summary, patch, source_proposal_id, created_at FROM coach_plan_revisions WHERE plan_id = ? ORDER BY revision ASC").all(id) as unknown as PlanRevisionRow[])
        .map((revision): CoachPlanRevision => ({
          revision: Number(revision.revision),
          summary: revision.summary,
          patch: JSON.parse(revision.patch) as JsonObject,
          ...(revision.source_proposal_id ? { sourceProposalId: revision.source_proposal_id } : {}),
          createdAt: Number(revision.created_at),
        }));
      return { ...planOf(row), revisions };
    },
    close: () => db.close(),
  };
}
