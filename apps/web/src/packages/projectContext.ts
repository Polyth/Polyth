import { useSyncExternalStore } from "react";
import type { ProjectContextContribution, ProjectContextSnapshot, Unregister } from "@polyth/web-sdk";
import { assertOwnerCanReplace } from "./ownership.ts";

export interface BoundProjectContextContribution {
  id: string;
  ownerPackageId: string;
  order: number;
  contribution: ProjectContextContribution;
}

export interface ProjectContextEntry {
  id: string;
  ownerPackageId: string;
  snapshot: ProjectContextSnapshot;
}

type RegistryEntry = {
  contribution: ProjectContextContribution;
  ownerPackageId: string;
};

const registry = new Map<string, RegistryEntry>();
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version++;
  for (const listener of [...listeners]) listener();
}

export function registerProjectContext(
  contribution: ProjectContextContribution,
  ownerPackageId?: string,
): Unregister {
  const existing = registry.get(contribution.id);
  if (existing) {
    assertOwnerCanReplace({
      registry: "project context",
      id: contribution.id,
      existingOwner: existing.ownerPackageId,
      nextOwner: ownerPackageId,
    });
  }
  const entry: RegistryEntry = { contribution, ownerPackageId: ownerPackageId ?? "host" };
  const stop = contribution.subscribe?.(() => bump()) ?? (() => undefined);
  registry.set(contribution.id, entry);
  bump();
  return () => {
    if (registry.get(contribution.id) !== entry) return;
    registry.delete(contribution.id);
    stop();
    bump();
  };
}

export function listProjectContextContributions(): BoundProjectContextContribution[] {
  return [...registry.entries()]
    .map(([id, entry]) => ({
      id,
      ownerPackageId: entry.ownerPackageId,
      order: entry.contribution.order ?? 0,
      contribution: entry.contribution,
    }))
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

export function listProjectContextSnapshots(projectId: string | null): ProjectContextEntry[] {
  if (!projectId) return [];
  const entries: ProjectContextEntry[] = [];
  for (const item of listProjectContextContributions()) {
    try {
      const snapshot = item.contribution.getSnapshot(projectId);
      if (!snapshot) continue;
      entries.push({
        id: item.id,
        ownerPackageId: item.ownerPackageId,
        snapshot,
      });
    } catch (error) {
      console.error(`[polyth] project context "${item.id}" failed`, error);
    }
  }
  return entries;
}

export function listProjectContextRecommendedWidgetIds(projectId: string | null): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of listProjectContextSnapshots(projectId)) {
    for (const id of entry.snapshot.recommendedWidgetIds ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export function subscribeProjectContext(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function projectContextVersion(): number {
  return version;
}

export function useProjectContextSnapshots(projectId: string | null): ProjectContextEntry[] {
  useSyncExternalStore(subscribeProjectContext, projectContextVersion);
  return listProjectContextSnapshots(projectId);
}

export function useProjectContextRecommendedWidgetIds(projectId: string | null): readonly string[] {
  useSyncExternalStore(subscribeProjectContext, projectContextVersion);
  return listProjectContextRecommendedWidgetIds(projectId);
}
