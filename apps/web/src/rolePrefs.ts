import { useSyncExternalStore } from "react";
import type { AgentDescriptor } from "@polyth/contracts";

export type RoleKind = "main" | "subagent";
export const ROLE_PREFS_KEY = "polyth.rolePrefs";

function parse(raw: string | null): Record<string, RoleKind> {
  try {
    const value = JSON.parse(raw ?? "") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value).filter(
      (entry): entry is [string, RoleKind] => entry[1] === "main" || entry[1] === "subagent",
    ));
  } catch {
    return {};
  }
}

let state = (() => {
  try { return parse(localStorage.getItem(ROLE_PREFS_KEY)); } catch { return {}; }
})();
const listeners = new Set<() => void>();

export function roleKind(agent: AgentDescriptor, prefs: Record<string, RoleKind> = state): RoleKind {
  return prefs[agent.name] ?? (agent.mode === "subagent" ? "subagent" : "main");
}

export function setRoleKind(name: string, kind: RoleKind): void {
  state = { ...state, [name]: kind };
  try { localStorage.setItem(ROLE_PREFS_KEY, JSON.stringify(state)); } catch { /* private mode */ }
  for (const listener of [...listeners]) listener();
}

export function useRolePrefs(): Record<string, RoleKind> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    () => state,
  );
}
