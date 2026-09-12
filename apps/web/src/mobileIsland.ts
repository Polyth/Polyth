// Pure helpers for the phone session island: what the compact pill shows,
// which sessions belong in the expanded sheet, and whether a cached log
// recorded an edit. DOM-free so node:test can cover the priority rules.
import type { JsonObject, SessionEvent, SessionProjection } from "@polyth/contracts";
import { displaySessionTitle, titleFromPrompt } from "./format.ts";
import { extractChangedFiles } from "./pendingChanges.ts";
import type {
  PendingPermission,
  PendingQuestion,
  PendingSecret,
  RenderMessage,
  TaskListState,
} from "./reduce.ts";
import { resolveSessionStatus, type SessionRowStatus } from "./sessionStatus.ts";
import { firstUserTextCached } from "./utils.ts";

export const ISLAND_RECENT_LIMIT = 8;
export const ISLAND_PEER_LIMIT = 2;
export const ISLAND_PROMPT_EXCERPT = 88;

export type IslandKind = "request" | "task" | "peer" | "session";

export interface IslandItem {
  id: string;
  kind: IslandKind;
  mark: string;
  text: string;
  live?: boolean;
  tone?: string;
}

export interface IslandLabels {
  task: string;
  request: string;
  session: string;
  peer: string;
  working: string;
  newChat: string;
}

export type IslandTask = TaskListState["items"][number];

const TODO_STATUS: Record<string, IslandTask["status"]> = {
  pending: "pending",
  queued: "pending",
  todo: "pending",
  in_progress: "active",
  inprogress: "active",
  active: "active",
  running: "active",
  working: "active",
  completed: "done",
  complete: "done",
  done: "done",
  success: "done",
  succeeded: "done",
  cancelled: "failed",
  canceled: "failed",
  failed: "failed",
  error: "failed",
};

export function promptExcerpt(text: string, max = ISLAND_PROMPT_EXCERPT): string {
  return titleFromPrompt(text, max);
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function eventsHaveCodeChangesUncached(events: readonly SessionEvent[]): boolean {
  const tools = new Map<string, string>();
  for (const ev of events) {
    if (ev.type !== "tool/call" && ev.type !== "tool/started" && ev.type !== "tool/result") continue;
    const data = asObject(ev.data) ?? {};
    const callId = typeof data.callId === "string" ? data.callId : "";
    if (typeof data.tool === "string" && data.tool && callId) tools.set(callId, data.tool);
    const tool = (typeof data.tool === "string" && data.tool) || (callId ? tools.get(callId) ?? "" : "");
    const input = asObject(data.input) ?? {};
    const metadata = asObject(data.metadata);
    if (extractChangedFiles(tool, input, metadata).length > 0) return true;
  }
  return false;
}

const codeChangeCache = new WeakMap<readonly SessionEvent[], boolean>();

/** True when the cached log contains at least one edit-like tool write. */
export function eventsHaveCodeChanges(events: readonly SessionEvent[] | undefined): boolean {
  if (!events || events.length === 0) return false;
  const cached = codeChangeCache.get(events);
  if (cached !== undefined) return cached;
  const value = eventsHaveCodeChangesUncached(events);
  codeChangeCache.set(events, value);
  return value;
}

function todoTool(tool: string): boolean {
  const normalized = tool.toLowerCase().replace(/[^a-z]/g, "");
  return normalized === "todowrite" || normalized === "todo";
}

function todoItems(value: unknown): IslandTask[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: IslandTask[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const row = candidate as Record<string, unknown>;
    const text = typeof row.content === "string" ? row.content.trim()
      : typeof row.text === "string" ? row.text.trim()
        : typeof row.description === "string" ? row.description.trim()
          : "";
    if (!text) continue;
    const rawStatus = typeof row.status === "string"
      ? row.status.trim().toLowerCase().replace(/[\s-]+/g, "_")
      : "pending";
    items.push({
      id: typeof row.id === "string" ? row.id
        : typeof row.id === "number" ? String(row.id)
          : `todo-${index}`,
      text,
      status: TODO_STATUS[rawStatus] ?? "pending",
    });
  }
  return items;
}

/**
 * Canonical task snapshots win. Harnesses that only expose TodoWrite as a
 * normal tool call still get a persistent checklist in the overview, including
 * the final completed snapshot after the turn has ended.
 */
export function tasksForIsland(
  tasks: TaskListState | null | undefined,
  messages: readonly RenderMessage[],
): IslandTask[] {
  if (tasks) return tasks.items;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.kind !== "tool" || !todoTool(message.tool)) continue;
    const source = message.input.todos ?? message.input.tasks ?? message.input.items;
    const items = todoItems(source);
    if (items !== undefined) return items;
  }
  return [];
}

/** Active task if one exists; otherwise the latest item in the snapshot. */
export function lastTask(tasks: IslandTask[] | undefined): IslandTask | undefined {
  if (!tasks || tasks.length === 0) return undefined;
  return tasks.find((task) => task.status === "active") ?? tasks[tasks.length - 1];
}

function requestLabel(permission: PendingPermission): string {
  return permission.preview?.title
    || permission.tool
    || permission.permission
    || permission.patterns[0]
    || "";
}

function questionLabel(question: PendingQuestion): string {
  const first = question.questions[0];
  if (!first) return "";
  for (const key of ["prompt", "question", "text", "message", "title"] as const) {
    const value = first[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function peerMark(status: SessionRowStatus, labels: IslandLabels): string {
  if (status.kind === "needs-approval" || status.kind === "needs-reply") return labels.request;
  if (status.kind === "working") return labels.working;
  if (status.kind === "failed") return status.label;
  return labels.peer;
}

export function sessionTitleOf(
  session: SessionProjection,
  events: Record<string, readonly SessionEvent[] | undefined>,
): string {
  return displaySessionTitle(session.title, session.id, firstUserTextCached(events[session.id]));
}

export function notablePeers(
  sessions: readonly SessionProjection[],
  activeId: string | undefined,
  events: Record<string, readonly SessionEvent[] | undefined>,
  limit = ISLAND_PEER_LIMIT,
): Array<{ id: string; title: string; status: SessionRowStatus }> {
  const rank = (kind: SessionRowStatus["kind"]): number => {
    if (kind === "needs-approval") return 0;
    if (kind === "needs-reply") return 1;
    if (kind === "working") return 2;
    if (kind === "failed") return 3;
    if (kind === "unread") return 4;
    return 8;
  };
  return sessions
    .filter((session) => session.id !== activeId && session.status !== "archived")
    .map((session) => ({
      session,
      status: resolveSessionStatus(session),
      title: sessionTitleOf(session, events),
    }))
    .filter((row) => rank(row.status.kind) < 8)
    .sort((a, b) => {
      const byKind = rank(a.status.kind) - rank(b.status.kind);
      if (byKind !== 0) return byKind;
      return (b.session.lastTurnAt ?? b.session.createdAt) - (a.session.lastTurnAt ?? a.session.createdAt);
    })
    .slice(0, limit)
    .map((row) => ({ id: row.session.id, title: row.title, status: row.status }));
}

export function recentSessionsForIsland(
  sessions: readonly SessionProjection[],
  activeId: string | undefined,
  limit = ISLAND_RECENT_LIMIT,
): SessionProjection[] {
  return sessions
    .filter((session) => session.status !== "archived" && session.id !== activeId)
    .sort((a, b) => (b.lastTurnAt ?? b.createdAt) - (a.lastTurnAt ?? a.createdAt))
    .slice(0, limit);
}

export function buildIslandItems(input: {
  sessionTitle: string;
  hasSession: boolean;
  tasks: IslandTask[] | undefined;
  permissions: readonly PendingPermission[];
  questions: readonly PendingQuestion[];
  secrets: readonly PendingSecret[];
  peers: Array<{ id: string; title: string; status: SessionRowStatus }>;
  labels: IslandLabels;
}): IslandItem[] {
  const items: IslandItem[] = [];
  const pendingPermissions = input.permissions.filter((item) => item.status === "pending").slice(0, 1);
  const pendingQuestions = input.questions.filter((item) => item.status === "pending").slice(0, 1);
  const pendingSecrets = input.secrets.filter((item) => item.status === "pending").slice(0, 1);

  for (const permission of pendingPermissions) {
    items.push({
      id: `perm:${permission.requestId}`,
      kind: "request",
      mark: input.labels.request,
      text: requestLabel(permission) || input.labels.request,
      live: true,
      tone: "needs-approval",
    });
  }
  for (const question of pendingQuestions) {
    items.push({
      id: `q:${question.requestId}`,
      kind: "request",
      mark: input.labels.request,
      text: questionLabel(question) || input.labels.request,
      live: true,
      tone: "needs-reply",
    });
  }
  if (pendingPermissions.length === 0) {
    for (const secret of pendingSecrets) {
      items.push({
        id: `secret:${secret.requestId}`,
        kind: "request",
        mark: input.labels.request,
        text: secret.label || secret.handle,
        live: true,
        tone: "needs-approval",
      });
    }
  }

  const task = lastTask(input.tasks);
  if (task) {
    items.push({
      id: `task:${task.id}`,
      kind: "task",
      mark: input.labels.task,
      text: task.text,
      live: task.status === "active",
      tone: task.status,
    });
  }

  for (const peer of input.peers) {
    const isRequest = peer.status.kind === "needs-approval" || peer.status.kind === "needs-reply";
    items.push({
      id: `peer:${peer.id}`,
      kind: isRequest ? "request" : "peer",
      mark: peerMark(peer.status, input.labels),
      text: peer.title,
      live: peer.status.kind === "working" || isRequest,
      tone: peer.status.kind,
    });
  }

  if (items.length === 0) {
    items.push({
      id: "session",
      kind: "session",
      mark: input.labels.session,
      text: input.hasSession ? input.sessionTitle : input.labels.newChat,
    });
  }
  return items;
}
