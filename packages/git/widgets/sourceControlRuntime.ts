import {
  type SourceControlCommitIdentity,
  type SourceControlResolution,
} from "@polyth/contracts/source-control";
import { api } from "@polyth/session/web-api";
import {
  consumeRepositorySystemIdentity,
  getSourceControlProfileState,
  rememberRepositorySystemIdentity,
  resolveStoredSourceControlContext,
} from "./sourceControlProfiles.ts";
import { repositorySourceControlRemote } from "./sourceControlRemote.ts";

export interface SourceControlRuntimeState {
  identity: SourceControlCommitIdentity;
  resolution: SourceControlResolution;
}

const inFlight = new Map<string, Promise<SourceControlRuntimeState>>();
const rerun = new Set<string>();

const sameIdentity = (a: SourceControlCommitIdentity, b: SourceControlCommitIdentity): boolean =>
  a.name === b.name && a.email === b.email;

async function reconcileOnce(projectId: string): Promise<SourceControlRuntimeState> {
  // Resolve the repository host before touching Git identity. This makes an
  // explicit provider-profile mismatch fail closed for existing repositories,
  // not only during clone.
  const remote = await repositorySourceControlRemote(projectId);
  let identity = await api.gitIdentity(projectId);
  let resolution = resolveStoredSourceControlContext({ projectId, remote, systemIdentity: identity });
  if (!resolution.ok) return { identity, resolution };

  const target = resolution.profile?.commitAuthor ?? null;
  const baseline = getSourceControlProfileState().repositorySystemIdentities[projectId] ?? null;

  if (target && !sameIdentity(identity, target)) {
    if (!baseline) rememberRepositorySystemIdentity(projectId, identity);
    identity = await api.gitIdentitySet(projectId, target);
    resolution = resolveStoredSourceControlContext({ projectId, remote, systemIdentity: identity });
    return { identity, resolution };
  }

  // A profile without an explicit author inherits System Git rather than
  // accidentally retaining the previously selected profile's author.
  if ((!resolution.profile || !target) && baseline) {
    if (!sameIdentity(identity, baseline)) identity = await api.gitIdentitySet(projectId, baseline);
    consumeRepositorySystemIdentity(projectId);
    resolution = resolveStoredSourceControlContext({ projectId, remote, systemIdentity: identity });
  }

  return { identity, resolution };
}

/**
 * Reconcile the resolved user-facing profile with repository Git config.
 * Repository config is the common denominator observed by the UI, terminal,
 * agent shell and ordinary Git CLI, so no model credentials or provider
 * secrets need to be injected into agent context.
 *
 * Reconciliation is serialized per repository. If profile state changes while
 * a write is in flight, the active run is marked dirty and repeats against the
 * newest state before resolving, preventing rapid profile switches from
 * leaving repository Git config on an older identity.
 */
export function reconcileSourceControlIdentity(projectId: string): Promise<SourceControlRuntimeState> {
  const pending = inFlight.get(projectId);
  if (pending) {
    rerun.add(projectId);
    return pending;
  }

  const task = (async () => {
    let state: SourceControlRuntimeState;
    do {
      rerun.delete(projectId);
      state = await reconcileOnce(projectId);
    } while (rerun.delete(projectId));
    return state;
  })().finally(() => {
    inFlight.delete(projectId);
    rerun.delete(projectId);
  });

  inFlight.set(projectId, task);
  return task;
}
