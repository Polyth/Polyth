// Account guardrails: the server half of "a household member uses Polyth with
// the owner's choices". Route/WS reachability is the paired-device default-deny
// table (see remotePolicy.ts + canonicalAuth.ts). This file owns what a route
// table cannot express: which models a guarded account may select, what it may
// approve, and which session operations stay closed even on allowed routes.
//
// Everything here keys off the gateway-validated SpaceContext.userId; nothing
// is read from request bodies.
import {
  guardrailModel,
  type AccountGuardrails,
  type HarnessSelection,
  type ModelDescriptor,
  type ModelRef,
  type ResumeTurnOptions,
  type SessionService,
  type SpaceContext,
  type SpaceRole,
} from "@polyth/contracts";
import { canonicalSecurity } from "./runtimeSecurity.ts";

export type GuardrailsLookup = (userId: string) => AccountGuardrails | null;

/** Live lookup through the canonical identity authority; legacy single-user
 *  installations have no guardrails. */
export const guardrailsForUser: GuardrailsLookup = (userId) =>
  canonicalSecurity()?.auth.guardrailsFor(userId) ?? null;

const forbidden = (message: string): Error => Object.assign(new Error(message), { code: "forbidden" });

/** A guarded account never administers a Space, whatever its membership says. */
export function guardedRole(role: SpaceRole, guardrails: AccountGuardrails | null): SpaceRole {
  return guardrails && (role === "admin" || role === "owner") ? "member" : role;
}

/** The catalog a guarded account may see: exactly its allowed models. */
export function guardedCatalog(models: readonly ModelDescriptor[], guardrails: AccountGuardrails): ModelDescriptor[] {
  return models.filter((model) => guardrailModel(guardrails, {
    ...(model.harnessId ? { harnessId: model.harnessId } : {}),
    providerID: model.providerID,
    modelID: model.modelID,
  }) !== undefined);
}

/**
 * Validate one explicit model/harness choice. Returns the route to apply:
 * an allowed model pins its harness; no explicit choice keeps the caller's
 * (owner-controlled) defaults. An empty allowlist admits no explicit choice.
 */
export function guardedRoute(
  guardrails: AccountGuardrails,
  model: ModelRef | undefined,
  harness: HarnessSelection | undefined,
): { model?: ModelRef; harness?: HarnessSelection } {
  if (!model) {
    if (harness && harness.mode === "pinned"
      && !guardrails.models.some((entry) => entry.harnessId === harness.harnessId)) {
      throw forbidden("This account cannot choose that assistant");
    }
    return harness ? { harness } : {};
  }
  const allowed = guardrailModel(guardrails, {
    ...(harness?.mode === "pinned" ? { harnessId: harness.harnessId } : {}),
    providerID: model.providerID,
    modelID: model.modelID,
  });
  if (!allowed) throw forbidden("This account cannot choose that model");
  return { model, harness: { mode: "pinned", harnessId: allowed.harnessId } };
}

/**
 * Session operations for a guarded actor. Wraps the Space-scoped facade, so
 * ownership/visibility checks have already run underneath; this layer only
 * narrows. Optional methods stay optional.
 */
export function guardedSessionService(base: SessionService, guardrails: AccountGuardrails): SessionService {
  // Own-property copy: callers may spread the facade, which a prototype
  // chain would silently drop.
  const guarded: SessionService = { ...base };
  guarded.create = async (input) => {
    const route = input.model || input.harness
      ? guardedRoute(guardrails, input.model, input.harness)
      : guardrails.models[0]
        ? {
            model: { providerID: guardrails.models[0].providerID, modelID: guardrails.models[0].modelID },
            harness: { mode: "pinned", harnessId: guardrails.models[0].harnessId } as HarnessSelection,
          }
        : {};
    return base.create({ ...input, ...route });
  };
  guarded.send = async (sessionId, input, admission) => {
    const route = guardedRoute(guardrails, input.model, input.harness);
    const { model: _model, harness: _harness, ...rest } = input;
    const next = { ...rest, ...route };
    return admission ? base.send(sessionId, next, admission) : base.send(sessionId, next);
  };
  if (base.resumeNow) {
    const resumeNow = base.resumeNow.bind(base);
    guarded.resumeNow = async (sessionId, options) => {
      // A bare ModelRef is the legacy form of { model }.
      const opts: ResumeTurnOptions | undefined = options && "providerID" in options
        ? { model: options as ModelRef }
        : options as ResumeTurnOptions | undefined;
      return resumeNow(sessionId, guardedRoute(guardrails, opts?.model, opts?.harness));
    };
  }
  if (base.switchHarness) {
    const switchHarness = base.switchHarness.bind(base);
    guarded.switchHarness = async (sessionId, selection, timing, launch) => {
      if (selection.mode !== "pinned") throw forbidden("This account cannot choose that assistant");
      guardedRoute(guardrails, launch?.model, selection);
      return switchHarness(sessionId, selection, timing, launch);
    };
  }
  if (base.runShell) guarded.runShell = () => Promise.reject(forbidden("Shell commands are not available for this account"));
  if (base.autoAcceptSet) {
    const autoAcceptSet = base.autoAcceptSet.bind(base);
    // Only lowering is allowed: "on" and Full access ("all") are refused, and so
    // is any level added later.
    guarded.autoAcceptSet = (sessionId, setting) => setting === "off" || setting === "inherit"
      ? autoAcceptSet(sessionId, setting)
      : Promise.reject(forbidden("Auto-Approve is not available for this account"));
  }
  guarded.replyPermission = (sessionId, requestId, reply, scope) => {
    if (reply === "always") return Promise.reject(forbidden("Only single approvals are available for this account"));
    if (reply === "once" && guardrails.approvals !== "once") {
      return Promise.reject(forbidden("Someone else in this Space must approve this action"));
    }
    return base.replyPermission(sessionId, requestId, reply, scope);
  };
  if (base.delegatePermission) {
    const delegatePermission = base.delegatePermission.bind(base);
    // Delegating hands an approval to an agent, so it needs approval rights.
    guarded.delegatePermission = (sessionId, requestId) => guardrails.approvals === "once"
      ? delegatePermission(sessionId, requestId)
      : Promise.reject(forbidden("Someone else in this Space must approve this action"));
  }
  // Importing native provider sessions adopts work that never ran under the
  // guardrails; deleting is not part of a guarded account's grants either.
  if (base.importBackendSessions) guarded.importBackendSessions = () => Promise.reject(forbidden("Importing is not available for this account"));
  return guarded;
}

/** Wrap only when the actor is guarded; everyone else gets `base` unchanged. */
export function sessionsForActor(ctx: SpaceContext, base: SessionService, lookup: GuardrailsLookup = guardrailsForUser): SessionService {
  const guardrails = lookup(ctx.userId);
  return guardrails ? guardedSessionService(base, guardrails) : base;
}

/**
 * A Space with at least one active guarded member is a guarded Space: agents
 * there never act on standing approvals. "Always" rules and Auto-Approve were
 * granted by someone else for their own work; in a shared/guarded Space every
 * non-trivial action is asked of a human again (explicit deny rules still win).
 */
export function spaceHasGuardedMember(spaceId: string | undefined): boolean {
  if (!spaceId) return false;
  const control = canonicalSecurity()?.control;
  if (!control) return false;
  return !!control.get(
    `SELECT 1 FROM space_memberships m JOIN account_guardrails g ON g.user_id=m.principal_id
      WHERE m.space_id=? AND m.state='active' AND g.guardrails_json IS NOT NULL LIMIT 1`,
    spaceId,
  );
}

type PermissionVerdict = "allow" | "deny" | "ask";
interface PermissionEvaluator {
  evaluate(permission: string, patterns: string[], projectId?: string, sessionId?: string): PermissionVerdict;
}

/** Downgrade standing `allow` rules to `ask` inside guarded Spaces. */
export function guardedPermissions<T extends PermissionEvaluator>(
  base: T,
  spaceOfProject: (projectId: string) => string | undefined,
  guarded: (spaceId: string | undefined) => boolean = spaceHasGuardedMember,
): T {
  return {
    ...base,
    evaluate(permission: string, patterns: string[], projectId?: string, sessionId?: string): PermissionVerdict {
      const verdict = base.evaluate(permission, patterns, projectId, sessionId);
      if (verdict !== "allow") return verdict;
      // Every guarded member's session runs in a registered, Space-owned
      // project; rules evaluated outside one (package internals) are unchanged.
      if (!projectId) return verdict;
      return guarded(spaceOfProject(projectId)) ? "ask" : verdict;
    },
  };
}
