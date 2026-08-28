import type { SessionProjection } from "@polyth/contracts";

export interface SessionSearchQuery {
  text: string;
  waiting: boolean;
  running: boolean;
}

const WAITING_TOKEN = /(^|\s)is:waiting(?=\s|$)/gi;
const RUNNING_TOKEN = /(^|\s)is:running(?=\s|$)/gi;

export function parseSessionSearchQuery(raw: string): SessionSearchQuery {
  const waiting = /(^|\s)is:waiting(\s|$)/i.test(raw);
  const running = /(^|\s)is:running(\s|$)/i.test(raw);
  return {
    text: raw.replace(WAITING_TOKEN, " ").replace(RUNNING_TOKEN, " ").replace(/\s+/g, " ").trim(),
    waiting,
    running,
  };
}

export function matchesSessionSearchFacets(
  session: SessionProjection,
  query: Pick<SessionSearchQuery, "waiting" | "running">,
): boolean {
  const waiting = session.status === "waiting"
    || (session.attention?.questions ?? 0) > 0
    || (session.attention?.permissions ?? 0) > 0;
  if (query.waiting && !waiting) return false;
  if (query.running && session.status !== "working") return false;
  return true;
}
