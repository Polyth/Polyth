// Client state for Spaces.
//
// Deliberately thin: a Space is a SERVER-side boundary, so the client never
// filters anything by it. It knows which Space is active only to render the
// switcher, and switching is a server call followed by a full reload of
// client state — nothing from the previous Space may survive the switch.
import { useSyncExternalStore } from "react";
import type { SpaceSummaryDto, SpacesStateDto } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";

export interface SpacesState {
  status: "idle" | "loading" | "ready" | "error";
  spaces: SpaceSummaryDto[];
  activeSpaceId: string | null;
  /** True while a switch is in flight — the switcher disables during it. */
  switching: boolean;
  canCreate: boolean;
  error?: string;
}

let state: SpacesState = {
  status: "idle",
  spaces: [],
  activeSpaceId: null,
  switching: false,
  canCreate: false,
};

const listeners = new Set<() => void>();
const emit = (): void => { for (const l of listeners) l(); };
const set = (patch: Partial<SpacesState>): void => {
  state = { ...state, ...patch };
  emit();
};

const apply = (dto: SpacesStateDto): void => set({
  status: "ready",
  spaces: dto.spaces,
  activeSpaceId: dto.activeSpaceId,
  canCreate: dto.canCreate,
  error: undefined,
});

export const getSpacesState = (): SpacesState => state;

export function useSpaces(): SpacesState {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    getSpacesState,
    getSpacesState,
  );
}

/** Load the switcher's data. Safe to call repeatedly. */
export async function loadSpaces(): Promise<void> {
  if (state.status === "loading") return;
  set({ status: state.status === "ready" ? "ready" : "loading" });
  try {
    apply(await api.spaces());
  } catch (error) {
    set({ status: "error", error: (error as Error).message });
  }
}

/**
 * Switch the active Space.
 *
 * A hard reload is intentional and is the honest implementation of "a
 * different environment": projects, sessions, events, drafts, model catalogs,
 * package state, and the WebSocket subscription are all per-Space, and a
 * partial in-place swap would leave whichever of those a future feature forgot
 * to reset showing the previous tenant's data. The switch itself is cheap —
 * the server does not restart, and the reload is a warm SPA boot.
 */
export async function switchSpace(spaceId: string): Promise<void> {
  if (spaceId === state.activeSpaceId || state.switching) return;
  set({ switching: true });
  try {
    apply(await api.activateSpace(spaceId));
    if (typeof window !== "undefined") {
      // Land on the shell root: a deep link to /p/<project>/s/<session> from
      // the old Space is meaningless (and 404s) in the new one.
      window.location.assign("/");
      return;
    }
  } catch (error) {
    set({ error: (error as Error).message });
  } finally {
    set({ switching: false });
  }
}

export async function createSpace(name: string): Promise<void> {
  apply(await api.createSpace({ name }));
}

export async function renameSpace(id: string, name: string): Promise<void> {
  apply(await api.patchSpace(id, { name }));
}

export async function deleteSpace(id: string): Promise<void> {
  apply(await api.deleteSpace(id));
}

export const activeSpace = (s: SpacesState): SpaceSummaryDto | undefined =>
  s.spaces.find((space) => space.id === s.activeSpaceId);

/** Test seam: install a known state without touching the network. */
export function __setSpacesStateForTest(next: Partial<SpacesState>): void {
  set(next);
}
