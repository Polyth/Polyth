import { useSyncExternalStore } from "react";

export interface GitPersona {
  id: string;
  label: string;
  name: string;
  email: string;
}

const KEY = "polyth.gitPersonas.v1";
const listeners = new Set<() => void>();

function parse(raw: string | null): GitPersona[] {
  try {
    const rows = JSON.parse(raw ?? "[]") as unknown;
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((value) => {
      const row = value as Partial<GitPersona>;
      return typeof row.id === "string" && typeof row.label === "string"
        && typeof row.name === "string" && typeof row.email === "string"
        ? [{ id: row.id, label: row.label, name: row.name, email: row.email }]
        : [];
    });
  } catch {
    return [];
  }
}

let state = (() => {
  try { return parse(localStorage.getItem(KEY)); } catch { return []; }
})();

function publish(next: GitPersona[]): void {
  state = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
  for (const listener of [...listeners]) listener();
}

export function saveGitPersona(persona: GitPersona): void {
  publish([...state.filter((row) => row.id !== persona.id), persona]);
}

export function removeGitPersona(id: string): void {
  publish(state.filter((row) => row.id !== id));
}

export function useGitPersonas(): GitPersona[] {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => state,
  );
}
