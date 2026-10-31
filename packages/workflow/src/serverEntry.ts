import { join } from "node:path";
import type {
  AttachmentRef,
  HarnessRegistry,
  ModelRef,
  RouteHandler,
  SessionProjection,
  SpaceContext,
  WorkflowDecisionInputDto,
  WorkflowEdgeDto,
  WorkflowLaunchOptionsDto,
  WorkflowNodeDto,
  WorkflowRunOptionsDto,
} from "@polyth/contracts";
import {
  localOnlyRemoteAccess,
  publishBackgroundWork,
  publishRecoveredBackgroundWork,
  serverServiceKey,
  SESSION_ATTENTION_SERVICE,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { effectiveHistory } from "@polyth/session";
import { JUDGMENT_SERVICE } from "@polyth/judgment/server";
import {
  createWorkflowService,
  type WorkflowCreateInput,
  type WorkflowNodeRoute,
  type WorkflowService,
  type WorkflowUpdateInput,
} from "./index.ts";
import { createWorkflowRunNode } from "./runner.ts";
import { getWorkflowPreset, workflowPresets } from "./presets.ts";
import { workflowReviewVerdictDescriptor } from "./judgment.ts";

const asModel = (value: unknown): ModelRef | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const model = value as {
    providerID?: unknown;
    modelID?: unknown;
    variant?: unknown;
  };
  return typeof model.providerID === "string" &&
    typeof model.modelID === "string"
    ? {
        providerID: model.providerID,
        modelID: model.modelID,
        ...(typeof model.variant === "string"
          ? { variant: model.variant }
          : {}),
      }
    : undefined;
};

const asModels = (value: unknown): ModelRef[] => {
  if (!Array.isArray(value) || value.length > 24)
    throw Object.assign(new Error("allowedModels must be an array of at most 24 models"), { code: "invalid-input" });
  if (!value.every((item) => item && typeof item === "object" && !Array.isArray(item) &&
    typeof item.providerID === "string" && item.providerID.trim() && item.providerID.length <= 300 &&
    typeof item.modelID === "string" && item.modelID.trim() && item.modelID.length <= 300 &&
    (item.variant === undefined || typeof item.variant === "string")))
    throw Object.assign(new Error("allowedModels contains an invalid model"), { code: "invalid-input" });
  const parsed = value.map(asModel);
  return parsed as ModelRef[];
};

const optionsOf = (value: unknown): WorkflowRunOptionsDto | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const raw = value as Record<string, unknown>;
  return {
    ...(raw.pipe === "direct" || raw.pipe === "ancestors"
      ? { pipe: raw.pipe }
      : {}),
    ...(raw.permissions === "auto" || raw.permissions === "manual"
      ? { permissions: raw.permissions }
      : {}),
    ...(raw.maxParallel !== undefined
      ? { maxParallel: Number(raw.maxParallel) }
      : {}),
    ...(raw.nodeTimeoutMs !== undefined
      ? { nodeTimeoutMs: Number(raw.nodeTimeoutMs) }
      : {}),
    ...(raw.reviewRounds !== undefined
      ? { reviewRounds: Number(raw.reviewRounds) }
      : {}),
  };
};

const attachmentOf = (value: unknown): AttachmentRef | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string" ||
    !raw.id.trim() ||
    typeof raw.name !== "string" ||
    typeof raw.mime !== "string" ||
    !Number.isSafeInteger(raw.size) ||
    Number(raw.size) < 0
  )
    return undefined;
  const kind =
    raw.kind === undefined ||
    raw.kind === "file" ||
    raw.kind === "image" ||
    raw.kind === "range" ||
    raw.kind === "url" ||
    raw.kind === "browser-context"
      ? (raw.kind as AttachmentRef["kind"])
      : undefined;
  if (raw.kind !== undefined && !kind) return undefined;
  if (raw.url !== undefined && typeof raw.url !== "string") return undefined;
  if (raw.path !== undefined && typeof raw.path !== "string") return undefined;
  const range = raw.range;
  if (
    range !== undefined &&
    (!Array.isArray(range) ||
      range.length !== 2 ||
      !Number.isSafeInteger(range[0]) ||
      !Number.isSafeInteger(range[1]) ||
      Number(range[0]) < 1 ||
      Number(range[1]) < Number(range[0]))
  )
    return undefined;
  if (
    kind === "browser-context" &&
    (!raw.browserContext || typeof raw.browserContext !== "object")
  )
    return undefined;
  return {
    id: raw.id,
    name: raw.name,
    mime: raw.mime,
    size: Number(raw.size),
    ...(kind ? { kind } : {}),
    ...(typeof raw.url === "string" ? { url: raw.url } : {}),
    ...(typeof raw.path === "string" ? { path: raw.path } : {}),
    ...(Array.isArray(range)
      ? { range: [Number(range[0]), Number(range[1])] as [number, number] }
      : {}),
    ...(kind === "browser-context" ? { browserContext: raw.browserContext as never } : {}),
  };
};

const attachmentsOf = (value: unknown): AttachmentRef[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const parsed = value.map(attachmentOf);
  return parsed.every((item): item is AttachmentRef => Boolean(item))
    ? parsed
    : undefined;
};

const nodesOf = (value: unknown): WorkflowNodeDto[] =>
  Array.isArray(value)
    ? value.map((candidate) => {
        const raw =
          candidate && typeof candidate === "object"
            ? (candidate as Record<string, unknown>)
            : {};
        const model = asModel(raw.model);
        const position =
          raw.position && typeof raw.position === "object"
            ? (raw.position as Record<string, unknown>)
            : undefined;
        return {
          id: String(raw.id ?? ""),
          role: String(raw.role ?? ""),
          prompt: String(raw.prompt ?? ""),
          ...(model ? { model } : {}),
          ...(raw.allowedModels !== undefined
            ? { allowedModels: asModels(raw.allowedModels) }
            : {}),
          ...(typeof raw.agent === "string" && raw.agent
            ? { agent: raw.agent }
            : {}),
          ...(raw.harness &&
          typeof raw.harness === "object" &&
          (raw.harness as { mode?: unknown }).mode === "auto"
            ? { harness: { mode: "auto" } as const }
            : raw.harness &&
              typeof raw.harness === "object" &&
              (raw.harness as { mode?: unknown }).mode === "pinned" &&
              typeof (raw.harness as { harnessId?: unknown }).harnessId ===
                "string"
            ? {
                harness: {
                  mode: "pinned",
                  harnessId: (raw.harness as { harnessId: string }).harnessId,
                } as const,
              }
            : {}),
          ...(typeof raw.group === "string" && raw.group
            ? { group: raw.group }
            : {}),
          ...(raw.kind === "lead" ||
          raw.kind === "worker" ||
          raw.kind === "review"
            ? { kind: raw.kind }
            : {}),
          ...(position &&
          Number.isFinite(Number(position.x)) &&
          Number.isFinite(Number(position.y))
            ? { position: { x: Number(position.x), y: Number(position.y) } }
            : {}),
        };
      })
    : [];

const edgesOf = (value: unknown): WorkflowEdgeDto[] =>
  Array.isArray(value)
    ? value.map((candidate) => {
        const raw =
          candidate && typeof candidate === "object"
            ? (candidate as Record<string, unknown>)
            : {};
        return {
          id: String(raw.id ?? ""),
          source: String(raw.source ?? ""),
          target: String(raw.target ?? ""),
        };
      })
    : [];

/** A context minted for server work rather than for a signed-in person. */
const isSystemContext = (ctx: SpaceContext): boolean =>
  (ctx as { authority?: { kind?: unknown } }).authority?.kind === "system" ||
  !ctx.userId ||
  ctx.userId.startsWith("system:");

const personOf = (space: SpaceContext): string | undefined =>
  isSystemContext(space) ? undefined : space.userId;

export function workflowRoutes(
  workflow:
    | WorkflowService
    | ((space: SpaceContext) => Promise<WorkflowService>),
  ensureSamples?: (projectId: string) => void,
  host?: Pick<
    ServerPackageHost,
    "forSpace" | "spaceStorage" | "projects" | "events" | "pluginId"
  >,
  /** The person a request acts for, recorded as a run's launcher. */
  actorOf: (space: SpaceContext) => string | undefined = personOf
): RouteHandler {
  return async (request) => {
    const { path, method, url, body, json } = request;
    const service =
      typeof workflow === "function" ? await workflow(request.space) : workflow;
    const scoped = host?.forSpace(request.space) ?? {
      projects: host?.projects,
      sessions: undefined,
    };
    const assertProject = async (projectId: string): Promise<void> => {
      if (!projectId.trim())
        throw Object.assign(new Error("projectId is required"), {
          code: "invalid-input",
        });
      const project = await scoped.projects?.get(projectId);
      if (
        !project ||
        (project.spaceId && project.spaceId !== request.space.spaceId)
      )
        throw Object.assign(new Error("project not found"), {
          code: "not-found",
        });
    };
    const assertSession = async (
      sessionId: string,
      projectId: string
    ): Promise<SessionProjection | undefined> => {
      if (!sessionId.trim())
        throw Object.assign(new Error("sessionId is required"), {
          code: "invalid-input",
        });
      const session = await scoped.sessions?.snapshot(sessionId);
      if (
        !session ||
        session.projectId !== projectId ||
        (session.spaceId && session.spaceId !== request.space.spaceId)
      )
        throw Object.assign(new Error("session not found"), {
          code: "not-found",
        });
      return session;
    };
    if (path === "/api/workflows" && method === "GET") {
      const projectId = url.searchParams.get("projectId") ?? "";
      await assertProject(projectId);
      ensureSamples?.(projectId);
      // Bundled templates carry the routes this project saved for their units.
      json(200, [...workflowPresets(projectId).map((preset) => service.withRoutes(preset)), ...service.list(projectId)]);
      return true;
    }
    if (path === "/api/workflows" && method === "POST") {
      const raw = await body();
      const preset =
        typeof raw.presetId === "string"
          ? getWorkflowPreset(raw.presetId)
          : undefined;
      const projectId = String(raw.projectId ?? preset?.projectId ?? "");
      await assertProject(projectId);
      if (preset && preset.projectId !== projectId)
        throw Object.assign(new Error("preset does not belong to project"), {
          code: "not-found",
        });
      const input: WorkflowCreateInput = {
        projectId,
        name: String(raw.name ?? (preset ? `${preset.name} copy` : "")),
        description:
          typeof raw.description === "string"
            ? raw.description
            : preset?.description,
        category: (raw.category ??
          preset?.category) as WorkflowCreateInput["category"],
        profile: (raw.profile ??
          preset?.profile) as WorkflowCreateInput["profile"],
        ...(preset?.preset
          ? { preset: preset.preset }
          : raw.preset &&
              typeof raw.preset === "object" &&
              typeof (raw.preset as { id?: unknown }).id === "string" &&
              Number.isSafeInteger((raw.preset as { version?: unknown }).version)
            ? {
                preset: {
                  id: (raw.preset as { id: string }).id,
                  version: Number((raw.preset as { version: number }).version),
                },
              }
            : {}),
        nodes:
          raw.nodes !== undefined ? nodesOf(raw.nodes) : preset?.nodes ?? [],
        edges:
          raw.edges !== undefined ? edgesOf(raw.edges) : preset?.edges ?? [],
        ...(optionsOf(raw.defaults)
          ? { defaults: optionsOf(raw.defaults)! }
          : preset?.defaults
          ? { defaults: preset.defaults }
          : {}),
      };
      json(200, service.create(input));
      return true;
    }
    if (path === "/api/workflow-runs" && method === "GET") {
      const projectId = url.searchParams.get("projectId") ?? "";
      await assertProject(projectId);
      json(200, service.listRuns(projectId));
      return true;
    }

    if (
      path === "/api/workflows/preferences" &&
      (method === "GET" || method === "PATCH")
    ) {
      const projectId = url.searchParams.get("projectId") ?? "";
      await assertProject(projectId);
      if (method === "GET") json(200, service.getPreferences(projectId));
      else
        json(
          200,
          service.updatePreferences(projectId, (await body()) as never)
        );
      return true;
    }

    let match = path.match(
      /^\/api\/workflow-runs\/([^/]+)(?:\/(stop|retry|decision))?$/
    );
    if (match) {
      const runId = decodeURIComponent(match[1]!);
      if (method === "GET" && !match[2]) {
        const run = service.getRun(runId);
        if (!run) {
          json(404, { error: "not-found", message: "workflow run not found" });
          return true;
        }
        if (!run.projectId) {
          json(404, { error: "not-found", message: "workflow run not found" });
          return true;
        }
        await assertProject(run.projectId);
        await assertSession(run.parentSessionId ?? "", run.projectId);
        json(200, run);
        return true;
      }
      if (method === "POST" && match[2] === "stop") {
        const run = service.getRun(runId);
        if (!run?.projectId)
          throw Object.assign(new Error("workflow run not found"), {
            code: "not-found",
          });
        await assertProject(run.projectId);
        await assertSession(run.parentSessionId ?? "", run.projectId);
        json(200, await service.stop(runId));
        return true;
      }
      if (method === "POST" && match[2] === "decision") {
        const raw = await body();
        const run = service.getRun(runId);
        if (!run?.projectId)
          throw Object.assign(new Error("workflow run not found"), {
            code: "not-found",
          });
        await assertProject(run.projectId);
        await assertSession(run.parentSessionId ?? "", run.projectId);
        // The service validates the action and note and refuses anyone but
        // the person who started the run.
        json(
          200,
          await service.decide(
            runId,
            raw as unknown as WorkflowDecisionInputDto,
            actorOf(request.space)
          )
        );
        return true;
      }
      if (method === "POST" && match[2] === "retry") {
        const raw = await body();
        const run = service.getRun(runId);
        if (!run?.projectId)
          throw Object.assign(new Error("workflow run not found"), {
            code: "not-found",
          });
        await assertProject(run.projectId);
        await assertSession(run.parentSessionId ?? "", run.projectId);
        // The service validates the route before it reaches a run or template.
        const replacement =
          raw.replacement && typeof raw.replacement === "object"
            ? (raw.replacement as WorkflowNodeRoute)
            : undefined;
        json(
          200,
          await service.retry(
            runId,
            String(raw.nodeId ?? ""),
            typeof raw.clientOperationId === "string"
              ? raw.clientOperationId
              : undefined,
            replacement,
            actorOf(request.space),
            { saveToWorkflow: raw.saveToWorkflow === true }
          )
        );
        return true;
      }
      return false;
    }

    if (path === "/api/workflows/preferences") return false;

    match = path.match(/^\/api\/workflows\/([^/]+)(?:\/(run))?$/);
    if (!match) return false;
    const id = decodeURIComponent(match[1]!);
    if (method === "POST" && match[2] === "run") {
      const raw = await body();
      const found = service.get(id) ?? getWorkflowPreset(id);
      if (!found) {
        json(404, { error: "not-found", message: "workflow not found" });
        return true;
      }
      await assertProject(found.projectId);
      const parent = await assertSession(String(raw.sessionId ?? ""), found.projectId);
      const requestedLaunch =
        raw.launch && typeof raw.launch === "object"
          ? (raw.launch as WorkflowLaunchOptionsDto)
          : undefined;
      const parentHarness = parent?.resolvedHarnessId
        ? { mode: "pinned" as const, harnessId: parent.resolvedHarnessId }
        : parent?.harness;
      const launch = parent
        ? {
            ...(parent.model ? { model: parent.model } : {}),
            ...(parentHarness ? { harness: parentHarness } : {}),
            ...(parent.agent ? { agent: parent.agent } : {}),
            ...(requestedLaunch ?? {}),
          }
        : requestedLaunch;
      json(
        200,
        await service.start(
          id,
          String(raw.sessionId ?? ""),
          String(raw.input ?? ""),
          optionsOf(raw.options),
          launch,
          actorOf(request.space)
        )
      );
      return true;
    }
    if (match[2]) return false;
    if (method === "GET") {
      const bundled = service.get(id) ? null : getWorkflowPreset(id);
      const found = service.get(id) ?? (bundled ? service.withRoutes(bundled) : null);
      if (!found) {
        json(404, { error: "not-found", message: "workflow not found" });
        return true;
      }
      await assertProject(found.projectId);
      json(200, found);
      return true;
    }
    if (method === "PATCH") {
      const raw = await body();
      const patch: WorkflowUpdateInput = {
        ...(raw.name !== undefined ? { name: String(raw.name) } : {}),
        ...(raw.description !== undefined
          ? { description: String(raw.description) }
          : {}),
        ...(raw.category !== undefined
          ? { category: raw.category as WorkflowUpdateInput["category"] }
          : {}),
        ...(raw.profile !== undefined
          ? { profile: raw.profile as WorkflowUpdateInput["profile"] }
          : {}),
        ...(raw.nodes !== undefined ? { nodes: nodesOf(raw.nodes) } : {}),
        ...(raw.edges !== undefined ? { edges: edgesOf(raw.edges) } : {}),
        ...(raw.defaults !== undefined
          ? { defaults: optionsOf(raw.defaults) ?? {} }
          : {}),
      };
      const found = service.get(id) ?? getWorkflowPreset(id);
      if (!found) {
        json(404, { error: "not-found", message: "workflow not found" });
        return true;
      }
      await assertProject(found.projectId);
      if (found.builtin) {
        json(409, {
          error: "conflict",
          message: "built-in workflows are read-only; duplicate it first",
        });
        return true;
      }
      json(
        200,
        service.update(id, {
          ...patch,
          expectedRevision:
            raw.expectedRevision === undefined
              ? undefined
              : Number(raw.expectedRevision),
        })
      );
      return true;
    }
    if (method === "DELETE") {
      const found = service.get(id) ?? getWorkflowPreset(id);
      if (!found) {
        json(404, { error: "not-found", message: "workflow not found" });
        return true;
      }
      await assertProject(found.projectId);
      if (found.builtin) {
        json(409, {
          error: "conflict",
          message: "built-in workflows are read-only",
        });
        return true;
      }
      if (!service.remove(id)) {
        json(409, {
          error: "conflict",
          message: "built-in workflows are read-only",
        });
        return true;
      }
      json(200, { ok: true });
      return true;
    }
    return false;
  };
}

export default function registerPackage(
  host: ServerPackageHost
): ServerPackage {
  // Every workflow node runs through the canonical session service, so nodes
  // stay visible, permission-aware, abortable, and durably logged.
  const services = new Map<
    string,
    WorkflowService | Promise<WorkflowService>
  >();
  let unregisterUse: (() => void) | undefined;
  const ensureRegistered = () => {
    if (unregisterUse) return;
    const judgment = host.services.get(JUDGMENT_SERVICE);
    if (judgment) {
      unregisterUse = judgment.registerUse(workflowReviewVerdictDescriptor);
    }
  };
  // People the host does not tell apart (an installation with one person
  // answers no `personSpaceContext`): their own gateway-validated request
  // context, per Space and person. Someone the host can name never uses it.
  const unnamedPeople = new Map<string, SpaceContext>();
  const personKey = (spaceId: string, userId: string) => `${spaceId}\u0000${userId}`;
  const actorOf = (space: SpaceContext): string | undefined => {
    const userId = personOf(space);
    if (!userId) return undefined;
    const key = personKey(space.spaceId, userId);
    if (host.personSpaceContext?.(userId, space.spaceId)) unnamedPeople.delete(key);
    else unnamedPeople.set(key, space);
    return userId;
  };
  /** The context a run acts in. Each run acts for the person who started it,
   * never for whoever first opened workflows in the Space; system work keeps
   * the Space's system context. */
  const contextFor = (spaceId: string, launchedBy: string | undefined): SpaceContext => {
    if (!launchedBy) return host.systemSpaceContext(spaceId);
    const person =
      host.personSpaceContext?.(launchedBy, spaceId) ??
      unnamedPeople.get(personKey(spaceId, launchedBy));
    if (!person)
      throw Object.assign(
        new Error("The person who started this workflow is no longer a member of this Space"),
        { code: "forbidden" }
      );
    return person;
  };
  const serviceFor = async (space: SpaceContext): Promise<WorkflowService> => {
    const existing = services.get(space.spaceId);
    if (existing) return await existing;
    const spaceId = space.spaceId;
    const creation = (async (): Promise<WorkflowService> => {
      // The service is shared by everyone in the Space, so it captures no
      // person's scoped services. Legacy workflows belong to the Space's
      // projects, not to the projects the first caller happens to see.
      const system = host.systemSpaceContext(spaceId);
      const projects = await host.forSpace(system).projects.list();
      const owned = new Set(
        projects
          .filter(
            (project) => !project.spaceId || project.spaceId === spaceId
          )
          .map((project) => project.id)
      );
      const scopedFor = (launchedBy: string | undefined) =>
        host.forSpace(contextFor(spaceId, launchedBy));
      const file = join(
        host.spaceStorage(space).packageDir(host.pluginId),
        "workflows.json"
      );
      const service = createWorkflowService({
        file,
        space: system,
        spaceFor: (launchedBy) => contextFor(spaceId, launchedBy),
        judgment: () => {
          ensureRegistered();
          return host.services.get(JUDGMENT_SERVICE);
        },
        builtin: (id) => getWorkflowPreset(id),
        legacyFile: join(host.storageDir, "workflows.json"),
        ownsLegacyProject: (projectId) => owned.has(projectId),
        append: async (sessionId, type, data, options) => {
          const event = await host.events.append(
            sessionId,
            type,
            data,
            options ?? { ignorable: true, producerPlugin: "workflow" }
          );
          // A run outlives its view: keep the parent chat's navigator/notification
          // state in sync so the session shows activity without the workflow
          // window open. This is a projection only; the canonical event above
          // already succeeded and must never be rolled back by it.
          const runId = typeof data.runId === "string" ? data.runId : "";
          if (runId && (type === "workflow/run-started" || type === "workflow/run-completed")) {
            try {
              await publishBackgroundWork(
                host,
                sessionId,
                "workflow",
                type === "workflow/run-started"
                  ? { phase: "started", id: runId }
                  : {
                      phase: "completed",
                      id: runId,
                      status: data.status === "done" ? "completed" : "failed",
                    }
              );
            } catch (cause) {
              console.warn("[workflow] background activity projection failed", cause);
            }
          }
          return event;
        },
        onInterruptedRunsRecovered: (runs) => {
          // The old process's runs are fenced as stopped: their parent cannot
          // be working on them anymore, so drop the stale count exactly once.
          for (const run of runs) {
            if (!run.parentSessionId) continue;
            void publishRecoveredBackgroundWork(host, run.parentSessionId, "workflow")
              .catch((cause) => console.warn("[workflow] removed stale background activity failed", cause));
          }
        },
        onReviewSettled: (event) => {
          // Resolved when it fires, never at registration. Older hosts have
          // no notify; the review is then simply not announced.
          const attention = host.services.get(SESSION_ATTENTION_SERVICE);
          if (event.outcome === "needs-decision") {
            attention?.waitingForPerson(event.parentSessionId);
            return;
          }
          attention?.notify?.(event.parentSessionId, {
            kind: "completed",
            statusText: event.rounds > 1
              ? `Review approved in ${event.rounds} rounds`
              : "Review approved on the first round",
            key: `workflow-review:${event.runId}`,
          });
        },
        onRunStarted: (run, launchedBy) => {
          if (!run.parentSessionId || !run.input.trim()) return;
          void Promise.resolve()
            .then(() => scopedFor(launchedBy).sessions.requestAutomaticTitle?.(run.parentSessionId!, run.input))
            .catch((cause) => console.warn("[workflow] parent session title request failed", cause));
        },
        buildContext: async (sessionId, launch, input, launchedBy) => {
        const events = effectiveHistory(
          await scopedFor(launchedBy).sessions.events(sessionId, 0)
        ).events;
        const source =
          launch?.sourceMessageSeq === undefined
            ? undefined
            : events.find(
                (event) =>
                  event.seq === launch.sourceMessageSeq &&
                  (event.type === "user/message" ||
                    event.type === "assistant/message" ||
                    event.type === "assistant/chunk")
              );
        if (launch?.sourceMessageSeq !== undefined && !source)
          throw Object.assign(
            new Error("sourceMessageSeq is not a canonical message"),
            { code: "invalid-input" }
          );
        const sourceAttachments = attachmentsOf(
          source && (source.data as { attachments?: unknown }).attachments
        );
        if (
          source &&
          (source.data as { attachments?: unknown }).attachments !== undefined &&
          !sourceAttachments
        )
          throw Object.assign(new Error("source message has invalid attachments"), {
            code: "invalid-input",
          });
        const requestedAttachments = attachmentsOf(launch?.attachments);
        if (launch?.attachments !== undefined && !requestedAttachments)
          throw Object.assign(new Error("invalid workflow attachments"), {
            code: "invalid-input",
          });
        const attachments = source
          ? requestedAttachments ?? sourceAttachments ?? []
          : requestedAttachments ?? [];
        const baseMessageEvents =
          launch?.context === "request"
            ? source
              ? [source]
              : []
            : events.filter(
                (event) =>
                  event.type === "user/message" ||
                  event.type === "assistant/message" ||
                  event.type === "assistant/chunk"
              );
        const messageEvents =
          source && !baseMessageEvents.includes(source)
            ? [...baseMessageEvents, source]
            : baseMessageEvents;
        const messageParts = new Map<string, string>();
        for (const event of messageEvents) {
          const data = event.data as { text?: unknown; partId?: unknown };
          if (typeof data.text !== "string") continue;
          const user = event.type === "user/message";
          const key = !user && typeof data.partId === "string" ? `assistant:${data.partId}` : event.id;
          const previous = messageParts.get(key);
          if (event.type === "assistant/chunk") {
            messageParts.set(key, `${previous ?? "Assistant: "}${data.text}`.slice(-12_000));
          } else if (data.text.trim()) {
            messageParts.set(key, `${user ? "User" : "Assistant"}: ${data.text.trim()}`.slice(-12_000));
          }
        }
        const messages = [...messageParts.values()]
          .join("\n")
          .slice(-12_000);
        const requestOnly =
          launch?.context === "request" &&
          !source &&
          typeof input === "string" &&
          input.trim()
            ? `User: ${input.trim().slice(0, 12_000)}`
            : "";
        return {
          ...(messages || requestOnly
            ? { conversation: messages || requestOnly }
            : {}),
          ...(attachments ? { attachments } : {}),
          ...(launch?.sourceMessageSeq !== undefined
            ? { sourceMessageSeq: launch.sourceMessageSeq }
            : {}),
        };
        },
        runNode: async (context, onUpdate) => {
          // Resolve who the node acts for before anything else: private
          // harnesses, account limits, chat ownership and authorship all
          // follow that person. A refusal here proves the node never ran.
          let person: SpaceContext;
          try {
            person = contextFor(spaceId, context.launchedBy);
          } catch (cause) {
            // No other route helps a run whose launcher left: it fails rather
            // than waiting for a fix only that person could make.
            throw Object.assign(cause as Error, {
              workflow: { retryable: true, phase: "pre-admission", fixable: false },
            });
          }
          const scoped = host.forSpace(person);
          // Resolve an explicit harness before creating a child. A failure at
          // this read-only boundary proves that this node has not executed.
          const project = await scoped.projects.get(context.projectId);
          const selection = context.node.harness ?? project?.defaults?.harness;
          const registry = host.services.get(serverServiceKey<HarnessRegistry>("harnesses"));
          if (registry && selection?.mode === "pinned" && project) {
            try {
              await registry.resolve({ space: person, spaceId,
                projectId: project.id, cwd: project.path, remote: Boolean(project.remote) }, selection);
            } catch (cause) {
              throw Object.assign(cause instanceof Error ? cause : new Error(String(cause)), {
                workflow: { retryable: true, phase: "pre-admission" },
              });
            }
          }
          return createWorkflowRunNode(scoped.sessions)(context, onUpdate);
        },
      });
      return service;
    })();
    services.set(spaceId, creation);
    try {
      const service = await creation;
      services.set(spaceId, service);
      return service;
    } catch (cause) {
      if (services.get(spaceId) === creation) services.delete(spaceId);
      throw cause;
    }
  };
  // The public service key is retained for package discovery compatibility,
  // but deliberately has no shared-store fallback. HTTP handlers always bind
  // a real service to rc.space before touching workflow state.
  const requiresSpace = (): never => {
    throw Object.assign(
      new Error("workflow service requires an explicit Space context"),
      { code: "unavailable" }
    );
  };
  const compatibility = new Proxy({} as WorkflowService, {
    get: () => requiresSpace,
  });
  host.services.provide(
    serverServiceKey<WorkflowService>("workflow"),
    compatibility
  );
  return {
    remoteAccess: localOnlyRemoteAccess(["workflow"]),
    onEnable: () => {
      ensureRegistered();
    },
    onDisable: () => {
      unregisterUse?.();
      unregisterUse = undefined;
    },
    routes: workflowRoutes(
      (space) => serviceFor(space),
      (projectId) => {
        /* seeded per Space in serviceFor */
      },
      host,
      actorOf
    ),
  };
}
