import type {
  GeneratedWalkthroughDto,
  ReviewAssessment,
  ReviewFlowState,
  RouteHandler,
  SessionEvent,
  SessionPersistence,
  WalkthroughSource,
} from "@polyth/contracts";
import {
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { decisionEventType, deriveWalkthrough, stepEventData } from "./index.ts";

interface WalkthroughJobService {
  create(source: WalkthroughSource, sessionId?: string): Promise<GeneratedWalkthroughDto>;
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
  generate(sessionId: string, source: WalkthroughSource): Promise<ReviewResult>;
}

interface ReviewFlowService {
  create(sessionId: string, opts?: { maxIterations?: number }): Promise<ReviewFlowState>;
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
  return async ({ path, method, json, body }) => {
    if (deps.jobs && path === "/api/walkthroughs" && method === "POST") {
      const input = await body();
      json(200, await deps.jobs.create(
        parseSource(input.source),
        input.sessionId ? String(input.sessionId) : undefined,
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
      json(200, await deps.review.generate(reviewMatch[1]!, parseSource(input.source)));
      return true;
    }
    reviewMatch = path.match(/^\/api\/sessions\/([^/]+)\/review-flow$/);
    if (deps.flow && reviewMatch && method === "POST") {
      const input = await body();
      json(200, await deps.flow.create(reviewMatch[1]!, {
        ...(input.maxIterations !== undefined
          ? { maxIterations: Number(input.maxIterations) }
          : {}),
      }));
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

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  let routes: RouteHandler | null = null;
  let flow: ReviewFlowService | null = null;
  let flowTimer: ReturnType<typeof setInterval> | null = null;
  return {
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      const jobs = host.services.require(
        serverServiceKey<WalkthroughJobService>("walkthrough.jobs"),
      );
      const review = host.services.require(
        serverServiceKey<ReviewService>("review"),
      );
      flow = host.services.require(
        serverServiceKey<ReviewFlowService>("review.flow"),
      );
      routes ??= walkthroughRoutes({
        store: host.store,
        broadcast: host.broadcast,
        jobs,
        review,
        flow,
      });
      flowTimer = setInterval(() => void flow?.tick(), 4_000);
      flowTimer.unref?.();
    },
    onDisable() {
      if (flowTimer) clearInterval(flowTimer);
      flowTimer = null;
    },
  };
}
