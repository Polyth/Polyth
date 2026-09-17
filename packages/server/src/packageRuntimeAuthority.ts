import type { ServerPackageHost } from "@polyth/plugins";

const notFound = (message: string): Error => Object.assign(new Error(message), { code: "not-found" });
const recovery = (): Error => Object.assign(new Error("runtime resource scope changed"), { code: "recovery-required" });

/**
 * Execution-plane companion to governPackageHost(). Resource lookups use the
 * already-governed host, while the actual runtime pool remains the raw server
 * implementation. A package can no longer turn an arbitrary project/session id
 * directly into host execution without first passing canonical authority.
 */
export function governPackageRuntimeHost(
  raw: ServerPackageHost,
  governed: ServerPackageHost,
): ServerPackageHost {
  const runtimes: ServerPackageHost["runtimes"] = {
    ...raw.runtimes,
    async forProject(projectId, cwd, targetHarnessId) {
      const project = await governed.projects.get(projectId);
      if (!project) throw notFound("project not found");
      return raw.runtimes.forProject(projectId, cwd, targetHarnessId);
    },
    ...(raw.runtimes.forSession ? {
      async forSession(projection, cwd, targetHarnessId) {
        const current = await governed.sessions.snapshot(projection.id);
        if (current.projectId !== projection.projectId || current.spaceId !== projection.spaceId) throw recovery();
        return raw.runtimes.forSession!(current, cwd, targetHarnessId);
      },
    } : {}),
  };

  return {
    ...governed,
    runtimes,
    async resolveSessionRuntime(sessionId) {
      await governed.sessions.snapshot(sessionId);
      return raw.resolveSessionRuntime(sessionId);
    },
  };
}
