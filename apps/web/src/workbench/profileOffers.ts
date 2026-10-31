// Optional workbench profiles. A profile registered with
// `presentation.optional: true` joins the header's view switch only once a
// project offers it — the same opt-in Canvas uses. Like `canvasEnabled`, the
// choice belongs to the project (presentation sync key `workbenchProfiles`),
// while which tab this device is showing stays device-local navigation.
import {
  markProjectPresentationChanged,
  PROJECT_PRESENTATION_HYDRATED_EVENT,
  projectPresentationEventHasKey,
  projectPresentationEventProjectId,
} from "../projectPresentationSync.ts";
import { presentationScopeId, subscribeProjectInterfaceMode } from "../projectInterfaceScope.ts";

export const WORKBENCH_PROFILE_OFFERS_KEY = "polyth.workbenchProfiles.v1";
export const workbenchProfileOffersStorageKey = (projectId: string): string =>
  `${WORKBENCH_PROFILE_OFFERS_KEY}.${presentationScopeId(projectId)}`;

export type WorkbenchProfileOffers = Readonly<Record<string, boolean>>;

const EMPTY: WorkbenchProfileOffers = Object.freeze({});
const cache = new Map<string, WorkbenchProfileOffers>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function parse(raw: string | null): WorkbenchProfileOffers {
  if (raw === null) return EMPTY;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY;
    const offers: Record<string, boolean> = {};
    for (const [id, enabled] of Object.entries(value as Record<string, unknown>)) {
      if (typeof enabled === "boolean") offers[id] = enabled;
    }
    return Object.freeze(offers);
  } catch {
    return EMPTY;
  }
}

/** Cached per storage scope (the project, or the shared interface): navigation
 * snapshots read this on every store tick. */
export function workbenchProfileOffers(projectId: string | null): WorkbenchProfileOffers {
  if (projectId === null) return EMPTY;
  const scope = presentationScopeId(projectId);
  const cached = cache.get(scope);
  if (cached) return cached;
  let raw: string | null = null;
  try { raw = localStorage.getItem(workbenchProfileOffersStorageKey(projectId)); }
  catch { /* private mode */ }
  const offers = parse(raw);
  cache.set(scope, offers);
  return offers;
}

export function isWorkbenchProfileOffered(profileId: string, projectId: string | null): boolean {
  return workbenchProfileOffers(projectId)[profileId] === true;
}

/** Offer (or withdraw) one optional profile for one project. */
export function setWorkbenchProfileOffered(profileId: string, projectId: string | null, enabled: boolean): void {
  if (projectId === null || isWorkbenchProfileOffered(profileId, projectId) === enabled) return;
  const next = Object.freeze({ ...workbenchProfileOffers(projectId), [profileId]: enabled });
  cache.set(presentationScopeId(projectId), next);
  try { localStorage.setItem(workbenchProfileOffersStorageKey(projectId), JSON.stringify(next)); }
  catch { /* private mode: the choice lasts for this document */ }
  markProjectPresentationChanged(projectId, "workbenchProfiles");
  notify();
}

export function subscribeWorkbenchProfileOffers(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

if (typeof window !== "undefined") {
  // Another device changed the project's offer: drop the cached record.
  window.addEventListener(PROJECT_PRESENTATION_HYDRATED_EVENT, (event) => {
    const projectId = projectPresentationEventProjectId(event);
    if (projectId === null || !projectPresentationEventHasKey(event, "workbenchProfiles")) return;
    cache.delete(presentationScopeId(projectId));
    notify();
  });
  subscribeProjectInterfaceMode(() => {
    cache.clear();
    notify();
  });
  window.addEventListener("storage", (event) => {
    if (!event.key?.startsWith(`${WORKBENCH_PROFILE_OFFERS_KEY}.`)) return;
    cache.delete(event.key.slice(WORKBENCH_PROFILE_OFFERS_KEY.length + 1));
    notify();
  });
}
