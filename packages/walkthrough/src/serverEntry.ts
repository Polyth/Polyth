import { join } from "node:path";
import type {
  GeneratedWalkthroughDto,
  JsonObject,
  ReviewAssessment,
  ReviewFlowState,
  RouteHandler,
  SessionEvent,
  SessionPersistence,
  WalkthroughSource,
} from "@polyth/contracts";
import {
  localOnlyRemoteAccess,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { decisionEventType, deriveWalkthrough, stepEventData } from "./index.ts";
import { createWalkthroughJobService } from "./jobs.ts";
import { createReviewFlowService, createReviewService } from "./reviewService.ts";

interface WalkthroughJobService {
  create(source: WalkthroughSource, sessionId?: string, userId?: string): Promise<GeneratedWalkthroughDto>;
  get(id: string): GeneratedWalkthroughDto | null;
  cancel(id: string): GeneratedWalkthroughDto | null;
  sourceStatus(id: string): Promise<{
    stale: boolean;
    sourceDigest: string;
    currentDigest: string;
  }>;
  list(): GeneratedWalkthroughDto[];
}

type ReviewResult =
  | { ok: true; reviewId: string; sourceDigest: string; assessment: ReviewAssessment }
  | { ok: false; reason: string };

interface ReviewService {
  generate(sessionId: string, source: WalkthroughSource, userId?: string): Promise<ReviewResult>;
}

interface ReviewFlowService {
  create(sessionId: string, opts?: { maxIterations?: number }, userId?: string): Promise<ReviewFlowState>;
  get(sessionId: string): ReviewFlowState | null;
  pause(sessionId: string): Promise<ReviewFlowState | null>;
  resume(sessionId: string): Promise<ReviewFlowState | null>;
  stop(sessionId: string): Promise<ReviewFlowState | null>;
  tick(): Promise<void>;
}

const parseSource = (raw: unknown): WalkthroughSource => {
  const source = raw as {
    kind?: unknown;
    projectId?: unknown;
    base?: unknown;
    head?: unknown;
    number?: unknown;
  };
  const projectId = String(source?.projectId ?? "");
  if (!projectId) {
    throw Object.assign(new Error("source.projectId required"), { code: "invalid-input" });
  }
  if (source.kind === "working-tree") return { kind: "working-tree", projectId };
  if (source.kind === "range") {
    const base = String(source.base ?? "");
    const head = String(source.head ?? "");
    if (!base || !head) {
      throw Object.assign(new Error("range source needs base and head"), {
        code: "invalid-input",
      });
    }
    return { kind: "range", projectId, base, head };
  }
  if (source.kind === "pull-request") {
    const number = Number(source.number);
    if (!Number.isInteger(number) || number <= 0) {
      throw Object.assign(new Error("pull-request source needs a PR number"), {
        code: "invalid-input",
      });
    }
    return { kind: "pull-request", projectId, number };
  }
  throw Object.assign(new Error("unknown source kind"), { code: "invalid-input" });
};

export function walkthroughRoutes(deps: {
  store: SessionPersistence;
  broadcast: { event(event: SessionEvent): void };
  jobs?: WalkthroughJobService;
  review?: ReviewService;
  flow?: ReviewFlowService;
}): RouteHandler {
  return async (rc) => {
    const { path, method, json, body } = rc;
    if (deps.jobs && path === "/api/walkthroughs" && method === "POST") {
      const input = await body();
      json(200, await deps.jobs.create(
        parseSource(input.source),
        input.sessionId ? String(input.sessionId) : undefined,
        rc.space.userId,
      ));
      return true;
    }
    if (deps.jobs && path === "/api/walkthroughs" && method === "GET") {
      json(200, deps.jobs.list());
      return true;
    }
    let match = path.match(/^\/api\/walkthroughs\/([^/]+)$/);
    if (deps.jobs && match && method === "GET") {
      const job = deps.jobs.get(match[1]!);
      if (!job) {
        json(404, { error: "not-found" });
        return true;
      }
      json(200, job);
      return true;
    }
    match = path.match(/^\/api\/walkthroughs\/([^/]+)\/cancel$/);
    if (deps.jobs && match && method === "POST") {
      const job = deps.jobs.cancel(match[1]!);
      if (!job) {
        json(404, { error: "not-found" });
        return true;
      }
      json(200, job);
      return true;
    }
    match = path.match(/^\/api\/walkthroughs\/([^/]+)\/source-status$/);
    if (deps.jobs && match && method === "GET") {
      json(200, await deps.jobs.sourceStatus(match[1]!));
      return true;
    }

    let reviewMatch = path.match(/^\/api\/sessions\/([^/]+)\/review\/generate$/);
    if (deps.review && reviewMatch && method === "POST") {
      const input = await body();
      json(200, await deps.review.generate(reviewMatch[1]!, parseSource(input.source), rc.space.userId));
      return true;
    }
    reviewMatch = path.match(/^\/api\/sessions\/([^/]+)\/review-flow$/);
    if (deps.flow && reviewMatch && method === "POST") {
      const input = await body();
      json(200, await deps.flow.create(reviewMatch[1]!, {
        ...(input.maxIterations !== undefined
          ? { maxIterations: Number(input.maxIterations) }
          : {}),
      }, rc.space.userId));
      return true;
    }
    if (deps.flow && reviewMatch && method === "GET") {
      const state = deps.flow.get(reviewMatch[1]!);
      if (!state) {
        json(404, { error: "not-found" });
        return true;
      }
      json(200, state);
      return true;
    }
    reviewMatch = path.match(
      /^\/api\/sessions\/([^/]+)\/review-flow\/(pause|resume|stop)$/,
    );
    if (deps.flow && reviewMatch && method === "POST") {
      const action = reviewMatch[2] as "pause" | "resume" | "stop";
      const state = await deps.flow[action](reviewMatch[1]!);
      if (!state) {
        json(404, { error: "not-found" });
        return true;
      }
      json(200, state);
      return true;
    }

    match = path.match(/^\/api\/sessions\/([^/]+)\/walkthrough$/);
    if (match && method === "GET") {
      json(200, { steps: deriveWalkthrough(await deps.store.events(match[1]!)) });
      return true;
    }
    match = path.match(
      /^\/api\/sessions\/([^/]+)\/walkthrough\/(\d+)\/(approve|reject)$/,
    );
    if (match && method === "POST") {
      const sessionId = match[1]!;
      const stepIndex = Number(match[2]);
      const decision = match[3] as "approve" | "reject";
      const step = deriveWalkthrough(await deps.store.events(sessionId))[stepIndex];
      if (!step) {
        json(404, { error: "not-found" });
        return true;
      }
      const event = await deps.store.append(
        sessionId,
        decisionEventType(decision === "approve" ? "approved" : "rejected"),
        stepEventData(stepIndex, step),
        { ignorable: true },
      );
      deps.broadcast.event(event);
      json(200, { ok: true });
      return true;
    }
    return false;
  };
}

/** Minimal structural views of the git/github services this package consumes
 *  for diff capture — resolved lazily from the shared service registry, so
 *  neither package is a build-time dependency. */
interface DiffGitService {
  diffHead(root: string): Promise<string>;
  diffRange(root: string, base: string, head: string): Promise<string>;
}
interface DiffGithubService {
  prDiff(
    cwd: string,
    number: number,
  ): Promise<{ ok: true; data: string } | { ok: false; reason: string }>;
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  // WP11: generated walkthroughs, structured reviews, bounded review flow.
  // The source diff is captured through git/gh only; the model call is a
  // small-model utility request on the project's runtime (never a user session).
  const captureDiff = async (source: WalkthroughSource): Promise<string> => {
    const project = await host.projects.get(source.projectId);
    if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
    const git = host.services.require(serverServiceKey<DiffGitService>("git"));
    if (source.kind === "working-tree") return git.diffHead(project.path);
    if (source.kind === "range") return git.diffRange(project.path, source.base, source.head);
    const github = host.services.require(serverServiceKey<DiffGithubService>("github"));
    const r = await github.prDiff(project.path, source.number);
    if (!r.ok) throw Object.assign(new Error(r.reason), { code: "invalid-input" });
    return r.data;
  };
  const generate = async (
    source: WalkthroughSource,
    prompt: string,
    signal?: AbortSignal,
    userId?: string,
  ): Promise<string> => {
    const project = await host.projects.get(source.projectId);
    const model = host.smallModel(userId);
    const rt = await host.runtimes.forProject(source.projectId, project?.path, model?.harnessId);
    const result = await host.smallModelComplete(rt, {
      cwd: project?.path ?? process.cwd(),
      prompt,
      ...(model ? { model } : {}),
      maxOutputTokens: 2_048,
      timeoutMs: 180_000,
      ...(signal ? { signal } : {}),
    });
    return result.text;
  };
  const inputBudget = async (source: WalkthroughSource, userId?: string): Promise<number> => {
    const model = host.smallModel(userId);
    const rt = await host.runtimes.forProject(source.projectId, undefined, model?.harnessId);
    return host.smallModelInputBudget(rt, model, 2_048);
  };
  const append = (sessionId: string, type: string, data: JsonObject) =>
    host.events.append(sessionId, type, data, { ignorable: true, producerPlugin: "review" });

  const jobs = createWalkthroughJobService({
    captureDiff,
    generate,
    append,
    cacheFile: join(host.storageDir, "walkthroughs.json"),
    inputBudget,
    modelId: (userId) => {
      const model = host.smallModel(userId);
      return model
        ? `${model.harnessId ?? "auto"}/${model.providerID}/${model.modelID}`
        : undefined;
    },
  });
  const review = createReviewService({ captureDiff, generate, append });
  const flow = createReviewFlowService({
    sessionStatus: async (sessionId) => (await host.store.projection(sessionId))?.status ?? null,
    sessionProject: async (sessionId) => (await host.store.projection(sessionId))?.projectId ?? null,
    send: async (sessionId, text) => { await host.sessions.send(sessionId, { text }); },
    review: (sessionId, source, userId) => review.generate(sessionId, source, userId),
    append,
  });
  host.services.provide(serverServiceKey<WalkthroughJobService>("walkthrough.jobs"), jobs);
  host.services.provide(serverServiceKey<ReviewService>("review"), review);
  host.services.provide(serverServiceKey<ReviewFlowService>("review.flow"), flow);

  const routes = walkthroughRoutes({
    store: host.store,
    broadcast: host.broadcast,
    jobs,
    review,
    flow,
  });
  let flowTimer: ReturnType<typeof setInterval> | null = null;
  return {
    remoteAccess: localOnlyRemoteAccess(["walkthrough"]),
    routes,
    onEnable() {
      if (flowTimer) {
        clearInterval(flowTimer);
        flowTimer = null;
      }
      flowTimer = setInterval(() => void flow.tick(), 4_000);
      flowTimer.unref?.();
    },
    onDisable() {
      if (flowTimer) clearInterval(flowTimer);
      flowTimer = null;
    },
  };
}
