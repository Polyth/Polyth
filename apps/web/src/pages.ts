// Package pages: content a package shows in place of Chat, the way a chat
// opens from the navigator (an agent's own screen). The store holds which
// page is open (`activePage`); WorkspaceHost renders it in the main canvas.
// The host owns the canvas, navigation in and out and failure isolation; the
// page owns everything inside the canvas, its header included.
import type { PageDefinition } from "@polyth/web-sdk";

const registry = new Map<string, PageDefinition>();
const listeners = new Set<() => void>();
let version = 0;

function bump(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

/** Register (or replace by id). The returned function removes only this
 *  registration; a superseded one is a no-op. */
export function registerPage(definition: PageDefinition): () => void {
  registry.set(definition.id, definition);
  bump();
  return () => {
    if (registry.get(definition.id) !== definition) return;
    registry.delete(definition.id);
    bump();
  };
}

export function getPage(id: string): PageDefinition | undefined {
  return registry.get(id);
}

export function listPages(): PageDefinition[] {
  return [...registry.values()];
}

export function subscribePages(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function pagesVersion(): number {
  return version;
}
