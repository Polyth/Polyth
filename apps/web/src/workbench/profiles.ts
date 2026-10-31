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
import { isProjectContributionRelevant, subscribeProjectRelevance } from "../packages/projectRelevance.ts";
import { tr } from "../i18n/index.ts";

export const CONVERSATION_PROFILE_ID = "conversation";

/** The classic shell: Chat alone in primary; package windows arrive through
 *  the companion host (floating, docked end, or fullscreen). */
export const CONVERSATION_TEMPLATE: WorkbenchLayoutTemplate = {
  surfaces: [{ surface: CHAT_SURFACE_ID, region: "primary", active: true }],
};

export const CONVERSATION_PROFILE: WorkbenchProfileDefinition = {
  id: CONVERSATION_PROFILE_ID,
  // Read when the profile list renders, so a language switch shows at once.
  get label() { return tr("workbench.conversationProfile"); },
  get description() { return tr("workbench.conversationProfileDescription"); },
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

subscribeProjectRelevance(bump);

/** Purpose owned by a package, remembered for the life of the process and
 *  cached per device. A disabled or uninstalled package unregisters its
 *  profile, but the sessions it created keep their `purpose`, so the host must
 *  still know whose lane that purpose is. Only the host (an activation scope)
 *  ever writes here. */
const purposeOwners = new Map<string, string>();
const PURPOSE_OWNERS_KEY = "polyth.workbench.sessionPurposeOwners";

function readPersistedPurposeOwners(): void {
  try {
    if (typeof localStorage === "undefined") return;
    const raw = JSON.parse(localStorage.getItem(PURPOSE_OWNERS_KEY) ?? "null") as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    for (const [purpose, owner] of Object.entries(raw)) {
      if (typeof owner === "string" && owner) purposeOwners.set(purpose, owner);
    }
  } catch {
    // Private mode or a corrupt record: the live registry still decides.
  }
}
readPersistedPurposeOwners();

function rememberPurpose(purpose: string | undefined, ownerPackageId: string | undefined): void {
  if (!purpose || !ownerPackageId) return;
  if (purposeOwners.get(purpose) === ownerPackageId) return;
  purposeOwners.set(purpose, ownerPackageId);
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(PURPOSE_OWNERS_KEY, JSON.stringify(Object.fromEntries(purposeOwners)));
    }
  } catch {
    // Best effort: this page still resolves the owner from memory.
  }
}

/** Package owning a session purpose, whether or not its profile is live. */
export function ownerOfSessionPurpose(purpose: string | undefined): string | undefined {
  return purpose ? purposeOwners.get(purpose) : undefined;
}

/** Session purposes a package declares through its workbench profiles, live or
 *  not, so disabling it can offer to clean up or hide the chats it owns. */
export function sessionPurposesOfPackage(packageId: string): string[] {
  return [...purposeOwners.entries()]
    .filter(([, owner]) => owner === packageId)
    .map(([purpose]) => purpose);
}

/** Test seam: forget remembered purpose ownership. */
export function resetSessionPurposeOwnersForTest(): void {
  purposeOwners.clear();
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(PURPOSE_OWNERS_KEY);
  } catch {
    // No storage: memory was the only copy.
  }
}

/** Register (or replace by id). The built-in conversation profile cannot be
 *  replaced or removed. Returns an identity-based unregister. */
export function registerWorkbenchProfile(definition: WorkbenchProfileDefinition): () => void {
  if (definition.id === CONVERSATION_PROFILE_ID) return () => {};
  rememberPurpose(definition.sessionPurpose, definition.ownerPackageId);
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
  const definition = registry.get(id);
  return definition && isProjectContributionRelevant(definition.ownerPackageId, definition.projectAffinity)
    ? definition : undefined;
}

export function listWorkbenchProfiles(): WorkbenchProfileDefinition[] {
  return [...registry.values()]
    .filter((definition) => isProjectContributionRelevant(definition.ownerPackageId, definition.projectAffinity))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
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
    ...(definition.sessionPurpose ? { sessionPurpose: definition.sessionPurpose } : {}),
    ...(definition.ownerPackageId ? { ownerPackageId: definition.ownerPackageId } : {}),
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
