// HTTP face of the walkthrough plugin (PLAN §12/M3). Session-derived steps are
// fully rebuilt from the durable event log; generated walkthroughs (WP11) are
// jobs with immutable source digests, and reviews/flows are logged first.
import { decisionEventType, deriveWalkthrough, stepEventData } from "@polyth/walkthrough";
import type { SessionEvent, SessionPersistence, WalkthroughSource } from "@polyth/contracts";
import type { RouteHandler } from "../http.ts";
import type { WalkthroughJobService } from "../walkthroughs.ts";
import type { ReviewFlowService, ReviewResult } from "../review.ts";

const parseSource = (raw: unknown): WalkthroughSource => {
  const s = raw as { kind?: unknown; projectId?: unknown; base?: unknown; head?: unknown; number?: unknown };
  const projectId = String(s?.projectId ?? "");
  if (!projectId) throw Object.assign(new Error("source.projectId required"), { code: "invalid-input" });
  if (s.kind === "working-tree") return { kind: "working-tree", projectId };
  if (s.kind === "range") {
    const base = String(s.base ?? "");
    const head = String(s.head ?? "");
    if (!base || !head) throw Object.assign(new Error("range source needs base and head"), { code: "invalid-input" });
    return { kind: "range", projectId, base, head };
  }
  if (s.kind === "pull-request") {
    const number = Number(s.number);
    if (!Number.isInteger(number) || number <= 0) throw Object.assign(new Error("pull-request source needs a PR number"), { code: "invalid-input" });
    return { kind: "pull-request", projectId, number };
  }
  throw Object.assign(new Error("unknown source kind"), { code: "invalid-input" });
};

export function walkthroughRoutes(deps: {
  store: SessionPersistence;
  broadcast: { event(ev: SessionEvent): void };
  jobs?: WalkthroughJobService;
  review?: { generate(sessionId: string, source: WalkthroughSource): Promise<ReviewResult> };
  flow?: ReviewFlowService;
}): RouteHandler {
  return async ({ path, method, json, body }) => {
    // ---- generated walkthrough jobs (WP11) ---------------------------------
    if (deps.jobs && path === "/api/walkthroughs" && method === "POST") {
      const b = await body();
      const source = parseSource(b.source);
      const sessionId = b.sessionId ? String(b.sessionId) : undefined;
      json(200, await deps.jobs.create(source, sessionId));
      return true;
    }
    if (deps.jobs && path === "/api/walkthroughs" && method === "GET") {
      json(200, deps.jobs.list());
      return true;
    }
    let g = path.match(/^\/api\/walkthroughs\/([^/]+)$/);
    if (deps.jobs && g && method === "GET") {
      const job = deps.jobs.get(g[1]!);
      if (!job) { json(404, { error: "not-found" }); return true; }
      json(200, job);
      return true;
    }
    g = path.match(/^\/api\/walkthroughs\/([^/]+)\/cancel$/);
    if (deps.jobs && g && method === "POST") {
      const job = deps.jobs.cancel(g[1]!);
      if (!job) { json(404, { error: "not-found" }); return true; }
      json(200, job);
      return true;
    }
    g = path.match(/^\/api\/walkthroughs\/([^/]+)\/source-status$/);
    if (deps.jobs && g && method === "GET") {
      json(200, await deps.jobs.sourceStatus(g[1]!));
      return true;
    }

    // ---- structured review generation (WP11) -------------------------------
    let r = path.match(/^\/api\/sessions\/([^/]+)\/review\/generate$/);
    if (deps.review && r && method === "POST") {
      const b = await body();
      json(200, await deps.review.generate(r[1]!, parseSource(b.source)));
      return true;
    }

    // ---- bounded auto-review flow (WP11) ------------------------------------
    r = path.match(/^\/api\/sessions\/([^/]+)\/review-flow$/);
    if (deps.flow && r && method === "POST") {
      const b = await body();
      json(200, await deps.flow.create(r[1]!, {
        ...(b.maxIterations !== undefined ? { maxIterations: Number(b.maxIterations) } : {}),
      }));
      return true;
    }
    if (deps.flow && r && method === "GET") {
      const state = deps.flow.get(r[1]!);
      if (!state) { json(404, { error: "not-found" }); return true; }
      json(200, state);
      return true;
    }
    r = path.match(/^\/api\/sessions\/([^/]+)\/review-flow\/(pause|resume|stop)$/);
    if (deps.flow && r && method === "POST") {
      const action = r[2] as "pause" | "resume" | "stop";
      const state = await deps.flow[action](r[1]!);
      if (!state) { json(404, { error: "not-found" }); return true; }
      json(200, state);
      return true;
    }

    let m = path.match(/^\/api\/sessions\/([^/]+)\/walkthrough$/);
    if (m && method === "GET") {
      const events = await deps.store.events(m[1]!);
      json(200, { steps: deriveWalkthrough(events) });
      return true;
    }

    m = path.match(/^\/api\/sessions\/([^/]+)\/walkthrough\/(\d+)\/(approve|reject)$/);
    if (m && method === "POST") {
      const sessionId = m[1]!;
      const stepIndex = Number(m[2]);
      const decision = m[3] as "approve" | "reject";
      const events = await deps.store.events(sessionId);
      const steps = deriveWalkthrough(events);
      const step = steps[stepIndex];
      if (!step) { json(404, { error: "not-found" }); return true; }
      const ev = await deps.store.append(
        sessionId,
        decisionEventType(decision === "approve" ? "approved" : "rejected"),
        stepEventData(stepIndex, step),
        { ignorable: true },
      );
      deps.broadcast.event(ev);
      json(200, { ok: true });
      return true;
    }

    return false;
  };
}
