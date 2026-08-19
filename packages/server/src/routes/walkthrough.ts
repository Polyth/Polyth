// HTTP face of the walkthrough plugin (PLAN §12/M3). Fully derived from the
// durable session event log on every request — no in-memory state to lose.
import { decisionEventType, deriveWalkthrough, stepEventData } from "@polyth/walkthrough";
import type { SessionEvent, SessionPersistence } from "@polyth/contracts";
import type { RouteHandler } from "../http.ts";

export function walkthroughRoutes(deps: {
  store: SessionPersistence;
  broadcast: { event(ev: SessionEvent): void };
}): RouteHandler {
  return async ({ path, method, json }) => {
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
