import type {
  AgentCapabilityContributionRegistry,
  Disposable,
  JsonObject,
  SpaceContext,
  ToolExecutionContext,
} from "@polyth/contracts";
import type { CoachProposal, CoachStore } from "./index.ts";
import { buildCoachContext } from "./context.ts";

const BEHAVIOR = `You are operating inside Polyth Personal Coach. Help the user decide, commit, act, reflect, and adapt with as little management overhead as possible.

Rules:
- Treat durable Coach state and tool results as the source of truth; do not pretend chat history is durable state.
- Prefer one useful next action over long task lists. Do not create synthetic productivity scores or guilt/streak pressure.
- Never mark a commitment complete unless the user explicitly states it is complete or directly asks you to mark it complete.
- Strategic changes to goals, commitments, or routines that you initiate must be created as proposals rather than silently applied. Use coach_propose_routine for anything the user wants to repeat on a schedule; there is no opaque "plan patch".
- A user-explicit low-risk operation such as "mark X done", "move X to tomorrow", a check-in, or a reflection may use the corresponding deterministic tool directly.
- Insights are hypotheses. Tie them to evidence and allow the user to disagree.
- Ask only questions that materially change the plan. Avoid turning every interaction into a questionnaire.
- Do not present yourself as a therapist, clinician, doctor, or financial adviser. Keep coaching focused on planning, execution, reflection, and prioritization.
- Use coach_read_context when current state matters. Do not assume stale session context is current.`;

const objectSchema = (properties: JsonObject, required: string[] = []): JsonObject => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const text = (description: string): JsonObject => ({ type: "string", description });
const number = (description: string): JsonObject => ({ type: "number", description });

const jsonOutput = (value: unknown, metadata?: JsonObject): { output: string; metadata?: JsonObject } => ({
  output: JSON.stringify(value),
  ...(metadata ? { metadata } : {}),
});

const optionalString = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value);
};

const optionalNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  return Number(value);
};

export interface CoachCapabilitySet {
  dispose(): void | Promise<void>;
  ids: string[];
}

export function registerCoachCapabilities(input: {
  registry: AgentCapabilityContributionRegistry;
  space: Pick<SpaceContext, "spaceId">;
  projectId: string;
  store: CoachStore;
  onProposalCreated?: (proposal: CoachProposal, ctx: ToolExecutionContext) => void | Promise<void>;
}): CoachCapabilitySet {
  const { registry, space, projectId, store } = input;
  const suffix = projectId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(-16) || "workspace";
  const id = (name: string): string => `personal-coach.${name}-${suffix}`;
  const registrations: Disposable[] = [];
  const ids: string[] = [];

  const register = (contribution: Parameters<AgentCapabilityContributionRegistry["register"]>[1]) => {
    ids.push(contribution.descriptor.id);
    registrations.push(registry.register("personal-coach", contribution));
  };

  const assertTarget = (ctx: ToolExecutionContext): void => {
    if (ctx.projectId !== projectId || (ctx.spaceId && ctx.spaceId !== space.spaceId)) {
      throw Object.assign(new Error("Coach tool target mismatch"), { code: "forbidden" });
    }
  };

  const proposalOutput = async (proposal: CoachProposal, ctx: ToolExecutionContext) => {
    await input.onProposalCreated?.(proposal, ctx);
    return jsonOutput(proposal, { entityId: proposal.id });
  };

  register({
    descriptor: {
      id: id("behavior"),
      kind: "instruction",
      owner: "personal-coach",
      scope: "project",
      spaceId: space.spaceId,
      projectId,
      revision: "1",
      title: "Personal Coach behavior",
      text: BEHAVIOR,
    },
  });

  const tool = (
    name: string,
    description: string,
    inputSchema: JsonObject,
    mutating: boolean,
    execute: (value: JsonObject, ctx: ToolExecutionContext) => Promise<{ output: string; metadata?: JsonObject }> | { output: string; metadata?: JsonObject },
  ) => register({
    descriptor: {
      id: id(name.replaceAll("_", "-")),
      kind: "tool",
      owner: "personal-coach",
      scope: "project",
      spaceId: space.spaceId,
      projectId,
      revision: "1",
      name,
      description,
      inputSchema,
      trust: mutating ? "workspace" : "pure",
      mutating,
    },
    execute: async (value, ctx) => {
      assertTarget(ctx);
      return execute(value, ctx);
    },
  });

  tool(
    "coach_read_context",
    "Read the current bounded Personal Coach state: preferences, active goals, today, recent check-ins, accepted insights, reflections, and recent activity.",
    objectSchema({}),
    false,
    () => ({ output: buildCoachContext(store) }),
  );

  tool(
    "coach_list_goals",
    "List durable Coach goals. Use this instead of guessing goals from chat history.",
    objectSchema({ status: text("Optional status: active, paused, completed, or cancelled") }),
    false,
    (value) => {
      const status = optionalString(value.status);
      const allowed = ["active", "paused", "completed", "cancelled"] as const;
      const typed = status && allowed.includes(status as typeof allowed[number])
        ? status as typeof allowed[number]
        : undefined;
      return jsonOutput({ goals: store.listGoals(typed).slice(0, 30) });
    },
  );

  tool(
    "coach_list_commitments",
    "List durable commitments. Results are bounded; prefer open commitments unless another status is specifically needed.",
    objectSchema({
      status: text("Optional status: open, done, skipped, or cancelled"),
      goalId: text("Optional goal id"),
      limit: number("Maximum records, 1-50"),
    }),
    false,
    (value) => {
      const statusRaw = optionalString(value.status);
      const allowed = ["open", "done", "skipped", "cancelled"] as const;
      const status = statusRaw && allowed.includes(statusRaw as typeof allowed[number])
        ? statusRaw as typeof allowed[number]
        : undefined;
      const rawLimit = optionalNumber(value.limit);
      const limit = rawLimit === undefined ? 20 : Math.max(1, Math.min(50, Math.trunc(rawLimit)));
      return jsonOutput({ commitments: store.listCommitments({
        ...(status ? { status } : {}),
        ...(optionalString(value.goalId) ? { goalId: optionalString(value.goalId)! } : {}),
        limit,
      }) });
    },
  );

  tool(
    "coach_complete_commitment",
    "Mark one commitment complete only when the user explicitly says it is done or asks to mark it done.",
    objectSchema({ id: text("Commitment id") }, ["id"]),
    true,
    (value) => {
      const commitment = store.completeCommitment(String(value.id ?? ""));
      return jsonOutput(commitment, { entityId: commitment.id });
    },
  );

  tool(
    "coach_reschedule_commitment",
    "Move one explicit commitment to a new planned epoch-millisecond time. Use only for a user-explicit change, not an autonomous strategic rewrite.",
    objectSchema({
      id: text("Commitment id"),
      plannedFor: number("New planned time as epoch milliseconds"),
      reason: text("Optional short reason"),
    }, ["id", "plannedFor"]),
    true,
    (value) => {
      const commitment = store.rescheduleCommitment(
        String(value.id ?? ""),
        Number(value.plannedFor),
        optionalString(value.reason),
      );
      return jsonOutput(commitment, { entityId: commitment.id });
    },
  );

  tool(
    "coach_cancel_commitment",
    "Cancel one explicit commitment when the user clearly decides it is no longer relevant.",
    objectSchema({ id: text("Commitment id"), reason: text("Optional short reason") }, ["id"]),
    true,
    (value) => {
      const commitment = store.cancelCommitment(String(value.id ?? ""), optionalString(value.reason));
      return jsonOutput(commitment, { entityId: commitment.id });
    },
  );

  tool(
    "coach_record_checkin",
    "Record a lightweight user check-in. Energy and focus are self-reported 1-5 signals, not medical measurements.",
    objectSchema({
      energy: number("Self-reported energy from 1 to 5"),
      focus: number("Self-reported focus from 1 to 5"),
      note: text("Optional short note from the user"),
    }, ["energy", "focus"]),
    true,
    (value) => {
      const checkIn = store.recordCheckIn({
        energy: Number(value.energy),
        focus: Number(value.focus),
        ...(optionalString(value.note) ? { note: optionalString(value.note)! } : {}),
      });
      return jsonOutput(checkIn, { entityId: checkIn.id });
    },
  );

  tool(
    "coach_record_reflection",
    "Persist a conclusion or observation the user explicitly expressed so it can survive disposable chat sessions.",
    objectSchema({
      text: text("Reflection text grounded in what the user actually said"),
      kind: text("Optional kind: note, daily, or weekly"),
    }, ["text"]),
    true,
    (value, ctx) => {
      const kindRaw = optionalString(value.kind);
      const kind = kindRaw === "daily" || kindRaw === "weekly" ? kindRaw : "note";
      const reflection = store.recordReflection({
        kind,
        text: String(value.text ?? ""),
        ...(ctx.sessionId ? { sourceSessionId: ctx.sessionId } : {}),
      });
      return jsonOutput(reflection, { entityId: reflection.id });
    },
  );

  tool(
    "coach_propose_goal",
    "Create a pending goal proposal for the user to review. Do not silently create strategic goals.",
    objectSchema({
      title: text("Concise goal title"),
      desiredOutcome: text("Optional observable desired outcome"),
      why: text("Optional reason grounded in the conversation"),
      priority: number("Optional priority 1-3"),
      targetAt: number("Optional target time as epoch milliseconds"),
      reason: text("Why this proposal is useful now"),
    }, ["title"]),
    true,
    async (value, ctx) => {
      const payload: JsonObject = { title: String(value.title ?? "") };
      const desiredOutcome = optionalString(value.desiredOutcome);
      const why = optionalString(value.why);
      const priority = optionalNumber(value.priority);
      const targetAt = optionalNumber(value.targetAt);
      if (desiredOutcome) payload.desiredOutcome = desiredOutcome;
      if (why) payload.why = why;
      if (priority !== undefined) payload.priority = priority;
      if (targetAt !== undefined) payload.targetAt = targetAt;
      const proposal = store.createProposal({
        type: "goal",
        payload,
        ...(optionalString(value.reason) ? { reason: optionalString(value.reason)! } : {}),
        ...(ctx.sessionId ? { sourceSessionId: ctx.sessionId } : {}),
      });
      return proposalOutput(proposal, ctx);
    },
  );

  tool(
    "coach_propose_commitment",
    "Create a pending commitment proposal when the agent is turning an intention into a new commitment. Existing explicit commitments should be mutated with their dedicated tools.",
    objectSchema({
      title: text("Concrete action"),
      goalId: text("Optional related goal id"),
      plannedFor: number("Optional planned time as epoch milliseconds"),
      dueAt: number("Optional deadline as epoch milliseconds"),
      estimateMinutes: number("Optional estimate in minutes"),
      reason: text("Why this commitment is appropriate"),
    }, ["title"]),
    true,
    async (value, ctx) => {
      const payload: JsonObject = { title: String(value.title ?? "") };
      const goalId = optionalString(value.goalId);
      const plannedFor = optionalNumber(value.plannedFor);
      const dueAt = optionalNumber(value.dueAt);
      const estimateMinutes = optionalNumber(value.estimateMinutes);
      if (goalId) payload.goalId = goalId;
      if (plannedFor !== undefined) payload.plannedFor = plannedFor;
      if (dueAt !== undefined) payload.dueAt = dueAt;
      if (estimateMinutes !== undefined) payload.estimateMinutes = estimateMinutes;
      const proposal = store.createProposal({
        type: "commitment",
        payload,
        ...(optionalString(value.reason) ? { reason: optionalString(value.reason)! } : {}),
        ...(ctx.sessionId ? { sourceSessionId: ctx.sessionId } : {}),
      });
      return proposalOutput(proposal, ctx);
    },
  );

  tool(
    "coach_propose_routine",
    "Create a pending routine proposal — a repeating commitment such as a weekday morning workout. The routine only exists once the user approves the proposal.",
    objectSchema({
      title: text("What the user repeats, phrased as they said it"),
      cadence: {
        type: "object",
        description: "One of {\"kind\":\"daily\"}, {\"kind\":\"weekly\",\"days\":[1,2,3,4,5]} with Sunday=0, or {\"kind\":\"interval\",\"everyDays\":3}",
      },
      preferredMinuteOfDay: number("Optional local time of day as minutes after midnight, e.g. 360 for 06:00"),
      goalId: text("Optional goal this routine serves"),
      reason: text("Why this routine is appropriate now"),
    }, ["title", "cadence"]),
    true,
    async (value, ctx) => {
      const cadence = value.cadence;
      if (!cadence || typeof cadence !== "object" || Array.isArray(cadence)) {
        throw Object.assign(new Error("cadence must be an object"), { code: "invalid-input" });
      }
      const payload: JsonObject = { title: String(value.title ?? ""), cadence: cadence as JsonObject };
      const goalId = optionalString(value.goalId);
      const preferred = optionalNumber(value.preferredMinuteOfDay);
      if (goalId) payload.goalId = goalId;
      if (preferred !== undefined) payload.preferredMinuteOfDay = preferred;
      const proposal = store.createProposal({
        type: "routine",
        payload,
        ...(optionalString(value.reason) ? { reason: optionalString(value.reason)! } : {}),
        ...(ctx.sessionId ? { sourceSessionId: ctx.sessionId } : {}),
      });
      return proposalOutput(proposal, ctx);
    },
  );

  tool(
    "coach_resolve_routine_day",
    "Record that the user completed or skipped one routine on one local day, when they explicitly say so. This does not change the routine itself.",
    objectSchema({
      routineId: text("Routine id"),
      date: text("Local day as YYYY-MM-DD"),
      status: text("done or skipped"),
      reason: text("Optional short reason the user gave"),
    }, ["routineId", "date", "status"]),
    true,
    (value) => {
      const status = String(value.status ?? "");
      if (status !== "done" && status !== "skipped") {
        throw Object.assign(new Error("status must be done or skipped"), { code: "invalid-input" });
      }
      const occurrence = store.setRoutineOccurrence({
        routineId: String(value.routineId ?? ""),
        dateKey: String(value.date ?? ""),
        status,
        ...(optionalString(value.reason) ? { reason: optionalString(value.reason)! } : {}),
      });
      return jsonOutput(occurrence, { entityId: occurrence.routineId });
    },
  );

  return {
    ids,
    async dispose() {
      for (const registration of registrations.toReversed()) await registration.dispose();
    },
  };
}
