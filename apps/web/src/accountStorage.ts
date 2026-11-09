const OWNER_ACCOUNT_ID = "usr_owner";
const ACTIVE_ACCOUNT_KEY = "polyth.activeAccount";
const ACCOUNT_ID = /^usr_[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** Runs of characters outside a-z0-9 become one "-", ends are trimmed.
 *  A single linear scan, not a regex: the value comes from user navigation. */
function separatorSlug(value: string): string {
  let slug = "";
  let separated = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if ((char >= "a" && char <= "z") || (char >= "0" && char <= "9")) {
      if (separated && slug) slug += "-";
      separated = false;
      slug += char;
    } else separated = true;
  }
  return slug;
}

const withoutTrailingSeparator = (value: string): string => {
  let end = value.length;
  while (end > 0 && value[end - 1] === "-") end -= 1;
  return value.slice(0, end);
};

export function normalizeAccountId(value: string): string {
  const input = value.trim();
  if (ACCOUNT_ID.test(input)) return input;
  const slug = withoutTrailingSeparator(
    separatorSlug(input.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()).slice(0, 40),
  );
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
