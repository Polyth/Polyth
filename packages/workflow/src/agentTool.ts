// `polyth_workflow` and `polyth_workflow_manage`: how a chat's agent runs and
// steers workflow templates instead of spawning each worker by hand.
// Server-only. Both tools act for the person of the calling turn, exactly as
// the HTTP routes act for the signed-in person, and reach only the calling
// chat's project and the runs started from that chat.
import type {
  AgentCapabilityContribution,
  HarnessSelection,
  JsonObject,
  ModelRef,
  SessionProjection,
  SpaceContext,
  ToolExecutionContext,
  WorkflowDto,
  WorkflowEdgeDto,
  WorkflowLaunchOptionsDto,
  WorkflowNodeDto,
  WorkflowRunDto,
  WorkflowRunNodeDto,
  WorkflowRunOptionsDto,
} from "@polyth/contracts";
import type { WorkflowNodeRoute, WorkflowService } from "./index.ts";
import { getWorkflowPreset, topologySummary, workflowPresets } from "./presets.ts";

export const WORKFLOW_PACKAGE_ID = "workflow";
export const WORKFLOW_TOOL_ID = "workflow.tool";
export const WORKFLOW_MANAGE_TOOL_ID = "workflow.manage-tool";
export const WORKFLOW_SKILL_ID = "workflow.skill";
export const WORKFLOW_TOOL_NAME = "polyth_workflow";
export const WORKFLOW_MANAGE_TOOL_NAME = "polyth_workflow_manage";

export interface WorkflowToolDeps {
  service(space: SpaceContext): Promise<WorkflowService>;
  /** The person's context in the Space, or undefined (no such member). */
  personSpace(userId: string, spaceId: string): SpaceContext | undefined;
  /** Context for a turn with no acting person. */
  systemSpace(spaceId: string): SpaceContext;
  /** The chat as that context sees it; undefined when it cannot. */
  session(space: SpaceContext, sessionId: string): Promise<SessionProjection | undefined>;
}

const RUN_ACTIONS = ["templates", "template", "run", "runs", "status", "output", "stop", "retry", "outcome", "stats"] as const;
const MANAGE_ACTIONS = ["create", "update", "delete", "decide"] as const;
type RunAction = typeof RUN_ACTIONS[number];
type ManageAction = typeof MANAGE_ACTIONS[number];

const ROLES = "explore, implement, verify, review, vision, write, or a custom-… id";
const OUTPUT_DEFAULT = 4_000;
const OUTPUT_MAX = 12_000;
const TEMPLATE_MAX = 16_000;
const PROMPT_PREVIEW = 160;

const fail = (message: string, code = "invalid-input") => Object.assign(new Error(message), { code });
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const oneLine = (value: string, max: number): string => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const when = (at?: number): string =>
  at ? `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC` : "unknown time";

// Everything below up to the handlers is standing context: harnesses that do
// not defer tools carry both schemas on every request, and prompt-delivered
// skills carry the instructions on every prompt. Keep it terse; guidance that
// is needed only at one step belongs in that step's output.
const runSchema: JsonObject = {
  type: "object",
  required: ["action"],
  properties: {
    action: { type: "string", enum: [...RUN_ACTIONS] },
    workflowId: { type: "string", description: "Template id, short id (build-review) or name." },
    input: { type: "string", description: "run: the task as a packet: goal, done-when, constraints, write paths, check." },
    facts: { type: "array", items: { type: "string" }, maxItems: 40, description: "run: what you already located, `path:line — fact` or `URL — fact` per line." },
    runId: { type: "string", description: "Defaults to this chat's latest run." },
    nodeId: { type: "string", description: "Unit id (output, retry)." },
    harnessId: { type: "string", description: "retry: another harness." },
    model: { type: "string", description: "retry: provider/model from agent.models." },
    value: { type: "string", enum: ["accepted", "reworked", "discarded"], description: "outcome: used as delivered / kept after more work / not used." },
    note: { type: "string", description: "outcome: one line why." },
    full: { type: "boolean", description: "template: whole unit prompts; status: the located facts." },
  },
};

const manageSchema: JsonObject = {
  type: "object",
  required: ["action"],
  properties: {
    action: { type: "string", enum: [...MANAGE_ACTIONS] },
    workflowId: { type: "string", description: "Saved template (update, delete)." },
    copyOf: { type: "string", description: "create: start from this template." },
    name: { type: "string" },
    description: { type: "string" },
    nodes: {
      type: "array",
      maxItems: 24,
      description: "The whole graph; edges come from `after`.",
      items: {
        type: "object",
        required: ["id", "role", "prompt"],
        properties: {
          id: { type: "string" },
          role: { type: "string" },
          prompt: { type: "string", description: "Standing instructions; the engine adds the task, facts and upstream reports." },
          kind: { type: "string", enum: ["lead", "worker", "review"], description: "review = a gate that can send work back." },
          after: { type: "array", items: { type: "string" }, description: "Units it waits for." },
          routingRole: { type: "string", description: `Model from the person's routing policy: ${ROLES}. Prefer it to a fixed model.` },
          harnessId: { type: "string" },
          model: { type: "string", description: "provider/model; with harnessId, the unit's own (fallback) route." },
        },
      },
    },
    reviewRounds: { type: "integer", minimum: 0, maximum: 5 },
    maxParallel: { type: "integer", minimum: 1, maximum: 6 },
    expectedRevision: { type: "integer" },
    runId: { type: "string" },
    nodeId: { type: "string", description: "decide: the waiting review unit." },
    decision: { type: "string", enum: ["accept", "another-round"] },
    note: { type: "string", description: "decide: guidance for another round." },
  },
};

export const workflowSkill: AgentCapabilityContribution = {
  descriptor: {
    id: WORKFLOW_SKILL_ID,
    kind: "skill",
    owner: WORKFLOW_PACKAGE_ID,
    scope: "deployment",
    revision: "2",
    name: "polyth-workflow",
    title: "Polyth workflows",
    description: "Run a workflow template (builder → reviewer, lead → workers → review) on this chat instead of spawning and reviewing each worker by hand.",
    instructions: `Use ${WORKFLOW_TOOL_NAME} when a task fits a saved template: a bounded change that needs an independent review, or work that splits into two or three non-overlapping scopes. The engine runs the units and their review rounds and wakes this chat, so you relay nothing. Do the work yourself, or spawn one worker, when it is a few tool calls, one file, or a decision one strong session should own: every unit costs a full session start.
Give "run" the task as a packet (goal, done-when, constraints, write paths, check) and the facts you already located, then end your turn. Each step's output says what to do next. After the run, verify the work yourself and record "outcome".
${WORKFLOW_MANAGE_TOOL_NAME} edits templates and settles a held review gate; it follows the chat's approval setting.`,
  },
};

/** A model as agents write it: `provider/model`, or the object form. */
function modelOf(value: unknown): ModelRef | undefined {
  if (typeof value === "string") {
    const at = value.indexOf("/");
    const providerID = at > 0 ? value.slice(0, at).trim() : "";
    const modelID = at > 0 ? value.slice(at + 1).trim() : "";
    return providerID && modelID ? { providerID, modelID } : undefined;
  }
  const raw = record(value);
  return raw && text(raw.providerID) && text(raw.modelID)
    ? { providerID: text(raw.providerID)!, modelID: text(raw.modelID)! }
    : undefined;
}

const routeText = (node: Pick<WorkflowRunNodeDto, "model" | "harness" | "routedRole"> | WorkflowNodeDto): string => {
  const harness = node.harness?.mode === "pinned" ? node.harness.harnessId : "";
  const model = node.model ? `${node.model.providerID}/${node.model.modelID}` : "";
  const role = "routingRole" in node && node.routingRole
    ? `role ${node.routingRole}`
    : "routedRole" in node && node.routedRole ? `by role ${node.routedRole}` : "";
  const route = [harness, model].filter(Boolean).join(" ");
  return [role, route].filter(Boolean).join(role && "routingRole" in node && route ? ", else " : " · ") || "chat route";
};

const shortId = (workflow: WorkflowDto): string => workflow.builtin && workflow.preset ? workflow.preset.id : workflow.id;

function templateLine(workflow: WorkflowDto): string {
  return `- ${shortId(workflow)} · ${workflow.name} · ${topologySummary(workflow)}${workflow.builtin ? "" : ` · saved r${workflow.revision ?? 0}`}`;
}

function runLine(run: WorkflowRunDto): string {
  const outcome = run.outcome ? ` · outcome ${run.outcome.value}` : run.status === "running" ? "" : " · outcome not recorded";
  return `- ${run.id} · “${run.name}” · ${run.status}${outcome} · started ${when(run.startedAt)} · ${oneLine(run.input, 100)}`;
}

function statusText(run: WorkflowRunDto, includeFacts: boolean): string {
  // A settled run's result is already in the chat's context (the run's
  // package context record); repeating it here would pay for it twice.
  const lines = [
    `Run ${run.id} · “${run.name}” · ${run.status} · started ${when(run.startedAt)}${run.finishedAt ? ` · finished ${when(run.finishedAt)}` : ""}`,
    run.outcome
      ? `Outcome: ${run.outcome.value} (recorded by ${run.outcome.by === "agent" ? "the agent" : "a person"})${run.outcome.note ? ` — ${run.outcome.note}` : ""}`
      : run.status === "running" ? "" : "Outcome: not recorded yet (action \"outcome\").",
    "Units:",
  ].filter(Boolean);
  for (const node of run.nodes) {
    const verdict = node.verdict === "approved" ? " · approved" : node.verdict === "changes-requested" ? " · changes requested" : "";
    const round = (node.round ?? 1) > 1 ? ` · round ${node.round}` : "";
    const session = node.sessionId ? ` · chat ${node.sessionId}` : "";
    const activity = node.status === "running" && node.activity ? ` · ${oneLine(node.activity, 60)}` : "";
    lines.push(`- ${node.id} (${node.role}) · ${node.status}${round}${verdict}${activity} · ${routeText(node)}${session}`);
    if (node.needsFix) lines.push(`    waits for a fix: ${oneLine(node.error ?? "could not start", 240)} → action "retry" with nodeId ${node.id}`);
    else if (node.status === "error" && node.error) lines.push(`    error: ${oneLine(node.error, 240)}${node.retryable ? " (retryable)" : ""}`);
    if (node.needsDecision) {
      lines.push(`    waits for a decision: ${node.needsDecision.items.length} blocker${node.needsDecision.items.length === 1 ? "" : "s"} still open${node.needsDecision.canAnotherRound ? "; another round is available" : ""} → ${WORKFLOW_MANAGE_TOOL_NAME} action "decide"`);
      for (const item of node.needsDecision.items.slice(0, 8)) {
        const finding = item.finding;
        lines.push(`      - ${finding.path ? `${finding.path}${finding.line ? `:${finding.line}` : ""} — ` : ""}${oneLine(finding.message, 200)}${item.reply ? ` (executor: ${oneLine(item.reply, 120)})` : ""}`);
      }
    } else if (node.findings?.length) {
      const blockers = node.findings.filter((finding) => finding.severity === "blocker").length;
      lines.push(`    findings: ${blockers} blocker${blockers === 1 ? "" : "s"}, ${node.findings.length - blockers} note${node.findings.length - blockers === 1 ? "" : "s"}`);
    }
  }
  const facts = run.facts ?? [];
  if (facts.length) {
    lines.push(includeFacts ? "Located facts:" : `Located facts: ${facts.length} (status with full to read them).`);
    if (includeFacts) lines.push(...facts.map((fact) => `- ${fact}`));
  }
  if (run.status !== "running") lines.push(`Result: in this chat's context; a unit's full report: action "output".`);
  return lines.join("\n");
}

function nodesOf(value: unknown): { nodes: WorkflowNodeDto[]; edges: WorkflowEdgeDto[] } {
  if (!Array.isArray(value) || value.length === 0 || value.length > 24) throw fail("nodes must list 1 to 24 units");
  const nodes: WorkflowNodeDto[] = [];
  const edges: WorkflowEdgeDto[] = [];
  for (const candidate of value) {
    const raw = record(candidate);
    const id = text(raw?.id);
    if (!raw || !id) throw fail("every unit needs an id");
    const modelRef = modelOf(raw.model);
    const harnessId = text(raw.harnessId);
    const harness: HarnessSelection | undefined = harnessId ? { mode: "pinned", harnessId } : undefined;
    const kind = raw.kind === "lead" || raw.kind === "worker" || raw.kind === "review" ? raw.kind : undefined;
    nodes.push({
      id,
      role: text(raw.role) ?? "",
      prompt: text(raw.prompt) ?? "",
      ...(kind ? { kind } : {}),
      ...(text(raw.routingRole) ? { routingRole: text(raw.routingRole)! } : {}),
      ...(modelRef ? { model: modelRef } : {}),
      ...(harness ? { harness } : {}),
      ...(text(raw.group) ? { group: text(raw.group)! } : {}),
    });
    const after = Array.isArray(raw.after) ? raw.after.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
    for (const source of after) edges.push({ id: `${source}-${id}`, source, target: id });
  }
  return { nodes, edges };
}

export function createWorkflowTools(deps: WorkflowToolDeps): { run: AgentCapabilityContribution; manage: AgentCapabilityContribution } {
  const scope = (ctx: ToolExecutionContext, tool: string): { space: SpaceContext; launchedBy?: string } => {
    if (!ctx.spaceId || !ctx.sessionId || !ctx.projectId) throw new Error(`${tool} needs a Polyth chat`);
    if (!ctx.actorUserId) return { space: deps.systemSpace(ctx.spaceId) };
    const space = deps.personSpace(ctx.actorUserId, ctx.spaceId);
    if (!space) throw fail("The person of this chat is not a member of its Space", "forbidden");
    return { space, launchedBy: ctx.actorUserId };
  };
  const writable = (space: SpaceContext): void => {
    if (space.role === "viewer") throw fail("Viewers can't run or change workflows", "forbidden");
  };
  /** The calling chat, proven to belong to the project the turn runs in. */
  const callerChat = async (space: SpaceContext, ctx: ToolExecutionContext): Promise<SessionProjection> => {
    const session = await deps.session(space, ctx.sessionId);
    if (!session || session.projectId !== ctx.projectId || (session.spaceId && session.spaceId !== ctx.spaceId))
      throw fail("this chat is not available to its workflow tool", "not-found");
    return session;
  };
  const templates = (service: WorkflowService, projectId: string): WorkflowDto[] =>
    [...workflowPresets(projectId).map((preset) => service.withRoutes(preset)), ...service.list(projectId)];
  /** A template of this project by id or bundled short id; never another project's. */
  const findTemplate = (service: WorkflowService, projectId: string, reference: string): WorkflowDto => {
    const saved = service.get(reference);
    if (saved && saved.projectId === projectId) return saved;
    const preset = getWorkflowPreset(reference) ?? getWorkflowPreset(`preset:${encodeURIComponent(projectId)}:${reference}`);
    if (preset && preset.projectId === projectId) return service.withRoutes(preset);
    // A model often names a template the way a person would. A name is
    // accepted only when exactly one template of this project carries it.
    const named = templates(service, projectId).filter((entry) => entry.name.trim().toLowerCase() === reference.trim().toLowerCase());
    if (named.length === 1) return named[0]!;
    throw fail(`No workflow template “${reference}” in this project. List them with ${WORKFLOW_TOOL_NAME} action "templates".`, "not-found");
  };
  /** A run started from the calling chat; any other run does not exist here. */
  const findRun = (service: WorkflowService, ctx: ToolExecutionContext, reference?: string): WorkflowRunDto => {
    const own = service.listRuns(ctx.projectId).filter((run) => run.parentSessionId === ctx.sessionId);
    const run = reference ? own.find((entry) => entry.id === reference) : own[0];
    if (!run) throw fail(reference ? "workflow run not found in this chat" : "this chat has no workflow runs", "not-found");
    return run;
  };

  const runTool = async (input: JsonObject, ctx: ToolExecutionContext): Promise<{ output: string; metadata?: JsonObject }> => {
    const action = input.action as RunAction;
    if (!RUN_ACTIONS.includes(action)) throw fail(`action must be one of ${RUN_ACTIONS.join(", ")}`);
    const { space, launchedBy } = scope(ctx, WORKFLOW_TOOL_NAME);
    const service = await deps.service(space);
    const parent = await callerChat(space, ctx);

    if (action === "templates") {
      const all = templates(service, ctx.projectId);
      return { output: [`${all.length} workflow template${all.length === 1 ? "" : "s"} (id · name · stages). Start one: action "run" with workflowId, input and facts.`, ...all.map(templateLine)].join("\n") };
    }
    if (action === "template") {
      const found = findTemplate(service, ctx.projectId, text(input.workflowId) ?? "");
      const view = {
        id: shortId(found),
        name: found.name,
        ...(found.description ? { description: found.description } : {}),
        bundled: found.builtin === true,
        revision: found.revision ?? 0,
        defaults: found.defaults ?? {},
        nodes: found.nodes.map((node) => ({
          id: node.id,
          role: node.role,
          ...(node.kind ? { kind: node.kind } : {}),
          after: found.edges.filter((edge) => edge.target === node.id).map((edge) => edge.source),
          ...(node.routingRole ? { routingRole: node.routingRole } : {}),
          ...(node.harness?.mode === "pinned" ? { harnessId: node.harness.harnessId } : {}),
          ...(node.model ? { model: { providerID: node.model.providerID, modelID: node.model.modelID } } : {}),
          ...(node.group ? { group: node.group } : {}),
          prompt: input.full === true || node.prompt.length <= PROMPT_PREVIEW ? node.prompt : `${node.prompt.slice(0, PROMPT_PREVIEW)}…`,
        })),
      };
      const clipped = input.full !== true && found.nodes.some((node) => node.prompt.length > PROMPT_PREVIEW);
      return { output: `${JSON.stringify(view).slice(0, TEMPLATE_MAX)}${clipped ? "\nPrompts are clipped; pass full to read them whole (needed only when you rewrite nodes; copyOf keeps them)." : ""}` };
    }
    if (action === "runs") {
      const own = service.listRuns(ctx.projectId).filter((run) => run.parentSessionId === ctx.sessionId);
      return { output: own.length ? [`${own.length} run${own.length === 1 ? "" : "s"} started from this chat, newest first:`, ...own.slice(0, 20).map(runLine)].join("\n") : "This chat has started no workflow runs." };
    }
    if (action === "stats") {
      const rows = service.outcomes(ctx.projectId);
      if (!rows.length) return { output: "No settled workflow runs in this project yet." };
      return {
        output: ["Settled runs per template (this project):", ...rows.map((row) =>
          `- “${row.name}”: ${row.runs} run${row.runs === 1 ? "" : "s"} (${row.done} done, ${row.error} failed, ${row.stopped} stopped) · outcome: ${row.accepted} accepted, ${row.reworked} reworked, ${row.discarded} discarded, ${row.unrecorded} not recorded · ${row.reworkedUnits} of ${row.units} units sent back by a review`)].join("\n"),
      };
    }
    if (action === "status") {
      return { output: statusText(findRun(service, ctx, text(input.runId)), input.full === true || input.includeFacts === true) };
    }
    if (action === "output") {
      const run = findRun(service, ctx, text(input.runId));
      const nodeId = text(input.nodeId);
      const node = nodeId ? run.nodes.find((entry) => entry.id === nodeId) : undefined;
      if (!node) throw fail(`output needs a nodeId; this run has: ${run.nodes.map((entry) => entry.id).join(", ")}`);
      const report = node.output?.trim();
      if (!report) return { output: `Unit ${node.id} (${node.role}) is ${node.status} and has no report yet.` };
      const limit = Math.max(200, Math.min(OUTPUT_MAX, Number.isInteger(input.maxChars) ? Number(input.maxChars) : OUTPUT_DEFAULT));
      const shown = report.length > limit ? `[The first ${report.length - limit} characters are omitted; raise maxChars or read chat ${node.sessionId ?? "of the unit"}.]\n${report.slice(-limit)}` : report;
      return { output: `Report of ${node.id} (${node.role}), ${node.status}${(node.round ?? 1) > 1 ? `, round ${node.round}` : ""}:\n${shown}` };
    }

    writable(space);
    if (action === "run") {
      const found = findTemplate(service, ctx.projectId, text(input.workflowId) ?? "");
      const task = text(input.input);
      if (!task) throw fail("run needs an input: the task, what counts as done, constraints and the check to run");
      const facts = Array.isArray(input.facts) ? input.facts.filter((fact): fact is string => typeof fact === "string" && fact.trim().length > 0) : [];
      const parentHarness: HarnessSelection | undefined = parent.resolvedHarnessId
        ? { mode: "pinned", harnessId: parent.resolvedHarnessId }
        : parent.harness;
      const launch: WorkflowLaunchOptionsDto = {
        ...(parent.model ? { model: parent.model } : {}),
        ...(parentHarness ? { harness: parentHarness } : {}),
        ...(parent.agent ? { agent: parent.agent } : {}),
        context: input.context === "recent" ? "recent" : "request",
        ...(facts.length ? { facts } : {}),
        ...(input.wake === false ? {} : { wake: true }),
      };
      // Units inherit this chat's approval level. An agent never starts a run
      // that approves more than the chat it works in.
      const options: WorkflowRunOptionsDto = {
        permissions: "manual",
        ...(Number.isInteger(input.reviewRounds) ? { reviewRounds: Number(input.reviewRounds) } : {}),
        ...(Number.isInteger(input.maxParallel) ? { maxParallel: Math.min(6, Number(input.maxParallel)) } : {}),
      };
      const run = await service.start(found.id, ctx.sessionId, task, options, launch, launchedBy);
      return {
        output: [
          `Started “${run.name}” as run ${run.id} with ${run.nodes.length} unit${run.nodes.length === 1 ? "" : "s"}: ${run.nodes.map((node) => node.id).join(", ")}.`,
          run.wake
            ? "End your turn now; do not poll. This chat is woken when the run settles or waits for you."
            : `Nothing wakes this chat for this run; read it with action "status".`,
        ].join("\n"),
        metadata: { runId: run.id },
      };
    }
    const run = findRun(service, ctx, text(input.runId));
    if (action === "stop") {
      const stopped = await service.stop(run.id, { quiet: true });
      return { output: `Run ${stopped.id} is ${stopped.status}.` };
    }
    if (action === "retry") {
      const nodeId = text(input.nodeId) ?? run.nodes.find((node) => node.needsFix)?.id;
      if (!nodeId) throw fail(`retry needs a nodeId; this run has: ${run.nodes.map((node) => `${node.id} (${node.status})`).join(", ")}`);
      const model = modelOf(input.model);
      const harnessId = text(input.harnessId);
      const replacement: WorkflowNodeRoute = {
        ...(harnessId ? { harness: { mode: "pinned", harnessId } } : {}),
        ...(model ? { model } : {}),
      };
      const next = await service.retry(run.id, nodeId, undefined, Object.keys(replacement).length ? replacement : undefined, launchedBy);
      return {
        output: next.id === run.id
          ? `Unit ${nodeId} continues in run ${run.id}.`
          : `Run ${run.id} had settled, so unit ${nodeId} restarts in a new run ${next.id}.`,
        metadata: { runId: next.id },
      };
    }
    // outcome
    const said = text(input.value)?.toLowerCase() ?? "";
    // The three values, however the verb was conjugated ("accept", "rework").
    const value = said.startsWith("accept") ? "accepted" : said.startsWith("rework") ? "reworked" : said.startsWith("discard") ? "discarded" : said;
    const recorded = await service.recordOutcome(
      run.id,
      { value: value as never, ...(typeof input.note === "string" ? { note: input.note } : {}) },
      launchedBy,
      "agent"
    );
    return { output: `Recorded: run ${recorded.id} was ${recorded.outcome?.value}.` };
  };

  const manageTool = async (input: JsonObject, ctx: ToolExecutionContext): Promise<{ output: string; metadata?: JsonObject }> => {
    const action = input.action as ManageAction;
    if (!MANAGE_ACTIONS.includes(action)) throw fail(`action must be one of ${MANAGE_ACTIONS.join(", ")}`);
    const { space, launchedBy } = scope(ctx, WORKFLOW_MANAGE_TOOL_NAME);
    writable(space);
    const service = await deps.service(space);
    await callerChat(space, ctx);

    if (action === "decide") {
      const run = findRun(service, ctx, text(input.runId));
      const nodeId = text(input.nodeId) ?? run.nodes.find((node) => node.needsDecision)?.id;
      if (!nodeId) throw fail("no review unit of this run waits for a decision");
      const decision = input.decision === "accept" || input.decision === "another-round" ? input.decision : undefined;
      if (!decision) throw fail("decision must be accept or another-round");
      await service.decide(run.id, { nodeId, action: decision, ...(typeof input.note === "string" && input.note.trim() ? { note: input.note } : {}) }, launchedBy);
      return { output: decision === "accept" ? `Accepted the work of run ${run.id} with its open blockers; the run moves on.` : `Run ${run.id} gets one more rework round at ${nodeId}.` };
    }
    // An agent never saves a template whose units approve more than the chat
    // that runs it.
    const defaultsOf = (base?: WorkflowRunOptionsDto): WorkflowRunOptionsDto => ({
      ...(base ?? {}),
      permissions: "manual",
      ...(Number.isInteger(input.reviewRounds) ? { reviewRounds: Number(input.reviewRounds) } : {}),
      ...(Number.isInteger(input.maxParallel) ? { maxParallel: Math.min(6, Number(input.maxParallel)) } : {}),
    });
    if (action === "create") {
      const base = text(input.copyOf) ? findTemplate(service, ctx.projectId, text(input.copyOf)!) : undefined;
      const graph = input.nodes !== undefined ? nodesOf(input.nodes) : base ? { nodes: base.nodes, edges: base.edges } : undefined;
      if (!graph) throw fail("create needs nodes, or copyOf naming a template to start from");
      const name = text(input.name) ?? (base ? `${base.name} (copy)` : undefined);
      if (!name) throw fail("create needs a name");
      const created = service.create({
        projectId: ctx.projectId,
        name,
        ...(text(input.description) ?? base?.description ? { description: text(input.description) ?? base!.description! } : {}),
        ...(base?.category ? { category: base.category } : {}),
        nodes: graph.nodes,
        edges: graph.edges,
        defaults: defaultsOf(base?.defaults),
      });
      return { output: `Saved template “${created.name}” as ${created.id} (${topologySummary(created)}).`, metadata: { workflowId: created.id } };
    }
    const reference = text(input.workflowId);
    const current = reference ? service.get(reference) : null;
    if (!current || current.projectId !== ctx.projectId)
      throw fail(`${action} needs the id of a saved template of this project; bundled templates are read-only (copy one with action "create" and copyOf).`, "not-found");
    if (action === "delete") {
      service.remove(current.id);
      return { output: `Deleted template “${current.name}” (${current.id}).` };
    }
    const graph = input.nodes !== undefined ? nodesOf(input.nodes) : undefined;
    const updated = service.update(current.id, {
      ...(text(input.name) ? { name: text(input.name)! } : {}),
      ...(text(input.description) ? { description: text(input.description)! } : {}),
      ...(graph ? { nodes: graph.nodes, edges: graph.edges } : {}),
      defaults: defaultsOf(current.defaults),
      ...(Number.isInteger(input.expectedRevision) ? { expectedRevision: Number(input.expectedRevision) } : {}),
    });
    return { output: `Updated template “${updated.name}” (${updated.id}), now revision ${updated.revision ?? 0} (${topologySummary(updated)}).` };
  };

  return {
    run: {
      descriptor: {
        id: WORKFLOW_TOOL_ID,
        kind: "tool",
        owner: WORKFLOW_PACKAGE_ID,
        scope: "deployment",
        revision: "1",
        name: WORKFLOW_TOOL_NAME,
        description: "Run and steer workflow templates (builder → reviewer, lead → workers → review) on this chat. templates: list. template: one definition. run: start one with a task and located facts, then end your turn; the chat is woken when the run settles or waits. runs, status: this chat's runs. output: one unit's report. stop. retry: continue a held or failed unit, optionally on another route. outcome: record how the result was used. stats: outcomes per template.",
        inputSchema: runSchema,
        trust: "workspace",
        mutating: true,
      },
      // Starting and stopping units of the chat's own project is the same
      // authority the chat already has over delegated children, and every
      // unit runs at the chat's own approval level.
      autoApprove: () => true,
      execute: runTool,
    },
    manage: {
      descriptor: {
        id: WORKFLOW_MANAGE_TOOL_ID,
        kind: "tool",
        owner: WORKFLOW_PACKAGE_ID,
        scope: "deployment",
        revision: "1",
        name: WORKFLOW_MANAGE_TOOL_NAME,
        description: "Create, update or delete this project's workflow templates, and decide a review gate a run holds after its rework rounds (accept, or another round). Follows the chat's approval setting.",
        inputSchema: manageSchema,
        trust: "workspace",
        mutating: true,
      },
      // No autoApprove: templates are shared and a held gate waits for a
      // person, so each call goes through the chat's permission flow.
      execute: manageTool,
    },
  };
}
