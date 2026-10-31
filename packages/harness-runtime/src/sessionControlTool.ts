import type {
  AgentCapabilityContributionRegistry,
  DelegatedIsolationDto,
  HarnessContext,
  HarnessSelection,
  JsonObject,
  ModelRef,
  Project,
  SessionProjection,
  SpaceContext,
  ToolExecutionContext,
} from "@polyth/contracts";
import { isolationBlocksUserMutation } from "@polyth/contracts";
import {
  SERVER_MODEL_ROUTING,
  SERVER_SESSION_ISOLATION,
  SERVER_SESSION_WATCHES,
  serverServiceKey,
  type ServerDelegatedSessionCreated,
  type ServerPackageHost,
  type ServerSessionWatchDto,
  type ServerSessionWatchReason,
} from "@polyth/plugins";
import type { ContextualCapabilityContribution } from "./contextualCapabilities.ts";
import { delegationRunning, publicDelegation } from "./delegationMerge.ts";

const SESSION_TITLE_MAX = 120;
const SESSION_MESSAGE_LIMIT = 100;
const SESSION_DEBUG_EVENT_LIMIT = 50;
const ACTIONS = [
  "project.list",
  "agent.list",
  "agent.models",
  "agent.spawn",
  "agent.merge",
  "agent.discard",
  "agent.resolve",
  "session.list",
  "session.create",
  "session.get",
  "session.messages",
  "session.debug",
  "session.send",
  "session.cancel",
  "session.archive",
  "session.restore",
  "session.fork",
  "session.isolate",
  "session.switchHarness",
  "session.watch",
  "session.watches",
  "session.unwatch",
  "permission.reply",
] as const;
type Action = typeof ACTIONS[number];
// "normal" stays accepted for older callers; for a send it behaves as queue.
const SEND_DELIVERIES = ["queue", "interrupt", "steer"] as const;
type SendDelivery = typeof SEND_DELIVERIES[number];
const SEND_OUTCOME_NOTES = {
  started: "The chat was idle; your message started a turn.",
  queued: "Your message waits in the chat's queue and runs after the current turn and any messages queued before it.",
  interrupting: "The chat's running turn was asked to stop; your message runs next.",
  steered: "Your message was added to the chat's running turn.",
} as const;

const DESCRIPTION =
  "Control canonical Polyth sessions regardless of which harness runs them. "
  + "Polyth owns delegation: never use a harness-native Agent, Task, task, agent, invoke_subagent, or equivalent spawn surface. Use agent.spawn instead. "
  + "Before agent.spawn, call agent.models once: a few lines ranking the user's favorite and most-used harness/model pairs, named as each harness's live model catalog lists them, with live quota headroom; pass the chosen row's harnessId and model to agent.spawn exactly. "
  + "agent.spawn always creates a canonical child Session of the calling Session, so every delegated worker has a durable parentId and appears as a Polyth sub-session. "
  + "Choose each child's workspace with parameters.isolation: shared (default) runs it in your checkout, where it sees your uncommitted files; isolated gives it its own git worktree branched from your last commit, so parallel or risky edits cannot collide. "
  + "Isolated work reaches your checkout only through agent.merge (agent.resolve for conflicts, agent.discard to drop it on purpose); merge or discard every isolated child before you finish. "
  + "Inside the current project, session orchestration is autonomous: spawn, create, inspect, debug, message, cancel, archive, fork, and switch harnesses without a Polyth orchestration approval on every call. "
  + "project.list discovers every project in the current authorized Space. Set parameters.projectId to target another project; Polyth protects that cross-project boundary with a target-specific approval that can be allowed once, for the session, or always for this source project. "
  + "session.isolate moves an existing chat at rest (never your own running session) into its own git worktree branched from the last commit of the checkout it works in; its uncommitted files stay behind, and its work returns there through agent.merge (for your own child) or the chat's isolation card. "
  + "Use session.watch for event-driven cross-session completion signals instead of polling; session.watches/session.unwatch inspect or remove them. "
  + "session.send messages another chat; parameters.delivery picks how it lands while that chat is busy: queue (default) waits for its current turn, interrupt stops that turn and runs your message next, steer adds it to the running turn. An idle chat starts at once in every mode. "
  + "Use session.debug for the bounded, redacted troubleshooting surface. "
  + "When the user delegates a subagent's permission request to you, you are woken with its details; decide with permission.reply (reply once or reject). Without that delegation, approving stays the user's decision.";

// Deployment skill: always available in any project/Space, not a managed project skill.
// Design/debug skills remain opt-in; this only covers core session/subagent orchestration.
// Future per-user customization can replace this deployment text with a Space-scoped override.
export const polythDelegationPolicy = {
  descriptor: {
    id: "harness-runtime.polyth-delegation-policy",
    kind: "instruction" as const,
    owner: "harness-runtime",
    scope: "deployment" as const,
    revision: "3",
    title: "Polyth-owned delegation",
    text: "Delegation is owned by Polyth. Never use harness-native Agent, Task, task, agent, invoke_subagent, or equivalent subagent/spawn tools. When work should be delegated, use the Polyth control tool with action agent.spawn. Every delegated worker must be a canonical Polyth child Session with parentId set by Polyth. For asynchronous work, use agent.spawn with watchCaller=true or session.watch so completion is event-driven; do not poll session status in a loop. Use session.send, session.messages, session.debug, and polyth_peer to coordinate those child sessions. Choose each child's workspace deliberately with agent.spawn isolation: shared (default) when it only reads, makes a small sequential edit, or must see your uncommitted files; isolated for parallel or risky code changes, which get their own git worktree branched from your last commit. You own integration: review every isolated child's result and bring it into your checkout with agent.merge (agent.resolve for conflicts, agent.discard only to drop work on purpose) before you finish. Polyth reminds you about unmerged isolated work and refuses to merge or discard your own isolated workspace while delegated work still targets it.",
  },
} satisfies import("@polyth/contracts").AgentCapabilityContribution;

export const polythSessionsSkill = {
  descriptor: {
    id: "harness-runtime.skill.polyth-sessions",
    kind: "skill" as const,
    owner: "harness-runtime",
    scope: "deployment" as const,
    revision: "8",
    name: "polyth-sessions",
    title: "Polyth sessions",
    description: "Orchestrate Polyth sessions and delegated subagents in any project.",
    instructions: `Use the available polyth tool (its harness may prefix the name) to work with canonical Polyth sessions. This is a Polyth product capability — available in every project and not dependent on project-specific skill installs.
${DESCRIPTION}
For delegated/subagent work, always use agent.spawn (title + optional prompt/harness). To choose the worker, call agent.models first — one cheap call returning ranked lines "N. ★ <harness> <provider>/<model> (<what an alias runs>) · <turns>t/<sessions>s · quota NN%" plus one quota line per source. Models are named as each harness's live catalog lists them (Claude Code takes alias rows such as anthropic/opus, not the concrete claude-… id it reports), and models a harness no longer offers are left out; skip BLOCKED/UNAVAILABLE rows, prefer favorites with headroom, match model strength to the task, and pass harnessId plus model {providerID, modelID} exactly as listed — never an id from memory or another harness. Optional parameters: harnessId (one harness), limit (rows, default 12), windowDays (default 30). Never invoke a harness-native Agent, Task, task, agent, invoke_subagent, or equivalent delegation tool. agent.spawn creates a canonical child Polyth Session with parentId set to the calling Session, so nested delegation remains a real session tree. Drive children with session.send / session.debug / session.messages. For asynchronous delegation, prefer agent.spawn with watchCaller=true so the calling session is woken exactly once when the child completes, fails, or aborts (a person pausing it also wakes you, as "paused", and the watch stays armed until it ends; only that person can continue it); use session.watch for other event-driven links and never poll session.get in a loop. Keep delegated work bounded and report findings via the peer observation skill instead of copying full transcripts. Respect cross-project approvals and Space isolation; never assume access to another project without an explicit grant.
Messaging another chat (session.send with sessionId + text) — pick parameters.delivery by urgency:
- queue (default): the chat finishes what it is doing first; your message waits behind its current turn and anything queued before it. Use it for ordinary follow-ups, answers and new work.
- interrupt: stop the chat's running turn now and run your message next. Use it when the running work is wrong, obsolete or blocking you. Partial work from the stopped turn stays in history.
- steer: add the message to the running turn without stopping it, for a mid-course correction; a harness that cannot steer stops the turn instead.
An idle chat starts your message at once in every mode. The result's outcome says what happened (started, queued, interrupting or steered). Interrupt and steer cannot target your own session.
Workspace choice (agent.spawn parameters.isolation), decided per child:
- shared (default): the child runs in your checkout, sees your uncommitted edits and writes straight into them. Use it for read-only exploration and review, small sequential edits, or work that needs your uncommitted files.
- isolated: the child gets its own git worktree on a polyth/isolate branch made from your last commit (commit first if it needs your edits). Use it for parallel implementers that could touch the same files, risky or experimental changes, and work you may want to throw away. The spawn result names the worktree and merge target; an isolated child wakes you when it terminates unless watchCaller=false.
Integration is your job, never optional:
- agent.list shows every isolated child's state and whether it still holds unmerged work.
- agent.merge (sessionId) squashes the child's work into your checkout as one commit and releases its worktree; a child without changes is just released. Review its result first (session.messages, or git in its worktree).
- Commit your own overlapping edits before merging: agent.merge refuses to mix the child's changes into uncommitted edits of the same files.
- A conflict leaves the child isolated: call agent.resolve to have it merge your latest work and fix the conflicts (you are woken when it finishes), then agent.merge again.
- agent.discard (sessionId) drops an isolated child's work on purpose; pass force=true when it still has changes.
- session.isolate (sessionId) moves an existing chat into isolation after the fact — typically a shared child you now want to keep apart before parallel or risky edits. The chat must be at rest (not running, not archived, not already isolated) and cannot be your own running session. Its worktree starts from the last commit of the checkout it worked in and does not take that checkout's uncommitted files (the result counts them). A child of yours that worked in your checkout becomes an isolated child: integrate it with agent.merge like any other. Any other chat returns its work through its own isolation card.
- Never finish with isolated children unmerged. Polyth reminds you when your turn ends while their work is pending, refuses to archive them through this tool, and refuses to merge or discard your own isolated workspace until every child targeting it is merged or discarded.`,
  },
} satisfies import("@polyth/contracts").AgentCapabilityContribution;

const inputSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { type: "string", enum: [...ACTIONS] },
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: {
          type: "string",
          description: "Target project id. Omit for the current project. A different project requires Polyth approval before the action runs.",
        },
        sessionId: { type: "string", description: "Canonical Polyth session id." },
        title: {
          type: "string",
          minLength: 1,
          maxLength: SESSION_TITLE_MAX,
          description: "Concise human-readable title for a session or delegated agent; never paste the full prompt.",
        },
        prompt: { type: "string", description: "Optional first prompt for session.create or agent.spawn." },
        text: { type: "string", description: "Prompt to send with session.send." },
        harnessId: {
          type: "string",
          description: "Registered harness id, or 'auto'. Omit on create to use Polyth Auto selection.",
        },
        timing: { type: "string", enum: ["after-turn", "stop-now"] },
        delivery: {
          type: "string",
          enum: [...SEND_DELIVERIES],
          description: "session.send while the target is busy. queue (default): wait for its current turn to finish. interrupt: stop that turn now and run this message next. steer: add it to the running turn without stopping it (harnesses that cannot steer stop the turn instead). An idle target starts the message at once.",
        },
        agent: { type: "string" },
        model: {
          type: "object",
          additionalProperties: false,
          required: ["providerID", "modelID"],
          properties: {
            providerID: { type: "string" },
            modelID: { type: "string" },
            variant: { type: "string" },
          },
        },
        atSeq: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1, maximum: SESSION_MESSAGE_LIMIT },
        windowDays: { type: "integer", minimum: 1, maximum: 365, description: "agent.models usage window; default 30." },
        worktreePath: {
          type: "string",
          description: "Optional worktree path for session.create or agent.spawn. Omit to inherit from the parent session.",
        },
        isolation: {
          type: "string",
          enum: ["shared", "isolated"],
          description: "agent.spawn workspace. shared (default): the child works in your checkout. isolated: its own git worktree from your last commit; merge it back with agent.merge.",
        },
        force: {
          type: "boolean",
          description: "agent.discard: also drop an isolated child's unmerged changes.",
        },
        targetSessionId: {
          type: "string",
          description: "Receiving session for a watch. Defaults to the calling session.",
        },
        watchId: { type: "string", description: "Durable session watch id." },
        requestId: { type: "string", description: "Permission request id for permission.reply." },
        reply: {
          type: "string",
          enum: ["once", "reject"],
          description: "permission.reply decision: allow once, or reject.",
        },
        events: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", enum: ["completed", "error", "aborted", "paused"] },
        },
        watchDelivery: { type: "string", enum: ["observe", "wake"] },
        once: { type: "boolean" },
        watchCaller: {
          type: "boolean",
          description: "For agent.spawn, wake the calling session once when the child terminates.",
        },
      },
    },
  },
  allOf: [
    {
      if: { properties: { action: { enum: ["session.create", "agent.spawn"] } }, required: ["action"] },
      then: {
        required: ["parameters"],
        properties: { parameters: { required: ["title"] } },
      },
    },
    {
      if: { properties: { action: { enum: [
        "session.get", "session.messages", "session.debug", "session.send", "session.cancel", "session.archive",
        "session.restore", "session.fork", "session.isolate", "session.switchHarness", "session.watch", "permission.reply",
        "agent.merge", "agent.discard", "agent.resolve",
      ] } }, required: ["action"] },
      then: {
        required: ["parameters"],
        properties: { parameters: { required: ["sessionId"] } },
      },
    },
    {
      if: { properties: { action: { const: "permission.reply" } }, required: ["action"] },
      then: {
        required: ["parameters"],
        properties: { parameters: { required: ["sessionId", "requestId", "reply"] } },
      },
    },
    {
      if: { properties: { action: { const: "session.unwatch" } }, required: ["action"] },
      then: {
        required: ["parameters"],
        properties: { parameters: { required: ["watchId"] } },
      },
    },
  ],
};

const invalid = (message: string): never => {
  throw Object.assign(new Error(message), { code: "invalid-input" });
};

const notFound = (message: string): never => {
  throw Object.assign(new Error(message), { code: "not-found" });
};

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const title = (value: unknown): string => {
  if (typeof value !== "string") return invalid("title is required");
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return invalid("title is required");
  if (normalized.length > SESSION_TITLE_MAX) return invalid(`title must be ${SESSION_TITLE_MAX} characters or fewer`);
  return normalized;
};

const model = (value: unknown): ModelRef | undefined => {
  if (value === undefined) return undefined;
  const input = object(value);
  const providerID = text(input.providerID);
  const modelID = text(input.modelID);
  if (!providerID || !modelID) return invalid("model requires providerID and modelID");
  const variant = text(input.variant);
  return { providerID, modelID, ...(variant ? { variant } : {}) };
};

const harness = (value: unknown, required = false): HarnessSelection | undefined => {
  const harnessId = text(value);
  if (!harnessId) {
    if (required) return invalid("harnessId is required for session.switchHarness");
    return undefined;
  }
  if (harnessId === "auto") return { mode: "auto" };
  if (!/^[a-z][a-z0-9-]*$/.test(harnessId)) return invalid("harnessId must be 'auto' or a registered harness id");
  return { mode: "pinned", harnessId };
};

const workspaceMode = (value: unknown): "shared" | "isolated" => {
  if (value === undefined || value === "shared") return "shared";
  if (value === "isolated") return "isolated";
  return invalid("isolation must be shared or isolated");
};

const boundedLimit = (value: unknown, fallback: number, max: number): number => {
  if (value === undefined) return fallback;
  const requested = Number(value);
  return Number.isSafeInteger(requested) && requested >= 1 && requested <= max ? requested : fallback;
};

const contextKey = (spaceId: string, projectId: string): string => `${spaceId}\u0000${projectId}`;

const publicProject = (project: Project): JsonObject => ({
  id: project.id,
  name: project.name,
  path: project.path,
  remote: Boolean(project.remote),
});

const publicSession = (session: SessionProjection): JsonObject => ({
  id: session.id,
  projectId: session.projectId,
  title: session.title,
  status: session.status,
  parentId: session.parentId ?? null,
  harness: session.harness ?? null,
  resolvedHarnessId: session.resolvedHarnessId ?? null,
  model: session.model ? { ...session.model } : null,
  agent: session.agent ?? null,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  // A person paused it: idle, but its work is not over.
  ...(session.paused ? { paused: true } : {}),
});

const diagnosticEvent = (type: string): boolean =>
  type === "turn/failed"
  || type === "turn/stopped"
  || type === "tool/error"
  || type === "permission/requested"
  || type === "permission/resolved"
  || type === "question/asked"
  || type === "question/answered"
  || type === "secret/requested"
  || type === "secret/resolved"
  || type.includes("runtime")
  || type.includes("harness")
  || type.includes("queue")
  || type.includes("mutation")
  || type.endsWith("/failed");

export function registerPolythSessionControl(
  host: ServerPackageHost,
  options: { delegations?: { noteDelegation(parentSessionId: string): void } } = {},
) {
  const spaces = new Map<string, SpaceContext>();
  const registry = host.services.require(
    serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"),
  );
  const descriptor = {
    id: "harness-runtime.polyth-control",
    kind: "tool" as const,
    owner: "harness-runtime",
    scope: "project" as const,
    revision: "9",
    name: "polyth",
    description: DESCRIPTION,
    inputSchema,
    // This truthfully describes the tool's effects. Authorization policy is
    // intentionally separate: the bridge auto-allows this capability inside
    // its source project and gates only explicit cross-project targets.
    trust: "device" as const,
    mutating: true,
  };

  const contribution: ContextualCapabilityContribution = {
    descriptor,
    resolveCapabilities(context: HarnessContext) {
      if (!context.space || context.projectId === "__default__") return [];
      spaces.set(contextKey(context.spaceId, context.projectId), context.space);
      return [descriptor];
    },
    async execute(input: JsonObject, ctx: ToolExecutionContext): Promise<{ output: string; metadata?: JsonObject }> {
      const provisioned = ctx.spaceId ? spaces.get(contextKey(ctx.spaceId, ctx.projectId)) : undefined;
      if (!provisioned) throw Object.assign(new Error("Polyth session control is unavailable outside an authenticated Space/project context"), { code: "forbidden" });
      // An agent acts for the person who sent the turn it answers: it sees and
      // changes only the chats that person can (Spaces §14.3). A person who
      // has left the Space lends it nothing. Turns no person started keep the
      // context the tool was provisioned with.
      let space = provisioned;
      if (ctx.actorUserId && host.personSpaceContext) {
        const person = host.personSpaceContext(ctx.actorUserId, provisioned.spaceId);
        if (!person) {
          throw Object.assign(new Error("The person this chat acts for is no longer a member of this Space"), { code: "forbidden" });
        }
        space = person;
      }
      const scoped = host.forSpace(space);
      const action = text(input.action) as Action | undefined;
      if (!action || !ACTIONS.includes(action)) return invalid(`Unsupported Polyth action: ${action ?? "missing"}`);
      const parameters = object(input.parameters);
      const watchService = () => host.services.require(SERVER_SESSION_WATCHES);
      const isolationService = () => {
        const service = host.services.get(SERVER_SESSION_ISOLATION);
        if (!service) {
          throw Object.assign(new Error("isolated delegation is unavailable: the Git package is not enabled"), { code: "unsupported" });
        }
        return service;
      };
      if (parameters.isolation !== undefined && action !== "agent.spawn") {
        return invalid("isolation applies only to agent.spawn");
      }

      if (action === "agent.models") {
        const routing = host.services.get(SERVER_MODEL_ROUTING);
        if (!routing) {
          return {
            output: "Model routing is unavailable: the Usage package is disabled. Choose from the user's favorites, or omit model on agent.spawn for Polyth Auto.",
            metadata: { action },
          };
        }
        const harnessId = harness(parameters.harnessId);
        const report = await routing.candidates(space, {
          ...(parameters.limit !== undefined ? { limit: boundedLimit(parameters.limit, 12, 50) } : {}),
          ...(parameters.windowDays !== undefined ? { windowDays: boundedLimit(parameters.windowDays, 30, 365) } : {}),
          ...(harnessId?.mode === "pinned" ? { harnessId: harnessId.harnessId } : {}),
        });
        return {
          output: report.text,
          metadata: { action, candidates: report.candidates.length, omitted: report.omitted, unlisted: report.unlisted },
        };
      }

      if (action === "project.list") {
        const projects = (await scoped.projects.list()).map(publicProject);
        return { output: JSON.stringify({ currentProjectId: ctx.projectId, projects }), metadata: { action } };
      }

      if ((action === "agent.spawn" || action === "agent.list") && !ctx.sessionId) {
        return invalid(`${action} requires a calling Polyth session`);
      }
      if ((action === "agent.spawn" || action === "agent.list")
        && text(parameters.projectId) && text(parameters.projectId) !== ctx.projectId) {
        return invalid(`${action} cannot cross project boundaries`);
      }
      const targetProjectId = action === "agent.spawn" || action === "agent.list"
        ? ctx.projectId
        : text(parameters.projectId) ?? ctx.projectId;
      const targetProject = await scoped.projects.get(targetProjectId);
      if (!targetProject) return notFound("project not found in the current Space");

      const targetSession = async (): Promise<SessionProjection> => {
        const sessionId = text(parameters.sessionId);
        if (!sessionId) return invalid("sessionId is required");
        const session = await scoped.sessions.snapshot(sessionId);
        if (session.projectId !== targetProjectId) {
          return notFound("session does not belong to the requested project");
        }
        return session;
      };

      if (action === "session.list" || action === "agent.list") {
        const rows = (await scoped.sessions.list(targetProjectId))
          .filter((session) => session.projectId === targetProjectId)
          .filter((session) => action !== "agent.list" || session.parentId === ctx.sessionId)
          .sort((a, b) => b.updatedAt - a.updatedAt);
        if (action === "session.list") {
          return {
            output: JSON.stringify({ project: publicProject(targetProject), sessions: rows.map(publicSession) }),
            metadata: { action, projectId: targetProjectId },
          };
        }
        // Isolated children carry their merge duty; shared children already
        // write into the caller's checkout.
        const delegated = new Map((await host.services.get(SERVER_SESSION_ISOLATION)?.delegatedChildren(ctx.sessionId!) ?? [])
          .map((child) => [child.sessionId, child] as const));
        const agents = rows.map((session) => {
          const child = delegated.get(session.id);
          return { ...publicSession(session), workspace: child ? publicDelegation(child) : { mode: "shared" } };
        });
        return {
          output: JSON.stringify({
            project: publicProject(targetProject),
            parentSessionId: ctx.sessionId ?? null,
            agents,
            unmergedIsolatedAgents: delegated.size,
          }),
          metadata: { action, projectId: targetProjectId },
        };
      }

      if (action === "session.create" || action === "agent.spawn") {
        const sessionTitle = title(parameters.title);
        const selection = harness(parameters.harnessId);
        const selectedModel = model(parameters.model);
        const agent = text(parameters.agent);
        const requestedWorktreePath = text(parameters.worktreePath);
        const mode = workspaceMode(parameters.isolation);
        if (mode === "isolated" && requestedWorktreePath) {
          return invalid("worktreePath cannot be combined with isolation=isolated: an isolated agent gets its own worktree");
        }
        const parentId = action === "agent.spawn"
          ? ctx.sessionId!
          : targetProjectId === ctx.projectId && ctx.sessionId ? ctx.sessionId : undefined;
        let delegated: ServerDelegatedSessionCreated | undefined;
        if (mode === "isolated") {
          const isolation = isolationService();
          // The caller's own canonical session proves the Space; the child
          // is created in the caller's project from the caller's checkout.
          const caller = await scoped.sessions.snapshot(ctx.sessionId!);
          if (caller.projectId !== targetProjectId) return invalid("agent.spawn cannot cross project boundaries");
          delegated = await isolation.createDelegatedSession({
            parentSessionId: caller.id,
            title: sessionTitle,
            ...(selection ? { harness: selection } : {}),
            ...(selectedModel ? { model: selectedModel } : {}),
            ...(agent ? { agent } : {}),
          });
          options.delegations?.noteDelegation(caller.id);
        }
        const ref = delegated ? { id: delegated.id } : await scoped.sessions.create({
          projectId: targetProjectId,
          title: sessionTitle,
          ...(parentId ? { parentId } : {}),
          ...(selection ? { harness: selection } : {}),
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(agent ? { agent } : {}),
          ...(requestedWorktreePath ? { worktreePath: requestedWorktreePath } : {}),
        });
        const prompt = typeof parameters.prompt === "string" ? parameters.prompt : undefined;
        // An isolated child's result is unusable until merged, so its
        // delegator is woken by default when it terminates.
        const watchCaller = action === "agent.spawn"
          && (parameters.watchCaller === true || (delegated !== undefined && parameters.watchCaller !== false));
        let spawnWatch: ServerSessionWatchDto | undefined;
        if (watchCaller) {
          spawnWatch = await watchService().create(space, {
            sourceSessionId: ref.id,
            targetSessionId: ctx.sessionId!,
            events: ["completed", "error", "aborted"],
            delivery: "wake",
            once: true,
          });
        }
        let sendResult: unknown;
        if (prompt !== undefined) {
          // A failed acknowledgement does not prove the child was not admitted.
          // Preserve its durable watch so a later terminal event still reaches
          // the caller; explicit unwatch/session deletion owns cleanup.
          sendResult = await scoped.sessions.send(ref.id, {
            text: prompt,
            ...(selectedModel ? { model: selectedModel } : {}),
            ...(agent ? { agent } : {}),
          });
        }
        return {
          output: JSON.stringify({
            session: publicSession(await scoped.sessions.snapshot(ref.id)),
            ...(delegated ? {
              workspace: {
                mode: "isolated",
                worktreePath: delegated.isolation.worktreePath,
                branch: delegated.isolation.worktreeBranch,
                mergeTarget: delegated.isolation.targetBranch,
                baseCommit: delegated.isolation.baseCommit,
                ...(delegated.originUncommitted ? { yourUncommittedFiles: delegated.originUncommitted } : {}),
              },
              next: [
                "This agent works in its own isolated worktree. Its changes reach your checkout only when you call agent.merge with its sessionId (agent.discard drops them).",
                ...(delegated.originUncommitted
                  ? [`It starts from your last commit and does not see your ${delegated.originUncommitted} uncommitted file(s); commit and spawn again if it needs them.`]
                  : []),
              ].join(" "),
            } : {}),
            ...(spawnWatch ? { watch: spawnWatch } : {}),
            ...(sendResult !== undefined ? { sendResult } : {}),
          }),
          metadata: {
            action,
            projectId: targetProjectId,
            ...(parentId ? { parentSessionId: parentId } : {}),
            ...(action === "agent.spawn" ? { childSessionId: ref.id, childTitle: sessionTitle } : {}),
            ...(delegated ? { isolation: "isolated" } : {}),
          },
        };
      }

      if (action === "session.watch") {
        if (!ctx.sessionId) return invalid("session.watch requires a calling Polyth session");
        const source = await targetSession();
        const targetSessionId = text(parameters.targetSessionId) ?? ctx.sessionId;
        const target = await scoped.sessions.snapshot(targetSessionId);
        if (target.projectId !== ctx.projectId) {
          return invalid("watch target must belong to the calling project");
        }
        const requestedEvents = parameters.events === undefined
          ? undefined
          : Array.isArray(parameters.events)
            ? parameters.events.map(String) as ServerSessionWatchReason[]
            : invalid("events must be an array");
        const delivery = text(parameters.watchDelivery);
        if (delivery && delivery !== "observe" && delivery !== "wake") {
          return invalid("watchDelivery must be observe or wake");
        }
        if (parameters.once !== undefined && typeof parameters.once !== "boolean") {
          return invalid("once must be boolean");
        }
        const watch = await watchService().create(space, {
          sourceSessionId: source.id,
          targetSessionId: target.id,
          ...(requestedEvents ? { events: requestedEvents } : {}),
          ...(delivery ? { delivery: delivery as "observe" | "wake" } : {}),
          ...(typeof parameters.once === "boolean" ? { once: parameters.once } : {}),
        });
        return {
          output: JSON.stringify({ watch }),
          metadata: { action, projectId: source.projectId, targetSessionId: target.id },
        };
      }
      if (action === "session.watches") {
        if (!ctx.sessionId) return invalid("session.watches requires a calling Polyth session");
        const sourceSessionId = text(parameters.sessionId);
        let source: SessionProjection | undefined;
        if (sourceSessionId) {
          source = await scoped.sessions.snapshot(sourceSessionId);
          if (source.projectId !== targetProjectId) {
            return notFound("watch source does not belong to the requested project");
          }
        }
        const targetSessionId = text(parameters.targetSessionId) ?? ctx.sessionId;
        const target = await scoped.sessions.snapshot(targetSessionId);
        if (target.projectId !== ctx.projectId) {
          return invalid("watch target must belong to the calling project");
        }
        const watches = await watchService().list(space, {
          ...(source ? { sourceSessionId: source.id } : {}),
          targetSessionId: target.id,
        });
        return {
          output: JSON.stringify({
            sourceSessionId: source?.id ?? null,
            targetSessionId: target.id,
            watches,
          }),
          metadata: { action, projectId: target.projectId, targetSessionId: target.id },
        };
      }
      if (action === "session.unwatch") {
        if (!ctx.sessionId) return invalid("session.unwatch requires a calling Polyth session");
        const targetSessionId = text(parameters.targetSessionId) ?? ctx.sessionId;
        const target = await scoped.sessions.snapshot(targetSessionId);
        if (target.projectId !== ctx.projectId) {
          return invalid("watch target must belong to the calling project");
        }
        const watchId = text(parameters.watchId);
        if (!watchId) return invalid("watchId is required");
        const removed = await watchService().remove(space, watchId, target.id);
        return {
          output: JSON.stringify({ watchId, removed }),
          metadata: { action, projectId: target.projectId, targetSessionId: target.id },
        };
      }

      const session = await targetSession();
      const ownIsolatedChild = async (): Promise<DelegatedIsolationDto | undefined> => {
        if (!ctx.sessionId || session.parentId !== ctx.sessionId) return undefined;
        return (await host.services.get(SERVER_SESSION_ISOLATION)?.delegatedChildren(ctx.sessionId))
          ?.find((child) => child.sessionId === session.id);
      };
      if (action === "agent.merge" || action === "agent.discard" || action === "agent.resolve") {
        if (!ctx.sessionId) return invalid(`${action} requires a calling Polyth session`);
        if (session.parentId !== ctx.sessionId) return invalid(`${action} applies only to agents you spawned`);
        const isolation = isolationService();
        const child = await ownIsolatedChild();
        const metadata = { action, projectId: targetProjectId, childSessionId: session.id };
        if (!child) {
          if (action === "agent.merge") {
            return {
              output: JSON.stringify({
                sessionId: session.id,
                merged: false,
                isolated: false,
                message: "This agent has no isolated worktree for your checkout: it shares your checkout (its edits are already there) or its isolated work was already merged or discarded.",
              }),
              metadata,
            };
          }
          return invalid(`${action} applies only to an agent with an isolated worktree; this one shares your checkout or was already merged`);
        }
        if (child.status === "archived") {
          return invalid(`"${session.title}" is archived; session.restore it first`);
        }
        if (delegationRunning(child)) {
          return invalid(`"${session.title}" is still running; wait for it to finish (or session.cancel it) first`);
        }
        if (action === "agent.discard") {
          if (child.hasChanges && parameters.force !== true) {
            return invalid(`"${session.title}" has unmerged changes. Merge them with agent.merge, or pass force=true to drop them`);
          }
          const released = await isolation.discard(session.id);
          return {
            output: JSON.stringify({
              sessionId: session.id,
              discarded: true,
              droppedChanges: child.hasChanges,
              session: publicSession(released),
            }),
            metadata,
          };
        }
        if (action === "agent.resolve") {
          if (child.state !== "conflict") {
            return invalid(`"${session.title}" has no merge conflict to resolve; call agent.merge`);
          }
          await isolation.resolveWithAgent(session.id);
          let resolveWatch: ServerSessionWatchDto | undefined;
          if (parameters.watchCaller !== false) {
            resolveWatch = await watchService().create(space, {
              sourceSessionId: session.id,
              targetSessionId: ctx.sessionId,
              events: ["completed", "error", "aborted"],
              delivery: "wake",
              once: true,
            });
          }
          return {
            output: JSON.stringify({
              sessionId: session.id,
              resolving: true,
              ...(resolveWatch ? { watch: resolveWatch } : {}),
              next: "The agent now merges your latest work into its worktree and fixes the conflicts. When it finishes, call agent.merge again.",
            }),
            metadata,
          };
        }
        try {
          const result = await isolation.mergeDelegated(session.id);
          return {
            output: JSON.stringify({
              sessionId: session.id,
              merged: result.merged,
              ...(result.commit ? { commit: result.commit } : {}),
              into: result.targetBranch,
              finalized: result.finalized,
              ...(!result.merged ? { message: "It had no changes; its worktree was released." } : {}),
              ...(result.merged && result.finalized
                ? { next: "Its changes are now committed in your checkout; re-read files you had loaded before relying on them." }
                : {}),
              ...(!result.finalized ? { next: "The merge published, but releasing the agent's worktree is unfinished; call agent.merge again to resume it." } : {}),
              session: publicSession(result.session),
            }),
            metadata,
          };
        } catch (error) {
          const failure = error as { code?: unknown; reason?: unknown; files?: unknown; message?: unknown };
          if (failure?.code !== "conflict") throw error;
          const files = Array.isArray(failure.files) ? failure.files.filter((file): file is string => typeof file === "string").slice(0, 30) : [];
          const reason = failure.reason === "target-overlap" || failure.reason === "delegated-pending" ? failure.reason : "conflict";
          return {
            output: JSON.stringify({
              sessionId: session.id,
              merged: false,
              reason,
              message: typeof failure.message === "string" ? failure.message : "the merge was refused",
              ...(files.length ? { files } : {}),
              next: reason === "target-overlap"
                ? "Commit (or move aside) your own uncommitted changes to these files, then call agent.merge again."
                : reason === "delegated-pending"
                  ? "That agent still has isolated agents of its own; have it merge or discard them first."
                  : files.length
                    ? "Call agent.resolve to have the agent merge your latest work and fix these conflicts, then agent.merge again."
                    : "Nothing was merged. Check agent.list, then retry agent.merge.",
            }),
            metadata,
          };
        }
      }
      if (action === "session.archive" && (await ownIsolatedChild())) {
        return invalid(`"${session.title}" still holds isolated work for your checkout. Merge it with agent.merge or drop it with agent.discard before archiving`);
      }
      if (action === "session.get") {
        return { output: JSON.stringify({ session: publicSession(session) }), metadata: { action, projectId: targetProjectId } };
      }
      if (action === "session.messages") {
        const limit = boundedLimit(parameters.limit, 20, SESSION_MESSAGE_LIMIT);
        const messages = (await scoped.sessions.events(session.id))
          .filter((event) => event.type === "user/message" || event.type === "assistant/message")
          .flatMap((event) => {
            const messageText = object(event.data).text;
            if (typeof messageText !== "string" || !messageText) return [];
            return [{
              seq: event.seq,
              time: event.time,
              role: event.type === "user/message" ? "user" : "assistant",
              text: messageText,
            }];
          })
          .slice(-limit);
        return {
          output: JSON.stringify({ session: publicSession(session), messages }),
          metadata: { action, projectId: targetProjectId },
        };
      }
      if (action === "session.debug") {
        if (!scoped.sessions.debug) {
          throw Object.assign(new Error("session debug is unavailable"), { code: "unsupported" });
        }
        const limit = boundedLimit(parameters.limit, 20, SESSION_DEBUG_EVENT_LIMIT);
        const [debug, events] = await Promise.all([
          scoped.sessions.debug(session.id),
          scoped.sessions.events(session.id),
        ]);
        const recentDiagnosticEvents = events
          .filter((event) => diagnosticEvent(event.type))
          .slice(-limit)
          .map((event) => ({ seq: event.seq, time: event.time, type: event.type }));
        return {
          output: JSON.stringify({
            session: publicSession(session),
            debug,
            recentDiagnosticEvents,
          }),
          metadata: { action, projectId: targetProjectId },
        };
      }
      if (action === "session.send") {
        if (typeof parameters.text !== "string") return invalid("text is required for session.send");
        const requested = text(parameters.delivery) ?? "queue";
        if (requested !== "normal" && !(SEND_DELIVERIES as readonly string[]).includes(requested)) {
          return invalid("delivery must be queue, interrupt or steer");
        }
        const delivery: SendDelivery = requested === "normal" ? "queue" : requested as SendDelivery;
        // Stopping or steering the turn that is running this very tool call
        // would abort the caller mid-call; it can only queue a follow-up.
        if (delivery !== "queue" && ctx.sessionId === session.id) {
          return invalid(`delivery ${delivery} cannot target your own session; use queue for a follow-up`);
        }
        // Continuing a person's pause is theirs to do.
        if (session.paused) {
          return invalid(`"${session.title}" was paused by a person; only they can continue it`);
        }
        const selectedModel = model(parameters.model);
        const agent = text(parameters.agent);
        const busy = session.status === "working" || session.status === "waiting";
        const sendResult = await scoped.sessions.send(session.id, {
          text: parameters.text,
          delivery,
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(agent ? { agent } : {}),
        });
        const outcome = sendResult.queueId
          ? sendResult.interrupting ? "interrupting" : "queued"
          : delivery === "steer" && busy ? "steered" : "started";
        return {
          output: JSON.stringify({ sessionId: session.id, delivery, outcome, note: SEND_OUTCOME_NOTES[outcome], sendResult }),
          metadata: { action, projectId: targetProjectId },
        };
      }
      if (action === "session.cancel") {
        await scoped.sessions.abort(session.id, { source: "agent" });
        return { output: JSON.stringify({ ok: true, sessionId: session.id }), metadata: { action, projectId: targetProjectId } };
      }
      if (action === "session.archive") {
        await scoped.sessions.archive(session.id);
        return { output: JSON.stringify({ session: publicSession(await scoped.sessions.snapshot(session.id)) }), metadata: { action, projectId: targetProjectId } };
      }
      if (action === "session.restore") {
        await scoped.sessions.restore(session.id);
        return { output: JSON.stringify({ session: publicSession(await scoped.sessions.snapshot(session.id)) }), metadata: { action, projectId: targetProjectId } };
      }
      if (action === "session.isolate") {
        // The turn running this call is the caller's own: its runtime cannot
        // be released and rebound from inside it.
        if (ctx.sessionId === session.id) {
          return invalid("session.isolate cannot move your own running session; the user can choose Move to isolated workspace in its session menu when it is idle");
        }
        if (session.status === "archived") return invalid(`"${session.title}" is archived; session.restore it first`);
        if (isolationBlocksUserMutation(session.status)) {
          return invalid(`"${session.title}" is still running; wait for it to finish (session.watch) or session.cancel it first`);
        }
        // Read and rebound through the acting person's scoped sessions, so the
        // Space and the right to manage this chat are enforced there.
        const result = await isolationService().isolateSession(session.id, { sessions: scoped.sessions });
        const isolation = result.session.isolation;
        const ownChild = Boolean(ctx.sessionId && isolation?.sourceSessionId === ctx.sessionId && session.parentId === ctx.sessionId);
        if (isolation?.sourceSessionId) options.delegations?.noteDelegation(isolation.sourceSessionId);
        return {
          output: JSON.stringify({
            session: publicSession(result.session),
            workspace: {
              mode: "isolated",
              ...(isolation ? {
                worktreePath: isolation.worktreePath,
                branch: isolation.worktreeBranch,
                baseCommit: isolation.baseCommit,
              } : {}),
              mergeTarget: result.targetBranch,
              ...(result.originUncommitted ? { uncommittedLeftBehind: result.originUncommitted } : {}),
            },
            next: [
              ownChild
                ? "This agent now works in its own isolated worktree. Its changes reach your checkout only through agent.merge with its sessionId (agent.discard drops them)."
                : `This chat now works in its own isolated worktree; its work returns to ${result.targetBranch} through the chat's isolation card (Merge, or Return when nothing changed).`,
              ...(result.originUncommitted
                ? [`${result.originUncommitted} uncommitted file(s) stayed in the checkout it worked in; the isolated worktree starts from that checkout's last commit.`]
                : []),
            ].join(" "),
          }),
          metadata: {
            action,
            projectId: targetProjectId,
            isolation: "isolated",
            ...(ownChild ? { childSessionId: session.id } : {}),
          },
        };
      }
      if (action === "session.fork") {
        const atSeq = parameters.atSeq === undefined ? undefined : Number(parameters.atSeq);
        if (atSeq !== undefined && (!Number.isSafeInteger(atSeq) || atSeq < 1)) return invalid("atSeq must be a positive integer");
        const ref = await scoped.sessions.fork(session.id, atSeq);
        return { output: JSON.stringify({ session: publicSession(await scoped.sessions.snapshot(ref.id)) }), metadata: { action, projectId: targetProjectId } };
      }
      if (action === "session.switchHarness") {
        if (!scoped.sessions.switchHarness) throw Object.assign(new Error("harness switching is unavailable"), { code: "unsupported" });
        const timing = text(parameters.timing);
        if (timing && timing !== "after-turn" && timing !== "stop-now") return invalid("timing must be after-turn or stop-now");
        const switched = await scoped.sessions.switchHarness(
          session.id,
          harness(parameters.harnessId, true)!,
          timing as "after-turn" | "stop-now" | undefined,
        );
        return { output: JSON.stringify({ session: publicSession(switched) }), metadata: { action, projectId: targetProjectId } };
      }
      if (action === "permission.reply") {
        if (!ctx.sessionId) return invalid("permission.reply requires a calling Polyth session");
        if (!scoped.sessions.replyDelegatedPermission) {
          throw Object.assign(new Error("delegated approvals are unavailable"), { code: "unsupported" });
        }
        const requestId = text(parameters.requestId);
        if (!requestId) return invalid("requestId is required for permission.reply");
        const reply = text(parameters.reply);
        if (reply !== "once" && reply !== "reject") return invalid("reply must be once or reject");
        // The session service admits only a request a person delegated to
        // this exact calling session; everything else stays the user's.
        await scoped.sessions.replyDelegatedPermission(ctx.sessionId, session.id, requestId, reply);
        return {
          output: JSON.stringify({ ok: true, sessionId: session.id, requestId, reply }),
          metadata: { action, projectId: targetProjectId },
        };
      }
      return invalid(`Unsupported Polyth action: ${action}`);
    },
  };

  return registry.register("harness-runtime", contribution);
}
