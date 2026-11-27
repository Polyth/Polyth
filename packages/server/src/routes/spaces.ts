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
import type { AuditSink, CreateSpaceInput, SpaceResolver, TenancyStore } from "@polyth/tenancy";
import { AUDIT } from "@polyth/tenancy";
import { personDisplayName } from "../sessionSharing.ts";
import { isJoinedSpaceId, type JoinedSpacesService } from "@polyth/plugins";
import { mayUseJoinedSpaces } from "../joinedSpaceRouting.ts";

const invalid = (message: string): Error =>
  Object.assign(new Error(message), { code: "invalid-input" });

const IDEMPOTENCY_KEY = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/i;

/** 128-bit caller-owned operation identity. Missing remains backward compatible;
 * malformed values never silently fall back to a non-idempotent mutation. */
function operationId(rc: Pick<RouteRequest, "req">): string | undefined {
  const raw = rc.req.headers["idempotency-key"];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw) || typeof raw !== "string") throw invalid("Idempotency-Key must be a single 128-bit random ID");
  const value = raw.trim().toLowerCase();
  if (!IDEMPOTENCY_KEY.test(value)) throw invalid("Idempotency-Key must be a 128-bit random ID");
  return value;
}

type MutationOperation = { operationId?: string };
type CanonicalMutationStore = TenancyStore & {
  createSpace(input: CreateSpaceInput, operation?: MutationOperation & { maxOwnedSpaces?: number }): ReturnType<TenancyStore["createSpace"]>;
  renameSpace(userId: string, spaceId: string, patch: Parameters<TenancyStore["renameSpace"]>[2], operation?: MutationOperation): ReturnType<TenancyStore["renameSpace"]>;
  deleteSpace(userId: string, spaceId: string, operation?: MutationOperation): void;
  addMember(actorId: string, spaceId: string, userId: string, role: Parameters<TenancyStore["addMember"]>[3], operation?: MutationOperation): ReturnType<TenancyStore["addMember"]>;
  removeMember(actorId: string, spaceId: string, userId: string, operation?: MutationOperation): void;
};

export interface SpaceRoutesDeps {
  store: TenancyStore;
  resolver: SpaceResolver;
  audit: AuditSink;
  /** Set the remembered-space cookie so a reload lands in the same Space. */
  setActiveSpaceCookie(rc: Pick<RouteRequest, "res" | "ingress">, spaceId: string): void;
  /** Max Spaces one user may own. Hosted deployments tighten this. */
  maxSpacesPerUser?: number;
  /** Spaces of other servers people here joined (the Link package). */
  joinedSpaces?: () => JoinedSpacesService | undefined;
  /** The joined Space this request's Space cookie names, if any. */
  joinedSpaceCookie?: (rc: Pick<RouteRequest, "req">) => string | null;
}

export function spaceRoutes(deps: SpaceRoutesDeps): RouteHandler {
  const { store, resolver, audit } = deps;
  const mutations = store as CanonicalMutationStore;
  const limit = deps.maxSpacesPerUser ?? 24;

  /** Only a person signed in here sees their joined Spaces, and only theirs. */
  const joinedFor = (rc: Pick<RouteRequest, "principal">, userId: string) => {
    if (!mayUseJoinedSpaces(rc.principal)) return [];
    return deps.joinedSpaces?.()?.list(userId) ?? [];
  };
  const state = (userId: string, activeSpaceId: string, joined: ReturnType<typeof joinedFor> = []): SpacesStateDto => {
    const user = store.user(userId);
    if (!user) throw Object.assign(new Error("unknown user"), { code: "unauthorized" });
    const spaces = store.spacesFor(userId);
    // This server's name only matters beside another server's: it heads its
    // own Spaces in the switcher once the person has joined one elsewhere.
    const serverName = joined.length ? deps.joinedSpaces?.()?.serverName?.().trim() ?? "" : "";
    return {
      user,
      spaces,
      activeSpaceId,
      deployment: resolver.deployment,
      canCreate: spaces.filter((s) => s.role === "owner").length < limit,
      ...(joined.length ? { joined } : {}),
      ...(serverName ? { serverName } : {}),
    };
  };

  return async (rc) => {
    const { path, method } = rc;
    if (!path.startsWith("/api/spaces")) return false;
    const ctx = rc.space;

    if (path === "/api/spaces" && method === "GET") {
      const joined = joinedFor(rc, ctx.userId);
      const cookie = deps.joinedSpaceCookie?.(rc) ?? null;
      const active = cookie && joined.some((space) => space.id === cookie) ? cookie : ctx.spaceId;
      rc.json(200, state(ctx.userId, active, joined));
      return true;
    }

    if (path === "/api/spaces" && method === "POST") {
      const op = operationId(rc);
      const current = state(ctx.userId, ctx.spaceId);
      // An idempotent retry may arrive after the first create reached the
      // ownership limit. Let the canonical receipt replay before enforcing the
      // limit again; the store checks maxOwnedSpaces on first execution only.
      if (!op && !current.canCreate) throw invalid(`a user may own at most ${limit} spaces`);
      const body = await rc.body();
      const space = mutations.createSpace({
        name: String(body.name ?? ""),
        ownerId: ctx.userId,
        ...(typeof body.color === "string" ? { color: body.color } : {}),
        ...(typeof body.icon === "string" ? { icon: body.icon } : {}),
      }, op ? { operationId: op, maxOwnedSpaces: limit } : undefined);
      audit.record(ctx, AUDIT.spaceCreated, { resource: { kind: "space", id: space.id } });
      rc.json(200, state(ctx.userId, ctx.spaceId));
      return true;
    }

    let m = path.match(/^\/api\/spaces\/([^/]+)$/);
    if (m && method === "PATCH") {
      const spaceId = m[1]!;
      const body = await rc.body();
      const op = operationId(rc);
      const space = mutations.renameSpace(ctx.userId, spaceId, {
        ...(body.name !== undefined ? { name: String(body.name) } : {}),
        ...(body.color !== undefined ? { color: String(body.color) } : {}),
        ...(body.icon !== undefined ? { icon: String(body.icon) } : {}),
      }, op ? { operationId: op } : undefined);
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
      const op = operationId(rc);
      mutations.deleteSpace(ctx.userId, spaceId, op ? { operationId: op } : undefined);
      audit.record(ctx, AUDIT.spaceDeleted, { resource: { kind: "space", id: spaceId } });
      rc.json(200, state(ctx.userId, ctx.spaceId));
      return true;
    }

    m = path.match(/^\/api\/spaces\/([^/]+)\/activate$/);
    if (m && method === "POST") {
      const spaceId = m[1]!;
      if (isJoinedSpaceId(spaceId)) {
        // Another server's Space: only its own person may open it, and this
        // server's remembered Space stays as it was for the way back.
        const joined = joinedFor(rc, ctx.userId);
        if (!joined.some((space) => space.id === spaceId)) {
          throw Object.assign(new Error("space not found"), { code: "not-found" });
        }
        deps.setActiveSpaceCookie(rc, spaceId);
        audit.record(ctx, AUDIT.spaceSwitched, { resource: { kind: "joined-space", id: spaceId } });
        rc.json(200, state(ctx.userId, spaceId, joined));
        return true;
      }
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
      // Members already see each other's names in sharing and mentions.
      rc.json(200, store.members(ctx.userId, m[1]!).map((member) => {
        const name = personDisplayName(member.userId);
        return name ? { ...member, name } : member;
      }));
      return true;
    }
    if (m && method === "POST") {
      const body = await rc.body();
      const role = body.role;
      if (!isSpaceRole(role)) throw invalid("role must be viewer, member, admin, or owner");
      const op = operationId(rc);
      const membership = mutations.addMember(ctx.userId, m[1]!, String(body.userId ?? ""), role, op ? { operationId: op } : undefined);
      audit.record(ctx, AUDIT.memberAdded, {
        resource: { kind: "space", id: m[1]! },
        detail: { userId: membership.userId, role: membership.role },
      });
      rc.json(200, membership);
      return true;
    }

    m = path.match(/^\/api\/spaces\/([^/]+)\/members\/([^/]+)$/);
    if (m && method === "DELETE") {
      const op = operationId(rc);
      mutations.removeMember(ctx.userId, m[1]!, m[2]!, op ? { operationId: op } : undefined);
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
