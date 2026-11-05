// Session sharing (Spaces §14.3): who can open a chat, at what level, and each
// reader's view of that on every projection.
//
// The canonical resource registry decides access; this file maps it onto
// sessions. Everything keys off the gateway-validated SpaceContext or a socket's
// authenticated account — never request input. A chat the reader cannot open
// answers `not-found`, exactly like a foreign id.
import {
  isSessionAccessLevel,
  isSessionVisibility,
  roleAtLeast,
  SESSION_ACCESS_LEVELS,
  sessionAccessAtLeast,
  type SessionAccessLevel,
  type SessionMentionCandidateDto,
  type NewChatPeopleDto,
  type SessionMentionOutsidersDto,
  type PersonMessageShare,
  type SessionPerson,
  type SessionProjection,
  type SessionSharingDto,
  type SessionSharingUpdate,
  type SessionSharingView,
  type SessionVisibility,
  type SpaceContext,
  type SpaceRole,
  type SpaceSharingPolicy,
  type SpaceSharingPolicyDto,
} from "@polyth/contracts";
import type { CanonicalResource, ResourceLifecycle } from "@polyth/control-plane/resources";
import { canonicalSecurity } from "./runtimeSecurity.ts";
import { isSystemContext } from "./sessionPeople.ts";

const notFound = (): Error => Object.assign(new Error("session not found"), { code: "not-found" });
const forbidden = (message: string): Error => Object.assign(new Error(message), { code: "forbidden" });
const conflict = (message: string): Error => Object.assign(new Error(message), { code: "conflict" });
const invalid = (message: string): Error => Object.assign(new Error(message), { code: "invalid-input" });

export interface SessionAccess {
  resource: CanonicalResource;
  level: SessionAccessLevel;
}

// A Space never changes organization, and a deleted Space's id is never reused.
const orgs = new WeakMap<object, Map<string, string>>();

/** Organization of a Space, from the canonical authority. */
export function orgOfSpace(spaceId: string): string | undefined {
  const security = canonicalSecurity();
  if (!security) return undefined;
  let known = orgs.get(security);
  if (!known) orgs.set(security, known = new Map());
  const cached = known.get(spaceId);
  if (cached) return cached;
  const id = security.control.get<{ id: string }>("SELECT org_id AS id FROM spaces WHERE id=?", spaceId)?.id;
  if (id) known.set(spaceId, id);
  return id;
}

/** A principal's effective access to one session of a Space, or undefined
 *  when it cannot open it. Without canonical identity there is a single
 *  person and nothing to decide, so callers skip this check entirely. */
export function sessionAccess(
  principalId: string,
  spaceId: string,
  sessionId: string,
  lifecycles?: readonly ResourceLifecycle[],
): SessionAccess | undefined {
  const result = resourceAccessOf(principalId, spaceId, sessionId, lifecycles);
  if (!result || result.resource.kind !== "session") return undefined;
  return { resource: result.resource, level: result.level };
}

function resourceAccessOf(
  principalId: string,
  spaceId: string,
  resourceId: string,
  lifecycles?: readonly ResourceLifecycle[],
) {
  const security = canonicalSecurity();
  if (!security) return undefined;
  const orgId = orgOfSpace(spaceId);
  if (!orgId) return undefined;
  try {
    return security.resourceAccess.access({
      resourceId, principalId, orgId, spaceId, ...(lifecycles ? { lifecycles } : {}),
    });
  } catch (cause) {
    // Malformed ids are indistinguishable from unknown ones.
    if ((cause as { code?: unknown } | null)?.code === "invalid-input") return undefined;
    throw cause;
  }
}

/** The row whose sharing a session follows: itself, unless it is a delegated
 *  subagent that inherits its parent chat's. */
function shareRoot(row: CanonicalResource): CanonicalResource {
  const resources = canonicalSecurity()!.resources;
  let current = row;
  for (let depth = 0; depth < 32 && current.visibility === "inherit" && current.accessParentId; depth += 1) {
    const parent = resources.resource(current.accessParentId);
    if (!parent) break;
    current = parent;
  }
  return current;
}

/** Audience after inheritance; a broken chain reads as private. */
function effectiveVisibility(row: CanonicalResource): SessionVisibility {
  const resources = canonicalSecurity()!.resources;
  let current: CanonicalResource | undefined = row;
  for (let depth = 0; current && depth < 32; depth += 1) {
    if (current.visibility !== "inherit") return current.visibility;
    const parentId: string | undefined = current.accessParentId ?? current.parentId;
    current = parentId ? resources.resource(parentId) : undefined;
  }
  return "private";
}

const humanName = (userId: string): string | undefined => canonicalSecurity()?.control.get<{ name: string }>(
  `SELECT u.display_name AS name FROM users u JOIN principals p ON p.id=u.id
    WHERE u.id=? AND p.kind='user'`,
  userId,
)?.name;
/** A person's current display name, for members addressing each other. */
export const personDisplayName = (userId: string): string | undefined => humanName(userId);
const isHuman = (principalId: string): boolean => !!canonicalSecurity()?.control.get(
  "SELECT 1 FROM principals WHERE id=? AND kind='user'",
  principalId,
);
const person = (userId: string): SessionPerson => {
  const name = humanName(userId);
  return { userId, ...(name ? { name } : {}) };
};

interface SpaceMember { userId: string; role: SpaceRole }
const spaceMembers = (spaceId: string): SpaceMember[] => canonicalSecurity()?.control.all<SpaceMember>(
  `SELECT m.principal_id AS userId, m.role AS role FROM space_memberships m JOIN principals p ON p.id=m.principal_id
    WHERE m.space_id=? AND m.state='active' AND m.role IN ('owner','admin','member','viewer')
      AND (m.expires_at_ms IS NULL OR m.expires_at_ms>?) AND p.kind='user' AND p.status='active'
    ORDER BY m.created_at_ms, m.principal_id`,
  spaceId,
  Date.now(),
) ?? [];

/** Per-call memo for decorating many rows of one Space. */
function viewer(spaceId: string, readerId: string) {
  let others: boolean | undefined;
  const memberIds = (): Set<string> => new Set(spaceMembers(spaceId).map((member) => member.userId));
  let members: Set<string> | undefined;
  const otherMembers = (): boolean => {
    if (others === undefined) {
      members ??= memberIds();
      others = [...members].some((id) => id !== readerId);
    }
    return others;
  };
  const owners = new Map<string, SessionPerson | null>();
  const ownerOf = (principalId: string): SessionPerson | undefined => {
    if (!owners.has(principalId)) owners.set(principalId, isHuman(principalId) ? person(principalId) : null);
    return owners.get(principalId) ?? undefined;
  };
  return {
    view(row: CanonicalResource, level: SessionAccessLevel): SessionSharingView {
      const root = shareRoot(row);
      const visibility = effectiveVisibility(row);
      const inherited = row.visibility === "inherit" && !!row.accessParentId;
      const owner = root.ownerPrincipalId === readerId ? undefined : ownerOf(root.ownerPrincipalId);
      let shared = owner !== undefined;
      if (!shared && visibility === "space") shared = otherMembers();
      if (!shared && visibility === "restricted") {
        members ??= memberIds();
        shared = canonicalSecurity()!.sharing.grants(root.id)
          .some((grant) => grant.principalId !== readerId && members!.has(grant.principalId));
      }
      return { visibility, ...(inherited ? { inherited: true } : {}), access: level, ...(owner ? { owner } : {}), shared };
    },
  };
}

/**
 * Rows as one person sees them: only the chats they can open, each with
 * their own `sharing` view. System work and installations without canonical
 * identity see everything, undecorated.
 */
export function rowsForReader(
  rows: readonly SessionProjection[],
  readerId: string | undefined,
  spaceId: string,
  lifecycles?: readonly ResourceLifecycle[],
): SessionProjection[] {
  if (!readerId || readerId.startsWith("system:") || !canonicalSecurity()) return [...rows];
  const memo = viewer(spaceId, readerId);
  const out: SessionProjection[] = [];
  for (const row of rows) {
    const access = sessionAccess(readerId, row.spaceId ?? spaceId, row.id, lifecycles);
    if (!access) continue;
    out.push({ ...row, sharing: memo.view(access.resource, access.level) });
  }
  return out;
}

/** Every active Space member who can open one session, in stable member
 *  order. Empty without canonical identity (a single-person install has no
 *  audience to address) or for an unknown/foreign session. */
export function sessionAudience(
  spaceId: string,
  sessionId: string,
): Array<{ userId: string; name?: string; access: SessionAccessLevel }> {
  if (!sessionId || !canonicalSecurity()) return [];
  const out: Array<{ userId: string; name?: string; access: SessionAccessLevel }> = [];
  for (const member of spaceMembers(spaceId)) {
    const access = sessionAccess(member.userId, spaceId, sessionId);
    if (!access) continue;
    const name = humanName(member.userId);
    out.push({ userId: member.userId, ...(name ? { name } : {}), access: access.level });
  }
  return out;
}

/** Space members the reader may mention in a chat: everyone who can open it,
 *  the reader excluded. A person who cannot open the session is never named. */
export function sessionMentionCandidates(
  spaceId: string,
  sessionId: string,
  excludeUserId?: string,
): SessionMentionCandidateDto[] {
  return sessionAudience(spaceId, sessionId)
    .filter((member) => member.userId !== excludeUserId)
    .map(({ userId, name, access }) => ({ userId, ...(name ? { name } : {}), access }));
}

/** Active Space members who cannot open a chat, the reader excluded. */
export function sessionOutsiders(
  spaceId: string,
  sessionId: string,
  excludeUserId?: string,
): Array<{ userId: string; name?: string }> {
  if (!sessionId || !canonicalSecurity()) return [];
  const out: Array<{ userId: string; name?: string }> = [];
  for (const member of spaceMembers(spaceId)) {
    if (member.userId === excludeUserId || sessionAccess(member.userId, spaceId, sessionId)) continue;
    const name = humanName(member.userId);
    out.push({ userId: member.userId, ...(name ? { name } : {}) });
  }
  return out;
}

/** The person who can open a chat to more people, `excludeUserId` aside: its
 *  owner when able, else the first member who is. Undefined when nobody is:
 *  Space admins get nothing on a private chat, so a policy that stops members
 *  from sharing can leave one with no way out. */
export function sessionShareApprover(
  spaceId: string,
  sessionId: string,
  excludeUserId?: string,
): SessionPerson | undefined {
  const security = canonicalSecurity();
  if (!security || !sessionId) return undefined;
  let row: CanonicalResource | undefined;
  try {
    row = security.resources.resource(sessionId);
  } catch {
    return undefined;
  }
  if (!row || row.kind !== "session" || row.spaceId !== spaceId) return undefined;
  const root = shareRoot(row);
  const policy = security.sharing.policy(spaceId);
  const able = spaceMembers(spaceId).filter((member) => {
    if (member.userId === excludeUserId || !roleAtLeast(member.role, "member")) return false;
    if (!roleAtLeast(member.role, "admin") && !policy.membersMayShare) return false;
    return sessionAccess(member.userId, spaceId, root.id)?.level === "manage";
  });
  const chosen = able.find((member) => member.userId === root.ownerPrincipalId) ?? able[0];
  return chosen ? person(chosen.userId) : undefined;
}

/** One row as one person sees it, or undefined when they cannot open it. */
export function rowForReader(
  row: SessionProjection,
  readerId: string | undefined,
  spaceId: string,
  lifecycles?: readonly ResourceLifecycle[],
): SessionProjection | undefined {
  return rowsForReader([row], readerId, spaceId, lifecycles)[0];
}

/** Lifecycles a live broadcast may announce. A new chat's projection commits,
 *  and is broadcast, while its resource is still provisioning; hiding it then
 *  would keep a fresh chat off its own creator's screen. */
export const BROADCAST_LIFECYCLES: readonly ResourceLifecycle[] = ["provisioning", "active", "archiving", "archived"];

/**
 * The person a chat is private to, or undefined when anyone else can open it
 * (restricted or Space audience), server work owns it, or there is no
 * canonical identity. A delegated subagent answers for the chat it follows.
 * Personal MCP servers (§14.6) attach only where this names their owner:
 * native MCP tools live in the harness process, which cannot gate per turn.
 */
export function privateSessionOwner(spaceId: string, sessionId: string): string | undefined {
  const security = canonicalSecurity();
  if (!security || !sessionId) return undefined;
  let row: CanonicalResource | undefined;
  try {
    row = security.resources.resource(sessionId);
  } catch {
    return undefined;
  }
  if (!row || row.kind !== "session" || row.spaceId !== spaceId) return undefined;
  if (effectiveVisibility(row) !== "private") return undefined;
  const owner = shareRoot(row).ownerPrincipalId;
  return owner && !owner.startsWith("system:") && isHuman(owner) ? owner : undefined;
}

/** Chats whose access follows `rootId`, deepest last, root excluded. */
export function accessDescendants(rootId: string): string[] {
  const sharing = canonicalSecurity()?.sharing;
  if (!sharing) return [];
  const out: string[] = [];
  const seen = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0 && out.length < 10_000) {
    for (const child of sharing.accessChildren(queue.shift()!)) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/** The audience a new chat starts with. A person's chat takes the Space's
 *  default (private unless an admin chose otherwise); chats server work
 *  starts follow their project, as before sharing existed. */
export function defaultSessionVisibility(ctx: SpaceContext): "private" | "inherit" {
  const security = canonicalSecurity();
  if (!security || !ctx.userId || isSystemContext(ctx)) return "inherit";
  return security.sharing.policy(ctx.spaceId).defaultVisibility === "space" ? "inherit" : "private";
}

/** How far a change opens a chat up: a wider audience, or people added or
 *  given more access. The Space policy limits only these. */
function widens(
  current: { visibility: SessionVisibility; grants: ReadonlyMap<string, SessionAccessLevel> },
  next: { visibility: SessionVisibility; grants: ReadonlyMap<string, SessionAccessLevel> },
): { audience: boolean; raised: SessionAccessLevel[] } {
  const order: SessionVisibility[] = ["private", "restricted", "space"];
  const audience = order.indexOf(next.visibility) > order.indexOf(current.visibility);
  const raised: SessionAccessLevel[] = [];
  for (const [userId, access] of next.grants) {
    const before = current.grants.get(userId);
    if (before === undefined || (access !== before && sessionAccessAtLeast(access, before))) raised.push(access);
  }
  return { audience, raised };
}

export interface SessionSharingDeps {
  /** Unscoped projection read (server-internal). */
  projection(sessionId: string): Promise<SessionProjection | undefined>;
  /** Tell connected readers that these chats' audience changed.
   *  `formerReaders` names, per chat, who could open it before the change:
   *  only they are told about a removal. */
  accessChanged?(projections: SessionProjection[], formerReaders: ReadonlyMap<string, ReadonlySet<string>>): void;
  /** Does this person keep any enabled personal MCP server (§14.6)? */
  hasPersonalMcpServers?(userId: string): boolean;
  /** These chats were private to `ownerUserId` and no longer are: a runtime
   *  that loaded the owner's personal MCP servers must drop them (§14.6).
   *  Called synchronously right after the change commits. */
  leftPrivate?(spaceId: string, chats: Array<{ sessionId: string; ownerUserId: string }>): void;
}

export interface SessionSharingService {
  state(ctx: SpaceContext, sessionId: string): SessionSharingDto;
  update(ctx: SpaceContext, sessionId: string, input: SessionSharingUpdate): Promise<SessionSharingDto>;
  /** Who cannot open this chat and what the reader can do about it. */
  outsiders(ctx: SpaceContext, sessionId: string): SessionMentionOutsidersDto;
  /** The same for a chat this person would start in a project. */
  newChatPeople(ctx: SpaceContext, projectId: string): NewChatPeopleDto;
  /** Adds people to a chat under the caller's own sharing rights; a delegated
   *  subagent's chat opens through the chat it follows. People who can already
   *  open it and ids that are not active members change nothing. */
  addPeople(ctx: SpaceContext, sessionId: string, people: readonly PersonMessageShare[]): Promise<void>;
  policy(ctx: SpaceContext): SpaceSharingPolicyDto;
  setPolicy(ctx: SpaceContext, input: Record<string, unknown>): SpaceSharingPolicyDto;
}

export function createSessionSharingService(deps: SessionSharingDeps): SessionSharingService {
  const authority = () => {
    const security = canonicalSecurity();
    if (!security) throw Object.assign(new Error("Sharing needs canonical identity"), { code: "unsupported" });
    return security;
  };
  const policyFor = (spaceId: string) => authority().sharing.policy(spaceId);

  const readable = (ctx: SpaceContext, sessionId: string): SessionAccess => {
    if (typeof sessionId !== "string" || !sessionId) throw notFound();
    const access = sessionAccess(ctx.userId, ctx.spaceId, sessionId);
    if (!access) throw notFound();
    return access;
  };

  /** What this person may change on a chat they can open. */
  const limits = (ctx: SpaceContext, access: SessionAccess) => rulesFor(
    ctx,
    access.level,
    access.resource.visibility === "inherit" && !!access.resource.accessParentId,
  );
  const rulesFor = (ctx: SpaceContext, level: SessionAccessLevel, inherited: boolean) => {
    const policy = policyFor(ctx.spaceId);
    const person = !!ctx.userId && !isSystemContext(ctx);
    const admin = roleAtLeast(ctx.role, "admin");
    const canShare = person && !inherited && level === "manage" && roleAtLeast(ctx.role, "member");
    const mayWiden = canShare && (admin || policy.membersMayShare);
    const maxGrant: SessionAccessLevel | null = !mayWiden ? null : admin ? "manage" : policy.maxMemberAccess;
    const allowedVisibilities: SessionVisibility[] = ["private"];
    if (mayWiden) {
      allowedVisibilities.push("restricted");
      if (policy.allowSpaceVisibility) allowedVisibilities.push("space");
    }
    return { policy, inherited, canShare, mayWiden, maxGrant, allowedVisibilities };
  };

  const currentGrants = (resourceId: string, spaceId: string): Map<string, SessionAccessLevel> => {
    const members = new Set(spaceMembers(spaceId).map((member) => member.userId));
    return new Map(authority().sharing.grants(resourceId)
      .filter((grant) => members.has(grant.principalId))
      .map((grant) => [grant.principalId, grant.access] as const));
  };

  const state = (ctx: SpaceContext, sessionId: string): SessionSharingDto => {
    const access = readable(ctx, sessionId);
    const row = access.resource;
    const root = shareRoot(row);
    const rules = limits(ctx, access);
    const owner = isHuman(root.ownerPrincipalId) ? person(root.ownerPrincipalId) : undefined;
    const grants = [...currentGrants(root.id, ctx.spaceId)].map(([userId, level]) => {
      const name = humanName(userId);
      return { userId, ...(name ? { name } : {}), access: level };
    });
    const people = spaceMembers(ctx.spaceId)
      .filter((member) => member.userId !== root.ownerPrincipalId)
      .map((member) => {
        const name = humanName(member.userId);
        return { userId: member.userId, ...(name ? { name } : {}), role: member.role };
      });
    return {
      sessionId: row.id,
      visibility: effectiveVisibility(row),
      inherited: rules.inherited,
      ...(rules.inherited && row.accessParentId ? { parentSessionId: row.accessParentId } : {}),
      ...(owner ? { owner } : {}),
      access: access.level,
      grants,
      people,
      canShare: rules.canShare,
      allowedVisibilities: rules.allowedVisibilities,
      maxGrant: rules.maxGrant,
      ...(!rules.inherited && root.ownerPrincipalId === ctx.userId && deps.hasPersonalMcpServers?.(ctx.userId)
        ? { personalMcpDetachedOnShare: true }
        : {}),
      revision: row.accessRevision,
    };
  };

  const update = async (ctx: SpaceContext, sessionId: string, input: SessionSharingUpdate): Promise<SessionSharingDto> => {
    const security = authority();
    const access = readable(ctx, sessionId);
    const rules = limits(ctx, access);
    if (rules.inherited) throw conflict("This chat follows the sharing of the chat it was delegated from; share that chat instead");
    if (!rules.canShare) throw forbidden("You can't change who can open this chat");
    if (input === null || typeof input !== "object") throw invalid("Invalid sharing change");
    if (input.visibility !== undefined && !isSessionVisibility(input.visibility)) throw invalid("Invalid audience");
    if (input.expectedRevision !== undefined
      && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) throw invalid("Invalid revision");
    let requested: Map<string, SessionAccessLevel> | undefined;
    if (input.grants !== undefined) {
      if (!Array.isArray(input.grants)) throw invalid("Invalid people list");
      requested = new Map();
      for (const grant of input.grants) {
        if (!grant || typeof grant.userId !== "string" || !grant.userId || !isSessionAccessLevel(grant.access)) {
          throw invalid("Invalid person in the people list");
        }
        if (requested.has(grant.userId)) throw invalid("A person is listed twice");
        requested.set(grant.userId, grant.access);
      }
    }
    const row = access.resource;
    const currentVisibility = effectiveVisibility(row);
    const before = currentGrants(row.id, ctx.spaceId);
    const nextVisibility = input.visibility ?? currentVisibility;
    if (nextVisibility === "private" && requested && requested.size > 0) {
      throw invalid("A private chat has nobody to share with; choose who can open it first");
    }
    const nextGrants = nextVisibility === "private" ? new Map<string, SessionAccessLevel>() : requested ?? before;
    const change = widens({ visibility: currentVisibility, grants: before }, { visibility: nextVisibility, grants: nextGrants });
    if (nextVisibility === "space" && currentVisibility !== "space" && !rules.policy.allowSpaceVisibility) {
      throw forbidden("This Space doesn't allow sharing chats with everyone");
    }
    if ((change.audience || change.raised.length > 0) && !rules.mayWiden) {
      throw forbidden("Only Space admins can share chats here");
    }
    if (rules.maxGrant && change.raised.some((level) => !sessionAccessAtLeast(rules.maxGrant!, level))) {
      throw forbidden("You can't give that much access in this Space");
    }

    const projection = await deps.projection(row.id);
    if (!projection || projection.spaceId !== ctx.spaceId) throw notFound();

    const orgId = orgOfSpace(ctx.spaceId);
    if (!orgId) throw notFound();
    // A top-level chat open to the Space follows its project, like every chat
    // did before sharing existed.
    const stored = nextVisibility === "space"
      ? (row.visibility === "space" ? "space" : row.parentId ? "inherit" : "space")
      : nextVisibility;
    // Who could open the chat and its subagents before; read synchronously
    // right before the change so nothing can interleave.
    const affectedIds = [row.id, ...accessDescendants(row.id)];
    const members = spaceMembers(ctx.spaceId).map((member) => member.userId);
    const formerReaders = new Map(affectedIds.map((id) => [
      id,
      new Set(members.filter((userId) => sessionAccess(userId, ctx.spaceId, id) !== undefined)),
    ] as const));
    const privateBefore = new Map(affectedIds.flatMap((id) => {
      const owner = privateSessionOwner(ctx.spaceId, id);
      return owner ? [[id, owner] as const] : [];
    }));
    security.sharing.share({
      resourceId: row.id,
      orgId,
      spaceId: ctx.spaceId,
      actor: ctx.userId,
      ...(input.expectedRevision !== undefined ? { expectedAccessRevision: input.expectedRevision } : {}),
      visibility: stored,
      ...(requested !== undefined || nextVisibility === "private"
        ? { grants: [...nextGrants].map(([principalId, level]) => ({ principalId, access: level })) }
        : {}),
    });
    const leftPrivate = [...privateBefore]
      .filter(([id]) => privateSessionOwner(ctx.spaceId, id) === undefined)
      .map(([sessionId, ownerUserId]) => ({ sessionId, ownerUserId }));
    if (leftPrivate.length > 0) deps.leftPrivate?.(ctx.spaceId, leftPrivate);

    if (deps.accessChanged) {
      const affected: SessionProjection[] = [];
      for (const id of affectedIds) {
        const current = id === row.id ? projection : await deps.projection(id);
        if (current) affected.push(current);
      }
      deps.accessChanged(affected, formerReaders);
    }
    return state(ctx, sessionId);
  };

  /** The chat whose sharing decides this one, as the reader may change it. */
  const rootRules = (ctx: SpaceContext, access: SessionAccess) => {
    const root = shareRoot(access.resource);
    const rootAccess = root.id === access.resource.id ? access : sessionAccess(ctx.userId, ctx.spaceId, root.id);
    return { root, rules: rootAccess ? limits(ctx, rootAccess) : undefined };
  };

  const outsiders = (ctx: SpaceContext, sessionId: string): SessionMentionOutsidersDto => {
    // Without canonical identity there is one person and nobody to mention.
    if (!canonicalSecurity()) return { people: [], action: "none", levels: [] };
    const access = readable(ctx, sessionId);
    const people = sessionOutsiders(ctx.spaceId, sessionId, ctx.userId);
    const { root, rules } = rootRules(ctx, access);
    if (rules?.mayWiden && rules.maxGrant) {
      const { maxGrant } = rules;
      const opensPrivateChat = effectiveVisibility(access.resource) === "private";
      return {
        people,
        action: "share",
        levels: SESSION_ACCESS_LEVELS.filter((level) => sessionAccessAtLeast(maxGrant, level)),
        ...(opensPrivateChat && root.ownerPrincipalId === ctx.userId && deps.hasPersonalMcpServers?.(ctx.userId)
          ? { personalMcpDetachedOnShare: true }
          : {}),
      };
    }
    const approver = sessionShareApprover(ctx.spaceId, sessionId, ctx.userId);
    return approver
      ? { people, action: "request", levels: [], approver }
      : { people, action: "none", levels: [] };
  };

  const newChatPeople = (ctx: SpaceContext, projectId: string): NewChatPeopleDto => {
    if (!canonicalSecurity()) return { people: [], inside: [], action: "none", levels: [] };
    const projectAccess = (userId: string) => {
      const result = resourceAccessOf(userId, ctx.spaceId, projectId);
      return result?.resource.kind === "project" ? result : undefined;
    };
    if (!projectId || !projectAccess(ctx.userId)) throw notFound();
    // A chat that starts private reaches nobody; one that follows its project
    // reaches whoever can open that project.
    const startsPrivate = defaultSessionVisibility(ctx) === "private";
    const people: NewChatPeopleDto["people"] = [];
    const inside: NewChatPeopleDto["inside"] = [];
    for (const member of spaceMembers(ctx.spaceId)) {
      if (member.userId === ctx.userId) continue;
      const name = humanName(member.userId);
      const named = { userId: member.userId, ...(name ? { name } : {}) };
      const level = startsPrivate ? undefined : projectAccess(member.userId)?.level;
      if (level) inside.push({ ...named, access: level });
      else people.push(named);
    }
    // Its owner-to-be holds `manage`, and with nobody else inside there is
    // nobody to ask if they may not share it.
    const { mayWiden, maxGrant } = rulesFor(ctx, "manage", false);
    if (!mayWiden || !maxGrant) return { people, inside, action: "none", levels: [] };
    return {
      people,
      inside,
      action: "share",
      levels: SESSION_ACCESS_LEVELS.filter((level) => sessionAccessAtLeast(maxGrant, level)),
      ...(startsPrivate && deps.hasPersonalMcpServers?.(ctx.userId) ? { personalMcpDetachedOnShare: true } : {}),
    };
  };

  const addPeople = async (ctx: SpaceContext, sessionId: string, people: readonly PersonMessageShare[]): Promise<void> => {
    const access = readable(ctx, sessionId);
    const { root } = rootRules(ctx, access);
    const outside = new Set(sessionOutsiders(ctx.spaceId, root.id, ctx.userId).map((member) => member.userId));
    const newcomers = people.filter((entry) => outside.has(entry.userId));
    if (newcomers.length === 0) return;
    const current = state(ctx, root.id);
    await update(ctx, root.id, {
      visibility: current.visibility === "private" ? "restricted" : current.visibility,
      grants: [
        ...current.grants.map(({ userId, access: level }) => ({ userId, access: level })),
        ...newcomers.map(({ userId, access: level }) => ({ userId, access: level })),
      ],
      expectedRevision: current.revision,
    });
  };

  const policyDto = (ctx: SpaceContext): SpaceSharingPolicyDto => {
    const record = policyFor(ctx.spaceId);
    return {
      defaultVisibility: record.defaultVisibility,
      allowSpaceVisibility: record.allowSpaceVisibility,
      membersMayShare: record.membersMayShare,
      maxMemberAccess: record.maxMemberAccess,
      revision: record.revision,
      canEdit: !!ctx.userId && !isSystemContext(ctx) && roleAtLeast(ctx.role, "admin"),
    };
  };

  return {
    state,
    update,
    outsiders,
    newChatPeople,
    addPeople,
    policy: policyDto,
    setPolicy(ctx, input) {
      if (!canonicalSecurity()) {
        throw Object.assign(new Error("Sharing needs canonical identity"), { code: "unsupported" });
      }
      if (!policyDto(ctx).canEdit) throw forbidden("Only Space admins can change how this Space shares chats");
      if (input === null || typeof input !== "object") throw invalid("Invalid sharing policy");
      const patch: Partial<SpaceSharingPolicy> = {};
      if (input.defaultVisibility !== undefined) {
        if (input.defaultVisibility !== "private" && input.defaultVisibility !== "space") throw invalid("Invalid default audience");
        patch.defaultVisibility = input.defaultVisibility;
      }
      for (const key of ["allowSpaceVisibility", "membersMayShare"] as const) {
        if (input[key] === undefined) continue;
        if (typeof input[key] !== "boolean") throw invalid(`Invalid ${key}`);
        patch[key] = input[key] as boolean;
      }
      if (input.maxMemberAccess !== undefined) {
        if (!isSessionAccessLevel(input.maxMemberAccess)) throw invalid("Invalid access level");
        patch.maxMemberAccess = input.maxMemberAccess;
      }
      const expected = input.expectedRevision;
      if (expected !== undefined && (!Number.isSafeInteger(expected) || (expected as number) < 0)) throw invalid("Invalid revision");
      authority().sharing.setPolicy({
        spaceId: ctx.spaceId,
        actor: ctx.userId,
        ...(expected !== undefined ? { expectedRevision: expected as number } : {}),
        patch,
      });
      return policyDto(ctx);
    },
  };
}
