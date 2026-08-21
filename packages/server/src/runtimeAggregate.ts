// Cross-runtime catalog aggregation shared by /api/models, /api/agents,
// /api/providers, and the agent-profile routes. Per-project pools may hold
// different runtimes, so a read fans out to every project in parallel
// (Promise.allSettled: one dead runtime never blocks or fails the rest) and
// the merged result is deduped by a caller-supplied key.
import type { AgentRuntime, ProjectService } from "@polyth/contracts";
import type { RuntimePool } from "./sessions.ts";

export async function aggregateRuntimes<T>(
  deps: { projects: ProjectService; runtimes: RuntimePool },
  fetch: (rt: AgentRuntime) => Promise<T[]>,
  key: (item: T) => string = (item) => JSON.stringify(item),
): Promise<T[]> {
  const projectList = await deps.projects.list();
  const ids = projectList.length ? projectList.map((p) => p.id) : ["__default__"];
  const settled = await Promise.allSettled(
    ids.map(async (id) => fetch(await deps.runtimes.forProject(id))),
  );
  const out: T[] = [];
  const seen = new Set<string>();
  for (const result of settled) {
    if (result.status !== "fulfilled") continue; // that project's runtime is unavailable
    for (const item of result.value) {
      const k = key(item);
      if (!seen.has(k)) { seen.add(k); out.push(item); }
    }
  }
  return out;
}
