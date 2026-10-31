import type { AccountLimits, AccountUsageToday, SpaceRole } from "@polyth/contracts";
import { getLocale, tr, type TranslationKey } from "../../i18n/index.ts";

/** Pure state and copy for Settings → Users; kept free of React so it can be
 *  tested directly. */

export type Scope = "all" | "selected";

/** Editable form of `AccountLimits`. A scope of "all" keeps the previous
 *  selection around so switching back and forth loses nothing. */
export interface LimitsDraft {
  projectScope: Scope;
  projects: string[];
  harnessScope: Scope;
  /** In order: the first is used for new chats. */
  harnesses: string[];
  messagesPerDay: number | null;
  chatsPerDay: number | null;
}

export const DEFAULT_MESSAGES_PER_DAY = 50;
export const DEFAULT_CHATS_PER_DAY = 10;

export function limitsDraftFrom(limits: AccountLimits | null): LimitsDraft {
  return {
    projectScope: limits?.projects ? "selected" : "all",
    projects: [...(limits?.projects ?? [])],
    harnessScope: limits?.harnesses ? "selected" : "all",
    harnesses: [...(limits?.harnesses ?? [])],
    messagesPerDay: limits?.messagesPerDay ?? null,
    chatsPerDay: limits?.chatsPerDay ?? null,
  };
}

/** `null` when nothing is restricted (the server stores that as removed). */
export function buildLimits(draft: LimitsDraft): AccountLimits | null {
  const limits: AccountLimits = {
    projects: draft.projectScope === "selected" ? [...new Set(draft.projects)] : null,
    harnesses: draft.harnessScope === "selected" ? [...new Set(draft.harnesses)] : null,
    messagesPerDay: draft.messagesPerDay,
    chatsPerDay: draft.chatsPerDay,
  };
  return limits.projects === null && limits.harnesses === null
    && limits.messagesPerDay === null && limits.chatsPerDay === null ? null : limits;
}

const sameList = (a: readonly string[] | null, b: readonly string[] | null, ordered: boolean): boolean => {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  return ordered ? a.every((id, i) => id === b[i]) : [...a].sort().join("\u0000") === [...b].sort().join("\u0000");
};

export function limitsChanged(a: LimitsDraft, b: LimitsDraft): boolean {
  const left = buildLimits(a), right = buildLimits(b);
  if (left === null || right === null) return left !== right;
  return !sameList(left.projects, right.projects, false)
    || !sameList(left.harnesses, right.harnesses, true)
    || left.messagesPerDay !== right.messagesPerDay
    || left.chatsPerDay !== right.chatsPerDay;
}

/** Toggle one id in an ordered selection; new ids go last. */
export function toggleId(list: readonly string[], id: string, on: boolean): string[] {
  const rest = list.filter((entry) => entry !== id);
  return on ? [...rest, id] : rest;
}

/** Move an id to the front (the default for new chats). */
export function makeFirst(list: readonly string[], id: string): string[] {
  return list.includes(id) ? [id, ...list.filter((entry) => entry !== id)] : [...list];
}

/** Why a draft can't be saved as is, or null. Empty selections would lock the
 *  account out of everything, which is never what "only selected" means. */
export function limitsProblem(draft: LimitsDraft): string | null {
  if (draft.projectScope === "selected" && draft.projects.length === 0) return tr("settings.users.problemNoProjects");
  if (draft.harnessScope === "selected" && draft.harnesses.length === 0) return tr("settings.users.problemNoAssistants");
  return null;
}

/** "1 project" / "5 projects". Locales without a usable singular word the
 *  phrase so one form fits every count. */
const plural = (count: number, one: TranslationKey, other: TranslationKey): string =>
  tr(new Intl.PluralRules(getLocale()).select(count) === "one" ? one : other, { count });

/** One-line description of what an account may do, for the account list. */
export function limitsSummary(
  limits: AccountLimits | null | undefined,
  harnessName: (id: string) => string = (id) => id,
): string[] {
  if (!limits) return [];
  const parts: string[] = [];
  if (limits.projects) parts.push(plural(limits.projects.length, "settings.users.projectCountOne", "settings.users.projectCountOther"));
  if (limits.harnesses) {
    parts.push(limits.harnesses.length === 1
      ? tr("settings.users.harnessOnly", { name: harnessName(limits.harnesses[0]!) })
      : limits.harnesses.length === 2
        ? limits.harnesses.map(harnessName).join(", ")
        : plural(limits.harnesses.length, "settings.users.assistantCountOne", "settings.users.assistantCountOther"));
  }
  if (limits.messagesPerDay !== null) parts.push(tr("settings.users.messagesADay", { count: limits.messagesPerDay }));
  if (limits.chatsPerDay !== null) parts.push(tr("settings.users.newChatsADay", { count: limits.chatsPerDay }));
  return parts;
}

/** "12 of 50 messages today" / "12 messages today". `one`/`many` name the
 *  counted thing ("message"/"messages" or "chat"/"chats"); the visible words
 *  come from the catalog. */
export function usageLine(usage: AccountUsageToday | undefined, cap: number | null, one: string, many: string): string {
  const messages = one === "message" || many === "messages";
  const used = usage?.[messages ? "messages" : "chats"] ?? 0;
  if (cap !== null) return tr(messages ? "settings.users.usageMessagesOfCap" : "settings.users.usageChatsOfCap", { used, cap });
  return messages
    ? plural(used, "settings.users.usageMessagesOne", "settings.users.usageMessagesOther")
    : plural(used, "settings.users.usageChatsOne", "settings.users.usageChatsOther");
}

const ROLE_KEYS = {
  viewer: ["settings.users.roleViewer", "settings.users.roleViewerDetail"],
  member: ["settings.users.roleMember", "settings.users.roleMemberDetail"],
  admin: ["settings.users.roleAdmin", "settings.users.roleAdminDetail"],
  owner: ["settings.users.roleOwner", "settings.users.roleOwnerDetail"],
} as const satisfies Record<SpaceRole, readonly [TranslationKey, TranslationKey]>;

/** Role name and one-line description in the active language. */
export function roleText(role: SpaceRole): { label: string; detail: string } {
  const [label, detail] = ROLE_KEYS[role];
  return { label: tr(label), detail: tr(detail) };
}

/** Lowercase login suggestion from a display name ("Maria Kovalenko" → "maria"). */
/** Settings target that opens the signed-in person's own account:
 *  `openSettingsPage("users", { itemId: OWN_ACCOUNT_TARGET })`, or the
 *  `?settings=users/account` deep link. */
export const OWN_ACCOUNT_TARGET = "account";

/** Up to two initials for an avatar; "?" for an empty name. */
export const initials = (name: string): string =>
  name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";

export function suggestLogin(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  return first
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9._-]/g, "").replace(/^[._-]+/, "")
    .slice(0, 64);
}

export const LOGIN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MIN_PASSWORD_LENGTH = 8;

/** Easy to read aloud and type on a TV remote: no 0/o/1/l/i. 4 groups of 4
 *  from 31 symbols ≈ 79 bits. */
const PASSPHRASE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export function generatePassphrase(random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)): string {
  const groups: string[] = [];
  for (let g = 0; g < 4; g += 1) {
    let group = "";
    while (group.length < 4) {
      const [byte] = random(new Uint8Array(1));
      // Rejection sampling keeps the distribution uniform.
      if (byte! < 248) group += PASSPHRASE_ALPHABET[byte! % PASSPHRASE_ALPHABET.length];
    }
    groups.push(group);
  }
  return groups.join("-");
}

const ERROR_TEXT: Record<string, TranslationKey> = {
  "invalid-credentials": "settings.users.errorInvalidCredentials",
  "rate-limited": "settings.users.errorRateLimited",
  "managed-identity": "settings.users.errorManagedIdentity",
  "last-owner": "settings.users.errorLastOwner",
  "invalid-transition": "settings.users.errorInvalidTransition",
  forbidden: "settings.users.errorForbidden",
  "owner-credential-required": "settings.users.errorOwnerCredentialRequired",
  "owner-confirmation-required": "settings.users.errorOwnerConfirmationRequired",
  "passkey-cancelled": "settings.users.errorPasskeyCancelled",
};

/** One human sentence for a failed owner action. */
export function accountErrorText(cause: unknown): string {
  const error = cause as { code?: unknown; status?: unknown; message?: unknown } | null;
  const code = typeof error?.code === "string" ? error.code : undefined;
  if (code === "conflict" && typeof error?.message === "string" && /login/i.test(error.message)) {
    return tr("settings.users.errorLoginTaken");
  }
  if (code === "conflict" || error?.status === 409) return tr("settings.users.errorConflict");
  if (code && ERROR_TEXT[code]) return tr(ERROR_TEXT[code]!);
  if (typeof error?.message === "string" && error.message.trim()) {
    const text = error.message.trim();
    return /[.!?]$/.test(text) ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
  }
  return tr("settings.users.errorGeneric");
}
