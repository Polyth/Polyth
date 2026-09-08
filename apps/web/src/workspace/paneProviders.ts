// EXTENSION-SEAMS slice 3: reactive pane-provider registry. A provider owns
// how one KIND of tab resource ("file", "plugin", …) renders inside the
// canonical Files surface's PaneHost. Registration, replacement, disposal,
// and availability are reactive so a provider that arrives after the initial
// mount (or disappears when its plugin unloads) re-renders the host without
// editing it. Providers make NO layout decisions — dock/expanded/full-screen
// geometry belongs to the surface host alone.
//
// Providers receive canonical project/session ids and the resource locator.
// They never receive filesystem authority, credentials, an arbitrary cwd, or
// backend session ids (typed api.ts calls only).
import type { ReactNode } from "react";

export interface PaneResourceContext {
  projectId: string;
  sessionId: string | null;
  /** Resource locator inside the kind (relative path, plugin tab id). */
  resource: string;
  /** False while the tab is kept alive but hidden — providers pause their
   *  UI-only polling on this; canonical subscriptions may stay attached. */
  visible: boolean;
}

export interface PaneScope {
  projectId: string;
  sessionId: string | null;
}

export interface PaneProvider {
  /** Tab kind this provider resolves (PaneTab.kind), e.g. "file". */
  kind: string;
  /** Human title for a resource (tab strip label fallback). */
  title?: (resource: string) => string;
  /** Whether a persisted resource can still be opened. Default: yes. */
  available?: (resource: string) => boolean;
  /** Unsaved-state probe: drives the tab dirty marker and the close guard. */
  dirty?: (scope: PaneScope, resource: string) => boolean;
  /** Authoritative discard of unsaved edits (called before close on dirty tabs). */
  discard?: (scope: PaneScope, resource: string) => void;
  /** Release document session and editor retained state when a tab closes. */
  close?: (scope: PaneScope, resource: string) => void;
  /** Change source for dirty/title updates (useSyncExternalStore shape). */
  subscribe?: (cb: () => void) => () => void;
  /** Resource body — a component, so it owns its hooks and state. */
  component: (ctx: PaneResourceContext) => ReactNode;
}

const registry = new Map<string, PaneProvider>();
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version++;
  for (const l of [...listeners]) l();
}

/** Register (or replace by kind). Returns an unregister function that removes
 *  only its own registration — a superseded off() is a no-op. */
export function registerPaneProvider(provider: PaneProvider): () => void {
  registry.set(provider.kind, provider);
  bump();
  return () => {
    if (registry.get(provider.kind) === provider) {
      registry.delete(provider.kind);
      bump();
    }
  };
}

export function getPaneProvider(kind: string): PaneProvider | undefined {
  return registry.get(kind);
}

export function listPaneProviders(): PaneProvider[] {
  return [...registry.values()].sort((a, b) => a.kind.localeCompare(b.kind));
}

/** Availability used when restoring persisted tabs: an unknown kind or a
 *  provider that rejects the resource restores flagged unavailable, never
 *  silently dropped. */
export function paneResourceAvailable(kind: string, resource: string): boolean {
  const provider = registry.get(kind);
  if (!provider) return false;
  return provider.available ? provider.available(resource) : true;
}

export function paneResourceTitle(kind: string, resource: string): string {
  const provider = registry.get(kind);
  return provider?.title ? provider.title(resource) : resource;
}

/** Notifies on every registration/replacement/disposal (useSyncExternalStore). */
export function subscribePaneProviders(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function paneProviderVersion(): number {
  return version;
}
