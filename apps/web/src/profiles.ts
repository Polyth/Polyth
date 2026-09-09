// Client cache for server-owned agent presets. The authenticated server record
// is authoritative and account-scoped; this module only mirrors the current
// account for composer and Settings surfaces.
import { useSyncExternalStore } from "react";
import type { AgentProfile, ModelDescriptor } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";

let profiles: AgentProfile[] = [];
let loaded = false;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of [...listeners]) listener(); };

export function getProfiles(): AgentProfile[] {
  return profiles;
}

/** True once the authoritative preset list has loaded at least once. */
export function profilesLoaded(): boolean {
  return loaded;
}

export async function refreshProfiles(): Promise<AgentProfile[]> {
  profiles = await api.listProfiles();
  loaded = true;
  emit();
  return profiles;
}

export function useProfiles(): AgentProfile[] {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      if (!loaded) void refreshProfiles();
      return () => { listeners.delete(callback); };
    },
    getProfiles,
  );
}

/** Compatibility-only cleanup for an old Composer call site. Favorites are
 * model-picker preferences, never agent presets, so this function deliberately
 * cannot create or update server records. # ponytail: remove with the stale
 * Composer import when that large owner is next edited. */
export async function migrateFavoritesOnce(_models: readonly ModelDescriptor[]): Promise<void> {
  try { localStorage.removeItem("polyth.profiles.favoritesMigrated"); } catch { /* private mode */ }
}
