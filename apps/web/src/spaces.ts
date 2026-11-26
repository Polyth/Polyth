// Client state for Spaces.
//
// Deliberately thin: a Space is a SERVER-side boundary, so the client never
// filters anything by it. It knows which Space is active only to render the
// switcher, and switching is a server call followed by a full reload of
// client state — nothing from the previous Space may survive the switch.
import { useSyncExternalStore } from "react";
import type { JoinedSpaceDto, SpaceSummaryDto, SpacesStateDto } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";

export interface SpacesState {
  status: "idle" | "loading" | "ready" | "error";
  spaces: SpaceSummaryDto[];
  /** Spaces of other Polyth servers this person joined through Polyth Link. */
  joined: JoinedSpaceDto[];
  activeSpaceId: string | null;
  /** True while a switch is in flight — the switcher disables during it. */
  switching: boolean;
  canCreate: boolean;
  error?: string;
}

let state: SpacesState = {
  status: "idle",
  spaces: [],
  joined: [],
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
  spaces: Array.isArray(dto.spaces) ? dto.spaces : [],
  joined: Array.isArray(dto.joined) ? dto.joined : [],
  activeSpaceId: typeof dto.activeSpaceId === "string" ? dto.activeSpaceId : null,
  canCreate: dto.canCreate === true,
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

// Joining or leaving another Polyth server (the Polyth Link page) changes the
// list without a Space switch: re-read it.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("polyth:spaces-changed", () => { void loadSpaces(); });
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
export async function switchSpace(spaceId: string, destination?: string): Promise<void> {
  if (spaceId === state.activeSpaceId || state.switching) return;
  set({ switching: true });
  try {
    apply(await api.activateSpace(spaceId));
    if (typeof window !== "undefined") {
      // The remembered project and chat belong to the Space being left: in
      // the next one (here or on another server) they name nothing, and
      // recovering them asks that Space for ids it does not have.
      try { (await import("./store.ts")).forgetNavigationHints(); } catch { /* keep switching */ }
      // Land on the shell root: a deep link to /p/<project>/s/<session> from
      // the old Space is meaningless (and 404s) in the new one.
      // The one exception is a link the caller made for the new Space.
      if (destination) window.location.assign(destination);
      else window.location.assign("/");
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

/** Who "me" is in the open Space: in another server's Space the person's
 *  account there, which authors their messages; otherwise this server's. */
export function selfInOpenSpace(local: string): string {
  return activeJoinedSpace(state)?.remoteUserId ?? local;
}

/** The joined Space open right now, if the active Space is another server's. */
export const activeJoinedSpace = (s: SpacesState): JoinedSpaceDto | undefined =>
  s.joined.find((space) => space.id === s.activeSpaceId);

/** Test seam: install a known state without touching the network. */
export function __setSpacesStateForTest(next: Partial<SpacesState>): void {
  set(next);
}
