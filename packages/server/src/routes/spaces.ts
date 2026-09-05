// Space management: list, create, rename, delete, switch, membership.
//
// The active Space is NEVER taken from a request body. `rc.space` is already
// resolved and validated by the gateway; these routes only mutate the registry
// and the remembered per-device selection.
import {
  isSpaceRole,
  type RouteHandler,
  type RouteRequest,
  type SpacesStateDto,
} from "@polyth/contracts";
import type { AuditSink, SpaceResolver, TenancyStore } from "@polyth/tenancy";
import { AUDIT } from "@polyth/tenancy";

const invalid = (message: string): Error =>
  Object.assign(new Error(message), { code: "invalid-input" });

export interface SpaceRoutesDeps {
  store: TenancyStore;
  resolver: SpaceResolver;
  audit: AuditSink;
  /** Set the remembered-space cookie so a reload lands in the same Space. */
  setActiveSpaceCookie(rc: Pick<RouteRequest, "res" | "ingress">, spaceId: string): void;
  /** Max Spaces one user may own. Hosted deployments tighten this. */
  maxSpacesPerUser?: number;
}

export function spaceRoutes(deps: SpaceRoutesDeps): RouteHandler {
  const { store, resolver, audit } = deps;
  const limit = deps.maxSpacesPerUser ?? 24;

  const state = (userId: string, activeSpaceId: string): SpacesStateDto => {
    const user = store.user(userId);
    if (!user) throw Object.assign(new Error("unknown user"), { code: "unauthorized" });
    const spaces = store.spacesFor(userId);
    return {
      user,
      spaces,
      activeSpaceId,
      deployment: resolver.deployment,
      canCreate: spaces.filter((s) => s.role === "owner").length < limit,
    };
  };

  return async (rc) => {
    const { path, method } = rc;
    if (!path.startsWith("/api/spaces")) return false;
    const ctx = rc.space;

    if (path === "/api/spaces" && method === "GET") {
      rc.json(200, state(ctx.userId, ctx.spaceId));
      return true;
    }

    if (path === "/api/spaces" && method === "POST") {
      const current = state(ctx.userId, ctx.spaceId);
      if (!current.canCreate) throw invalid(`a user may own at most ${limit} spaces`);
      const body = await rc.body();
      const space = store.createSpace({
        name: String(body.name ?? ""),
        ownerId: ctx.userId,
        ...(typeof body.color === "string" ? { color: body.color } : {}),
        ...(typeof body.icon === "string" ? { icon: body.icon } : {}),
      });
      audit.record(ctx, AUDIT.spaceCreated, { resource: { kind: "space", id: space.id } });
      rc.json(200, state(ctx.userId, ctx.spaceId));
      return true;
    }

    let m = path.match(/^\/api\/spaces\/([^/]+)$/);
    if (m && method === "PATCH") {
      const spaceId = m[1]!;
      const body = await rc.body();
      const space = store.renameSpace(ctx.userId, spaceId, {
        ...(body.name !== undefined ? { name: String(body.name) } : {}),
        ...(body.color !== undefined ? { color: String(body.color) } : {}),
        ...(body.icon !== undefined ? { icon: String(body.icon) } : {}),
      });
      audit.record(ctx, AUDIT.spaceRenamed, { resource: { kind: "space", id: space.id } });
      rc.json(200, state(ctx.userId, ctx.spaceId));
      return true;
    }

    if (m && method === "DELETE") {
      const spaceId = m[1]!;
      // Deleting the Space you are standing in would leave the session with a
      // dangling context, so the caller must switch away first.
      if (spaceId === ctx.spaceId) {
        throw invalid("switch to another space before deleting this one");
      }
      store.deleteSpace(ctx.userId, spaceId);
      audit.record(ctx, AUDIT.spaceDeleted, { resource: { kind: "space", id: spaceId } });
      rc.json(200, state(ctx.userId, ctx.spaceId));
      return true;
    }

    m = path.match(/^\/api\/spaces\/([^/]+)\/activate$/);
    if (m && method === "POST") {
      const spaceId = m[1]!;
      // requireMembership throws not-found for a Space this user cannot use,
      // so an unauthorized switch is indistinguishable from a bad id.
      store.requireMembership(ctx.userId, spaceId);
      resolver.remember(rc.principal, spaceId);
      deps.setActiveSpaceCookie(rc, spaceId);
      audit.record(ctx, AUDIT.spaceSwitched, { resource: { kind: "space", id: spaceId } });
      rc.json(200, state(ctx.userId, spaceId));
      return true;
    }

    m = path.match(/^\/api\/spaces\/([^/]+)\/members$/);
    if (m && method === "GET") {
      rc.json(200, store.members(ctx.userId, m[1]!));
      return true;
    }
    if (m && method === "POST") {
      const body = await rc.body();
      const role = body.role;
      if (!isSpaceRole(role)) throw invalid("role must be viewer, member, admin, or owner");
      const membership = store.addMember(ctx.userId, m[1]!, String(body.userId ?? ""), role);
      audit.record(ctx, AUDIT.memberAdded, {
        resource: { kind: "space", id: m[1]! },
        detail: { userId: membership.userId, role: membership.role },
      });
      rc.json(200, membership);
      return true;
    }

    m = path.match(/^\/api\/spaces\/([^/]+)\/members\/([^/]+)$/);
    if (m && method === "DELETE") {
      store.removeMember(ctx.userId, m[1]!, m[2]!);
      audit.record(ctx, AUDIT.memberRemoved, {
        resource: { kind: "space", id: m[1]! },
        detail: { userId: m[2]! },
      });
      rc.json(200, { ok: true });
      return true;
    }

    return false;
  };
}
