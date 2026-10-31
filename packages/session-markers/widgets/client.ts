// The browser's copy of this Space's chat markers: one shared snapshot every
// badge, menu and panel reads, refreshed after each change, when an agent's
// marker tool call lands, when the window comes back, and on a slow timer.
import { useSyncExternalStore } from "react";
import { createApiTransport, type Unregister, type WebPackageHost } from "@polyth/web-sdk";
import {
  BUILT_IN_MARKERS,
  type MarkedSession,
  type MarkerDefinition,
  type MarkerDefinitionInput,
  type MarkersSnapshot,
  type SessionMarker,
} from "../src/markers.ts";

const api = createApiTransport();
const PATH = "/api/session-markers";
const TOOL_NAME = "polyth_session_markers";
const POLL_MS = 60_000;

export interface MarkerAdditionInput {
  marker: string;
  note?: string;
}

export interface MarkerChangeInput {
  sessionIds: readonly string[];
  add?: readonly MarkerAdditionInput[];
  remove?: readonly string[];
  clear?: boolean;
  create?: boolean;
}

interface State {
  snapshot: MarkersSnapshot | null;
  error: unknown;
  /** sessionId -> markers, derived once per snapshot for O(1) row lookups. */
  bySession: ReadonlyMap<string, readonly SessionMarker[]>;
}

const EMPTY: readonly SessionMarker[] = [];
let state: State = { snapshot: null, error: null, bySession: new Map() };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let queued = false;

const emit = () => { for (const listener of listeners) listener(); };

export function acceptSnapshot(snapshot: MarkersSnapshot): void {
  // A slower, older answer never replaces a newer one.
  if (state.snapshot && snapshot.revision < state.snapshot.revision) return;
  state = {
    snapshot,
    error: null,
    bySession: new Map(snapshot.sessions.map((session) => [session.sessionId, session.markers])),
  };
  emit();
}

export function refreshMarkers(): Promise<void> {
  if (inflight) {
    queued = true;
    return inflight;
  }
  inflight = api.get<MarkersSnapshot>(PATH)
    .then(acceptSnapshot, (error: unknown) => {
      state = { ...state, error };
      emit();
    })
    .finally(() => {
      inflight = null;
      if (queued) {
        queued = false;
        void refreshMarkers();
      }
    });
  return inflight;
}

export async function changeMarkers(change: MarkerChangeInput): Promise<MarkersSnapshot> {
  const snapshot = await api.post<MarkersSnapshot>(`${PATH}/apply`, change);
  acceptSnapshot(snapshot);
  return snapshot;
}

export async function createMarker(input: MarkerDefinitionInput): Promise<MarkerDefinition> {
  const result = await api.post<{ marker: MarkerDefinition; snapshot: MarkersSnapshot }>(`${PATH}/definitions`, input);
  acceptSnapshot(result.snapshot);
  return result.marker;
}

export async function updateMarker(id: string, input: MarkerDefinitionInput): Promise<void> {
  acceptSnapshot(await api.post<MarkersSnapshot>(`${PATH}/definitions/update`, { ...input, id }));
}

export async function deleteMarker(id: string): Promise<void> {
  acceptSnapshot(await api.post<MarkersSnapshot>(`${PATH}/definitions/delete`, { id }));
}

const subscribe = (listener: () => void): Unregister => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** Non-React readers (the session-list grouping). */
export const subscribeMarkers = subscribe;
export const getSessionMarkers = (sessionId: string): readonly SessionMarker[] => state.bySession.get(sessionId) ?? EMPTY;
export const getDefinitions = (): readonly MarkerDefinition[] => state.snapshot?.definitions ?? BUILT_IN_MARKERS;

export function useMarkerState(): State {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

export function useSessionMarkers(sessionId: string): readonly SessionMarker[] {
  return useSyncExternalStore(subscribe, () => state.bySession.get(sessionId) ?? EMPTY, () => EMPTY);
}

export function useDefinitions(): readonly MarkerDefinition[] {
  // Until the first answer the predefined markers are already known.
  return useSyncExternalStore(subscribe, getDefinitions, () => BUILT_IN_MARKERS);
}

export const markedSessions = (snapshot: MarkersSnapshot | null): readonly MarkedSession[] => snapshot?.sessions ?? [];

/** Keep the snapshot current while the package is active. */
export function connectMarkers(host: WebPackageHost): Unregister {
  void refreshMarkers();
  const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
  const onVisible = () => { if (visible()) void refreshMarkers(); };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
  const timer = setInterval(() => { if (visible()) void refreshMarkers(); }, POLL_MS);
  // An agent's marker call names the tool; its result means the change is stored.
  const offEvents = host.sessions.subscribeEvents((event) => {
    if (event.type !== "tool/result") return;
    const tool = (event.data as { tool?: unknown }).tool;
    if (typeof tool === "string" && tool.includes(TOOL_NAME)) void refreshMarkers();
  });
  return () => {
    clearInterval(timer);
    offEvents();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
  };
}

/** Test seam: forget the cached snapshot. */
export function resetMarkerState(): void {
  state = { snapshot: null, error: null, bySession: new Map() };
  emit();
}
