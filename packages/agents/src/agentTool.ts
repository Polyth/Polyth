// `polyth_agents` agent tool and its skill: how a chat agent lists, creates,
// changes and wakes Polyth Agents — the named agents of the Agents page that
// wake on a schedule, a heartbeat or on demand and keep a notebook. Without
// it a chat asked to "create an agent in Polyth" has no way to do so.
// Server-only; it acts for the person of the turn, who owns what it creates.
import type { AgentCapabilityContribution, JsonObject, SpaceContext, ToolExecutionContext } from "@polyth/contracts";
import { AGENT_ICON_IDS } from "./agentPrompt.ts";
import type { AgentColor, AgentNotifyPolicy, ScheduleService, ScheduleTask, ScheduleTaskInput } from "./index.ts";

export const AGENTS_PACKAGE_ID = "agents";
export const AGENTS_TOOL_ID = "agents.tool";
export const AGENTS_SKILL_ID = "agents.skill";
export const AGENTS_TOOL_NAME = "polyth_agents";

const ACTIONS = ["list", "get", "create", "update", "run"] as const;
type Action = typeof ACTIONS[number];
const COLORS: readonly AgentColor[] = ["neutral", "blue", "green", "amber", "purple", "red"];
const NOTIFY: readonly AgentNotifyPolicy[] = ["alerts", "updates", "off"];
/** Placeholder clock of an on-demand agent; it never fires while manualOnly. */
const ON_DEMAND_CRON = "0 9 * * 1";

export interface AgentsToolDeps {
  service: ScheduleService;
  /** The person's context in the Space, or undefined (no such member). */
  personSpace(userId: string, spaceId: string): SpaceContext | undefined;
  /** The project as this person sees it, or undefined. */
  project(space: SpaceContext, projectId: string): Promise<{ id: string; name?: string } | undefined>;
  /** "own" | "admin" | "none", as the HTTP routes decide it. */
  access(space: SpaceContext, task: ScheduleTask): "own" | "admin" | "none";
}

const inputSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: [...ACTIONS],
      description: "list: the Polyth Agents of this project. get: one agent in full. create: a new agent. update: change an agent you own. run: wake an agent now, optionally with a message.",
    },
    agentId: { type: "string", description: "Agent id for get/update/run." },
    projectId: { type: "string", description: "Project of the agent. Defaults to this chat's project." },
    name: { type: "string", description: "create/update: the agent's display name, e.g. \"Otto\"." },
    charter: {
      type: "string",
      description: "create/update: the agent's standing instructions, written to the agent in the second person — who it is, its character and tone, what it watches and does, what it never does. Sent at the start of every conversation of the agent.",
    },
    description: { type: "string", description: "create/update: one line shown on the agent's card (up to 280 characters)." },
    icon: { type: "string", enum: [...AGENT_ICON_IDS], description: "create/update: the agent's glyph." },
    color: { type: "string", enum: [...COLORS], description: "create/update: the agent's colour." },
    schedule: {
      type: "object",
      additionalProperties: false,
      required: ["cron", "timeZone"],
      description: "create/update: wake on a clock (five-field cron, at most hourly). Omit for an agent that wakes only on demand and on its heartbeat; null on update removes the clock.",
      properties: {
        cron: { type: "string", description: "e.g. \"0 9 * * 1-5\" for weekdays at 09:00." },
        timeZone: { type: "string", description: "IANA zone, e.g. \"Europe/Kyiv\"." },
      },
    },
    heartbeat: {
      type: "object",
      additionalProperties: false,
      required: ["everyMinutes", "timeZone"],
      description: "create/update: a light, frequent check-in inside the agent's ongoing conversation; it stays quiet unless something needs the person. null on update turns it off.",
      properties: {
        everyMinutes: { type: "integer", minimum: 10, maximum: 1440 },
        timeZone: { type: "string", description: "IANA zone of the active hours." },
        activeFrom: { type: "integer", description: "Start of active hours, minutes after local midnight (e.g. 540 = 09:00)." },
        activeTo: { type: "integer", description: "End of active hours, minutes after local midnight (exclusive)." },
        checklist: { type: "string", description: "What to look at on every beat. Empty = the charter." },
      },
    },
    memory: {
      type: "string",
      enum: ["rolling", "fresh"],
      description: "create: rolling (default) keeps one ongoing conversation that remembers earlier runs; fresh starts every run from the charter and notebook alone. A heartbeat needs rolling.",
    },
    notebook: { type: "string", description: "create/update: the agent's notebook — facts it should start from and keep up to date (preferences, constraints, what it already knows)." },
    notify: { type: "string", enum: [...NOTIFY], description: "create/update: when a finished run notifies the person (default alerts)." },
    enabled: { type: "boolean", description: "create/update: false keeps the agent paused (create default true)." },
    message: { type: "string", description: "run: text the agent receives from the person on this wake." },
  },
};

export const agentsSkill: AgentCapabilityContribution = {
  descriptor: {
    id: AGENTS_SKILL_ID,
    kind: "skill",
    owner: AGENTS_PACKAGE_ID,
    scope: "deployment",
    revision: "1",
    name: "polyth-agents",
    title: "Polyth Agents",
    description: "Create, change, list and wake Polyth Agents: named agents that live on the Agents page, wake on a schedule, heartbeat or on demand, and keep a notebook.",
    instructions: `A Polyth Agent is a named, long-lived agent of a project that lives on Polyth's Agents page. It has a charter (standing instructions and character), a notebook (what it knows), and wakes on a schedule, on a heartbeat, on events or when the person runs it; every run is its own Polyth conversation the person can read and answer.
When the user asks to create, make or set up an agent "in Polyth" (any language, for example "створи агента в Політі", "агент Політу"), or describes a persistent assistant or persona with a name, make a Polyth Agent with ${AGENTS_TOOL_NAME} action "create". This is not a delegated child session (agent.spawn), not a harness agent file (.opencode/agents, .claude/agents) and not a persona written into AGENTS.md; do not substitute those.
Before creating: call ${AGENTS_TOOL_NAME} action "list" so you do not duplicate an agent of the same name (update it instead). Write the charter to the agent in the second person from everything the user said — its name, role, character and tone, what it watches, how and when it asks questions, what it suggests, its boundaries — and keep the user's language. Put facts it should start from (preferences, constraints, known context from memory or this chat) in the notebook, not the charter. Choose a fitting icon and colour.
When to wake: use the schedule or heartbeat the user asked for. A proactive companion that checks in "sometimes" or "if we have not talked for a while" fits a heartbeat with daytime active hours (for example every 240 minutes, 09:00–21:00) in the user's time zone; ask for the time zone if you cannot tell it. With no timing at all, create it on demand only and say how to add a schedule later. Keep rolling memory unless the user wants every run to start fresh.
After creating, report the agent's name and id and that it is on the Agents page; wake it with action "run" only when the user asks. Change an existing agent with action "update" (only the fields to change). Agents defined by a repository file (.agents/agents/*.md) are changed by editing that file.`,
  },
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const invalid = (message: string): Error => Object.assign(new Error(message), { code: "invalid-input" });
const forbidden = (message: string): Error => Object.assign(new Error(message), { code: "forbidden" });

const date = (at: number | null | undefined): string =>
  at ? new Date(at).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "never";

/** When an agent wakes, in a few words. */
function wakes(task: ScheduleTask): string {
  const parts: string[] = [];
  if (!task.manualOnly) {
    const cadence = task.cadence;
    parts.push(cadence.kind === "cron" ? `schedule ${cadence.expression} (${cadence.timeZone})`
      : cadence.kind === "every" ? `every ${cadence.everyMinutes} min`
        : `once at ${date(cadence.at)}`);
  }
  if (task.heartbeat) {
    const beat = task.heartbeat;
    const clock = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    const window = beat.activeFrom !== undefined && beat.activeTo !== undefined ? ` ${clock(beat.activeFrom)}–${clock(beat.activeTo)}` : "";
    parts.push(`heartbeat every ${beat.everyMinutes} min${window} (${beat.timeZone})`);
  }
  if (task.eventTriggers?.length) parts.push(`${task.eventTriggers.length} event wake${task.eventTriggers.length === 1 ? "" : "s"}`);
  return parts.length ? parts.join(", ") : "on demand only";
}

const summary = (task: ScheduleTask): string =>
  `- ${task.id} · “${task.title || "Untitled"}”${task.description ? ` — ${task.description}` : ""} · ${task.enabled ? "active" : "paused"} · wakes: ${wakes(task)} · last run ${date(task.lastRunAt)}${task.source === "loop-file" ? ` · defined by ${task.sourcePath ?? "a repository file"}` : ""}`;

/** Fields shared by create and update, from untrusted tool input. */
function fieldsOf(input: JsonObject): Partial<ScheduleTaskInput> {
  const out: Partial<ScheduleTaskInput> = {};
  const name = text(input.name);
  if (name) out.title = name.slice(0, 120);
  const charter = text(input.charter);
  if (charter) out.prompt = charter;
  if (typeof input.description === "string") out.description = input.description;
  if (typeof input.icon === "string") {
    if (!(AGENT_ICON_IDS as readonly string[]).includes(input.icon)) throw invalid(`icon must be one of ${AGENT_ICON_IDS.join(", ")}`);
    out.icon = input.icon;
  }
  if (input.color !== undefined) {
    if (!COLORS.includes(input.color as AgentColor)) throw invalid(`color must be one of ${COLORS.join(", ")}`);
    out.color = input.color as AgentColor;
  }
  if (input.notify !== undefined) {
    if (!NOTIFY.includes(input.notify as AgentNotifyPolicy)) throw invalid(`notify must be one of ${NOTIFY.join(", ")}`);
    out.notify = input.notify as AgentNotifyPolicy;
  }
  if (typeof input.notebook === "string") out.notebook = input.notebook;
  if (typeof input.enabled === "boolean") out.enabled = input.enabled;
  if (input.heartbeat !== undefined) out.heartbeat = input.heartbeat;
  if (input.schedule !== undefined && input.schedule !== null) {
    const schedule = input.schedule as { cron?: unknown; timeZone?: unknown };
    const cron = text(schedule.cron);
    const timeZone = text(schedule.timeZone);
    if (!cron || !timeZone) throw invalid("schedule needs cron and timeZone");
    out.cadence = { kind: "cron", expression: cron, timeZone };
    out.manualOnly = false;
  }
  return out;
}

export function createAgentsTool(deps: AgentsToolDeps): AgentCapabilityContribution {
  const personOf = (ctx: ToolExecutionContext): SpaceContext => {
    if (!ctx.spaceId || !ctx.sessionId) throw new Error(`${AGENTS_TOOL_NAME} needs a Polyth chat`);
    // An agent acts for the person who owns it; work with no person may not make one.
    if (!ctx.actorUserId || ctx.actorUserId.startsWith("system:")) {
      throw forbidden("Polyth Agents act for a person; this turn acts for no one");
    }
    const space = deps.personSpace(ctx.actorUserId, ctx.spaceId);
    if (!space) throw forbidden("The person of this chat is not a member of its Space");
    return space;
  };

  const projectOf = async (space: SpaceContext, input: JsonObject, ctx: ToolExecutionContext) => {
    const projectId = text(input.projectId) ?? ctx.projectId;
    const project = projectId ? await deps.project(space, projectId) : undefined;
    if (!project) throw Object.assign(new Error("project not found"), { code: "not-found" });
    return project;
  };

  /** An agent this person may see; `own` also demands full access. */
  const agentOf = async (space: SpaceContext, input: JsonObject, need: "own" | "see"): Promise<ScheduleTask> => {
    const id = text(input.agentId);
    if (!id) throw invalid("agentId is required");
    const task = deps.service.get(id);
    const visible = task && (!task.spaceId || task.spaceId === space.spaceId) && await deps.project(space, task.projectId);
    const access = visible ? deps.access(space, task) : "none";
    if (!task || access === "none") throw Object.assign(new Error("agent not found"), { code: "not-found" });
    if (need === "own" && access !== "own") throw forbidden("Only the person who owns this agent can change or wake it");
    return task;
  };

  const run = async (input: JsonObject, ctx: ToolExecutionContext): Promise<{ output: string; metadata?: JsonObject }> => {
    const action = input.action as Action;
    if (!ACTIONS.includes(action)) throw invalid(`action must be one of ${ACTIONS.join(", ")}`);
    const space = personOf(ctx);

    if (action === "list") {
      const project = await projectOf(space, input, ctx);
      const tasks = deps.service.list(project.id)
        .filter((task) => (!task.spaceId || task.spaceId === space.spaceId) && deps.access(space, task) !== "none");
      const where = project.name ? `${project.name} (${project.id})` : project.id;
      if (!tasks.length) return { output: `No Polyth Agents in project ${where} yet.` };
      return { output: [`${tasks.length} Polyth Agent${tasks.length === 1 ? "" : "s"} in project ${where}:`, ...tasks.map(summary)].join("\n") };
    }

    if (action === "get") {
      const task = await agentOf(space, input, "see");
      if (deps.access(space, task) !== "own") return { output: summary(task) };
      return {
        output: [
          summary(task),
          `Charter:\n${task.prompt}`,
          task.notebook ? `Notebook:\n${task.notebook}` : "Notebook: empty",
          `Memory: ${(task.target?.mode ?? "new-session-per-run") === "dedicated-session" ? "rolling" : "fresh"} · notify: ${task.notify ?? "alerts"}`,
        ].join("\n\n"),
      };
    }

    if (action === "create") {
      if (space.role === "viewer") throw forbidden("Viewers can't create agents");
      const project = await projectOf(space, input, ctx);
      const fields = fieldsOf(input);
      if (!fields.title) throw invalid("create needs a name");
      if (!fields.prompt) throw invalid("create needs a charter");
      const memory = input.memory === "fresh" ? "fresh" : "rolling";
      if (memory === "fresh" && fields.heartbeat) throw invalid("a heartbeat needs rolling memory");
      const timeZone = fields.cadence?.kind === "cron" ? fields.cadence.timeZone
        : text((fields.heartbeat as { timeZone?: unknown } | undefined)?.timeZone) ?? "UTC";
      const created = deps.service.create({
        icon: "bot",
        color: "neutral",
        ...fields,
        projectId: project.id,
        spaceId: space.spaceId,
        ownerUserId: space.userId,
        prompt: fields.prompt,
        cadence: fields.cadence ?? { kind: "cron", expression: ON_DEMAND_CRON, timeZone },
        manualOnly: !fields.cadence,
        target: { mode: memory === "rolling" ? "dedicated-session" : "new-session-per-run" },
        ...(memory === "rolling" ? { keepWarm: "off" as const } : {}),
      });
      return {
        output: `Created Polyth Agent “${created.title}” (${created.id}) in project ${project.name ?? project.id}. It is on the Agents page; wakes: ${wakes(created)}; ${created.enabled ? "active" : "paused"}.`,
        metadata: { agentId: created.id, projectId: project.id },
      };
    }

    const task = await agentOf(space, input, "own");
    if (action === "update") {
      if (task.source === "loop-file") throw Object.assign(new Error(`This agent is defined by ${task.sourcePath ?? "a repository file"}; edit that file instead`), { code: "conflict" });
      const fields = fieldsOf(input);
      const patch: Partial<ScheduleTaskInput> = { ...fields, spaceId: space.spaceId };
      if (input.schedule === null) patch.manualOnly = true;
      if (input.heartbeat === null) patch.heartbeat = null;
      if (Object.keys(patch).length === 1) throw invalid("update needs at least one field to change");
      const updated = deps.service.update(task.id, patch);
      return { output: `Updated “${updated.title}” (${updated.id}). ${summary(updated).slice(2)}`, metadata: { agentId: updated.id } };
    }

    const message = text(input.message);
    const woken = await deps.service.runNow(task.id, message ? { input: message } : undefined);
    return { output: `Woke “${woken.title}” (${woken.id}); its run appears on the Agents page.`, metadata: { agentId: woken.id } };
  };

  return {
    descriptor: {
      id: AGENTS_TOOL_ID,
      kind: "tool",
      owner: AGENTS_PACKAGE_ID,
      scope: "deployment",
      revision: "1",
      name: AGENTS_TOOL_NAME,
      description: "List, create, change and wake Polyth Agents — the named agents on Polyth's Agents page that wake on a schedule, heartbeat or on demand and keep a notebook. Use it whenever the user asks to create or set up an agent in Polyth.",
      inputSchema,
      trust: "workspace",
      mutating: true,
    },
    // No auto-approval: an agent acts for the person and spends on their
    // accounts, so creating, changing or waking one stays their decision.
    execute: run,
  };
}
