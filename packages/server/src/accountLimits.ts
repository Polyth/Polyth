// Account limits: the owner's per-account ceiling on projects, harnesses and
// daily use (Settings → Users). Independent of Protected mode
// (accountGuardrails.ts): any non-owner account may be limited.
//
// Project lists are enforced in the canonical read policy (resourceAccess's
// `projectAllowed`, wired in canonicalSecurity.ts), so every project, session
// and package route already sees only allowed projects. This file owns what a
// read policy cannot express: which harness a chat runs on, the daily counts,
// listings that bypass per-resource reads, and adding new projects.
//
// Everything here keys off the gateway-validated SpaceContext.userId; nothing
// is read from request bodies.
import {
  accountLimitAllowsProject,
  harnessUsableByUser,
  type AccountLimits,
  type HarnessSelection,
  type ModelDescriptor,
  type ProjectService,
  type SessionProjection,
  type SessionService,
  type SpaceContext,
} from "@polyth/contracts";
import type { HarnessAccess, HarnessActor } from "./accountPermissions.ts";
import { canonicalSecurity } from "./runtimeSecurity.ts";

type Metric = "messages" | "chats";

export interface LimitsAuthority {
  forUser(userId: string): AccountLimits | null;
  /** Count one use; the counted day, or null when today's cap is reached. */
  consume(userId: string, metric: Metric, cap: number | null): string | null;
  refund(userId: string, metric: Metric, day: string): void;
}

/** Live authority through the canonical identity store; legacy single-user
 *  installations have no limits. */
export function limitsAuthority(): LimitsAuthority | null {
  const limits = canonicalSecurity()?.identity.limits;
  if (!limits) return null;
  return {
    forUser: (userId) => limits.forUser(userId).limits as AccountLimits | null,
    consume: (userId, metric, cap) => limits.consume(userId, metric, cap),
    refund: (userId, metric, day) => limits.refund(userId, metric, day),
  };
}

export const limitsForUser = (userId: string): AccountLimits | null => limitsAuthority()?.forUser(userId) ?? null;

const forbidden = (message: string): Error => Object.assign(new Error(message), { code: "forbidden" });
const notFound = (): Error => Object.assign(new Error("project not found"), { code: "not-found" });
/** A refusal before any effect; 429 tells clients it is about volume. */
const limitReached = (message: string): Error => Object.assign(new Error(message), { code: "limit-reached", status: 429 });

const pinned = (harnessId: string): HarnessSelection => ({ mode: "pinned", harnessId });

/** May this account run on a harness under its limits? */
type HarnessAllowed = (limits: AccountLimits | null, harnessId: string) => boolean;

/** The limit check for one user in one Space: a shared harness must be on
 *  the owner's list and open to the user and Space; the user's own private
 *  login need not be on the list. Other users' private logins are refused
 *  here and by accountPermissions.ts. */
export function harnessAllowedFor(actor: HarnessActor, harnessAccess?: HarnessAccess): HarnessAllowed {
  return (limits, harnessId) =>
    harnessUsableByUser({ id: harnessId, ...harnessAccess?.().get(harnessId) }, actor.userId, limits?.harnesses, actor.spaceId);
}

/** A pinned selection must be allowed; Auto is never allowed under a list,
 *  because Auto may fall back to any harness. */
function checkSelection(allowed: HarnessAllowed, limits: AccountLimits, selection: HarnessSelection): HarnessSelection {
  if (selection.mode !== "pinned" || !allowed(limits, selection.harnessId)) {
    throw forbidden("This account can't use that assistant");
  }
  return selection;
}

function defaultHarness(limits: AccountLimits): HarnessSelection {
  const first = limits.harnesses?.[0];
  if (!first) throw forbidden("No assistant is available for this account");
  return pinned(first);
}

/**
 * The selection a turn on an existing chat must carry. A chat already pinned
 * to an allowed harness needs none; anything else (Auto, or another member's
 * harness in a shared chat) is pinned first, to the harness it already runs
 * on when that is allowed, so no switch happens.
 */
function turnSelection(allowed: HarnessAllowed, limits: AccountLimits, projection: SessionProjection): HarnessSelection | undefined {
  const current = projection.harness;
  if (current?.mode === "pinned" && allowed(limits, current.harnessId)) return undefined;
  const running = projection.resolvedHarnessId;
  return running && allowed(limits, running) ? pinned(running) : defaultHarness(limits);
}

/** Unlimited accounts are not counted: an ordinary send never writes to the
 *  control plane. A limited account is counted even for an uncapped metric,
 *  so the owner sees its use. */
async function counted<T>(
  authority: LimitsAuthority,
  userId: string,
  limits: AccountLimits | null,
  metric: Metric,
  run: () => Promise<T>,
): Promise<T> {
  if (!limits) return run();
  const cap = metric === "messages" ? limits.messagesPerDay : limits.chatsPerDay;
  const day = authority.consume(userId, metric, cap);
  if (day === null) {
    throw limitReached(metric === "messages"
      ? `This account has used today's ${cap} messages. The limit resets tomorrow.`
      : `This account has started today's ${cap} new chats. The limit resets tomorrow.`);
  }
  try {
    return await run();
  } catch (cause) {
    // Nothing was sent or created; the use is not spent.
    authority.refund(userId, metric, day);
    throw cause;
  }
}

/**
 * Session operations for an actor. Applied inside the Protected mode facade
 * (so its model/harness choice is checked here too) and above every
 * ownership/visibility check. Optional methods stay optional.
 */
export function limitedSessionService(
  base: SessionService,
  actor: HarnessActor,
  authority: LimitsAuthority,
  harnessAccess?: HarnessAccess,
): SessionService {
  const { userId } = actor;
  const limited: SessionService = { ...base };
  const allowed = harnessAllowedFor(actor, harnessAccess);
  // Re-read per call: a saved change applies to the next action, not the
  // next sign-in.
  const current = (): AccountLimits | null => authority.forUser(userId);

  limited.create = async (input) => {
    const limits = current();
    if (limits && !accountLimitAllowsProject(limits, input.projectId)) throw notFound();
    const harness = limits?.harnesses
      ? input.harness ? checkSelection(allowed, limits, input.harness) : defaultHarness(limits)
      : input.harness;
    return counted(authority, userId, limits, "chats", () =>
      base.create({ ...input, ...(harness ? { harness } : {}) }));
  };
  limited.fork = async (sessionId, atSeq) => {
    const limits = current();
    return counted(authority, userId, limits, "chats", () => base.fork(sessionId, atSeq));
  };
  limited.send = async (sessionId, input, admission) => {
    const limits = current();
    let next = input;
    if (limits?.harnesses) {
      if (input.harness) checkSelection(allowed, limits, input.harness);
      else {
        const selection = turnSelection(allowed, limits, await base.snapshot(sessionId));
        if (selection) next = { ...input, harness: selection };
      }
    }
    return counted(authority, userId, limits, "messages", () =>
      admission ? base.send(sessionId, next, admission) : base.send(sessionId, next));
  };
  if (base.resumeNow) {
    const resumeNow = base.resumeNow.bind(base);
    limited.resumeNow = async (sessionId, options) => {
      const limits = current();
      if (!limits?.harnesses) return resumeNow(sessionId, options);
      // A bare ModelRef is the legacy form of { model }.
      const opts = options && "providerID" in options ? { model: options } : options;
      if (opts?.harness) {
        checkSelection(allowed, limits, opts.harness);
        return resumeNow(sessionId, opts);
      }
      const selection = turnSelection(allowed, limits, await base.snapshot(sessionId));
      return resumeNow(sessionId, selection ? { ...opts, harness: selection } : options);
    };
  }
  if (base.switchHarness) {
    const switchHarness = base.switchHarness.bind(base);
    limited.switchHarness = async (sessionId, selection, timing, launch) => {
      const limits = current();
      if (limits?.harnesses) checkSelection(allowed, limits, selection);
      return switchHarness(sessionId, selection, timing, launch);
    };
  }
  if (base.summaries) {
    const summaries = base.summaries.bind(base);
    // The navigator's paged listing reads the Space index directly, not
    // through per-resource reads; narrow it to the allowed projects here.
    limited.summaries = async (input) => {
      const limits = current();
      if (!limits?.projects) return summaries(input);
      if (input.projectId && !accountLimitAllowsProject(limits, input.projectId)) throw notFound();
      const page = await summaries(input);
      return { ...page, sessions: page.sessions.filter((session) => accountLimitAllowsProject(limits, session.projectId)) };
    };
  }
  return limited;
}

/** Wrap only when a canonical authority exists; it re-reads limits per call. */
export function limitedSessionsForActor(
  ctx: SpaceContext,
  base: SessionService,
  authority: LimitsAuthority | null = limitsAuthority(),
  harnessAccess?: HarnessAccess,
): SessionService {
  return authority ? limitedSessionService(base, ctx, authority, harnessAccess) : base;
}

/**
 * Projects for an actor. Reads are already narrowed by the canonical read
 * policy; an account with a project list may not add projects, because a new
 * project could never be on the owner's list.
 */
export function limitedProjectsForActor(
  ctx: SpaceContext,
  base: ProjectService,
  lookup: (userId: string) => AccountLimits | null = limitsForUser,
): ProjectService {
  const allowed = <T>(run: () => Promise<T>): Promise<T> => lookup(ctx.userId)?.projects
    ? Promise.reject(forbidden("This account can only use the projects the server owner chose"))
    : run();
  const scoped: ProjectService = {
    ...base,
    add: (path, name) => allowed(() => base.add(path, name)),
    create: (path, name) => allowed(() => base.create(path, name)),
  };
  if (base.clone) {
    const clone = base.clone.bind(base);
    scoped.clone = (repository, parentPath) => allowed(() => clone(repository, parentPath));
  }
  if (base.addRemote) {
    const addRemote = base.addRemote.bind(base);
    scoped.addRemote = (path, remote, name) => allowed(() => addRemote(path, remote, name));
  }
  if (base.ensurePersonal) {
    // A project-limited account works only where the owner put it.
    const ensurePersonal = base.ensurePersonal.bind(base);
    scoped.ensurePersonal = (name) => allowed(() => ensurePersonal(name));
  }
  return scoped;
}

/** The catalog an account may pick from: only models on allowed harnesses
 *  and its own private logins. Models without a harness tag are routed by
 *  the session's pinned harness. */
export function limitedCatalog(
  models: readonly ModelDescriptor[],
  limits: AccountLimits | null,
  allowed: HarnessAllowed = harnessAllowedFor({ userId: "", spaceId: "" }),
): ModelDescriptor[] {
  if (!limits?.harnesses) return [...models];
  return models.filter((model) => !model.harnessId || allowed(limits, model.harnessId));
}

/** WS fan-out: may this user see live updates of a project's chats? */
export function projectVisibleToUser(userId: string | undefined, projectId: string): boolean {
  if (!userId) return true;
  return accountLimitAllowsProject(limitsForUser(userId), projectId);
}
