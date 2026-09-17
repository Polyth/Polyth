import type {
  AgentCapabilityContributionRegistry,
  HarnessContext,
  HarnessSelection,
  JsonObject,
  ModelRef,
  Project,
  SessionProjection,
  SpaceContext,
  ToolExecutionContext,
} from "@polyth/contracts";
import { serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import type { ContextualCapabilityContribution } from "./contextualCapabilities.ts";

const SESSION_TITLE_MAX = 120;
const SESSION_MESSAGE_LIMIT = 100;
const SESSION_DEBUG_EVENT_LIMIT = 50;
const ACTIONS = [
  "project.list",
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
  "session.switchHarness",
] as const;
type Action = typeof ACTIONS[number];

const DESCRIPTION =
  "Control canonical Polyth sessions regardless of which harness runs them. "
  + "Inside the current project, session orchestration is autonomous: create, inspect, debug, message, cancel, archive, fork, and switch harnesses without a Polyth orchestration approval on every call. "
  + "project.list discovers every project in the current authorized Space. Set parameters.projectId to target another project; Polyth protects that cross-project boundary with a target-specific approval that can be allowed once, for the session, or always for this source project. "
  + "Same-project sessions created by an agent are canonical children of the calling session, so hierarchy, permission inheritance, recovery, and UI grouping remain intact. "
  + "Create delegated sessions with a concise title and use session.debug for the bounded, redacted troubleshooting surface.";

// Deployment skill: always available in any project/Space, not a managed project skill.
// Design/debug skills remain opt-in; this only covers core session/subagent orchestration.
// Future per-user customization can replace this deployment text with a Space-scoped override.
export const polythSessionsSkill = {
  descriptor: {
    id: "harness-runtime.skill.polyth-sessions",
    kind: "skill" as const,
    owner: "harness-runtime",
    scope: "deployment" as const,
    revision: "1",
    name: "polyth-sessions",
    title: "Polyth sessions",
    description: "Orchestrate Polyth sessions and delegated subagents in any project.",
    instructions: `Use the available polyth tool (its harness may prefix the name) to work with canonical Polyth sessions. This is a Polyth product capability — available in every project and not dependent on project-specific skill installs.
${DESCRIPTION}
For subagent work, create delegated sessions with session.create (title + optional prompt/harness), then drive them with session.send / session.debug / session.messages. Keep delegated work bounded and report findings via the peer observation skill instead of copying full transcripts. Respect cross-project approvals and Space isolation; never assume access to another project without an explicit grant.`,
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
          description: "Concise human-readable title for a delegated session; never paste the full prompt.",
        },
        prompt: { type: "string", description: "Optional first prompt for session.create." },
        text: { type: "string", description: "Prompt to send with session.send." },
        harnessId: {
          type: "string",
          description: "Registered harness id, or 'auto'. Omit on create to use Polyth Auto selection.",
        },
        timing: { type: "string", enum: ["after-turn", "stop-now"] },
        delivery: { type: "string", enum: ["normal", "steer", "queue", "interrupt"] },
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
      },
    },
  },
  allOf: [
    {
      if: { properties: { action: { const: "session.create" } }, required: ["action"] },
      then: {
        required: ["parameters"],
        properties: { parameters: { required: ["title"] } },
      },
    },
    {
      if: { properties: { action: { enum: [
        "session.get", "session.messages", "session.debug", "session.send", "session.cancel", "session.archive",
        "session.restore", "session.fork", "session.switchHarness",
      ] } }, required: ["action"] },
      then: {
        required: ["parameters"],
        properties: { parameters: { required: ["sessionId"] } },
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
  if (typeof value !== "string") return invalid("title is required for session.create");
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return invalid("title is required for session.create");
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
  model: session.model ?? null,
  agent: session.agent ?? null,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
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

export function registerPolythSessionControl(host: ServerPackageHost) {
  const spaces = new Map<string, SpaceContext>();
  const registry = host.services.require(
    serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"),
  );
  const descriptor = {
    id: "harness-runtime.polyth-control",
    kind: "tool" as const,
    owner: "harness-runtime",
    scope: "project" as const,
    revision: "3",
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
    async execute(input: JsonObject, ctx: ToolExecutionContext) {
      const space = ctx.spaceId ? spaces.get(contextKey(ctx.spaceId, ctx.projectId)) : undefined;
      if (!space) throw Object.assign(new Error("Polyth session control is unavailable outside an authenticated Space/project context"), { code: "forbidden" });
      const scoped = host.forSpace(space);
      const action = text(input.action) as Action | undefined;
      if (!action || !ACTIONS.includes(action)) return invalid(`Unsupported Polyth action: ${action ?? "missing"}`);
      const parameters = object(input.parameters);

      if (action === "project.list") {
        const projects = (await scoped.projects.list()).map(publicProject);
        return { output: JSON.stringify({ currentProjectId: ctx.projectId, projects }), metadata: { action } };
      }

      const targetProjectId = text(parameters.projectId) ?? ctx.projectId;
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

      if (action === "session.list") {
        const sessions = (await scoped.sessions.list())
          .filter((session) => session.projectId === targetProjectId)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map(publicSession);
        return {
          output: JSON.stringify({ project: publicProject(targetProject), sessions }),
          metadata: { action, projectId: targetProjectId },
        };
      }

      if (action === "session.create") {
        const sessionTitle = title(parameters.title);
        const selection = harness(parameters.harnessId);
        const selectedModel = model(parameters.model);
        const agent = text(parameters.agent);
        const parentId = targetProjectId === ctx.projectId && ctx.sessionId ? ctx.sessionId : undefined;
        const ref = await scoped.sessions.create({
          projectId: targetProjectId,
          title: sessionTitle,
          ...(parentId ? { parentId } : {}),
          ...(selection ? { harness: selection } : {}),
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(agent ? { agent } : {}),
        });
        const prompt = typeof parameters.prompt === "string" ? parameters.prompt : undefined;
        let sendResult: unknown;
        if (prompt !== undefined) {
          sendResult = await scoped.sessions.send(ref.id, {
            text: prompt,
            ...(selectedModel ? { model: selectedModel } : {}),
            ...(agent ? { agent } : {}),
          });
        }
        return {
          output: JSON.stringify({
            session: publicSession(await scoped.sessions.snapshot(ref.id)),
            ...(sendResult !== undefined ? { sendResult } : {}),
          }),
          metadata: { action, projectId: targetProjectId },
        };
      }

      const session = await targetSession();
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
        const delivery = text(parameters.delivery);
        if (delivery && !["normal", "steer", "queue", "interrupt"].includes(delivery)) return invalid("invalid delivery mode");
        const selectedModel = model(parameters.model);
        const agent = text(parameters.agent);
        const sendResult = await scoped.sessions.send(session.id, {
          text: parameters.text,
          ...(delivery ? { delivery: delivery as "normal" | "steer" | "queue" | "interrupt" } : {}),
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(agent ? { agent } : {}),
        });
        return { output: JSON.stringify({ sessionId: session.id, sendResult }), metadata: { action, projectId: targetProjectId } };
      }
      if (action === "session.cancel") {
        await scoped.sessions.abort(session.id);
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
      return invalid(`Unsupported Polyth action: ${action}`);
    },
  };

  return registry.register("harness-runtime", contribution);
}
