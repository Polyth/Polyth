/**
 * Package-owned client settings registry.
 *
 * Core owns the authenticated /api/settings/client transport. Feature packages
 * contribute serializable preference slices through this registry instead of
 * being imported into the host. That keeps optional packages optional while
 * still giving them the same account-scoped, cross-device persistence as core
 * UI/model preferences.
 */

export interface ClientSettingsContribution<T = unknown> {
  /** Stable package-owned key inside settings.packagePrefs. */
  id: string;
  /** Return the current JSON-serializable preference snapshot. */
  get(): T;
  /** Apply an authoritative server snapshot to the package-local cache. */
  apply(value: unknown): void;
  /** Notify when the local package preference snapshot changes. */
  subscribe(listener: () => void): () => void;
}

const contributions = new Map<string, ClientSettingsContribution>();
const listeners = new Set<() => void>();

const validId = (id: string): boolean => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(id);

const emit = (): void => {
  for (const listener of [...listeners]) listener();
};

export function registerClientSettingsContribution(
  contribution: ClientSettingsContribution,
): () => void {
  if (!validId(contribution.id)) throw new Error(`invalid client settings contribution id: ${contribution.id}`);
  if (contributions.has(contribution.id)) {
    throw new Error(`duplicate client settings contribution: ${contribution.id}`);
  }
  contributions.set(contribution.id, contribution);
  emit();
  return () => {
    if (contributions.get(contribution.id) !== contribution) return;
    contributions.delete(contribution.id);
    emit();
  };
}

export function listClientSettingsContributions(): ClientSettingsContribution[] {
  return [...contributions.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function subscribeClientSettingsContributions(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
