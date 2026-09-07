// Workbench profile registry. A profile is a recommended arrangement of one
// workbench (which surfaces, in which regions, with which sizes) plus
// presentation hints — never a separate application and never an editor id.
// `conversation` is built in; packages register the rest through
// `host.workbench.profiles.register` (text-editor → authoring, code-editor →
// development). Reactive (useSyncExternalStore shape) so a profile that
// arrives after mount, or disappears when its package unloads, re-renders the
// picker without editing it.
import type {
  WorkbenchLayoutTemplate,
  WorkbenchProfileDefinition,
  WorkbenchProfileSummary,
} from "@polyth/web-sdk";
import { CHAT_SURFACE_ID } from "./layout.ts";

export const CONVERSATION_PROFILE_ID = "conversation";

/** The classic shell: Chat alone in primary; package windows arrive through
 *  the companion host (floating, docked end, or fullscreen). */
export const CONVERSATION_TEMPLATE: WorkbenchLayoutTemplate = {
  surfaces: [{ surface: CHAT_SURFACE_ID, region: "primary", active: true }],
};

export const CONVERSATION_PROFILE: WorkbenchProfileDefinition = {
  id: CONVERSATION_PROFILE_ID,
  label: "Conversation",
  description: "Chat in focus; package windows open beside it.",
  order: 0,
  defaultLayout: CONVERSATION_TEMPLATE,
  presentation: { chat: "primary" },
};

const registry = new Map<string, WorkbenchProfileDefinition>([[CONVERSATION_PROFILE_ID, CONVERSATION_PROFILE]]);
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version++;
  for (const listener of [...listeners]) listener();
}

/** Register (or replace by id). The built-in conversation profile cannot be
 *  replaced or removed. Returns an identity-based unregister. */
export function registerWorkbenchProfile(definition: WorkbenchProfileDefinition): () => void {
  if (definition.id === CONVERSATION_PROFILE_ID) return () => {};
  registry.set(definition.id, definition);
  bump();
  return () => {
    if (registry.get(definition.id) === definition) {
      registry.delete(definition.id);
      bump();
    }
  };
}

export function getWorkbenchProfile(id: string): WorkbenchProfileDefinition | undefined {
  return registry.get(id);
}

export function listWorkbenchProfiles(): WorkbenchProfileDefinition[] {
  return [...registry.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function profileSummary(definition: WorkbenchProfileDefinition): WorkbenchProfileSummary {
  let available = true;
  try {
    available = definition.available ? definition.available() : true;
  } catch {
    available = false;
  }
  return {
    id: definition.id,
    label: definition.label,
    description: definition.description,
    order: definition.order,
    available,
    presentation: definition.presentation ?? {},
  };
}

export function listWorkbenchProfileSummaries(): WorkbenchProfileSummary[] {
  return listWorkbenchProfiles().map(profileSummary);
}

export function subscribeWorkbenchProfiles(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function workbenchProfileVersion(): number {
  return version;
}

/** Test seam: drop every package-registered profile. */
export function resetWorkbenchProfilesForTest(): void {
  for (const id of [...registry.keys()]) if (id !== CONVERSATION_PROFILE_ID) registry.delete(id);
  bump();
}
