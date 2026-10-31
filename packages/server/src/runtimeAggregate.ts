// Runtime catalog aggregation for global metadata routes.
//
// Global metadata must not scale with unrelated project count. At the same
// time, multi-harness semantics require retaining catalogs from distinct
// pinned engines. Pick at most one representative project per declared
// harness selection (plus one Auto representative), preferring local projects
// for each selection while preserving remote-only selections.
// The cost is therefore bounded by harness diversity, not workspace size.
import type { AgentRuntime, Project, ProjectService } from "@polyth/contracts";
import type { RuntimePool } from "./sessions.ts";

export interface RuntimeAggregate<T> {
  items: T[];
  /** True only when every selected representative runtime answered. */
  complete: boolean;
}

const selectionKey = (project: Project): string => {
  const selection = project.defaults?.harness;
  return selection?.mode === "pinned" ? `pinned:${selection.harnessId}` : "auto";
};

export async function aggregateRuntimes<T>(
  deps: { projects: ProjectService; runtimes: RuntimePool },
  fetch: (rt: AgentRuntime) => Promise<T[]>,
  key: (item: T) => string = (item) => JSON.stringify(item),
  onResult?: (items: T[]) => void,
): Promise<RuntimeAggregate<T>> {
  const projectList = await deps.projects.list();
  const bySelection = new Map<string, Project>();
  for (const project of projectList) {
    const selection = selectionKey(project);
    const current = bySelection.get(selection);
    // Keep one project per selection, replacing a remote representative with a
    // local one when available. Never drop a selection that exists only on a
    // remote project.
    if (!current || (current.remote && !project.remote)) {
      bySelection.set(selection, project);
    }
  }
  const representatives = [...bySelection.values()].map((project) => project.id);
  if (representatives.length === 0) representatives.push("__default__");

  const settled = await Promise.allSettled(
    representatives.map(async (projectId) => {
      const items = await fetch(await deps.runtimes.forProject(projectId));
      onResult?.(items);
      return items;
    }),
  );
  const out: T[] = [];
  const seen = new Set<string>();
  let complete = true;
  for (const response of settled) {
    if (response.status !== "fulfilled") {
      complete = false;
      continue;
    }
    for (const item of response.value) {
      const id = key(item);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(item);
    }
  }
  return { items: out, complete };
}
