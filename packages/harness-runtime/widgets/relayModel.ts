// Pure helpers for the Relay group of the Accounts section.
import type { RelayMemberView, RelayView } from "@polyth/harness-runtime/relay";

export type { RelayMemberView, RelayView };
export type RelayTranslate = (key: string, values?: Record<string, string | number>) => string;

/** Included members in plan order, then the rest in server order. */
export function orderedMembers(view: RelayView): RelayMemberView[] {
  const included = view.members.filter((member) => member.included)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return [...included, ...view.members.filter((member) => !member.included)];
}

/** `members` for a PUT: the included ids in the shown order. */
export const includedIds = (rows: readonly RelayMemberView[]): string[] => rows.filter((row) => row.included).map((row) => row.harnessId);

/** Moves one included row by `delta` among the included rows. */
export function moveIncluded(rows: readonly RelayMemberView[], id: string, delta: -1 | 1): RelayMemberView[] {
  const ids = includedIds(rows);
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return [...rows];
  return reorderIncluded(rows, id, to);
}

/** Puts one included row at `to` (0-based among included rows). */
export function reorderIncluded(rows: readonly RelayMemberView[], id: string, to: number): RelayMemberView[] {
  const ids = includedIds(rows);
  const from = ids.indexOf(id);
  if (from < 0 || to < 0 || to >= ids.length || from === to) return [...rows];
  ids.splice(to, 0, ids.splice(from, 1)[0]!);
  const byId = new Map(rows.map((row) => [row.harnessId, row] as const));
  const sorted = ids.map((rowId, index) => ({ ...byId.get(rowId)!, position: index + 1 }));
  return [...sorted, ...rows.filter((row) => !row.included)];
}

/** Includes or excludes a member; a newly included one joins at the end. */
export function setIncluded(rows: readonly RelayMemberView[], id: string, included: boolean): RelayMemberView[] {
  const ids = includedIds(rows).filter((rowId) => rowId !== id);
  if (included) ids.push(id);
  const byId = new Map(rows.map((row) => [row.harnessId, row] as const));
  const sorted = ids.map((rowId, index) => ({ ...byId.get(rowId)!, included: true, position: index + 1 }));
  const rest = rows.filter((row) => !ids.includes(row.harnessId)).map((row) => {
    if (row.harnessId !== id) return row;
    const { position: _position, ...without } = row;
    return { ...without, included: false };
  });
  return [...sorted, ...rest];
}

/** "19:00" today, "Thu 19:00" on another day. */
export function refillTime(at: number, now: number, locale: string): string {
  const date = new Date(at);
  const clock = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === new Date(now).toDateString() ? clock : `${date.toLocaleDateString(locale, { weekday: "short" })} ${clock}`;
}

export function meterText(member: RelayMemberView, t: RelayTranslate, now: number, locale: string): string {
  const tightest = member.tightest;
  if (!tightest) return t("noReading");
  const values = { window: tightest.label || "·", percent: Math.round(tightest.remaining * 100) };
  return tightest.resetsAt !== undefined && tightest.resetsAt > now
    ? t("meter", { ...values, time: refillTime(tightest.resetsAt, now, locale) })
    : t("meterNoReset", values);
}

export function reasonText(member: RelayMemberView, t: RelayTranslate, now: number, locale: string): string | undefined {
  switch (member.reason) {
    case "signed-out": return t("reason.signedOut");
    case "refused": return t("reason.refused");
    case "no-access": return t("reason.noAccess");
    case "limit": return member.refillsAt !== undefined ? t("reason.limit", { time: refillTime(member.refillsAt, now, locale) }) : t("reason.limitUnknown");
    default: return undefined;
  }
}
