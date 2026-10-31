import test from "node:test";
import assert from "node:assert/strict";
import type { AgentRuntime, Project, SessionProjection } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import { governPackageRuntimeHost } from "../src/packageRuntimeAuthority.ts";

const project: Project = { id: "prj_one", path: "/tmp/project", name: "One", createdAt: 1, spaceId: "spc_home" };
const projection: SessionProjection = {
  id: "ses_one", projectId: project.id, spaceId: "spc_home", title: "One",
  status: "idle", createdAt: 1, updatedAt: 1,
};

test("package runtime lookup requires governed project/session visibility first", async () => {
  let projectRuns = 0;
  let sessionRuns = 0;
  let resolved = 0;
  const runtime = {} as AgentRuntime;
  const raw = {
    runtimes: {
      async forProject() { projectRuns++; return runtime; },
      async forSession() { sessionRuns++; return runtime; },
    },
    async resolveSessionRuntime() { resolved++; return { rt: runtime, cwd: project.path }; },
  } as unknown as ServerPackageHost;
  const governed = {
    ...raw,
    projects: { get: async (id: string) => id === project.id ? project : undefined },
    sessions: {
      async snapshot(id: string) {
        if (id !== projection.id) throw Object.assign(new Error("not found"), { code: "not-found" });
        return projection;
      },
    },
  } as unknown as ServerPackageHost;

  const host = governPackageRuntimeHost(raw, governed);
  assert.equal(await host.runtimes.forProject(project.id), runtime);
  assert.equal(await host.runtimes.forSession!(projection, project.path), runtime);
  assert.equal((await host.resolveSessionRuntime(projection.id)).rt, runtime);
  await assert.rejects(host.runtimes.forProject("foreign"), { code: "not-found" });
  await assert.rejects(host.resolveSessionRuntime("foreign"), { code: "not-found" });

  assert.equal(projectRuns, 1);
  assert.equal(sessionRuns, 1);
  assert.equal(resolved, 1);
});
