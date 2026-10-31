import type { ProjectSettingsContribution, Unregister } from "@polyth/web-sdk";
import { assertOwnerCanReplace } from "./packages/ownership.ts";

type Entry = {
  contribution: ProjectSettingsContribution;
  ownerPackageId: string;
};

const registry = new Map<string, Entry>();
const listeners = new Set<() => void>();
export interface ProjectSettingsNavigation { projectId: string; contributionId?: string }
const navigationListeners = new Set<(request: ProjectSettingsNavigation) => void>();

export function openProjectSettings(projectId: string, contributionId?: string): void {
  const request = { projectId, ...(contributionId ? { contributionId } : {}) };
  for (const listener of [...navigationListeners]) listener(request);
}

export function subscribeProjectSettingsNavigation(listener: (request: ProjectSettingsNavigation) => void): Unregister {
  navigationListeners.add(listener);
  return () => { navigationListeners.delete(listener); };
}

function bump(): void {
  for (const listener of [...listeners]) listener();
}

export function registerProjectSettings(
  contribution: ProjectSettingsContribution,
  ownerPackageId?: string,
): Unregister {
  const existing = registry.get(contribution.id);
  if (existing) {
    assertOwnerCanReplace({
      registry: "project settings contribution",
      id: contribution.id,
      existingOwner: existing.ownerPackageId,
      nextOwner: ownerPackageId,
    });
  }
  const entry: Entry = {
    contribution: { ...contribution, ownerPackageId: ownerPackageId ?? contribution.ownerPackageId },
    ownerPackageId: ownerPackageId ?? contribution.ownerPackageId ?? "host",
  };
  registry.set(contribution.id, entry);
  bump();
  return () => {
    if (registry.get(contribution.id) !== entry) return;
    registry.delete(contribution.id);
    bump();
  };
}

export function listProjectSettings(projectId: string): readonly ProjectSettingsContribution[] {
  return [...registry.values()]
    .filter(({ contribution }) => {
      try {
        return contribution.visible?.(projectId) ?? true;
      } catch (error) {
        console.error(`[polyth] project settings "${contribution.id}" visibility failed`, error);
        return false;
      }
    })
    .map(({ contribution }) => contribution)
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id));
}

export function subscribeProjectSettings(listener: () => void): Unregister {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
