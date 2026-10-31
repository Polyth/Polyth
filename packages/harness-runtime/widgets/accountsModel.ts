// Pure presentation rules for Settings → Harnesses → harness → Accounts
// (Spaces §13): which group a row belongs to, how its access reads, and the
// body an access edit sends.
import type { HarnessAccountAccessUpdate } from "@polyth/contracts";

export type AccountRow = {
  id: string;
  harnessId: string;
  name: string;
  /** The caller may rename and remove this account. */
  removable: boolean;
  /** Only the person who added it sees and uses it. */
  private?: boolean;
  /** A private account the caller added. */
  mine?: boolean;
  /** The caller may run chats on it in the current Space. Absent on an older
   *  server, which only listed accounts the caller could use. */
  usable?: boolean;
  /** The caller may choose who uses this shared account; the lists below are
   *  then present (absent = everyone / every Space). */
  accessEditable?: boolean;
  allowedUserIds?: string[];
  allowedSpaceIds?: string[];
  signInCommand?: string;
  status: { loggedIn: boolean | "unknown"; email?: string; plan?: string };
};

/** `manageable`: this caller may add its own accounts here. `canAddShared`:
 *  it may also add accounts everyone can use (the server owner).
 *  `canEditAccess`: it may choose who uses shared accounts. */
export type AccountList = {
  label: string;
  manageable: boolean;
  canAddShared?: boolean;
  canEditAccess?: boolean;
  unsupported?: string;
  accounts: AccountRow[];
};

export type AccountGroups = { mine: AccountRow[]; shared: AccountRow[]; others: AccountRow[] };

/** Your private accounts, shared accounts, and (server owner only) other
 *  people's private accounts, each in server order. */
export function groupAccounts(rows: readonly AccountRow[]): AccountGroups {
  const groups: AccountGroups = { mine: [], shared: [], others: [] };
  for (const row of rows) {
    if (!row.private) groups.shared.push(row);
    else if (row.mine) groups.mine.push(row);
    else groups.others.push(row);
  }
  return groups;
}

export const rowUsable = (row: AccountRow): boolean => row.usable !== false;

export type Named = { id: string; name: string };

/** Looks a message up under `harnessruntime.accounts.` in the active locale. */
export type AccountsTranslate = (key: string, values?: Record<string, string | number>) => string;

const listText = (ids: readonly string[] | undefined, known: readonly Named[], one: string, many: string, everyone: string, t: AccountsTranslate): string => {
  if (!ids?.length) return everyone;
  if (ids.length === 1) return known.find((entry) => entry.id === ids[0])?.name ?? t(one);
  return t(many, { count: ids.length });
};

/** One line describing who may use a shared account. */
export function accessSummary(row: Pick<AccountRow, "allowedUserIds" | "allowedSpaceIds">, people: readonly Named[], spaces: readonly Named[], t: AccountsTranslate): string {
  const everyone = t("access.everyone");
  if (!row.allowedUserIds?.length && !row.allowedSpaceIds?.length) return everyone;
  const who = listText(row.allowedUserIds, people, "access.onePerson", "access.manyPeople", everyone, t);
  const where = row.allowedSpaceIds?.length ? listText(row.allowedSpaceIds, spaces, "access.oneSpace", "access.manySpaces", "", t) : "";
  return where ? `${who} · ${where}` : who;
}

export type AccessScope = "everyone" | "selected";
export type AccessDraft = { people: AccessScope; userIds: string[]; spaces: AccessScope; spaceIds: string[] };

export const accessDraftFrom = (row: Pick<AccountRow, "allowedUserIds" | "allowedSpaceIds">): AccessDraft => ({
  people: row.allowedUserIds?.length ? "selected" : "everyone",
  userIds: [...(row.allowedUserIds ?? [])],
  spaces: row.allowedSpaceIds?.length ? "selected" : "everyone",
  spaceIds: [...(row.allowedSpaceIds ?? [])],
});

/** Why the draft can't be saved yet: an empty selection would mean everyone
 *  on the server, so "Only selected" needs at least one choice. */
export function accessProblem(draft: AccessDraft, t: AccountsTranslate): string | null {
  if (draft.people === "selected" && draft.userIds.length === 0) return t("access.pickPerson");
  if (draft.spaces === "selected" && draft.spaceIds.length === 0) return t("access.pickSpace");
  return null;
}

export const accessBody = (draft: AccessDraft): HarnessAccountAccessUpdate => ({
  allowedUserIds: draft.people === "selected" && draft.userIds.length ? draft.userIds : null,
  allowedSpaceIds: draft.spaces === "selected" && draft.spaceIds.length ? draft.spaceIds : null,
});
