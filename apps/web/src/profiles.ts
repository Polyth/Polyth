// Client cache for server-owned agent presets. The authenticated server record
// is authoritative and account-scoped; this module only mirrors the current
// account for composer and Settings surfaces.
import { useSyncExternalStore } from "react";
import type { AgentProfile } from "@polyth/contracts";
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
