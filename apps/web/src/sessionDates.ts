import type { SessionProjection } from "@polyth/contracts";

const DAY_MS = 24 * 60 * 60_000;

export type SessionDateFilterMode = "all" | "date" | "range";

export interface SessionDateFilter {
  mode: SessionDateFilterMode;
  date: string;
  from: string;
  to: string;
}

export const EMPTY_SESSION_DATE_FILTER: SessionDateFilter = {
  mode: "all",
  date: "",
  from: "",
  to: "",
};

export function sessionActivityAt(
  session: Pick<SessionProjection, "createdAt" | "lastTurnAt">,
): number {
  return session.lastTurnAt ?? session.createdAt;
}

/** HTML date controls and filtering both use the viewer's local calendar day.
 * Comparing YYYY-MM-DD keys keeps the range inclusive without DST arithmetic. */
export function sessionDateInputValue(timestamp: number): string {
  const date = new Date(timestamp);
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function sessionDateDaysAgoInputValue(days: number, now = Date.now()): string {
  const date = new Date(now);
  date.setDate(date.getDate() - Math.max(0, days));
  return sessionDateInputValue(date.getTime());
}

export function sessionDateFilterActive(filter: SessionDateFilter): boolean {
  if (filter.mode === "date") return filter.date !== "";
  if (filter.mode === "range") return filter.from !== "" || filter.to !== "";
  return false;
}

export function sessionMatchesDateFilter(
  session: Pick<SessionProjection, "createdAt" | "lastTurnAt">,
  filter: SessionDateFilter,
): boolean {
  if (!sessionDateFilterActive(filter)) return true;
  const day = sessionDateInputValue(sessionActivityAt(session));
  if (filter.mode === "date") return day === filter.date;
  return (!filter.from || day >= filter.from) && (!filter.to || day <= filter.to);
}

/** Pinned chats are an explicit user priority. Everything else is strictly
 * chronological; metadata-only updates such as rename do not move a chat. */
export function compareSessionNavigation(a: SessionProjection, b: SessionProjection): number {
  const aPinned = a.pinned !== undefined;
  const bPinned = b.pinned !== undefined;
  if (aPinned !== bPinned) return aPinned ? -1 : 1;
  if (aPinned && bPinned) {
    const byPosition = a.pinned!.position - b.pinned!.position;
    if (byPosition !== 0) return byPosition;
  }
  return sessionActivityAt(b) - sessionActivityAt(a) || a.id.localeCompare(b.id);
}

export function sortPinnedSessions(sessions: readonly SessionProjection[]): SessionProjection[] {
  return sessions.filter((session) => session.pinned !== undefined).sort(compareSessionNavigation);
}

export interface SessionDateGroup<T> {
  key: string;
  timestamp: number;
  sessions: T[];
}

/** Group an already chronologically ordered list without changing its order. */
export function groupSessionsByActivityDate<
  T extends Pick<SessionProjection, "createdAt" | "lastTurnAt">,
>(sessions: readonly T[]): SessionDateGroup<T>[] {
  const groups: SessionDateGroup<T>[] = [];
  for (const session of sessions) {
    const timestamp = sessionActivityAt(session);
    const key = sessionDateInputValue(timestamp);
    const previous = groups.at(-1);
    if (previous?.key === key) previous.sessions.push(session);
    else groups.push({ key, timestamp, sessions: [session] });
  }
  return groups;
}

function localDayOrdinal(timestamp: number): number {
  const date = new Date(timestamp);
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

export function sessionDateGroupLabel(
  timestamp: number,
  relative: boolean,
  locale: string,
  now = Date.now(),
): string {
  const date = new Date(timestamp);
  const current = new Date(now);
  const dayDifference = localDayOrdinal(timestamp) - localDayOrdinal(now);
  if (relative && dayDifference >= -6 && dayDifference <= 1) {
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(dayDifference, "day");
  }
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === current.getFullYear() ? {} : { year: "numeric" }),
  }).format(date);
}
