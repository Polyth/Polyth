// Ownership and access presentation for Settings → SSH remotes (Spaces §14.6).
// DOM-free and node:test friendly. The server decides everything; these rules
// only shape what the list shows and what an access edit sends.
import type { SshConnectionWithStatus } from "@polyth/session/web-api";
import { tr } from "../../../../apps/web/src/i18n/index.ts";

/** One row of `GET /api/ssh/connections` as the caller sees it. */
export type SshConnectionView = SshConnectionWithStatus & {
  /** `installation`: the server's shared connection; `person`: someone's own. */
  owner?: "installation" | "person";
  /** The caller added it (personal) or is the instance owner (shared). */
  mine?: boolean;
  /** The caller may edit, delete, disconnect and install on it. */
  editable?: boolean;
  /** Personal: a private key has been uploaded. */
  keyUploaded?: boolean;
  /** Shared, instance owner only: who else may use it. */
  allowedUserIds?: string[];
  allowedSpaceIds?: string[];
};

export type SshConnectionList = {
  items: SshConnectionView[];
  /** The caller may add shared connections (the instance owner). */
  canAddShared?: boolean;
  /** The caller may add connections only they use. */
  canAddPersonal?: boolean;
};

export const isPersonal = (conn: Pick<SshConnectionView, "owner">): boolean => conn.owner === "person";
export const isEditable = (conn: Pick<SshConnectionView, "editable">): boolean => conn.editable !== false;
/** Only the instance owner receives allowlists, so their presence is the
 *  "may edit access" signal. */
export const accessEditable = (conn: Pick<SshConnectionView, "owner" | "allowedUserIds" | "allowedSpaceIds">): boolean =>
  !isPersonal(conn) && Array.isArray(conn.allowedUserIds) && Array.isArray(conn.allowedSpaceIds);

export type SshGroups = { mine: SshConnectionView[]; shared: SshConnectionView[] };

/** Your own connections, then the server's shared ones, each in server order. */
export function groupConnections(items: readonly SshConnectionView[]): SshGroups {
  const groups: SshGroups = { mine: [], shared: [] };
  for (const item of items) (isPersonal(item) ? groups.mine : groups.shared).push(item);
  return groups;
}

/** Which owner choices the add form offers: both for an instance owner who may
 *  also add personal ones, one otherwise, none when adding is not allowed. */
export function addOwnerChoices(list: Pick<SshConnectionList, "canAddShared" | "canAddPersonal">): Array<"installation" | "person"> {
  return [
    ...(list.canAddShared ? ["installation" as const] : []),
    ...(list.canAddPersonal ? ["person" as const] : []),
  ];
}

export type Named = { id: string; name: string };

/** One line describing who besides the instance owner may use a shared
 *  connection. Empty lists mean only the owner. */
export function sshAccessSummary(
  conn: Pick<SshConnectionView, "allowedUserIds" | "allowedSpaceIds">,
  people: readonly Named[] = [],
  spaces: readonly Named[] = [],
): string {
  const users = conn.allowedUserIds ?? [];
  const spaceIds = conn.allowedSpaceIds ?? [];
  if (users.length === 0 && spaceIds.length === 0) return tr("ssh.sshaccess.onlyYou");
  const userText = users.length === 1
    ? people.find((entry) => entry.id === users[0])?.name ?? tr("ssh.sshaccess.onePerson")
    : tr("ssh.sshaccess.manyPeople", { count: users.length });
  const spaceName = spaceIds.length === 1 ? spaces.find((entry) => entry.id === spaceIds[0])?.name : undefined;
  const spaceText = spaceName
    ? tr("ssh.sshaccess.everyoneInSpace", { space: spaceName })
    : spaceIds.length === 1
      ? tr("ssh.sshaccess.everyoneInOneSpace")
      : tr("ssh.sshaccess.everyoneInSpaces", { count: spaceIds.length });
  return [
    tr("ssh.sshaccess.you"),
    users.length ? userText : "",
    spaceIds.length ? spaceText : "",
  ].filter(Boolean).join(" · ");
}

export type SshAccessDraft = { userIds: string[]; spaceIds: string[] };

export const sshAccessDraftFrom = (conn: Pick<SshConnectionView, "allowedUserIds" | "allowedSpaceIds">): SshAccessDraft => ({
  userIds: [...(conn.allowedUserIds ?? [])],
  spaceIds: [...(conn.allowedSpaceIds ?? [])],
});

/** `PUT /api/ssh/connections/:id/access`. Empty lists = only the owner. */
export const sshAccessBody = (draft: SshAccessDraft): { allowedUserIds: string[]; allowedSpaceIds: string[] } => ({
  allowedUserIds: [...new Set(draft.userIds)],
  allowedSpaceIds: [...new Set(draft.spaceIds)],
});

/** Saved ids the lists no longer show stay selectable under a neutral label. */
export function withUnknown(known: readonly Named[], saved: readonly string[], label: string): Named[] {
  return [...known, ...saved.filter((id) => !known.some((entry) => entry.id === id)).map((id) => ({ id, name: label }))];
}

/** Private keys are short text files; refuse anything that is plainly not
 *  one before it leaves the form (the server re-checks format and size). */
export const SSH_KEY_MAX_BYTES = 16 * 1024;
export function sshKeyProblem(value: string): string | null {
  const key = value.trim();
  if (!key) return tr("ssh.key.paste");
  if (new TextEncoder().encode(key).length > SSH_KEY_MAX_BYTES) return tr("ssh.key.tooLarge");
  if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(key)) return tr("ssh.key.notPrivateKey");
  return null;
}
