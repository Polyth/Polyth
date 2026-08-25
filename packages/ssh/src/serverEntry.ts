import type {
  Project,
  ProjectService,
  RouteHandler,
  SshConnectionInput,
} from "@polyth/contracts";
import {
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import type { SshService } from "./index.ts";

export interface SshRuntimeProbe {
  ok: boolean;
  version?: string;
  message?: string;
}

export function sshRoutes(deps: {
  ssh: SshService;
  projects: ProjectService;
  probeRuntime?: (connectionId: string) => Promise<SshRuntimeProbe>;
}): RouteHandler {
  const boundProjects = async (connectionId: string): Promise<Project[]> =>
    (await deps.projects.list()).filter(
      (project) => project.remote?.connectionId === connectionId,
    );

  return async ({ path, method, url, body, json }) => {
    if (!path.startsWith("/api/ssh/")) return false;
    if (path === "/api/ssh/connections" && method === "GET") {
      json(200, {
        items: deps.ssh.list().map((connection) => ({
          ...connection,
          ...(deps.ssh.cachedStatus(connection.id)
            ? { status: deps.ssh.cachedStatus(connection.id)! }
            : {}),
        })),
      });
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
          new Error(
            `connection is used by ${bound.length} project(s): ${bound.map((project) => project.name).join(", ")} — remove them first`,
          ),
          { code: "conflict" },
        );
      }
      await deps.ssh.remove(member[1]!);
      json(200, { ok: true });
      return true;
    }
    const action = path.match(
      /^\/api\/ssh\/connections\/([^/]+)\/(connect|disconnect|status|test)$/,
    );
    if (action) {
      const [, id, operation] = action;
      if (operation === "status" && method === "GET") {
        json(200, await deps.ssh.status(id!));
        return true;
      }
      if (method !== "POST") return false;
      if (operation === "connect") {
        json(200, await deps.ssh.connect(id!));
        return true;
      }
      if (operation === "disconnect") {
        json(200, await deps.ssh.disconnect(id!));
        return true;
      }
      if (operation === "test") {
        const status = await deps.ssh.test(id!);
        if (status.state !== "connected" || !deps.probeRuntime) {
          json(200, status);
          return true;
        }
        const runtime = await deps.probeRuntime(id!).catch((error: unknown) => ({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }));
        json(200, { ...status, runtime });
        return true;
      }
    }
    if (path === "/api/ssh/browse" && method === "GET") {
      const connectionId = url.searchParams.get("connectionId") ?? "";
      if (!connectionId) {
        throw Object.assign(new Error("connectionId required"), {
          code: "invalid-input",
        });
      }
      json(200, await deps.ssh.browse(
        connectionId,
        url.searchParams.get("path") ?? undefined,
      ));
      return true;
    }
    if (path === "/api/ssh/projects" && method === "POST") {
      const input = await body();
      const connectionId = String(input.connectionId ?? "");
      const remotePath = String(input.path ?? "").trim();
      if (!connectionId) {
        throw Object.assign(new Error("connectionId required"), {
          code: "invalid-input",
        });
      }
      if (!remotePath) {
        throw Object.assign(new Error("path required"), { code: "invalid-input" });
      }
      if (!deps.ssh.get(connectionId)) {
        throw Object.assign(new Error("unknown SSH connection"), { code: "not-found" });
      }
      if (!deps.projects.addRemote) {
        throw Object.assign(new Error("remote projects are not supported"), {
          code: "unsupported",
        });
      }
      if (!(await deps.ssh.dirExists(connectionId, remotePath))) {
        if (input.createDirectory === true) {
          await deps.ssh.makeDir(connectionId, remotePath);
        } else {
          throw Object.assign(
            new Error(`remote path does not exist: ${remotePath}`),
            { code: "not-found" },
          );
        }
      }
      const name = typeof input.name === "string" && input.name.trim()
        ? input.name.trim().slice(0, 120)
        : undefined;
      json(200, await deps.projects.addRemote(
        remotePath,
        { kind: "ssh", connectionId },
        name,
      ));
      return true;
    }
    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  let routes: RouteHandler | null = null;
  let ssh: SshService | null = null;
  return {
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      ssh = host.services.require(serverServiceKey<SshService>("ssh"));
      routes ??= sshRoutes({
        ssh,
        projects: host.projects,
        probeRuntime: host.services.require(
          serverServiceKey<(connectionId: string) => Promise<SshRuntimeProbe>>(
            "ssh.probe-runtime",
          ),
        ),
      });
    },
    async onDisable() {
      await ssh?.disconnectAll();
    },
  };
}
