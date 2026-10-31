// Typed calls onto the same HTTP API the web/mobile UI uses. The CLI never
// talks to a native harness; it only asks Polyth.
import { resolve, sep } from "node:path";
import { UsageError } from "./args.ts";
import { PolythError, type Client } from "./client.ts";

export interface Project {
  id: string;
  name: string;
  path: string;
  remote?: boolean;
}

export interface SessionSummary {
  id: string;
  projectId: string;
  parentId?: string;
  title?: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  lastTurnAt?: number;
  model?: { providerID: string; modelID: string };
  resolvedHarnessId?: string;
  worktreePath?: string;
  branch?: string;
  pinned?: boolean;
  attention?: { questions: number; permissions: number; unread: number; goalStatus?: string };
}

export interface SessionEvent {
  id: string;
  sessionId: string;
  seq: number;
  time: number;
  type: string;
  data: Record<string, unknown>;
  ignorable?: boolean;
}

export interface ReplayPage {
  events: SessionEvent[];
  cursor: number;
  highWater: number;
  complete: boolean;
}

export interface SummaryPage {
  sessions: SessionSummary[];
  next?: { updatedAt: number; id: string };
  complete: boolean;
  revision: number;
}

export interface WhoAmI {
  kind: string;
  userId: string | null;
  spaceId: string;
  role: string;
  deployment: string;
  version: string;
  tokenId?: string;
  tokenKind?: string;
  grants?: string[];
  pinnedSpace?: string | null;
  trustedCli?: boolean;
}

export const listProjects = (client: Client): Promise<Project[]> => client.get<Project[]>("/api/projects");

/** `-p` accepts an id, a name (case-insensitive) or a path; default is the
 *  project that contains the working directory. */
export async function resolveProject(client: Client, wanted: string | undefined, cwd = process.cwd()): Promise<Project> {
  const projects = await listProjects(client);
  if (wanted) {
    const byId = projects.find((p) => p.id === wanted);
    if (byId) return byId;
    const lower = wanted.toLowerCase();
    const byName = projects.filter((p) => p.name.toLowerCase() === lower);
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) throw new UsageError(`several projects are named "${wanted}"; use the id (polyth projects)`);
    const abs = resolve(cwd, wanted);
    const byPath = projects.find((p) => resolve(p.path) === abs);
    if (byPath) return byPath;
    const prefix = projects.filter((p) => p.id.startsWith(wanted));
    if (prefix.length === 1) return prefix[0]!;
    throw new UsageError(`no project "${wanted}"; see \`polyth projects\``);
  }
  const here = resolve(cwd);
  const containing = projects
    .filter((p) => !p.remote && (here === resolve(p.path) || here.startsWith(resolve(p.path) + sep)))
    .sort((a, b) => b.path.length - a.path.length);
  if (containing[0]) return containing[0];
  if (projects.length === 1) return projects[0]!;
  throw new UsageError("which project? pass -p <name|id|path> (the working directory is not inside a Polyth project)");
}

export async function summaries(client: Client, query: {
  projectId?: string; limit?: number; archived?: boolean; attentionOnly?: boolean; query?: string;
  waitMs?: number; updatedAfter?: number;
} = {}, signal?: AbortSignal): Promise<SummaryPage> {
  return client.get<SummaryPage>("/api/sessions/summaries", {
    query: {
      projectId: query.projectId,
      limit: query.limit ?? 50,
      ...(query.archived !== undefined ? { archived: query.archived } : {}),
      ...(query.attentionOnly ? { attentionOnly: true } : {}),
      ...(query.query ? { query: query.query } : {}),
      ...(query.waitMs ? { waitMs: query.waitMs, updatedAfter: query.updatedAfter ?? 0 } : {}),
    },
    ...(signal ? { signal } : {}),
    timeoutMs: (query.waitMs ?? 0) + 30_000,
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Full id, unique prefix (≥ 4 chars) among recent sessions, or `last`. */
export async function resolveSessionId(client: Client, wanted: string | undefined, projectId?: string): Promise<string> {
  if (!wanted) throw new UsageError("a session id is required (see `polyth sessions`)");
  if (UUID.test(wanted)) return wanted.toLowerCase();
  if (wanted === "last" || wanted === "-") {
    const page = await summaries(client, { ...(projectId ? { projectId } : {}), limit: 1 });
    const first = page.sessions[0];
    if (!first) throw new UsageError("there are no sessions yet");
    return first.id;
  }
  if (wanted.length < 4) throw new UsageError("use at least 4 characters of a session id");
  const page = await summaries(client, { ...(projectId ? { projectId } : {}), limit: 200 });
  const matches = page.sessions.filter((s) => s.id.startsWith(wanted.toLowerCase()));
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) throw new UsageError(`"${wanted}" matches ${matches.length} sessions; use more characters`);
  throw new PolythError(404, "not-found", `no recent session starts with "${wanted}"`);
}

export const session = (client: Client, id: string): Promise<SessionSummary & Record<string, unknown>> =>
  client.get(`/api/sessions/${encodeURIComponent(id)}`);

export async function replay(client: Client, id: string, afterSeq: number, waitMs = 0, signal?: AbortSignal): Promise<ReplayPage> {
  return client.get<ReplayPage>(`/api/sessions/${encodeURIComponent(id)}/events/forward`, {
    query: { afterSeq, ...(waitMs ? { waitMs } : {}) },
    ...(signal ? { signal } : {}),
    timeoutMs: waitMs + 30_000,
  });
}

/** Newest `limit` events (keyset page), oldest first. */
export async function tail(client: Client, id: string, limit: number): Promise<SessionEvent[]> {
  const page = await client.get<SessionEvent[] | { events: SessionEvent[] }>(`/api/sessions/${encodeURIComponent(id)}/events`, {
    query: { limit },
  });
  return Array.isArray(page) ? page : page.events ?? [];
}

/** Current last persisted sequence of a session. */
export async function highWater(client: Client, id: string): Promise<number> {
  const events = await tail(client, id, 1);
  return events.at(-1)?.seq ?? 0;
}

export function modelRef(raw: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!raw) return undefined;
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) throw new UsageError("--model must be provider/model (see `polyth models`)");
  return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) };
}

/** Deterministic UUID for an idempotency key: the same key always maps to the
 *  same server operation id (the server scopes it to the account). */
export async function operationIdFor(key: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update("polyth-cli\0").update(key).digest();
  digest[6] = (digest[6]! & 0x0f) | 0x40;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface OpenRequest {
  kind: "permission" | "question";
  sessionId: string;
  requestId: string;
  title: string;
  detail?: string;
  options?: Array<{ value: string; label: string }>;
  questionId?: string;
  seq: number;
}

/** Open permission/question requests derived from recent history. */
export function openRequests(events: SessionEvent[]): OpenRequest[] {
  const open = new Map<string, OpenRequest>();
  for (const event of events) {
    const d = event.data ?? {};
    const requestId = typeof d.requestId === "string" ? d.requestId : undefined;
    if (!requestId) continue;
    if (event.type === "permission/requested") {
      const patterns = Array.isArray(d.patterns) ? d.patterns.map(String) : [];
      open.set(requestId, {
        kind: "permission", sessionId: event.sessionId, requestId, seq: event.seq,
        title: String(d.permission ?? d.title ?? "permission"),
        ...(patterns.length ? { detail: patterns.join(" ").replace(/\s+/g, " ").slice(0, 300) } : {}),
      });
    } else if (event.type === "question/asked") {
      const questions = Array.isArray(d.questions) ? d.questions as Array<Record<string, unknown>> : [];
      const first = questions[0] ?? {};
      const options = Array.isArray(first.options)
        ? (first.options as Array<Record<string, unknown>>).map((o) => ({ value: String(o.value ?? o.label ?? ""), label: String(o.label ?? o.value ?? "") }))
        : undefined;
      open.set(requestId, {
        kind: "question", sessionId: event.sessionId, requestId, seq: event.seq,
        title: String(first.title ?? "question"),
        ...(first.prompt ? { detail: String(first.prompt) } : {}),
        ...(options?.length ? { options } : {}),
        ...(typeof first.id === "string" ? { questionId: first.id } : {}),
      });
    } else if (/^(permission\/resolved|question\/(answered|expired|rejected|cancelled|response-failed))$/.test(event.type)) {
      open.delete(requestId);
    }
  }
  return [...open.values()];
}
