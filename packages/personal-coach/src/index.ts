import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JsonObject } from "@polyth/contracts";

export type CoachTone = "supportive" | "balanced" | "direct";
export type CoachInitiative = "reactive" | "balanced" | "proactive";
export type CoachOnboardingState = "new" | "started" | "complete";
export type CoachAreaStatus = "active" | "archived";
export type CoachGoalStatus = "active" | "paused" | "completed" | "cancelled";
export type CoachMilestoneStatus = "open" | "done" | "cancelled";
export type CoachCommitmentStatus = "open" | "done" | "skipped" | "cancelled";
export type CoachRoutineStatus = "active" | "paused" | "archived";
export type CoachReflectionKind = "note" | "daily" | "weekly";
export type CoachInsightConfidence = "low" | "medium" | "high";
export type CoachInsightStatus = "candidate" | "accepted" | "rejected" | "expired";
export type CoachProposalType = "goal" | "commitment" | "routine" | "plan-change";
export type CoachProposalStatus = "pending" | "accepted" | "rejected" | "expired";
export type CoachSource = "user" | "agent" | "import";

export type CoachRoutineCadence =
  | { kind: "daily" }
  | { kind: "weekly"; days: number[] }
  | { kind: "interval"; everyDays: number };

export interface CoachProfile {
  tone: CoachTone;
  initiative: CoachInitiative;
  timeZone: string;
  challengeAssumptions: boolean;
  onboardingState: CoachOnboardingState;
  updatedAt: number;
}

export interface CoachArea {
  id: string;
  title: string;
  status: CoachAreaStatus;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface CoachGoal {
  id: string;
  areaId?: string;
  title: string;
  desiredOutcome?: string;
  why?: string;
  status: CoachGoalStatus;
  priority: 1 | 2 | 3;
  targetAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CoachMilestone {
  id: string;
  goalId: string;
  title: string;
  status: CoachMilestoneStatus;
  dueAt?: number;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface CoachCommitment {
  id: string;
  goalId?: string;
  title: string;
  status: CoachCommitmentStatus;
  plannedFor?: number;
  dueAt?: number;
  estimateMinutes?: number;
  source: CoachSource;
  sourceSessionId?: string;
  completedAt?: number;
  lastReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CoachRoutine {
  id: string;
  goalId?: string;
  title: string;
  cadence: CoachRoutineCadence;
  preferredMinuteOfDay?: number;
  status: CoachRoutineStatus;
  createdAt: number;
  updatedAt: number;
}

export interface CoachCheckIn {
  id: string;
  energy: number;
  focus: number;
  note?: string;
  createdAt: number;
}

export interface CoachReflection {
  id: string;
  kind: CoachReflectionKind;
  text: string;
  sourceSessionId?: string;
  createdAt: number;
}

export interface CoachInsightEvidence {
  eventSeq: number;
}

export interface CoachInsight {
  id: string;
  statement: string;
  confidence: CoachInsightConfidence;
  evidence: CoachInsightEvidence[];
  status: CoachInsightStatus;
  createdAt: number;
  updatedAt: number;
}

export interface CoachProposal {
  id: string;
  type: CoachProposalType;
  payload: JsonObject;
  reason?: string;
  status: CoachProposalStatus;
  sourceSessionId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CoachEvent {
  seq: number;
  eventType: string;
  entityType: string;
  entityId: string;
  payload: JsonObject;
  createdAt: number;
}

export interface CoachStore {
  revision(): number;
  profile(): CoachProfile;
  updateProfile(patch: Partial<Pick<CoachProfile, "tone" | "initiative" | "timeZone" | "challengeAssumptions" | "onboardingState">>): CoachProfile;

  listAreas(): CoachArea[];
  getArea(id: string): CoachArea | undefined;
  createArea(input: { title: string; sortOrder?: number }): CoachArea;
  updateArea(id: string, patch: { title?: string; status?: CoachAreaStatus; sortOrder?: number }): CoachArea;

  listGoals(status?: CoachGoalStatus): CoachGoal[];
  getGoal(id: string): CoachGoal | undefined;
  createGoal(input: {
    areaId?: string;
    title: string;
    desiredOutcome?: string;
    why?: string;
    priority?: 1 | 2 | 3;
    targetAt?: number;
  }): CoachGoal;
  updateGoal(id: string, patch: {
    areaId?: string | null;
    title?: string;
    desiredOutcome?: string | null;
    why?: string | null;
    status?: CoachGoalStatus;
    priority?: 1 | 2 | 3;
    targetAt?: number | null;
  }): CoachGoal;

  listMilestones(goalId: string): CoachMilestone[];
  createMilestone(input: { goalId: string; title: string; dueAt?: number; sortOrder?: number }): CoachMilestone;
  updateMilestone(id: string, patch: { title?: string; status?: CoachMilestoneStatus; dueAt?: number | null; sortOrder?: number }): CoachMilestone;

  listCommitments(query?: {
    status?: CoachCommitmentStatus;
    goalId?: string;
    from?: number;
    to?: number;
    limit?: number;
  }): CoachCommitment[];
  getCommitment(id: string): CoachCommitment | undefined;
  createCommitment(input: {
    goalId?: string;
    title: string;
    plannedFor?: number;
    dueAt?: number;
    estimateMinutes?: number;
    source?: CoachSource;
    sourceSessionId?: string;
  }): CoachCommitment;
  completeCommitment(id: string): CoachCommitment;
  rescheduleCommitment(id: string, plannedFor: number, reason?: string): CoachCommitment;
  skipCommitment(id: string, reason?: string): CoachCommitment;
  cancelCommitment(id: string, reason?: string): CoachCommitment;

  listRoutines(status?: CoachRoutineStatus): CoachRoutine[];
  getRoutine(id: string): CoachRoutine | undefined;
  createRoutine(input: {
    goalId?: string;
    title: string;
    cadence: CoachRoutineCadence;
    preferredMinuteOfDay?: number;
  }): CoachRoutine;
  updateRoutine(id: string, patch: {
    goalId?: string | null;
    title?: string;
    cadence?: CoachRoutineCadence;
    preferredMinuteOfDay?: number | null;
    status?: CoachRoutineStatus;
  }): CoachRoutine;

  recordCheckIn(input: { energy: number; focus: number; note?: string }): CoachCheckIn;
  listCheckIns(input?: { since?: number; limit?: number }): CoachCheckIn[];

  recordReflection(input: { kind?: CoachReflectionKind; text: string; sourceSessionId?: string }): CoachReflection;
  listReflections(limit?: number): CoachReflection[];

  createInsight(input: { statement: string; confidence: CoachInsightConfidence; evidence: CoachInsightEvidence[] }): CoachInsight;
  listInsights(status?: CoachInsightStatus): CoachInsight[];
  setInsightStatus(id: string, status: CoachInsightStatus): CoachInsight;

  createProposal(input: { type: CoachProposalType; payload: JsonObject; reason?: string; sourceSessionId?: string }): CoachProposal;
  listProposals(status?: CoachProposalStatus): CoachProposal[];
  setProposalStatus(id: string, status: CoachProposalStatus): CoachProposal;

  listEvents(input?: { sinceSeq?: number; entityType?: string; entityId?: string; limit?: number }): CoachEvent[];
  close(): void;
}

const SCHEMA_VERSION = 1;
const TITLE_MAX = 240;
const SHORT_TEXT_MAX = 2_000;
const REFLECTION_MAX = 8_000;
const TIME_ZONE_MAX = 96;
const REASON_MAX = 500;
const LIMIT_MAX = 500;

const err = (code: string, message: string): Error => Object.assign(new Error(message), { code });

const requiredText = (value: unknown, name: string, max = TITLE_MAX): string => {
  if (typeof value !== "string" || !value.trim()) throw err("invalid-input", `${name} is required`);
  const text = value.trim();
  if (text.length > max) throw err("invalid-input", `${name} exceeds ${max} characters`);
  return text;
};

const optionalText = (value: unknown, name: string, max = SHORT_TEXT_MAX): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw err("invalid-input", `${name} must be a string`);
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > max) throw err("invalid-input", `${name} exceeds ${max} characters`);
  return text;
};

const optionalTime = (value: unknown, name: string): number | undefined => {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw err("invalid-input", `${name} must be a finite epoch millisecond value`);
  return Math.trunc(n);
};

const intRange = (value: unknown, name: string, min: number, max: number): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw err("invalid-input", `${name} must be an integer from ${min} to ${max}`);
  return n;
};

const enumValue = <T extends string>(value: unknown, name: string, values: readonly T[]): T => {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw err("invalid-input", `${name} must be one of: ${values.join(", ")}`);
  }
  return value as T;
};

const parseObject = (raw: string): JsonObject => JSON.parse(raw) as JsonObject;

const validateJsonObject = (value: JsonObject): JsonObject => {
  try {
    JSON.stringify(value);
  } catch {
    throw err("invalid-input", "payload must be JSON-serializable");
  }
  return value;
};

const validateCadence = (value: CoachRoutineCadence): CoachRoutineCadence => {
  if (!value || typeof value !== "object") throw err("invalid-input", "cadence is required");
  if (value.kind === "daily") return { kind: "daily" };
  if (value.kind === "interval") {
    return { kind: "interval", everyDays: intRange(value.everyDays, "everyDays", 1, 365) };
  }
  if (value.kind === "weekly") {
    if (!Array.isArray(value.days) || value.days.length === 0) throw err("invalid-input", "weekly cadence needs at least one day");
    const days = [...new Set(value.days.map((day) => intRange(day, "day", 0, 6)))].sort((a, b) => a - b);
    return { kind: "weekly", days };
  }
  throw err("invalid-input", "unsupported cadence kind");
};

interface ProfileRow {
  tone: string;
  initiative: string;
  time_zone: string;
  challenge_assumptions: number;
  onboarding_state: string;
  updated_at: number;
}

interface AreaRow {
  id: string;
  title: string;
  status: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

interface GoalRow {
  id: string;
  area_id: string | null;
  title: string;
  desired_outcome: string | null;
  why: string | null;
  status: string;
  priority: number;
  target_at: number | null;
  created_at: number;
  updated_at: number;
}

interface MilestoneRow {
  id: string;
  goal_id: string;
  title: string;
  status: string;
  due_at: number | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

interface CommitmentRow {
  id: string;
  goal_id: string | null;
  title: string;
  status: string;
  planned_for: number | null;
  due_at: number | null;
  estimate_minutes: number | null;
  source: string;
  source_session_id: string | null;
  completed_at: number | null;
  last_reason: string | null;
  created_at: number;
  updated_at: number;
}

interface RoutineRow {
  id: string;
  goal_id: string | null;
  title: string;
  cadence: string;
  preferred_minute_of_day: number | null;
  status: string;
  created_at: number;
  updated_at: number;
}

interface CheckInRow { id: string; energy: number; focus: number; note: string | null; created_at: number }
interface ReflectionRow { id: string; kind: string; text: string; source_session_id: string | null; created_at: number }
interface InsightRow { id: string; statement: string; confidence: string; evidence: string; status: string; created_at: number; updated_at: number }
interface ProposalRow { id: string; type: string; payload: string; reason: string | null; status: string; source_session_id: string | null; created_at: number; updated_at: number }
interface EventRow { seq: number; event_type: string; entity_type: string; entity_id: string; payload: string; created_at: number }

const profileOf = (r: ProfileRow): CoachProfile => ({
  tone: r.tone as CoachTone,
  initiative: r.initiative as CoachInitiative,
  timeZone: r.time_zone,
  challengeAssumptions: Boolean(r.challenge_assumptions),
  onboardingState: r.onboarding_state as CoachOnboardingState,
  updatedAt: Number(r.updated_at),
});

const areaOf = (r: AreaRow): CoachArea => ({ id: r.id, title: r.title, status: r.status as CoachAreaStatus, sortOrder: Number(r.sort_order), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) });
const goalOf = (r: GoalRow): CoachGoal => ({ id: r.id, ...(r.area_id ? { areaId: r.area_id } : {}), title: r.title, ...(r.desired_outcome ? { desiredOutcome: r.desired_outcome } : {}), ...(r.why ? { why: r.why } : {}), status: r.status as CoachGoalStatus, priority: Number(r.priority) as 1 | 2 | 3, ...(r.target_at !== null ? { targetAt: Number(r.target_at) } : {}), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) });
const milestoneOf = (r: MilestoneRow): CoachMilestone => ({ id: r.id, goalId: r.goal_id, title: r.title, status: r.status as CoachMilestoneStatus, ...(r.due_at !== null ? { dueAt: Number(r.due_at) } : {}), sortOrder: Number(r.sort_order), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) });
const commitmentOf = (r: CommitmentRow): CoachCommitment => ({ id: r.id, ...(r.goal_id ? { goalId: r.goal_id } : {}), title: r.title, status: r.status as CoachCommitmentStatus, ...(r.planned_for !== null ? { plannedFor: Number(r.planned_for) } : {}), ...(r.due_at !== null ? { dueAt: Number(r.due_at) } : {}), ...(r.estimate_minutes !== null ? { estimateMinutes: Number(r.estimate_minutes) } : {}), source: r.source as CoachSource, ...(r.source_session_id ? { sourceSessionId: r.source_session_id } : {}), ...(r.completed_at !== null ? { completedAt: Number(r.completed_at) } : {}), ...(r.last_reason ? { lastReason: r.last_reason } : {}), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) });
const routineOf = (r: RoutineRow): CoachRoutine => ({ id: r.id, ...(r.goal_id ? { goalId: r.goal_id } : {}), title: r.title, cadence: JSON.parse(r.cadence) as CoachRoutineCadence, ...(r.preferred_minute_of_day !== null ? { preferredMinuteOfDay: Number(r.preferred_minute_of_day) } : {}), status: r.status as CoachRoutineStatus, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) });
const checkInOf = (r: CheckInRow): CoachCheckIn => ({ id: r.id, energy: Number(r.energy), focus: Number(r.focus), ...(r.note ? { note: r.note } : {}), createdAt: Number(r.created_at) });
const reflectionOf = (r: ReflectionRow): CoachReflection => ({ id: r.id, kind: r.kind as CoachReflectionKind, text: r.text, ...(r.source_session_id ? { sourceSessionId: r.source_session_id } : {}), createdAt: Number(r.created_at) });
const insightOf = (r: InsightRow): CoachInsight => ({ id: r.id, statement: r.statement, confidence: r.confidence as CoachInsightConfidence, evidence: JSON.parse(r.evidence) as CoachInsightEvidence[], status: r.status as CoachInsightStatus, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) });
const proposalOf = (r: ProposalRow): CoachProposal => ({ id: r.id, type: r.type as CoachProposalType, payload: parseObject(r.payload), ...(r.reason ? { reason: r.reason } : {}), status: r.status as CoachProposalStatus, ...(r.source_session_id ? { sourceSessionId: r.source_session_id } : {}), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) });
const eventOf = (r: EventRow): CoachEvent => ({ seq: Number(r.seq), eventType: r.event_type, entityType: r.entity_type, entityId: r.entity_id, payload: parseObject(r.payload), createdAt: Number(r.created_at) });

export function createCoachStore(file: string, opts: { now?: () => number } = {}): CoachStore {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  const now = opts.now ?? Date.now;
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  const version = Number((db.prepare("PRAGMA user_version").get() as unknown as { user_version: number }).user_version);
  if (version > SCHEMA_VERSION) {
    db.close();
    throw err("unsupported-schema", `coach database schema ${version} is newer than supported ${SCHEMA_VERSION}`);
  }
  if (version === 0) {
    db.exec(`
      CREATE TABLE coach_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL
      );
      INSERT INTO coach_meta (id, revision) VALUES (1, 0);

      CREATE TABLE coach_profile (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        tone TEXT NOT NULL,
        initiative TEXT NOT NULL,
        time_zone TEXT NOT NULL,
        challenge_assumptions INTEGER NOT NULL,
        onboarding_state TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO coach_profile (id, tone, initiative, time_zone, challenge_assumptions, onboarding_state, updated_at)
        VALUES (1, 'balanced', 'balanced', 'UTC', 0, 'new', 0);

      CREATE TABLE coach_areas (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE coach_goals (
        id TEXT PRIMARY KEY,
        area_id TEXT REFERENCES coach_areas(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        desired_outcome TEXT,
        why TEXT,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL,
        target_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE coach_milestones (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES coach_goals(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        due_at INTEGER,
        sort_order INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE coach_commitments (
        id TEXT PRIMARY KEY,
        goal_id TEXT REFERENCES coach_goals(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        planned_for INTEGER,
        due_at INTEGER,
        estimate_minutes INTEGER,
        source TEXT NOT NULL,
        source_session_id TEXT,
        completed_at INTEGER,
        last_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE coach_routines (
        id TEXT PRIMARY KEY,
        goal_id TEXT REFERENCES coach_goals(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        cadence TEXT NOT NULL,
        preferred_minute_of_day INTEGER,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE coach_checkins (
        id TEXT PRIMARY KEY,
        energy INTEGER NOT NULL,
        focus INTEGER NOT NULL,
        note TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE coach_reflections (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        source_session_id TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE coach_insights (
        id TEXT PRIMARY KEY,
        statement TEXT NOT NULL,
        confidence TEXT NOT NULL,
        evidence TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE coach_proposals (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        reason TEXT,
        status TEXT NOT NULL,
        source_session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE coach_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX idx_coach_goals_status_priority ON coach_goals(status, priority, updated_at);
      CREATE INDEX idx_coach_commitments_status_planned ON coach_commitments(status, planned_for, created_at);
      CREATE INDEX idx_coach_routines_status ON coach_routines(status, updated_at);
      CREATE INDEX idx_coach_events_created ON coach_events(created_at, seq);
      CREATE INDEX idx_coach_events_entity ON coach_events(entity_type, entity_id, seq);
      PRAGMA user_version = 1;
    `);
  }

  const transaction = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (cause) {
      try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw cause;
    }
  };

  const revision = (): number => Number((db.prepare("SELECT revision FROM coach_meta WHERE id = 1").get() as unknown as { revision: number }).revision);
  const bumpRevision = (): void => { db.prepare("UPDATE coach_meta SET revision = revision + 1 WHERE id = 1").run(); };
  const appendEvent = (eventType: string, entityType: string, entityId: string, payload: JsonObject, at: number): void => {
    db.prepare("INSERT INTO coach_events (event_type, entity_type, entity_id, payload, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(eventType, entityType, entityId, JSON.stringify(validateJsonObject(payload)), at);
  };
  const mutate = <T>(eventType: string, entityType: string, entityId: string, payload: JsonObject, fn: (at: number) => T): T => transaction(() => {
    const at = now();
    const result = fn(at);
    appendEvent(eventType, entityType, entityId, payload, at);
    bumpRevision();
    return result;
  });

  const mustArea = (id: string): AreaRow => {
    const row = db.prepare("SELECT * FROM coach_areas WHERE id = ?").get(id) as unknown as AreaRow | undefined;
    if (!row) throw err("not-found", "area not found");
    return row;
  };
  const mustGoal = (id: string): GoalRow => {
    const row = db.prepare("SELECT * FROM coach_goals WHERE id = ?").get(id) as unknown as GoalRow | undefined;
    if (!row) throw err("not-found", "goal not found");
    return row;
  };
  const mustMilestone = (id: string): MilestoneRow => {
    const row = db.prepare("SELECT * FROM coach_milestones WHERE id = ?").get(id) as unknown as MilestoneRow | undefined;
    if (!row) throw err("not-found", "milestone not found");
    return row;
  };
  const mustCommitment = (id: string): CommitmentRow => {
    const row = db.prepare("SELECT * FROM coach_commitments WHERE id = ?").get(id) as unknown as CommitmentRow | undefined;
    if (!row) throw err("not-found", "commitment not found");
    return row;
  };
  const mustRoutine = (id: string): RoutineRow => {
    const row = db.prepare("SELECT * FROM coach_routines WHERE id = ?").get(id) as unknown as RoutineRow | undefined;
    if (!row) throw err("not-found", "routine not found");
    return row;
  };
  const ensureArea = (id?: string): void => { if (id) mustArea(id); };
  const ensureGoal = (id?: string): void => { if (id) mustGoal(id); };

  const store: CoachStore = {
    revision,
    profile() {
      return profileOf(db.prepare("SELECT * FROM coach_profile WHERE id = 1").get() as unknown as ProfileRow);
    },
    updateProfile(patch) {
      const before = store.profile();
      const tone = patch.tone === undefined ? before.tone : enumValue(patch.tone, "tone", ["supportive", "balanced", "direct"] as const);
      const initiative = patch.initiative === undefined ? before.initiative : enumValue(patch.initiative, "initiative", ["reactive", "balanced", "proactive"] as const);
      const timeZone = patch.timeZone === undefined ? before.timeZone : requiredText(patch.timeZone, "timeZone", TIME_ZONE_MAX);
      const onboardingState = patch.onboardingState === undefined ? before.onboardingState : enumValue(patch.onboardingState, "onboardingState", ["new", "started", "complete"] as const);
      const challenge = patch.challengeAssumptions ?? before.challengeAssumptions;
      return mutate("profile.updated", "profile", "profile", {}, (at) => {
        db.prepare("UPDATE coach_profile SET tone = ?, initiative = ?, time_zone = ?, challenge_assumptions = ?, onboarding_state = ?, updated_at = ? WHERE id = 1")
          .run(tone, initiative, timeZone, challenge ? 1 : 0, onboardingState, at);
        return store.profile();
      });
    },

    listAreas() {
      return (db.prepare("SELECT * FROM coach_areas ORDER BY sort_order ASC, created_at ASC").all() as unknown as AreaRow[]).map(areaOf);
    },
    getArea(id) {
      const row = db.prepare("SELECT * FROM coach_areas WHERE id = ?").get(id) as unknown as AreaRow | undefined;
      return row ? areaOf(row) : undefined;
    },
    createArea(input) {
      const id = randomUUID();
      const title = requiredText(input.title, "title");
      const sortOrder = input.sortOrder === undefined ? store.listAreas().length : intRange(input.sortOrder, "sortOrder", 0, 100_000);
      return mutate("area.created", "area", id, { title }, (at) => {
        db.prepare("INSERT INTO coach_areas (id, title, status, sort_order, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?)")
          .run(id, title, sortOrder, at, at);
        return areaOf(mustArea(id));
      });
    },
    updateArea(id, patch) {
      const current = areaOf(mustArea(id));
      const title = patch.title === undefined ? current.title : requiredText(patch.title, "title");
      const status = patch.status === undefined ? current.status : enumValue(patch.status, "status", ["active", "archived"] as const);
      const sortOrder = patch.sortOrder === undefined ? current.sortOrder : intRange(patch.sortOrder, "sortOrder", 0, 100_000);
      return mutate("area.updated", "area", id, {}, (at) => {
        db.prepare("UPDATE coach_areas SET title = ?, status = ?, sort_order = ?, updated_at = ? WHERE id = ?")
          .run(title, status, sortOrder, at, id);
        return areaOf(mustArea(id));
      });
    },

    listGoals(status) {
      const rows = (status
        ? db.prepare("SELECT * FROM coach_goals WHERE status = ? ORDER BY priority DESC, updated_at DESC").all(status)
        : db.prepare("SELECT * FROM coach_goals ORDER BY priority DESC, updated_at DESC").all()) as unknown as GoalRow[];
      return rows.map(goalOf);
    },
    getGoal(id) {
      const row = db.prepare("SELECT * FROM coach_goals WHERE id = ?").get(id) as unknown as GoalRow | undefined;
      return row ? goalOf(row) : undefined;
    },
    createGoal(input) {
      ensureArea(input.areaId);
      const id = randomUUID();
      const title = requiredText(input.title, "title");
      const desiredOutcome = optionalText(input.desiredOutcome, "desiredOutcome");
      const why = optionalText(input.why, "why");
      const priority = intRange(input.priority ?? 2, "priority", 1, 3) as 1 | 2 | 3;
      const targetAt = optionalTime(input.targetAt, "targetAt");
      return mutate("goal.created", "goal", id, { title }, (at) => {
        db.prepare("INSERT INTO coach_goals (id, area_id, title, desired_outcome, why, status, priority, target_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)")
          .run(id, input.areaId ?? null, title, desiredOutcome ?? null, why ?? null, priority, targetAt ?? null, at, at);
        return goalOf(mustGoal(id));
      });
    },
    updateGoal(id, patch) {
      const current = goalOf(mustGoal(id));
      const areaId = patch.areaId === undefined ? current.areaId : patch.areaId ?? undefined;
      ensureArea(areaId);
      const title = patch.title === undefined ? current.title : requiredText(patch.title, "title");
      const desiredOutcome = patch.desiredOutcome === undefined ? current.desiredOutcome : optionalText(patch.desiredOutcome, "desiredOutcome");
      const why = patch.why === undefined ? current.why : optionalText(patch.why, "why");
      const status = patch.status === undefined ? current.status : enumValue(patch.status, "status", ["active", "paused", "completed", "cancelled"] as const);
      const priority = patch.priority === undefined ? current.priority : intRange(patch.priority, "priority", 1, 3) as 1 | 2 | 3;
      const targetAt = patch.targetAt === undefined ? current.targetAt : optionalTime(patch.targetAt, "targetAt");
      return mutate("goal.updated", "goal", id, {}, (at) => {
        db.prepare("UPDATE coach_goals SET area_id = ?, title = ?, desired_outcome = ?, why = ?, status = ?, priority = ?, target_at = ?, updated_at = ? WHERE id = ?")
          .run(areaId ?? null, title, desiredOutcome ?? null, why ?? null, status, priority, targetAt ?? null, at, id);
        return goalOf(mustGoal(id));
      });
    },

    listMilestones(goalId) {
      mustGoal(goalId);
      return (db.prepare("SELECT * FROM coach_milestones WHERE goal_id = ? ORDER BY sort_order ASC, created_at ASC").all(goalId) as unknown as MilestoneRow[]).map(milestoneOf);
    },
    createMilestone(input) {
      mustGoal(input.goalId);
      const id = randomUUID();
      const title = requiredText(input.title, "title");
      const dueAt = optionalTime(input.dueAt, "dueAt");
      const sortOrder = input.sortOrder === undefined ? store.listMilestones(input.goalId).length : intRange(input.sortOrder, "sortOrder", 0, 100_000);
      return mutate("milestone.created", "milestone", id, { goalId: input.goalId, title }, (at) => {
        db.prepare("INSERT INTO coach_milestones (id, goal_id, title, status, due_at, sort_order, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?, ?, ?)")
          .run(id, input.goalId, title, dueAt ?? null, sortOrder, at, at);
        return milestoneOf(mustMilestone(id));
      });
    },
    updateMilestone(id, patch) {
      const current = milestoneOf(mustMilestone(id));
      const title = patch.title === undefined ? current.title : requiredText(patch.title, "title");
      const status = patch.status === undefined ? current.status : enumValue(patch.status, "status", ["open", "done", "cancelled"] as const);
      const dueAt = patch.dueAt === undefined ? current.dueAt : optionalTime(patch.dueAt, "dueAt");
      const sortOrder = patch.sortOrder === undefined ? current.sortOrder : intRange(patch.sortOrder, "sortOrder", 0, 100_000);
      return mutate("milestone.updated", "milestone", id, {}, (at) => {
        db.prepare("UPDATE coach_milestones SET title = ?, status = ?, due_at = ?, sort_order = ?, updated_at = ? WHERE id = ?")
          .run(title, status, dueAt ?? null, sortOrder, at, id);
        return milestoneOf(mustMilestone(id));
      });
    },

    listCommitments(query = {}) {
      const where: string[] = [];
      const args: Array<string | number> = [];
      if (query.status) { where.push("status = ?"); args.push(query.status); }
      if (query.goalId) { where.push("goal_id = ?"); args.push(query.goalId); }
      if (query.from !== undefined) { where.push("planned_for >= ?"); args.push(optionalTime(query.from, "from")!); }
      if (query.to !== undefined) { where.push("planned_for < ?"); args.push(optionalTime(query.to, "to")!); }
      const limit = intRange(query.limit ?? 200, "limit", 1, LIMIT_MAX);
      args.push(limit);
      const sql = `SELECT * FROM coach_commitments${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY CASE WHEN planned_for IS NULL THEN 1 ELSE 0 END, planned_for ASC, created_at ASC LIMIT ?`;
      return (db.prepare(sql).all(...args) as unknown as CommitmentRow[]).map(commitmentOf);
    },
    getCommitment(id) {
      const row = db.prepare("SELECT * FROM coach_commitments WHERE id = ?").get(id) as unknown as CommitmentRow | undefined;
      return row ? commitmentOf(row) : undefined;
    },
    createCommitment(input) {
      ensureGoal(input.goalId);
      const id = randomUUID();
      const title = requiredText(input.title, "title");
      const plannedFor = optionalTime(input.plannedFor, "plannedFor");
      const dueAt = optionalTime(input.dueAt, "dueAt");
      const estimateMinutes = input.estimateMinutes === undefined ? undefined : intRange(input.estimateMinutes, "estimateMinutes", 1, 24 * 60);
      const source = enumValue(input.source ?? "user", "source", ["user", "agent", "import"] as const);
      const sourceSessionId = optionalText(input.sourceSessionId, "sourceSessionId", 200);
      return mutate("commitment.created", "commitment", id, { title }, (at) => {
        db.prepare("INSERT INTO coach_commitments (id, goal_id, title, status, planned_for, due_at, estimate_minutes, source, source_session_id, completed_at, last_reason, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, NULL, NULL, ?, ?)")
          .run(id, input.goalId ?? null, title, plannedFor ?? null, dueAt ?? null, estimateMinutes ?? null, source, sourceSessionId ?? null, at, at);
        return commitmentOf(mustCommitment(id));
      });
    },
    completeCommitment(id) {
      const current = commitmentOf(mustCommitment(id));
      if (current.status === "done") return current;
      if (current.status === "cancelled") throw err("conflict", "cancelled commitment cannot be completed");
      return mutate("commitment.completed", "commitment", id, {}, (at) => {
        db.prepare("UPDATE coach_commitments SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?").run(at, at, id);
        return commitmentOf(mustCommitment(id));
      });
    },
    rescheduleCommitment(id, plannedFor, reason) {
      const current = commitmentOf(mustCommitment(id));
      if (current.status === "done" || current.status === "cancelled") throw err("conflict", `${current.status} commitment cannot be rescheduled`);
      const target = optionalTime(plannedFor, "plannedFor")!;
      const why = optionalText(reason, "reason", REASON_MAX);
      return mutate("commitment.rescheduled", "commitment", id, { plannedFor: target }, (at) => {
        db.prepare("UPDATE coach_commitments SET status = 'open', planned_for = ?, last_reason = ?, updated_at = ? WHERE id = ?").run(target, why ?? null, at, id);
        return commitmentOf(mustCommitment(id));
      });
    },
    skipCommitment(id, reason) {
      const current = commitmentOf(mustCommitment(id));
      if (current.status === "skipped") return current;
      if (current.status === "done" || current.status === "cancelled") throw err("conflict", `${current.status} commitment cannot be skipped`);
      const why = optionalText(reason, "reason", REASON_MAX);
      return mutate("commitment.skipped", "commitment", id, {}, (at) => {
        db.prepare("UPDATE coach_commitments SET status = 'skipped', last_reason = ?, updated_at = ? WHERE id = ?").run(why ?? null, at, id);
        return commitmentOf(mustCommitment(id));
      });
    },
    cancelCommitment(id, reason) {
      const current = commitmentOf(mustCommitment(id));
      if (current.status === "cancelled") return current;
      if (current.status === "done") throw err("conflict", "completed commitment cannot be cancelled");
      const why = optionalText(reason, "reason", REASON_MAX);
      return mutate("commitment.cancelled", "commitment", id, {}, (at) => {
        db.prepare("UPDATE coach_commitments SET status = 'cancelled', last_reason = ?, updated_at = ? WHERE id = ?").run(why ?? null, at, id);
        return commitmentOf(mustCommitment(id));
      });
    },

    listRoutines(status) {
      const rows = (status
        ? db.prepare("SELECT * FROM coach_routines WHERE status = ? ORDER BY updated_at DESC").all(status)
        : db.prepare("SELECT * FROM coach_routines ORDER BY updated_at DESC").all()) as unknown as RoutineRow[];
      return rows.map(routineOf);
    },
    getRoutine(id) {
      const row = db.prepare("SELECT * FROM coach_routines WHERE id = ?").get(id) as unknown as RoutineRow | undefined;
      return row ? routineOf(row) : undefined;
    },
    createRoutine(input) {
      ensureGoal(input.goalId);
      const id = randomUUID();
      const title = requiredText(input.title, "title");
      const cadence = validateCadence(input.cadence);
      const preferred = input.preferredMinuteOfDay === undefined ? undefined : intRange(input.preferredMinuteOfDay, "preferredMinuteOfDay", 0, 1439);
      return mutate("routine.created", "routine", id, { title }, (at) => {
        db.prepare("INSERT INTO coach_routines (id, goal_id, title, cadence, preferred_minute_of_day, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)")
          .run(id, input.goalId ?? null, title, JSON.stringify(cadence), preferred ?? null, at, at);
        return routineOf(mustRoutine(id));
      });
    },
    updateRoutine(id, patch) {
      const current = routineOf(mustRoutine(id));
      const goalId = patch.goalId === undefined ? current.goalId : patch.goalId ?? undefined;
      ensureGoal(goalId);
      const title = patch.title === undefined ? current.title : requiredText(patch.title, "title");
      const cadence = patch.cadence === undefined ? current.cadence : validateCadence(patch.cadence);
      const preferred = patch.preferredMinuteOfDay === undefined ? current.preferredMinuteOfDay : patch.preferredMinuteOfDay === null ? undefined : intRange(patch.preferredMinuteOfDay, "preferredMinuteOfDay", 0, 1439);
      const status = patch.status === undefined ? current.status : enumValue(patch.status, "status", ["active", "paused", "archived"] as const);
      return mutate("routine.updated", "routine", id, {}, (at) => {
        db.prepare("UPDATE coach_routines SET goal_id = ?, title = ?, cadence = ?, preferred_minute_of_day = ?, status = ?, updated_at = ? WHERE id = ?")
          .run(goalId ?? null, title, JSON.stringify(cadence), preferred ?? null, status, at, id);
        return routineOf(mustRoutine(id));
      });
    },

    recordCheckIn(input) {
      const id = randomUUID();
      const energy = intRange(input.energy, "energy", 1, 5);
      const focus = intRange(input.focus, "focus", 1, 5);
      const note = optionalText(input.note, "note", REASON_MAX);
      return mutate("checkin.recorded", "checkin", id, { energy, focus }, (at) => {
        db.prepare("INSERT INTO coach_checkins (id, energy, focus, note, created_at) VALUES (?, ?, ?, ?, ?)").run(id, energy, focus, note ?? null, at);
        return checkInOf(db.prepare("SELECT * FROM coach_checkins WHERE id = ?").get(id) as unknown as CheckInRow);
      });
    },
    listCheckIns(input = {}) {
      const limit = intRange(input.limit ?? 50, "limit", 1, LIMIT_MAX);
      if (input.since !== undefined) {
        const since = optionalTime(input.since, "since")!;
        return (db.prepare("SELECT * FROM coach_checkins WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?").all(since, limit) as unknown as CheckInRow[]).map(checkInOf);
      }
      return (db.prepare("SELECT * FROM coach_checkins ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as CheckInRow[]).map(checkInOf);
    },

    recordReflection(input) {
      const id = randomUUID();
      const kind = enumValue(input.kind ?? "note", "kind", ["note", "daily", "weekly"] as const);
      const text = requiredText(input.text, "text", REFLECTION_MAX);
      const sourceSessionId = optionalText(input.sourceSessionId, "sourceSessionId", 200);
      return mutate("reflection.recorded", "reflection", id, { kind }, (at) => {
        db.prepare("INSERT INTO coach_reflections (id, kind, text, source_session_id, created_at) VALUES (?, ?, ?, ?, ?)").run(id, kind, text, sourceSessionId ?? null, at);
        return reflectionOf(db.prepare("SELECT * FROM coach_reflections WHERE id = ?").get(id) as unknown as ReflectionRow);
      });
    },
    listReflections(limit = 50) {
      const bounded = intRange(limit, "limit", 1, LIMIT_MAX);
      return (db.prepare("SELECT * FROM coach_reflections ORDER BY created_at DESC LIMIT ?").all(bounded) as unknown as ReflectionRow[]).map(reflectionOf);
    },

    createInsight(input) {
      const id = randomUUID();
      const statement = requiredText(input.statement, "statement", SHORT_TEXT_MAX);
      const confidence = enumValue(input.confidence, "confidence", ["low", "medium", "high"] as const);
      if (!Array.isArray(input.evidence) || input.evidence.length === 0) throw err("invalid-input", "insight evidence is required");
      const evidence = input.evidence.map((item) => ({ eventSeq: intRange(item.eventSeq, "eventSeq", 1, Number.MAX_SAFE_INTEGER) }));
      return mutate("insight.created", "insight", id, { confidence }, (at) => {
        db.prepare("INSERT INTO coach_insights (id, statement, confidence, evidence, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'candidate', ?, ?)")
          .run(id, statement, confidence, JSON.stringify(evidence), at, at);
        return insightOf(db.prepare("SELECT * FROM coach_insights WHERE id = ?").get(id) as unknown as InsightRow);
      });
    },
    listInsights(status) {
      const rows = (status
        ? db.prepare("SELECT * FROM coach_insights WHERE status = ? ORDER BY updated_at DESC").all(status)
        : db.prepare("SELECT * FROM coach_insights ORDER BY updated_at DESC").all()) as unknown as InsightRow[];
      return rows.map(insightOf);
    },
    setInsightStatus(id, status) {
      const row = db.prepare("SELECT * FROM coach_insights WHERE id = ?").get(id) as unknown as InsightRow | undefined;
      if (!row) throw err("not-found", "insight not found");
      const next = enumValue(status, "status", ["candidate", "accepted", "rejected", "expired"] as const);
      if (row.status === next) return insightOf(row);
      return mutate("insight.status-changed", "insight", id, { status: next }, (at) => {
        db.prepare("UPDATE coach_insights SET status = ?, updated_at = ? WHERE id = ?").run(next, at, id);
        return insightOf(db.prepare("SELECT * FROM coach_insights WHERE id = ?").get(id) as unknown as InsightRow);
      });
    },

    createProposal(input) {
      const id = randomUUID();
      const type = enumValue(input.type, "type", ["goal", "commitment", "routine", "plan-change"] as const);
      const payload = validateJsonObject(input.payload);
      const reason = optionalText(input.reason, "reason", SHORT_TEXT_MAX);
      const sourceSessionId = optionalText(input.sourceSessionId, "sourceSessionId", 200);
      return mutate("proposal.created", "proposal", id, { type }, (at) => {
        db.prepare("INSERT INTO coach_proposals (id, type, payload, reason, status, source_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)")
          .run(id, type, JSON.stringify(payload), reason ?? null, sourceSessionId ?? null, at, at);
        return proposalOf(db.prepare("SELECT * FROM coach_proposals WHERE id = ?").get(id) as unknown as ProposalRow);
      });
    },
    listProposals(status) {
      const rows = (status
        ? db.prepare("SELECT * FROM coach_proposals WHERE status = ? ORDER BY updated_at DESC").all(status)
        : db.prepare("SELECT * FROM coach_proposals ORDER BY updated_at DESC").all()) as unknown as ProposalRow[];
      return rows.map(proposalOf);
    },
    setProposalStatus(id, status) {
      const row = db.prepare("SELECT * FROM coach_proposals WHERE id = ?").get(id) as unknown as ProposalRow | undefined;
      if (!row) throw err("not-found", "proposal not found");
      const next = enumValue(status, "status", ["pending", "accepted", "rejected", "expired"] as const);
      if (row.status === next) return proposalOf(row);
      return mutate("proposal.status-changed", "proposal", id, { status: next }, (at) => {
        db.prepare("UPDATE coach_proposals SET status = ?, updated_at = ? WHERE id = ?").run(next, at, id);
        return proposalOf(db.prepare("SELECT * FROM coach_proposals WHERE id = ?").get(id) as unknown as ProposalRow);
      });
    },

    listEvents(input = {}) {
      const where: string[] = [];
      const args: Array<string | number> = [];
      if (input.sinceSeq !== undefined) { where.push("seq > ?"); args.push(intRange(input.sinceSeq, "sinceSeq", 0, Number.MAX_SAFE_INTEGER)); }
      if (input.entityType) { where.push("entity_type = ?"); args.push(requiredText(input.entityType, "entityType", 80)); }
      if (input.entityId) { where.push("entity_id = ?"); args.push(requiredText(input.entityId, "entityId", 200)); }
      const limit = intRange(input.limit ?? 100, "limit", 1, LIMIT_MAX);
      args.push(limit);
      const sql = `SELECT * FROM coach_events${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ?`;
      return (db.prepare(sql).all(...args) as unknown as EventRow[]).map(eventOf);
    },

    close() { db.close(); },
  };

  return store;
}
