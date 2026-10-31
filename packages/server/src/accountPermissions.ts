// Account permissions: installation-wide authority the instance owner hands
// to another account (Settings → Users). The canonical Space gateway mints
// `harnessManager` / `harnessPersonal` from them (canonicalSpaces.ts); legacy
// single-user installations grant none (their local user is already the owner).
//
// `harnesses.manage` and `harnesses.personal` let an account add its own
// private harness accounts; managers also restrict shared accounts to people
// and Spaces. A private account harness is usable only by that user and a
// restricted shared one only by the people and in the Spaces it names (the
// harness routes filter listings); neither is chosen by Auto for anyone else.
// This file refuses every chat operation that would run on a harness the
// actor may not use in the actor's Space. Keys off the gateway-validated
// SpaceContext.userId/spaceId; nothing is read from request bodies.
import {
  harnessVisibleToUser,
  type HarnessAccessRule,
  type HarnessSelection,
  type ModelDescriptor,
  type SessionProjection,
  type SessionService,
  type SpaceContext,
} from "@polyth/contracts";

/** Harness id → who may use it. Unrestricted shared harnesses are absent. */
export type HarnessAccess = () => ReadonlyMap<string, HarnessAccessRule>;
/** Whose harness rules apply: the person and the Space they act in. */
export type HarnessActor = Pick<SpaceContext, "userId" | "spaceId">;

/** The access map the registry's descriptors describe right now. */
export function harnessAccessOf(descriptors: Iterable<{ id: string } & HarnessAccessRule>): Map<string, HarnessAccessRule> {
  const access = new Map<string, HarnessAccessRule>();
  for (const descriptor of descriptors) {
    if (descriptor.accountOwnerUserId) access.set(descriptor.id, { accountOwnerUserId: descriptor.accountOwnerUserId });
    else if (descriptor.accountAllowedUserIds || descriptor.accountAllowedSpaceIds) {
      access.set(descriptor.id, {
        ...(descriptor.accountAllowedUserIds ? { accountAllowedUserIds: [...descriptor.accountAllowedUserIds] } : {}),
        ...(descriptor.accountAllowedSpaceIds ? { accountAllowedSpaceIds: [...descriptor.accountAllowedSpaceIds] } : {}),
      });
    }
  }
  return access;
}

const forbidden = (message: string): Error => Object.assign(new Error(message), { code: "forbidden" });

export const harnessUsableIn = (access: ReadonlyMap<string, HarnessAccessRule>, actor: HarnessActor, harnessId: string | undefined): boolean =>
  !harnessId || harnessVisibleToUser(access.get(harnessId) ?? {}, actor.userId, actor.spaceId);

function refusal(access: ReadonlyMap<string, HarnessAccessRule>, harnessId: string | undefined, continuing: boolean): Error {
  const rule = harnessId ? access.get(harnessId) : undefined;
  if (rule?.accountOwnerUserId) {
    return forbidden(continuing
      ? "This chat runs on someone else's assistant account; switch the assistant to continue"
      : "This assistant account belongs to someone else");
  }
  return forbidden(continuing
    ? "This chat runs on an assistant account you can't use here; switch the assistant to continue"
    : "This assistant account isn't available to you here");
}

function checkSelection(access: ReadonlyMap<string, HarnessAccessRule>, actor: HarnessActor, selection: HarnessSelection | undefined): void {
  if (selection?.mode === "pinned" && !harnessUsableIn(access, actor, selection.harnessId)) {
    throw refusal(access, selection.harnessId, false);
  }
}

/** An existing chat may continue only on a harness the actor may use. */
function checkProjection(access: ReadonlyMap<string, HarnessAccessRule>, actor: HarnessActor, projection: SessionProjection): void {
  const pinned = projection.harness?.mode === "pinned" ? projection.harness.harnessId : undefined;
  if (!harnessUsableIn(access, actor, pinned)) throw refusal(access, pinned, true);
  if (!harnessUsableIn(access, actor, projection.resolvedHarnessId)) throw refusal(access, projection.resolvedHarnessId, true);
}

export function privateHarnessSessionService(
  base: SessionService,
  actor: HarnessActor,
  harnessAccess: HarnessAccess,
): SessionService {
  const scoped: SessionService = { ...base };
  scoped.create = async (input) => {
    checkSelection(harnessAccess(), actor, input.harness);
    return base.create(input);
  };
  scoped.send = async (sessionId, input, admission) => {
    const access = harnessAccess();
    if (access.size) {
      if (input.harness) checkSelection(access, actor, input.harness);
      else checkProjection(access, actor, await base.snapshot(sessionId));
    }
    return admission ? base.send(sessionId, input, admission) : base.send(sessionId, input);
  };
  if (base.resumeNow) {
    const resumeNow = base.resumeNow.bind(base);
    scoped.resumeNow = async (sessionId, options) => {
      const access = harnessAccess();
      if (access.size) {
        const selection = options && !("providerID" in options) ? options.harness : undefined;
        if (selection) checkSelection(access, actor, selection);
        else checkProjection(access, actor, await base.snapshot(sessionId));
      }
      return resumeNow(sessionId, options);
    };
  }
  if (base.switchHarness) {
    const switchHarness = base.switchHarness.bind(base);
    scoped.switchHarness = async (sessionId, selection, timing, launch) => {
      checkSelection(harnessAccess(), actor, selection);
      return switchHarness(sessionId, selection, timing, launch);
    };
  }
  if (base.restartRuntime) {
    const restartRuntime = base.restartRuntime.bind(base);
    scoped.restartRuntime = async (sessionId) => {
      const access = harnessAccess();
      if (access.size) checkProjection(access, actor, await base.snapshot(sessionId));
      return restartRuntime(sessionId);
    };
  }
  return scoped;
}

/** Wrap only when the host can name restricted harnesses. */
export function privateHarnessSessionsForActor(
  ctx: SpaceContext,
  base: SessionService,
  harnessAccess: HarnessAccess | undefined,
): SessionService {
  return harnessAccess ? privateHarnessSessionService(base, ctx, harnessAccess) : base;
}

/** A model or agent catalog without harnesses the actor may not use here
 *  (other users' private accounts, shared accounts not open to them). */
export function privateHarnessCatalog<T extends Pick<ModelDescriptor, "harnessId">>(
  entries: readonly T[],
  actor: HarnessActor,
  harnessAccess: HarnessAccess | undefined,
): T[] {
  const access = harnessAccess?.();
  if (!access?.size) return [...entries];
  return entries.filter((entry) => harnessUsableIn(access, actor, entry.harnessId));
}
