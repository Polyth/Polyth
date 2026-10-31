import { join } from "node:path";
import { principalHasFullAccess, type ProjectService, type RouteHandler, type RouteRequest, type SessionService } from "@polyth/contracts";
import { hasInstanceOwnerAuthority, requireInstanceOwnerAuthority } from "@polyth/contracts/instance-authority";
import {
  localOnlyRemoteAccess,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { JUDGMENT_SERVICE, type JudgmentService } from "@polyth/judgment/server";
import {
  approvalLevelRank,
  createApprovalDefaultsService,
  createAutoAcceptStore,
  createPermissionScopeCheck,
  createPermissionService,
  isApprovalLevel,
  PERMISSION_SCOPE_CHECK_USE,
  type ApprovalDefaultsService,
  type ApprovalDefaultsState,
  type ApprovalLevel,
  type AutoAcceptStore,
  type PermissionScopeCheck,
  type PermissionService,
} from "./index.ts";
import { latestPersonRequest } from "./scopeCheckSources.ts";

export const APPROVAL_DEFAULTS_PATH = "/api/permissions/defaults";
/** Older clients' "Full access in every chat" switch over the Space level. */
export const FULL_ACCESS_DEFAULT_PATH = "/api/permissions/full-access";

const PROJECT_DEFAULT_PATH = /^\/api\/permissions\/defaults\/projects\/([^/]+)$/;

export interface ApprovalDefaultsDto extends ApprovalDefaultsState {
  /** Whether the reader may change them: the instance owner. */
  canEdit: boolean;
}

/** A person at a screen: the public listener, or a paired device its owner
 *  trusts like this computer. Never the agent control socket. */
const personIngress = (request: RouteRequest): boolean =>
  request.ingress.kind === "public-http"
  || (request.ingress.kind === "polyth-link" && principalHasFullAccess(request.principal));

const invalid = (message: string): Error => Object.assign(new Error(message), { code: "invalid-input" });
const forbidden = (message: string): Error => Object.assign(new Error(message), { code: "forbidden" });

/** Owner only; a change that gives any chat more autonomy also needs a
 *  person (see `personIngress`). The agent control socket may only lower. */
const requireChangeAuthority = (request: RouteRequest, before: ApprovalLevel, after: ApprovalLevel): void => {
  requireInstanceOwnerAuthority(request, "Approval defaults can only be changed by the instance owner");
  if (approvalLevelRank(after) > approvalLevelRank(before) && !personIngress(request)) {
    throw forbidden("Only a person in Polyth settings can raise an approval default");
  }
};

/** The Space's approval defaults: its own level and the projects that set
 *  their own. Anyone in the Space may read them; only the instance owner may
 *  change them, and raising one additionally requires a person. `projectsOf`
 *  resolves the caller's Space-scoped projects, so a project id from another
 *  Space reads as not found. */
export function approvalDefaultsRoutes(
  service: ApprovalDefaultsService,
  projectsOf: (request: RouteRequest) => Pick<ProjectService, "list" | "get">,
): RouteHandler {
  const dto = async (request: RouteRequest, state: ApprovalDefaultsState): Promise<ApprovalDefaultsDto> => {
    // Only projects of this Space; a removed project's level stays inert.
    const known = new Set((await projectsOf(request).list()).map((project) => project.id));
    return {
      ...state,
      projects: Object.fromEntries(Object.entries(state.projects).filter(([id]) => known.has(id))),
      canEdit: hasInstanceOwnerAuthority(request),
    };
  };
  return async (request: RouteRequest) => {
    const spaceId = request.space.spaceId;
    if (request.path === APPROVAL_DEFAULTS_PATH) {
      if (request.method === "GET") {
        request.json(200, await dto(request, service.get(spaceId)));
        return true;
      }
      if (request.method === "PUT") {
        const input = await request.body();
        if (!isApprovalLevel(input.level)) throw invalid("level must be off, routine, or all");
        requireChangeAuthority(request, service.get(spaceId).level, input.level);
        request.json(200, await dto(request, service.setSpaceLevel(spaceId, input.level, request.space.userId)));
        return true;
      }
      return false;
    }
    const match = request.path.match(PROJECT_DEFAULT_PATH);
    if (match && request.method === "PUT") {
      let projectId: string;
      try {
        projectId = decodeURIComponent(match[1]!);
      } catch {
        throw invalid("invalid project id");
      }
      const input = await request.body();
      const level = input.level;
      if (level !== "inherit" && !isApprovalLevel(level)) throw invalid("level must be off, routine, all, or inherit");
      requireInstanceOwnerAuthority(request, "Approval defaults can only be changed by the instance owner");
      if (!await projectsOf(request).get(projectId)) {
        throw Object.assign(new Error("project not found"), { code: "not-found" });
      }
      const state = service.get(spaceId);
      const before = state.projects[projectId]?.level ?? state.level;
      requireChangeAuthority(request, before, level === "inherit" ? state.level : level);
      request.json(200, await dto(request, service.setProjectLevel(spaceId, projectId, level, request.space.userId)));
      return true;
    }
    if (request.path === FULL_ACCESS_DEFAULT_PATH) {
      const legacy = (state: ApprovalDefaultsState) => ({
        enabled: state.level === "all",
        ...(state.level === "all" && state.changedAt !== undefined ? { enabledAt: state.changedAt } : {}),
        ...(state.level === "all" && state.changedBy !== undefined ? { enabledBy: state.changedBy } : {}),
      });
      if (request.method === "GET") {
        request.json(200, legacy(service.get(spaceId)));
        return true;
      }
      if (request.method === "PUT") {
        const input = await request.body();
        if (typeof input.enabled !== "boolean") throw invalid("enabled must be a boolean");
        const current = service.get(spaceId);
        // Off means back to asking, and only where Full access was the default.
        const next: ApprovalLevel = input.enabled ? "all" : current.level === "all" ? "off" : current.level;
        requireChangeAuthority(request, current.level, next);
        request.json(200, legacy(next === current.level ? current : service.setSpaceLevel(spaceId, next, request.space.userId)));
        return true;
      }
    }
    return false;
  };
}

export function autoAcceptRoutes(sessions: SessionService): RouteHandler {
  return async (request) => {
    const match = request.path.match(
      /^\/api\/sessions\/([^/]+)\/permissions\/auto-accept$/,
    );
    if (!match) return false;
    const sessionId = match[1]!;
    if (request.method === "GET") {
      if (!sessions.autoAcceptGet) {
        throw Object.assign(new Error("auto-accept unavailable"), {
          code: "unsupported",
        });
      }
      request.json(200, await sessions.autoAcceptGet(sessionId));
      return true;
    }
    if (request.method === "PATCH") {
      if (!sessions.autoAcceptSet) {
        throw Object.assign(new Error("auto-accept unavailable"), {
          code: "unsupported",
        });
      }
      const input = await request.body();
      const setting = input.setting;
      if (setting !== "on" && setting !== "all" && setting !== "off" && setting !== "inherit") {
        throw Object.assign(
          new Error("setting must be on, all, off, or inherit"),
          { code: "invalid-input" },
        );
      }
      request.json(200, await sessions.autoAcceptSet(sessionId, setting));
      return true;
    }
    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  // Shared instances the session service depends on are created here (not in
  // the composition root) and published at load time, so they exist even
  // while this package's routes are disabled.
  host.services.provide(
    serverServiceKey<PermissionService>("permissions"),
    createPermissionService(host.storageDir),
  );
  host.services.provide(
    serverServiceKey<AutoAcceptStore>("permissions.auto-accept"),
    // Compatibility reader for pre-projection settings. SessionService moves
    // each entry into canonical session storage before clearing it here.
    createAutoAcceptStore(join(host.storageDir, "auto-accept.json")),
  );
  // Per-Space, so one Space's choice never reaches another tenant. The file
  // keeps the name older servers read ("Full access in every chat").
  const approvalDefaults = createApprovalDefaultsService((spaceId) => {
    try {
      return join(host.spaceStorage(host.systemSpaceContext(spaceId)).packageDir(host.pluginId), "full-access.json");
    } catch {
      return undefined;
    }
  });
  host.services.provide(
    serverServiceKey<ApprovalDefaultsService>("permissions.approval-defaults"),
    approvalDefaults,
  );
  // Judgment second opinion for Auto-Approve. The session service decides;
  // this only answers whether to leave a routine request for a person. The
  // Judgment use registers on enable, or lazily on first use when Judgment
  // enabled later; without Judgment every review leaves today's decision.
  let enabled = false;
  let registered: { service: JudgmentService; off: () => void } | undefined;
  const judgment = (): JudgmentService | undefined => {
    const service = enabled ? host.services.get(JUDGMENT_SERVICE) : undefined;
    if (registered && registered.service !== service) {
      registered.off();
      registered = undefined;
    }
    if (service && !registered) {
      try {
        registered = { service, off: service.registerUse(PERMISSION_SCOPE_CHECK_USE) };
      } catch (error) {
        console.warn("[polyth] permissions: Judgment use registration failed", error);
      }
    }
    return service;
  };
  host.services.provide(
    serverServiceKey<PermissionScopeCheck>("permissions.scope-check"),
    createPermissionScopeCheck({
      judgment,
      context: async (sessionId) => {
        const projection = await host.store.projection(sessionId);
        if (!projection?.spaceId || !projection.projectId) return undefined;
        return { space: host.systemSpaceContext(projection.spaceId), projectId: projection.projectId };
      },
      latestRequest: (sessionId) => latestPersonRequest(host.store, sessionId),
    }),
  );
  const sessionRoutes = autoAcceptRoutes(host.sessions);
  const settingsRoutes = approvalDefaultsRoutes(approvalDefaults, (request) => host.forSpace(request.space).projects);
  return {
    remoteAccess: localOnlyRemoteAccess(["permissions"]),
    routes: async (request) => await settingsRoutes(request) || await sessionRoutes(request),
    onEnable() {
      enabled = true;
      judgment();
    },
    onDisable() {
      enabled = false;
      registered?.off();
      registered = undefined;
    },
  };
}
