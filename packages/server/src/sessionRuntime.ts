import type {
  AgentRuntime,
  ModelRef,
  ProjectService,
  SessionPersistence,
} from "@polyth/contracts";
import type { RuntimePool } from "./sessions.ts";

export interface SessionRuntimeBinding {
  rt: AgentRuntime;
  cwd: string;
  model?: ModelRef;
  agent?: string;
}

/** Resolve background model work against the same project/worktree runtime as
 * the parent session. */
export async function resolveSessionRuntimeBinding(
  sessionId: string,
  deps: {
    store: Pick<SessionPersistence, "projection">;
    projects: Pick<ProjectService, "get">;
    runtimes: RuntimePool;
  },
): Promise<SessionRuntimeBinding> {
  const projection = await deps.store.projection(sessionId);
  const projectId = projection?.projectId ?? "__default__";
  const project = projection ? await deps.projects.get(projectId) : undefined;
  // A canonical session may outlive project metadata. Never reinterpret that
  // stale stable project id as the default project/Space: doing so could bind
  // background work to another tenant's runtime capabilities after deletion.
  if (projection && !project) {
    throw Object.assign(new Error("project not found"), { code: "not-found" });
  }
  const cwd = projection?.worktreePath ?? project?.path ?? process.cwd();
  const rt = projection && deps.runtimes.forSession
    ? await deps.runtimes.forSession(projection, cwd)
    : await deps.runtimes.forProject(projectId, cwd);
  return {
    rt,
    cwd,
    ...(projection?.model ? { model: projection.model } : {}),
    ...(projection?.agent ? { agent: projection.agent } : {}),
  };
}
