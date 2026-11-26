// Pure helpers for Relay inside the Accounts section.
import { RELAY_MIN_MEMBERS } from "@polyth/harness-runtime/relay";
import { refillTime, type RelayMemberView, type RelayTranslate, type RelayView } from "@polyth/harness-runtime/relay-ui";

/** The family has enough accounts this person may use to rotate between, so
 *  Settings offers Relay at all. */
export const relayAvailable = (view: Pick<RelayView, "members"> | undefined): boolean => (view?.members.length ?? 0) >= RELAY_MIN_MEMBERS;

/** Enough members to rotate: the server then lists `<family>-relay` in this
 *  person's harness list and picker (same rule as `FamilyRelay.listed`). */
export const relayListed = (rows: readonly Pick<RelayMemberView, "included">[]): boolean => rows.filter((row) => row.included).length >= RELAY_MIN_MEMBERS;

const STATE_RANK: Record<RelayMemberView["state"], number> = { now: 0, next: 1, queued: 2, exhausted: 3, skipped: 4 };

/** Included members in the order a Relay chat would try them now: the
 *  current one, the next, the rest of the queue, then those out of limit or
 *  skipped, each by position. */
export const routeMembers = (rows: readonly RelayMemberView[]): RelayMemberView[] => rows
  .filter((row) => row.included)
  .toSorted((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || (a.position ?? 0) - (b.position ?? 0));

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
