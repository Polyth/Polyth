import type {
  RouteHandler,
  SpaceContext,
} from "@polyth/contracts";
import type {
  CoachCommitmentStatus,
  CoachGoalStatus,
  CoachInitiative,
  CoachRoutineCadence,
  CoachRoutineStatus,
  CoachStore,
  CoachTone,
} from "./index.ts";
import { buildCoachHome, isCoachTimeZone } from "./home.ts";

export interface CoachStoreResolver {
  forSpace(space: SpaceContext): CoachStore;
}

const GOAL_STATUSES: readonly CoachGoalStatus[] = ["active", "paused", "completed", "cancelled"];
const COMMITMENT_STATUSES: readonly CoachCommitmentStatus[] = ["open", "done", "skipped", "cancelled"];
const ROUTINE_STATUSES: readonly CoachRoutineStatus[] = ["active", "paused", "archived"];

const invalid = (message: string): Error => Object.assign(new Error(message), { code: "invalid-input" });

const optionalString = (value: unknown): string | undefined =>
  value === undefined || value === null || value === "" ? undefined : String(value);

const optionalNumber = (value: unknown): number | undefined =>
  value === undefined || value === null || value === "" ? undefined : Number(value);

const optionalBoolean = (value: unknown, name: string): boolean | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw invalid(`${name} must be a boolean`);
  return value;
};

const queryNumber = (value: string | null): number | undefined =>
  value === null || value === "" ? undefined : Number(value);

const queryEnum = <T extends string>(value: string | null, name: string, allowed: readonly T[]): T | undefined => {
  if (value === null || value === "") return undefined;
  if (!allowed.includes(value as T)) throw invalid(`${name} must be one of: ${allowed.join(", ")}`);
  return value as T;
};

const cadenceOf = (raw: unknown): CoachRoutineCadence => {
  const value = raw as Record<string, unknown> | undefined;
  if (!value || typeof value !== "object") throw invalid("cadence is required");
  if (value.kind === "daily") return { kind: "daily" };
  if (value.kind === "weekly") {
    return { kind: "weekly", days: Array.isArray(value.days) ? value.days.map(Number) : [] };
  }
  if (value.kind === "interval") return { kind: "interval", everyDays: Number(value.everyDays) };
  throw invalid("unsupported cadence kind");
};

export function personalCoachRoutes(service: CoachStoreResolver): RouteHandler {
  return async (request) => {
    if (!request.path.startsWith("/api/personal-coach")) return false;
    const store = service.forSpace(request.space);
    const { path, method, url, json } = request;

    if (path === "/api/personal-coach/home" && method === "GET") {
      json(200, buildCoachHome(store));
      return true;
    }

    if (path === "/api/personal-coach/settings" && method === "GET") {
      json(200, { revision: store.revision(), profile: store.profile() });
      return true;
    }
    if (path === "/api/personal-coach/settings" && method === "PUT") {
      const input = await request.body();
      const timeZone = optionalString(input.timeZone);
      const challengeAssumptions = optionalBoolean(input.challengeAssumptions, "challengeAssumptions");
      if (timeZone !== undefined && !isCoachTimeZone(timeZone)) throw invalid("timeZone must be a valid IANA time zone");
      json(200, store.updateProfile({
        ...(input.tone !== undefined ? { tone: String(input.tone) as CoachTone } : {}),
        ...(input.initiative !== undefined ? { initiative: String(input.initiative) as CoachInitiative } : {}),
        ...(timeZone !== undefined ? { timeZone } : {}),
        ...(challengeAssumptions !== undefined ? { challengeAssumptions } : {}),
        // onboardingState is intentionally not client-writable here. The
        // Coach onboarding tool owns that transition after explicit choices.
      }));
      return true;
    }

    if (path === "/api/personal-coach/goals" && method === "GET") {
      const status = queryEnum(url.searchParams.get("status"), "status", GOAL_STATUSES);
      json(200, { goals: store.listGoals(status) });
      return true;
    }
    if (path === "/api/personal-coach/goals" && method === "POST") {
      const input = await request.body();
      json(200, store.createGoal({
        ...(optionalString(input.areaId) ? { areaId: optionalString(input.areaId)! } : {}),
        title: String(input.title ?? ""),
        ...(optionalString(input.desiredOutcome) ? { desiredOutcome: optionalString(input.desiredOutcome)! } : {}),
        ...(optionalString(input.why) ? { why: optionalString(input.why)! } : {}),
        ...(input.priority !== undefined ? { priority: Number(input.priority) as 1 | 2 | 3 } : {}),
        ...(optionalNumber(input.targetAt) !== undefined ? { targetAt: optionalNumber(input.targetAt)! } : {}),
      }));
      return true;
    }
    let match = path.match(/^\/api\/personal-coach\/goals\/([^/]+)$/);
    if (match && method === "PATCH") {
      const input = await request.body();
      const areaId = input.areaId === null ? null : optionalString(input.areaId);
      const targetAt = input.targetAt === null ? null : optionalNumber(input.targetAt);
      json(200, store.updateGoal(decodeURIComponent(match[1]!), {
        ...(input.areaId !== undefined ? { areaId: areaId ?? null } : {}),
        ...(input.title !== undefined ? { title: String(input.title) } : {}),
        ...(input.desiredOutcome !== undefined ? { desiredOutcome: input.desiredOutcome === null ? null : String(input.desiredOutcome) } : {}),
        ...(input.why !== undefined ? { why: input.why === null ? null : String(input.why) } : {}),
        ...(input.status !== undefined ? { status: String(input.status) as CoachGoalStatus } : {}),
        ...(input.priority !== undefined ? { priority: Number(input.priority) as 1 | 2 | 3 } : {}),
        ...(input.targetAt !== undefined ? { targetAt: targetAt ?? null } : {}),
      }));
      return true;
    }

    if (path === "/api/personal-coach/commitments" && method === "GET") {
      const status = queryEnum(url.searchParams.get("status"), "status", COMMITMENT_STATUSES);
      json(200, {
        commitments: store.listCommitments({
          ...(status ? { status } : {}),
          ...(url.searchParams.get("goalId") ? { goalId: url.searchParams.get("goalId")! } : {}),
          ...(queryNumber(url.searchParams.get("from")) !== undefined ? { from: queryNumber(url.searchParams.get("from"))! } : {}),
          ...(queryNumber(url.searchParams.get("to")) !== undefined ? { to: queryNumber(url.searchParams.get("to"))! } : {}),
          ...(queryNumber(url.searchParams.get("limit")) !== undefined ? { limit: queryNumber(url.searchParams.get("limit"))! } : {}),
        }),
      });
      return true;
    }
    if (path === "/api/personal-coach/commitments" && method === "POST") {
      const input = await request.body();
      json(200, store.createCommitment({
        ...(optionalString(input.goalId) ? { goalId: optionalString(input.goalId)! } : {}),
        title: String(input.title ?? ""),
        ...(optionalNumber(input.plannedFor) !== undefined ? { plannedFor: optionalNumber(input.plannedFor)! } : {}),
        ...(optionalNumber(input.dueAt) !== undefined ? { dueAt: optionalNumber(input.dueAt)! } : {}),
        ...(input.estimateMinutes !== undefined ? { estimateMinutes: Number(input.estimateMinutes) } : {}),
        // Direct REST creation is a user action. Agent/import provenance must
        // come from their dedicated trusted flows, never client-supplied tags.
        source: "user",
      }));
      return true;
    }
    match = path.match(/^\/api\/personal-coach\/commitments\/([^/]+)\/(complete|reschedule|skip|cancel)$/);
    if (match && method === "POST") {
      const id = decodeURIComponent(match[1]!);
      const action = match[2]!;
      if (action === "complete") {
        json(200, store.completeCommitment(id));
        return true;
      }
      const input = await request.body();
      if (action === "reschedule") {
        json(200, store.rescheduleCommitment(id, Number(input.plannedFor), optionalString(input.reason)));
        return true;
      }
      if (action === "skip") {
        json(200, store.skipCommitment(id, optionalString(input.reason)));
        return true;
      }
      json(200, store.cancelCommitment(id, optionalString(input.reason)));
      return true;
    }

    if (path === "/api/personal-coach/routines" && method === "GET") {
      const status = queryEnum(url.searchParams.get("status"), "status", ROUTINE_STATUSES);
      json(200, { routines: store.listRoutines(status) });
      return true;
    }
    if (path === "/api/personal-coach/routines" && method === "POST") {
      const input = await request.body();
      json(200, store.createRoutine({
        ...(optionalString(input.goalId) ? { goalId: optionalString(input.goalId)! } : {}),
        title: String(input.title ?? ""),
        cadence: cadenceOf(input.cadence),
        ...(input.preferredMinuteOfDay !== undefined
          ? { preferredMinuteOfDay: Number(input.preferredMinuteOfDay) }
          : {}),
      }));
      return true;
    }
    match = path.match(/^\/api\/personal-coach\/routines\/([^/]+)$/);
    if (match && method === "PATCH") {
      const input = await request.body();
      json(200, store.updateRoutine(decodeURIComponent(match[1]!), {
        ...(input.goalId !== undefined ? { goalId: input.goalId === null ? null : String(input.goalId) } : {}),
        ...(input.title !== undefined ? { title: String(input.title) } : {}),
        ...(input.cadence !== undefined ? { cadence: cadenceOf(input.cadence) } : {}),
        ...(input.preferredMinuteOfDay !== undefined
          ? { preferredMinuteOfDay: input.preferredMinuteOfDay === null ? null : Number(input.preferredMinuteOfDay) }
          : {}),
        ...(input.status !== undefined ? { status: String(input.status) as CoachRoutineStatus } : {}),
      }));
      return true;
    }

    if (path === "/api/personal-coach/checkins" && method === "POST") {
      const input = await request.body();
      json(200, store.recordCheckIn({
        energy: Number(input.energy),
        focus: Number(input.focus),
        ...(optionalString(input.note) ? { note: optionalString(input.note)! } : {}),
      }));
      return true;
    }

    if (path === "/api/personal-coach/activity" && method === "GET") {
      json(200, {
        events: store.listEvents({
          ...(queryNumber(url.searchParams.get("sinceSeq")) !== undefined
            ? { sinceSeq: queryNumber(url.searchParams.get("sinceSeq"))! }
            : {}),
          ...(url.searchParams.get("entityType") ? { entityType: url.searchParams.get("entityType")! } : {}),
          ...(url.searchParams.get("entityId") ? { entityId: url.searchParams.get("entityId")! } : {}),
          ...(queryNumber(url.searchParams.get("limit")) !== undefined
            ? { limit: queryNumber(url.searchParams.get("limit"))! }
            : {}),
        }),
      });
      return true;
    }

    return false;
  };
}
