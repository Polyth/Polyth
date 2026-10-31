import { join } from "node:path";
import type {
  HarnessContext,
  HarnessRegistry,
  Project,
  ProjectService,
  RouteHandler,
  RouteRequest,
  SpaceContext,
  SshConnectionInput,
  SshRemoteHarnessDto,
} from "@polyth/contracts";
import {
  hasInstanceOwnerAuthority,
  hasPersonalHarnessAuthority,
  requireInstanceOwnerAuthority,
} from "@polyth/contracts/instance-authority";
import {
  adoptLegacyPackageData,
  localOnlyRemoteAccess,
  packageDataDir,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import {
  createSshService,
  type SshAccessList,
  type SshConnectionRecordDto,
  type SshPrincipal,
  type SshService,
} from "./index.ts";
import {
  installRemoteHarness,
  listRemoteHarnesses,
  remoteHarnessTargets,
} from "./harnesses.ts";

export interface SshRuntimeProbe {
  ok: boolean;
  version?: string;
  message?: string;
  installable?: boolean;
}

export function sshRoutes(deps: {
  ssh: SshService;
  projects: ProjectService;
  probeRuntime?: (connectionId: string) => Promise<SshRuntimeProbe>;
  installRuntime?: (connectionId: string) => Promise<void>;
  /** Space-scoped projects for request routes (remote project registration).
   *  The package host's unscoped project service refuses to create projects,
   *  so routes must register the checkout in the caller's Space. Defaults to
   *  `projects` for minimal deployments and existing test fakes. */
  scopedProjects?: (space: SpaceContext) => Pick<ProjectService, "list" | "addRemote">;
  /** Resolved per request: the registry belongs to another package. */
  harnesses?: () => HarnessRegistry | undefined;
}): RouteHandler {
  const installs = new Map<string, Promise<SshRemoteHarnessDto>>();
  const registry = (): HarnessRegistry => {
    const found = deps.harnesses?.();
    if (!found) {
      throw Object.assign(new Error("harnesses are unavailable"), { code: "unavailable" });
    }
    return found;
  };
  // Harness enablement is a per-Space preference; the remote host has no
  // local project, so the roster is read for the Space alone.
  const harnessContext = (space: RouteRequest["space"]): HarnessContext => ({
    space,
    spaceId: space.spaceId,
    projectId: "__default__",
    cwd: process.cwd(),
    remote: true,
  });

  const scopedProjects = (space: SpaceContext): Pick<ProjectService, "list" | "addRemote"> =>
    deps.scopedProjects?.(space) ?? deps.projects;

  const boundProjects = async (space: SpaceContext, connectionId: string): Promise<Project[]> =>
    (await scopedProjects(space).list()).filter(
      (project) => project.remote?.connectionId === connectionId,
    );

  return async (request) => {
    const { path, method, url, body, json, space } = request;
    if (!path.startsWith("/api/ssh/")) return false;
    const instanceOwner = hasInstanceOwnerAuthority(request);
    const principal: SshPrincipal = {
      kind: "person",
      userId: space.userId,
      spaceId: space.spaceId,
      instanceOwner,
    };
    const notFound = (): Error => Object.assign(new Error("unknown SSH connection"), { code: "not-found" });
    /** A connection the caller may use, else not-found (never "forbidden":
     * nobody learns another person's connection exists). */
    const usable = (id: string): SshConnectionRecordDto => {
      const connection = deps.ssh.get(id);
      if (!connection || !deps.ssh.usable(id, principal)) throw notFound();
      return connection;
    };
    // Installation connections live in the shared ssh.json, so changing one
    // (or running installs/disconnects against its host) is an owner
    // decision; a personal connection is managed by its owner alone.
    const requireManage = (connection: SshConnectionRecordDto): void => {
      if (connection.owner === "person") {
        if (connection.ownerUserId !== space.userId) throw notFound();
        return;
      }
      requireInstanceOwnerAuthority(
        request,
        "Shared SSH connections belong to the whole installation; only the server owner can change them",
      );
    };
    /** What the caller sees: allowlists only for the instance owner. */
    const view = (connection: SshConnectionRecordDto) => {
      const mine = connection.owner === "person" ? connection.ownerUserId === space.userId : instanceOwner;
      const { allowedUserIds, allowedSpaceIds, ownerUserId: _owner, ...rest } = connection;
      return {
        ...rest,
        mine,
        editable: mine,
        ...(connection.owner === "installation" && instanceOwner
          ? { allowedUserIds: allowedUserIds ?? [], allowedSpaceIds: allowedSpaceIds ?? [] }
          : {}),
        ...(deps.ssh.cachedStatus(connection.id) ? { status: deps.ssh.cachedStatus(connection.id)! } : {}),
      };
    };
    const harnessRoute = path.match(
      /^\/api\/ssh\/connections\/([^/]+)\/harnesses(?:\/([^/]+)\/install)?$/,
    );
    if (harnessRoute) {
      const [, id, harnessId] = harnessRoute;
      const connection = usable(id!);
      if (harnessId && method === "POST") requireManage(connection);
      const targets = await remoteHarnessTargets(registry(), harnessContext(space));
      if (!harnessId && method === "GET") {
        json(200, await listRemoteHarnesses({
          connection,
          host: deps.ssh.host(id!),
          targets,
          probe: url.searchParams.get("probe") === "1",
        }));
        return true;
      }
      if (harnessId && method === "POST") {
        const target = targets.find((entry) => entry.harnessId === harnessId);
        if (!target) {
          throw Object.assign(new Error("harness is not enabled"), { code: "not-found" });
        }
        const key = `${id}\0${harnessId}`;
        let flight = installs.get(key);
        if (!flight) {
          flight = installRemoteHarness({ connection, host: deps.ssh.host(id!), target })
            .finally(() => installs.delete(key));
          installs.set(key, flight);
        }
        json(200, await flight);
        return true;
      }
      return false;
    }
    if (path === "/api/ssh/connections" && method === "GET") {
      const shared = deps.ssh.list().filter((connection) => deps.ssh.usable(connection.id, principal));
      json(200, {
        items: [...shared, ...deps.ssh.listOwned(space.userId)].map(view),
        canAddShared: instanceOwner,
        canAddPersonal: hasPersonalHarnessAuthority(request),
      });
      return true;
    }
    if (path === "/api/ssh/connections" && method === "POST") {
      const input = await body() as SshConnectionInput & { owner?: unknown };
      const { owner, ...fields } = input;
      if (owner !== undefined && owner !== "installation" && owner !== "person") {
        throw Object.assign(new Error('owner must be "installation" or "person"'), { code: "invalid-input" });
      }
      // The instance owner adds shared connections unless it asks for a
      // personal one; everyone else may add only their own.
      const personal = owner === "person" || (owner === undefined && !instanceOwner);
      if (!personal) {
        requireInstanceOwnerAuthority(
          request,
          "Shared SSH connections belong to the whole installation; only the server owner can add them",
        );
        json(200, view(deps.ssh.create(fields)));
        return true;
      }
      if (!hasPersonalHarnessAuthority(request)) {
        throw Object.assign(
          new Error("adding your own SSH connections requires permission from the server owner"),
          { code: "forbidden" },
        );
      }
      json(200, view(deps.ssh.create(fields, { kind: "person", userId: space.userId })));
      return true;
    }
    const accessRoute = path.match(/^\/api\/ssh\/connections\/([^/]+)\/access$/);
    if (accessRoute && method === "PUT") {
      const connection = usable(accessRoute[1]!);
      if (connection.owner !== "installation") {
        throw Object.assign(new Error("a personal connection is used only by its owner"), { code: "invalid-input" });
      }
      requireManage(connection);
      json(200, view(deps.ssh.setAccess(connection.id, await body() as unknown as SshAccessList)));
      return true;
    }
    const keyRoute = path.match(/^\/api\/ssh\/connections\/([^/]+)\/key$/);
    if (keyRoute && method === "PUT") {
      const connection = usable(keyRoute[1]!);
      requireManage(connection);
      const input = await body();
      json(200, view(deps.ssh.putKey(connection.id, input.privateKey as string)));
      return true;
    }
    const member = path.match(/^\/api\/ssh\/connections\/([^/]+)$/);
    if (member && method === "PATCH") {
      const connection = usable(member[1]!);
      requireManage(connection);
      json(200, view(deps.ssh.update(connection.id, await body() as SshConnectionInput)));
      return true;
    }
    if (member && method === "DELETE") {
      requireManage(usable(member[1]!));
      const bound = await boundProjects(space, member[1]!);
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
      /^\/api\/ssh\/connections\/([^/]+)\/(connect|disconnect|status|test|install)$/,
    );
    if (action) {
      const [, id, operation] = action;
      const connection = usable(id!);
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
        requireManage(connection);
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
      if (operation === "install") {
        requireManage(connection);
        if (!deps.installRuntime) {
          throw Object.assign(new Error("remote OpenCode installation is unavailable"), {
            code: "unsupported",
          });
        }
        await deps.installRuntime(id!);
        json(200, { ok: true });
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
      usable(connectionId);
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
      usable(connectionId);
      const projects = scopedProjects(space);
      if (!projects.addRemote) {
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
      // The checkout must be registered in the caller's Space: the package
      // host's unscoped project service refuses to create projects.
      json(200, await projects.addRemote(
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
  // SSH remotes: connection inventory + multiplexed OpenSSH transport.
  // Remote-bound projects run their agent runtime ON the remote host (the
  // composition root's runtime pool resolves this service lazily); this
  // service never speaks OpenCode itself.
  const dataDir = packageDataDir(host);
  adoptLegacyPackageData(host, ["ssh.json"]);
  const people = host.people;
  const ssh = createSshService({
    file: join(dataDir, "ssh.json"),
    ...(people
      ? {
        personStorage: (userId: string) => people.storage(userId, "ssh"),
        isMember: (userId: string, spaceId: string) => people.isMember(userId, spaceId),
      }
      : {}),
  });
  host.services.provide(serverServiceKey<SshService>("ssh"), ssh);
  let routes: RouteHandler | null = null;
  return {
    remoteAccess: localOnlyRemoteAccess(["ssh"]),
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      // The probe stays bound in the composition root so no feature package
      // ever imports backend-opencode; it is published after package load.
      routes ??= sshRoutes({
        ssh,
        projects: host.projects,
        scopedProjects: (space) => host.forSpace(space).projects,
        probeRuntime: host.services.require(
          serverServiceKey<(connectionId: string) => Promise<SshRuntimeProbe>>(
            "ssh.probe-runtime",
          ),
        ),
        installRuntime: host.services.require(
          serverServiceKey<(connectionId: string) => Promise<void>>(
            "ssh.install-runtime",
          ),
        ),
        harnesses: () => host.services.get(serverServiceKey<HarnessRegistry>("harnesses")),
      });
    },
    async onDisable() {
      await ssh.disconnectAll();
    },
  };
}
