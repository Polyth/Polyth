// Client cache for server-owned agent profiles (WP8), plus the one-time
// favorites→profiles migration. The server record is the source of truth;
// this module only mirrors it for pickers and settings.
import { useSyncExternalStore } from "react";
import type { AgentProfile, ModelDescriptor } from "@polyth/contracts";
import { planFavoriteMigration } from "@polyth/models";
import { api } from "@polyth/session/web-api";
import { getModelPrefs } from "@polyth/models/web-prefs";

let profiles: AgentProfile[] = [];
let loaded = false;
const listeners = new Set<() => void>();
const emit = () => { for (const l of [...listeners]) l(); };

export function getProfiles(): AgentProfile[] {
  return profiles;
}

/** True once the authoritative profile list has loaded at least once —
 *  "profile deleted" states must never fire on the initial empty mirror. */
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
    (cb) => {
      listeners.add(cb);
      if (!loaded) void refreshProfiles();
      return () => { listeners.delete(cb); };
    },
    getProfiles,
  );
}

const MIGRATION_FLAG = "polyth.profiles.favoritesMigrated";

/** Migrate model favorites into minimal profiles exactly once. Idempotent on
 *  both sides: the plan skips provider/model pairs that already have a profile,
 *  and the local flag stops repeat attempts. Favorites keep working as before. */
export async function migrateFavoritesOnce(models: readonly ModelDescriptor[]): Promise<void> {
  try {
    if (localStorage.getItem(MIGRATION_FLAG) === "1") return;
  } catch { return; }
  if (models.length === 0) return; // adapter absent: retry next boot
  const existing = loaded ? profiles : await refreshProfiles();
  const plan = planFavoriteMigration(getModelPrefs(), models, existing);
  for (const seed of plan) {
    await api.createProfile({ name: seed.name, providerID: seed.providerID, modelID: seed.modelID, features: {} })
      .catch(() => {}); // partial failure: flag stays unset, next boot retries
  }
  try { localStorage.setItem(MIGRATION_FLAG, "1"); } catch { /* private mode */ }
  if (plan.length > 0) await refreshProfiles();
}
