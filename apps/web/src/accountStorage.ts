const OWNER_ACCOUNT_ID = "usr_owner";
const ACTIVE_ACCOUNT_KEY = "polyth.activeAccount";
const ACCOUNT_ID = /^usr_[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function normalizeAccountId(value: string): string {
  const input = value.trim();
  if (ACCOUNT_ID.test(input)) return input;
  const slug = input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug ? `usr_${slug}` : OWNER_ACCOUNT_ID;
}

export function activeBrowserAccountId(): string {
  try {
    const value = localStorage.getItem(ACTIVE_ACCOUNT_KEY);
    return value && ACCOUNT_ID.test(value) ? value : OWNER_ACCOUNT_ID;
  } catch {
    return OWNER_ACCOUNT_ID;
  }
}

export function setActiveBrowserAccount(accountId: string): void {
  try { localStorage.setItem(ACTIVE_ACCOUNT_KEY, normalizeAccountId(accountId)); } catch { /* private mode */ }
}

export function accountStorageKey(key: string, accountId = activeBrowserAccountId()): string {
  return `${key}.account.${accountId}`;
}

export function accountStorageGet(key: string): string | null {
  try {
    const accountId = activeBrowserAccountId();
    const scopedKey = accountStorageKey(key, accountId);
    const scoped = localStorage.getItem(scopedKey);
    if (scoped !== null) return scoped;
    if (accountId !== OWNER_ACCOUNT_ID) return null;
    const legacy = localStorage.getItem(key);
    if (legacy === null) return null;
    localStorage.setItem(scopedKey, legacy);
    localStorage.removeItem(key);
    return legacy;
  } catch {
    return null;
  }
}

export function accountStorageSet(key: string, value: string): void {
  try { localStorage.setItem(accountStorageKey(key), value); } catch { /* private mode */ }
}

export function accountStorageRemove(key: string): void {
  try { localStorage.removeItem(accountStorageKey(key)); } catch { /* private mode */ }
}
