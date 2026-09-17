import { Buffer } from "node:buffer";
import type {
  AgentCapabilityContributionRegistry,
  HarnessContext,
  JsonObject,
  SessionProjection,
  SpaceContext,
  ToolExecutionContext,
} from "@polyth/contracts";
import { serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import type { ContextualCapabilityContribution } from "./contextualCapabilities.ts";

const EVENT_TYPE = "session/observation";
const MAX_CONTENT_BYTES = 4096;
const MAX_ARTIFACTS = 8;
const MAX_ARTIFACT_REF = 512;
const MAX_TASK_REF = 160;
const MAX_RESULTS = 50;
const MAX_ANCESTRY = 64;

const KINDS = ["finding", "question", "answer", "artifact", "blocker", "review"] as const;
type ObservationKind = typeof KINDS[number];
const ACTIONS = ["session.observe", "session.observations"] as const;
type Action = typeof ACTIONS[number];

// Deployment skill for subagent coordination: always available, not project-dependent.
export const polythPeerSkill = {
  descriptor: {
    id: "harness-runtime.skill.polyth-peer",
    kind: "skill" as const,
    owner: "harness-runtime",
    scope: "deployment" as const,
    revision: "1",
    name: "polyth-peer",
    title: "Polyth peer observations",
    description: "Coordinate delegated subagents via bounded peer observations in any project.",
    instructions: `Use the available polyth_peer tool to coordinate delegated Polyth sessions. This is a Polyth product capability — available in every project and not a project-owned skill.
Exchange only concise structured observations (finding/question/answer/artifact/blocker/review) between related delegated sessions in the same project tree. Use session.observe to publish and session.observations to read. Never send chain-of-thought or hidden reasoning; keep content bounded and task-focused. Observations are limited to sessions sharing the same delegated root; cross-project sharing is blocked.`,
  },
} satisfies import("@polyth/contracts").AgentCapabilityContribution;

const schema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { type: "string", enum: [...ACTIONS] },
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionId: {
          type: "string",
          description: "Target delegated session. Omit for session.observations to read the calling session.",
        },
        kind: { type: "string", enum: [...KINDS] },
        content: {
          type: "string",
          description: "Concise work evidence only; never raw chain-of-thought or hidden reasoning.",
        },
        taskId: { type: "string", maxLength: MAX_TASK_REF },
        artifacts: {
          type: "array",
          maxItems: MAX_ARTIFACTS,
          items: { type: "string", maxLength: MAX_ARTIFACT_REF },
        },
        afterSeq: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: MAX_RESULTS },
      },
    },
  },
  allOf: [
    {
      if: { properties: { action: { const: "session.observe" } }, required: ["action"] },
      then: {
        required: ["parameters"],
        properties: { parameters: { required: ["sessionId", "kind", "content"] } },
      },
    },
  ],
};

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const invalid = (message: string): never => {
  throw Object.assign(new Error(message), { code: "invalid-input" });
};

const forbidden = (message: string): never => {
  throw Object.assign(new Error(message), { code: "forbidden" });
};

const contextKey = (spaceId: string, projectId: string): string => `${spaceId}\u0000${projectId}`;

function observationContent(value: unknown): string {
  const content = text(value);
  if (!content) return invalid("content is required for session.observe");
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
    return invalid(`observation content must be ${MAX_CONTENT_BYTES} UTF-8 bytes or fewer`);
  }
  return content;
}

function artifacts(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ARTIFACTS) {
    return invalid(`artifacts must contain at most ${MAX_ARTIFACTS} references`);
  }
  return value.map((item) => {
    const ref = text(item);
    if (!ref || ref.length > MAX_ARTIFACT_REF) return invalid("artifact reference is invalid or too long");
    return ref;
  });
}

async function lineageRoot(
  session: SessionProjection,
  snapshot: (id: string) => Promise<SessionProjection>,
  projectId: string,
): Promise<string> {
  const seen = new Set<string>();
  let current = session;
  for (let depth = 0; depth < MAX_ANCESTRY; depth += 1) {
    if (current.projectId !== projectId || seen.has(current.id)) {
      return forbidden("session ancestry is outside the authorized project or contains a cycle");
    }
    seen.add(current.id);
    if (!current.parentId) return current.id;
    current = await snapshot(current.parentId);
  }
  return forbidden("session ancestry exceeds the supported depth");
}

export function registerPeerObservationTool(host: ServerPackageHost) {
  const spaces = new Map<string, SpaceContext>();
  const registry = host.services.require(
    serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"),
  );
  const descriptor = {
    id: "harness-runtime.peer-observations",
    kind: "tool" as const,
    owner: "harness-runtime",
    scope: "project" as const,
    revision: "1",
    name: "polyth_peer",
    description:
      "Exchange bounded structured work observations between related delegated Polyth sessions without copying full chat traffic into the parent context. "
      + "Use session.observe for concise findings/questions/answers/artifacts/blockers/reviews and session.observations to inspect only an explicitly related session. Never send chain-of-thought or hidden reasoning.",
    inputSchema: schema,
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
      if (!ctx.sessionId || !ctx.spaceId) return forbidden("peer observations require a canonical calling session");
      const space = spaces.get(contextKey(ctx.spaceId, ctx.projectId));
      if (!space) return forbidden("peer observations are unavailable outside an authenticated Space/project context");
      const scoped = host.forSpace(space);
      const source = await scoped.sessions.snapshot(ctx.sessionId);
      if (source.projectId !== ctx.projectId) return forbidden("calling session does not belong to the current project");

      const action = text(input.action) as Action | undefined;
      if (!action || !ACTIONS.includes(action)) return invalid(`unsupported peer observation action: ${action ?? "missing"}`);
      const parameters = object(input.parameters);
      const targetId = text(parameters.sessionId) ?? (action === "session.observations" ? source.id : undefined);
      if (!targetId) return invalid("sessionId is required for session.observe");
      const target = await scoped.sessions.snapshot(targetId);
      if (target.projectId !== ctx.projectId) return forbidden("peer observations cannot cross project boundaries");

      const snapshot = (id: string) => scoped.sessions.snapshot(id);
      const [sourceRoot, targetRoot] = await Promise.all([
        lineageRoot(source, snapshot, ctx.projectId),
        lineageRoot(target, snapshot, ctx.projectId),
      ]);
      if (sourceRoot !== targetRoot) {
        return forbidden("peer observations are limited to the same delegated session tree");
      }

      if (action === "session.observe") {
        const kind = text(parameters.kind) as ObservationKind | undefined;
        if (!kind || !KINDS.includes(kind)) return invalid("invalid observation kind");
        const content = observationContent(parameters.content);
        const taskId = text(parameters.taskId);
        if (taskId && taskId.length > MAX_TASK_REF) return invalid("taskId is too long");
        const refs = artifacts(parameters.artifacts);
        const event = await host.events.append(target.id, EVENT_TYPE, {
          kind,
          content,
          sourceSessionId: source.id,
          targetSessionId: target.id,
          rootSessionId: sourceRoot,
          projectId: ctx.projectId,
          ...(taskId ? { taskId } : {}),
          ...(refs.length ? { artifacts: refs } : {}),
        }, { ignorable: true, producerPlugin: "harness-runtime" });
        return {
          output: JSON.stringify({
            observation: {
              seq: event.seq,
              time: event.time,
              kind,
              sourceSessionId: source.id,
              targetSessionId: target.id,
            },
          }),
          metadata: { action, projectId: ctx.projectId, targetSessionId: target.id },
        };
      }

      const limit = parameters.limit === undefined ? 20 : Number(parameters.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULTS) return invalid(`limit must be 1-${MAX_RESULTS}`);
      const afterSeq = parameters.afterSeq === undefined ? 0 : Number(parameters.afterSeq);
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) return invalid("afterSeq must be a non-negative integer");
      const all = (await scoped.sessions.events(target.id))
        .filter((event) => event.type === EVENT_TYPE && event.seq > afterSeq);
      const selected = all.slice(-limit).map((event) => {
        const data = object(event.data);
        return {
          seq: event.seq,
          time: event.time,
          kind: data.kind,
          content: data.content,
          sourceSessionId: data.sourceSessionId,
          targetSessionId: data.targetSessionId,
          rootSessionId: data.rootSessionId,
          projectId: data.projectId,
          ...(data.taskId ? { taskId: data.taskId } : {}),
          ...(Array.isArray(data.artifacts) ? { artifacts: data.artifacts } : {}),
        };
      });
      return {
        output: JSON.stringify({
          targetSessionId: target.id,
          observations: selected,
          returned: selected.length,
          unreadCount: all.length,
          latestSeq: all.at(-1)?.seq ?? afterSeq,
        }),
        metadata: { action, projectId: ctx.projectId, targetSessionId: target.id },
      };
    },
  };

  return registry.register("harness-runtime", contribution);
}
