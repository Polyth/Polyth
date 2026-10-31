// Pure helpers for the phone session island: what the compact pill shows,
// which sessions belong in the expanded sheet, and whether a cached log
// recorded an edit. DOM-free so node:test can cover the priority rules.
import { draftTitleSource } from "./sessionDraft.ts";
import type { JsonObject, SessionEvent, SessionProjection } from "@polyth/contracts";
import { latestTodoItemsFromMessages } from "@polyth/todos";
import { displaySessionTitle, titleFromPrompt } from "./format.ts";
import { getLocale } from "./i18n/index.ts";
import { sessionDateGroupLabel } from "./sessionDates.ts";
import { extractChangedFiles } from "./pendingChanges.ts";
import type {
  PendingPermission,
  PendingQuestion,
  PendingSecret,
  RenderMessage,
  TaskActivityMsg,
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

export interface RecentSessionDayGroup {
  key: string;
  label: string;
  sessions: SessionProjection[];
}

export function recentSessionTimestamp(session: Pick<SessionProjection, "lastTurnAt" | "createdAt">): number {
  return session.lastTurnAt ?? session.createdAt;
}

function recentSessionDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Group an already ordered recent-session window in the user's local day. */
export function groupRecentSessionsByDay(
  sessions: readonly SessionProjection[],
  locale = getLocale(),
  now = Date.now(),
): RecentSessionDayGroup[] {
  const groups: RecentSessionDayGroup[] = [];
  const seen = new Set<string>();
  const byDay = new Map<string, RecentSessionDayGroup>();
  for (const session of sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    const timestamp = recentSessionTimestamp(session);
    const key = recentSessionDayKey(timestamp);
    let group = byDay.get(key);
    if (!group) {
      group = { key, label: sessionDateGroupLabel(timestamp, true, locale, now), sessions: [] };
      byDay.set(key, group);
      groups.push(group);
    }
    group.sessions.push(session);
  }
  return groups;
}

export type SessionLocation = Pick<SessionProjection, "isolation" | "branch" | "worktreePath">;

/** A managed isolation is also a worktree-backed session, so callers can
 * render both the branch and lock affordances without inferring from color. */
export function isIsolatedSession(session: SessionLocation): boolean {
  return session.isolation?.kind === "git-worktree"
    || (session.branch ?? "").startsWith("polyth/isolate/");
}

export function hasWorktreeSession(session: SessionLocation): boolean {
  return Boolean(session.worktreePath) || isIsolatedSession(session);
}

export interface ProjectSessionStatusCounts {
  active: number;
  waiting: number;
  unread: number;
  failed: number;
  /** Paused on a provider limit until the server re-sends automatically. */
  limited: number;
}

export function projectSessionStatusCounts(
  sessions: readonly SessionProjection[],
  now = Date.now(),
): ProjectSessionStatusCounts {
  const counts: ProjectSessionStatusCounts = { active: 0, waiting: 0, unread: 0, failed: 0, limited: 0 };
  for (const session of sessions) {
    if (session.status === "archived") continue;
    const kind = resolveSessionStatus(session, now).kind;
    if (kind === "working") counts.active += 1;
    else if (kind === "needs-reply" || kind === "needs-approval") counts.waiting += 1;
    else if (kind === "unread") counts.unread += 1;
    else if (kind === "failed") counts.failed += 1;
    else if (kind === "rate-limited") counts.limited += 1;
  }
  return counts;
}

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
  return latestTodoItemsFromMessages(messages, { fallbackId: (index) => `todo-${index}` }) ?? [];
}

/** Active task if one exists; otherwise the latest item in the snapshot. */
export function lastTask(tasks: IslandTask[] | undefined): IslandTask | undefined {
  if (!tasks || tasks.length === 0) return undefined;
  return tasks.find((task) => task.status === "active") ?? tasks[tasks.length - 1];
}

/** Latest explicit task start, used for the phone title's brief handoff. */
export function latestStartedTask(messages: readonly RenderMessage[]): TaskActivityMsg | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.kind === "task" && message.action === "started") return message;
  }
  return undefined;
}

export function requestLabel(permission: PendingPermission): string {
  return permission.preview?.title
    || permission.tool
    || permission.permission
    || permission.patterns[0]
    || "";
}

export function questionLabel(question: PendingQuestion): string {
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
  if (status.kind === "failed" || status.kind === "rate-limited") return status.label;
  return labels.peer;
}

export function sessionTitleOf(
  session: SessionProjection,
  events: Record<string, readonly SessionEvent[] | undefined>,
): string {
  return displaySessionTitle(session.title, session.id, firstUserTextCached(events[session.id]) ?? draftTitleSource(session));
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

function overviewStatusRank(session: SessionProjection, now = Date.now()): number {
  const kind = resolveSessionStatus(session, now).kind;
  if (kind === "needs-approval") return 0;
  if (kind === "needs-reply") return 1;
  if (kind === "working") return 2;
  if (kind === "failed") return 3;
  if (kind === "epoch-pending") return 4;
  if (kind === "reconciling") return 5;
  if (kind === "unknown") return 6;
  return 8;
}

function isOverviewActive(session: SessionProjection, now = Date.now()): boolean {
  const kind = resolveSessionStatus(session, now).kind;
  return kind !== "regular" && kind !== "resume-ready" && kind !== "unread";
}

/** Sessions that need a visible live state, with the current session first.
 * The current session stays in this list even while idle so the overview has a
 * stable selected home without reintroducing a separate current-task card. */
export function activeSessionsForIsland(
  sessions: readonly SessionProjection[],
  activeId: string | undefined,
  limit?: number,
  now = Date.now(),
): SessionProjection[] {
  const rows = sessions
    .filter((session) => session.status !== "archived" && (session.id === activeId || isOverviewActive(session, now)))
    .sort((a, b) => {
      if (a.id === activeId) return b.id === activeId ? 0 : -1;
      if (b.id === activeId) return 1;
      const byStatus = overviewStatusRank(a, now) - overviewStatusRank(b, now);
      if (byStatus !== 0) return byStatus;
      const byActivity = recentSessionTimestamp(b) - recentSessionTimestamp(a);
      return byActivity !== 0 ? byActivity : a.id.localeCompare(b.id);
    });
  return limit === undefined ? rows : rows.slice(0, limit);
}

/** Chronological history only: live/attention sessions have their own section,
 * and the currently open session is never repeated in Recent. */
export function recentSessionsForIsland(
  sessions: readonly SessionProjection[],
  activeId: string | undefined,
  limit = ISLAND_RECENT_LIMIT,
  now = Date.now(),
): SessionProjection[] {
  const seen = new Set<string>();
  return [...sessions]
    .filter((session) => session.status !== "archived" && session.id !== activeId && !isOverviewActive(session, now))
    .sort((a, b) => {
      const byActivity = recentSessionTimestamp(b) - recentSessionTimestamp(a);
      return byActivity !== 0 ? byActivity : a.id.localeCompare(b.id);
    })
    .filter((session) => {
      if (seen.has(session.id)) return false;
      seen.add(session.id);
      return true;
    })
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
