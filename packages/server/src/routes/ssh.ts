// HTTP face of the SSH remotes package.
//   GET    /api/ssh/connections                 -> {items: [{...dto, status?}]}
//   POST   /api/ssh/connections {input}         -> dto
//   PATCH  /api/ssh/connections/:id {input}     -> dto
//   DELETE /api/ssh/connections/:id             -> {ok} (409 when a project is bound)
//   POST   /api/ssh/connections/:id/connect     -> status
//   POST   /api/ssh/connections/:id/disconnect  -> status
//   GET    /api/ssh/connections/:id/status      -> status (local mux check)
//   POST   /api/ssh/connections/:id/test        -> status (real round-trip + runtime probe)
//   GET    /api/ssh/browse?connectionId=&path=  -> SshBrowseDto
//   POST   /api/ssh/projects {connectionId, path, name?, createDirectory?} -> Project
// Secrets never transit this surface: the connection DTO carries key PATHS and
// env-delegated auth only, and the service rejects secret-looking fields.
import type { Project, ProjectService, SshConnectionInput } from "@polyth/contracts";
import type { SshService } from "@polyth/ssh";
import type { RouteHandler } from "../http.ts";

export interface SshRuntimeProbe {
  ok: boolean;
  version?: string;
  message?: string;
}

export function sshRoutes(deps: {
  ssh: SshService;
  projects: ProjectService;
  /** Checks the agent runtime is installed on the remote (wired at the
   *  composition root through backend-opencode — this route never speaks
   *  OpenCode itself). */
  probeRuntime?: (connectionId: string) => Promise<SshRuntimeProbe>;
  /** Composition-root hook: dispose a pooled runtime bound to a project. */
  onProjectRemoved?: (projectId: string) => void | Promise<void>;
}): RouteHandler {
  const boundProjects = async (connectionId: string): Promise<Project[]> =>
    (await deps.projects.list()).filter((p) => p.remote?.connectionId === connectionId);

  return async ({ path, method, url, body, json }) => {
    if (!path.startsWith("/api/ssh/")) return false;

    if (path === "/api/ssh/connections" && method === "GET") {
      const items = deps.ssh.list().map((conn) => ({
        ...conn,
        ...(deps.ssh.cachedStatus(conn.id) ? { status: deps.ssh.cachedStatus(conn.id)! } : {}),
      }));
      json(200, { items });
      return true;
    }

    if (path === "/api/ssh/connections" && method === "POST") {
      json(200, deps.ssh.create(await body() as SshConnectionInput));
      return true;
    }

    const member = path.match(/^\/api\/ssh\/connections\/([^/]+)$/);
    if (member && method === "PATCH") {
      json(200, deps.ssh.update(member[1]!, await body() as SshConnectionInput));
      return true;
    }
    if (member && method === "DELETE") {
      const bound = await boundProjects(member[1]!);
      if (bound.length > 0) {
        throw Object.assign(
          new Error(`connection is used by ${bound.length} project(s): ${bound.map((p) => p.name).join(", ")} — remove them first`),
          { code: "conflict" },
        );
      }
      await deps.ssh.remove(member[1]!);
      json(200, { ok: true });
      return true;
    }

    const action = path.match(/^\/api\/ssh\/connections\/([^/]+)\/(connect|disconnect|status|test)$/);
    if (action) {
      const [, id, op] = action;
      if (op === "status" && method === "GET") {
        json(200, await deps.ssh.status(id!));
        return true;
      }
      if (method !== "POST") return false;
      if (op === "connect") { json(200, await deps.ssh.connect(id!)); return true; }
      if (op === "disconnect") { json(200, await deps.ssh.disconnect(id!)); return true; }
      if (op === "test") {
        const status = await deps.ssh.test(id!);
        if (status.state !== "connected" || !deps.probeRuntime) {
          json(200, status);
          return true;
        }
        const runtime = await deps.probeRuntime(id!).catch((err: unknown) => ({
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        }));
        json(200, { ...status, runtime });
        return true;
      }
    }

    if (path === "/api/ssh/browse" && method === "GET") {
      const connectionId = url.searchParams.get("connectionId") ?? "";
      if (!connectionId) throw Object.assign(new Error("connectionId required"), { code: "invalid-input" });
      json(200, await deps.ssh.browse(connectionId, url.searchParams.get("path") ?? undefined));
      return true;
    }

    if (path === "/api/ssh/projects" && method === "POST") {
      const b = await body();
      const connectionId = String(b.connectionId ?? "");
      const remotePath = String(b.path ?? "").trim();
      if (!connectionId) throw Object.assign(new Error("connectionId required"), { code: "invalid-input" });
      if (!remotePath) throw Object.assign(new Error("path required"), { code: "invalid-input" });
      if (!deps.ssh.get(connectionId)) {
        throw Object.assign(new Error("unknown SSH connection"), { code: "not-found" });
      }
      if (!deps.projects.addRemote) {
        throw Object.assign(new Error("remote projects are not supported"), { code: "unsupported" });
      }
      if (!(await deps.ssh.dirExists(connectionId, remotePath))) {
        if (b.createDirectory === true) {
          await deps.ssh.makeDir(connectionId, remotePath);
        } else {
          throw Object.assign(
            new Error(`remote path does not exist: ${remotePath}`),
            { code: "not-found" },
          );
        }
      }
      const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 120) : undefined;
      json(200, await deps.projects.addRemote(remotePath, { kind: "ssh", connectionId }, name));
      return true;
    }

    return false;
  };
}
