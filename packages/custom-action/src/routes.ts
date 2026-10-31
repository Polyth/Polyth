// HTTP surface of custom actions. Every handler works inside the gateway-
// validated Space (`rc.space`): the project and session ids a client sends are
// resolved through the Space-scoped services before anything runs, and the
// action itself is always read from the server store — a run request never
// carries command text.
import {
  principalAllowsRemoteCapability,
  REMOTE_CAPABILITY,
  roleAtLeast,
  type AuthPrincipal,
  type Project,
  type ProjectService,
  type RemoteAccessPolicy,
  type RouteHandler,
  type RouteRequest,
  type SessionProjection,
  type SessionService,
  type SpaceContext,
} from "@polyth/contracts";
import { workspaceExecutionPath } from "@polyth/contracts/workspace";
import {
  actionAvailableIn,
  normalizeActionInput,
  type CustomActionInput,
  type CustomActionListDto,
} from "./actionModel.ts";
import type { ActionStore } from "./actionStore.ts";
import type { RunManager } from "./runManager.ts";

const PREFIX = "/api/custom-action";
const ID = "[A-Za-z0-9_-]{1,80}";
const ACTION_PATH = new RegExp(`^${PREFIX}/actions/(${ID})$`);
const RUN_ACTION_PATH = new RegExp(`^${PREFIX}/actions/(${ID})/run$`);
const RUN_OUTPUT_PATH = new RegExp(`^${PREFIX}/runs/(${ID})/output$`);
const RUN_STOP_PATH = new RegExp(`^${PREFIX}/runs/(${ID})/stop$`);

/** Paired devices reach custom actions only with the matching terminal grant:
 *  reading and running need `terminal.open` (the same grant that opens a
 *  Terminal with a command), authoring a command needs `terminal.input`, and
 *  a chat hand-off additionally needs the session grants. */
export const CUSTOM_ACTION_REMOTE_ACCESS: RemoteAccessPolicy = {
  routeScopes: ["custom-action"],
  http: [
    { methods: ["GET"], path: `${PREFIX}/actions`, capability: REMOTE_CAPABILITY.terminalOpen, mutation: false },
    { methods: ["POST"], path: `${PREFIX}/actions`, capability: REMOTE_CAPABILITY.terminalInput, mutation: true, maxBodyBytes: 128 * 1024 },
    { methods: ["PUT", "DELETE"], path: `${PREFIX}/actions/:id`, capability: REMOTE_CAPABILITY.terminalInput, mutation: true, maxBodyBytes: 128 * 1024 },
    { methods: ["PUT"], path: `${PREFIX}/order`, capability: REMOTE_CAPABILITY.terminalInput, mutation: true, maxBodyBytes: 64 * 1024 },
    { methods: ["POST"], path: `${PREFIX}/actions/:id/run`, capability: REMOTE_CAPABILITY.terminalOpen, mutation: true, maxBodyBytes: 4 * 1024 },
    { methods: ["GET"], path: `${PREFIX}/runs`, capability: REMOTE_CAPABILITY.terminalOpen, mutation: false },
    { methods: ["GET"], path: `${PREFIX}/runs/:id/output`, capability: REMOTE_CAPABILITY.terminalOpen, mutation: false },
    { methods: ["POST"], path: `${PREFIX}/runs/:id/stop`, capability: REMOTE_CAPABILITY.terminalOpen, mutation: true, maxBodyBytes: 1024 },
  ],
};

export interface CustomActionRouteDeps {
  store: ActionStore;
  runs: RunManager;
  forSpace(space: SpaceContext): { projects: ProjectService; sessions: SessionService };
}

const error = (message: string, code: string) => Object.assign(new Error(message), { code });

/** Mirrors the gateway's capability semantics without its denial logging. */
function allows(principal: AuthPrincipal, capability: string): boolean {
  if (principal.kind === "anonymous") return false;
  if (principal.kind === "local-user" || principal.kind === "internal-service") return true;
  return principalAllowsRemoteCapability(principal, capability);
}

interface Permissions {
  canManage: boolean;
  canRun: boolean;
  canChat: boolean;
  /** Why running is impossible here, when it is. */
  blocked: string | null;
}

function permissions(rc: Pick<RouteRequest, "principal" | "space">): Permissions {
  const sandboxed = rc.space.deployment === "multi-tenant-sandboxed";
  const member = roleAtLeast(rc.space.role, "member");
  const blocked = sandboxed
    ? "Custom actions run commands on the Polyth host, which this deployment does not allow."
    : !member ? "Your role in this Space cannot run commands." : null;
  const canRun = !blocked && allows(rc.principal, REMOTE_CAPABILITY.terminalOpen);
  return {
    canManage: !blocked && allows(rc.principal, REMOTE_CAPABILITY.terminalInput),
    canRun,
    canChat: canRun
      && allows(rc.principal, REMOTE_CAPABILITY.coreSessionsCreate)
      && allows(rc.principal, REMOTE_CAPABILITY.coreSessionsMessage),
    blocked,
  };
}

function requireManage(rc: RouteRequest): void {
  const allowed = permissions(rc);
  if (allowed.blocked) throw error(allowed.blocked, "forbidden");
  rc.requireCapability(REMOTE_CAPABILITY.terminalInput);
}

function requireRun(rc: RouteRequest, chat: boolean): void {
  const allowed = permissions(rc);
  if (allowed.blocked) throw error(allowed.blocked, "forbidden");
  rc.requireCapability(REMOTE_CAPABILITY.terminalOpen);
  if (chat) {
    rc.requireCapability(REMOTE_CAPABILITY.coreSessionsCreate);
    rc.requireCapability(REMOTE_CAPABILITY.coreSessionsMessage);
  }
}

async function projectInSpace(projects: ProjectService, projectId: unknown): Promise<Project> {
  if (typeof projectId !== "string" || !projectId) throw error("Choose a project.", "invalid-input");
  const project = await projects.get(projectId);
  if (!project) throw error("project not found", "not-found");
  return project;
}

async function checkedInput(rc: RouteRequest, projects: ProjectService): Promise<CustomActionInput> {
  const input = normalizeActionInput(await rc.body());
  if (input.projectId !== null) await projectInSpace(projects, input.projectId);
  return input;
}

export function customActionRoutes(deps: CustomActionRouteDeps): RouteHandler {
  return async (rc) => {
    const { path, method } = rc;
    if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false;
    const scoped = deps.forSpace(rc.space);

    if (path === `${PREFIX}/actions` && method === "GET") {
      const allowed = permissions(rc);
      const body: CustomActionListDto & { blocked: string | null } = {
        actions: await deps.store.list(rc.space),
        canManage: allowed.canManage,
        canRun: allowed.canRun,
        canChat: allowed.canChat,
        blocked: allowed.blocked,
      };
      rc.json(200, body);
      return true;
    }

    if (path === `${PREFIX}/actions` && method === "POST") {
      requireManage(rc);
      rc.json(200, { action: await deps.store.create(rc.space, await checkedInput(rc, scoped.projects)) });
      return true;
    }

    if (path === `${PREFIX}/order` && method === "PUT") {
      requireManage(rc);
      const body = await rc.body();
      const ids = Array.isArray(body.ids) && body.ids.every((id) => typeof id === "string") ? body.ids as string[] : null;
      if (!ids) throw error("ids must be a list of action ids.", "invalid-input");
      rc.json(200, { actions: await deps.store.reorder(rc.space, ids) });
      return true;
    }

    const actionMatch = path.match(ACTION_PATH);
    if (actionMatch && method === "PUT") {
      requireManage(rc);
      rc.json(200, { action: await deps.store.update(rc.space, actionMatch[1]!, await checkedInput(rc, scoped.projects)) });
      return true;
    }
    if (actionMatch && method === "DELETE") {
      requireManage(rc);
      await deps.store.remove(rc.space, actionMatch[1]!);
      rc.json(200, { ok: true });
      return true;
    }

    const runMatch = path.match(RUN_ACTION_PATH);
    if (runMatch && method === "POST") {
      const action = await deps.store.get(rc.space, runMatch[1]!);
      if (!action) throw error("This action no longer exists.", "not-found");
      if (action.mode === "terminal") {
        throw error("Terminal actions open in Terminal; start them from the Terminal endpoint.", "invalid-input");
      }
      requireRun(rc, action.mode === "chat");
      const body = await rc.body();
      const project = await projectInSpace(scoped.projects, body.projectId);
      if (!actionAvailableIn(action, project.id)) throw error("This action is not available in that project.", "not-found");
      let session: SessionProjection | null = null;
      if (typeof body.sessionId === "string" && body.sessionId) {
        const candidate = await scoped.sessions.snapshot(body.sessionId);
        // A chat from another project is not this run's context.
        if (candidate.projectId === project.id) session = candidate;
      }
      if (session?.worktreeState === "missing") throw error("The chat's checkout is missing.", "not-found");
      const cwd = workspaceExecutionPath(project, session);
      const started = await deps.runs.start({
        space: rc.space,
        action,
        projectId: project.id,
        sessionId: session?.id ?? null,
        cwd,
      });
      rc.json(200, started);
      return true;
    }

    if (path === `${PREFIX}/runs` && method === "GET") {
      rc.json(200, { runs: deps.runs.list(rc.space) });
      return true;
    }

    const outputMatch = path.match(RUN_OUTPUT_PATH);
    if (outputMatch && method === "GET") {
      const from = Number(rc.url.searchParams.get("from") ?? 0);
      rc.json(200, deps.runs.output(rc.space, outputMatch[1]!, Number.isFinite(from) ? from : 0));
      return true;
    }

    const stopMatch = path.match(RUN_STOP_PATH);
    if (stopMatch && method === "POST") {
      requireRun(rc, false);
      rc.json(200, { run: await deps.runs.stop(rc.space, stopMatch[1]!) });
      return true;
    }

    return false;
  };
}
