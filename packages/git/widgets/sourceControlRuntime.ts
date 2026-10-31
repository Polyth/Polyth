import {
  type SourceControlAccountBinding,
  type SourceControlCommitIdentity,
  type SourceControlProfile,
  type SourceControlResolution,
} from "@polyth/contracts/source-control";
import { api, sessionFetch, type GitCheckoutIdentity } from "@polyth/session/web-api";
import { workspacePresentationKey } from "../../../apps/web/src/store.ts";
import {
  consumeRepositorySystemIdentity,
  getSourceControlProfileState,
  rememberRepositorySystemIdentity,
  resolveStoredSourceControlContext,
} from "./sourceControlProfiles.ts";
import { repositorySourceControlRemote } from "./sourceControlRemote.ts";
import { loadPersonGitProfile, mayWriteCheckoutIdentity } from "./personGitProfile.ts";

export interface SourceControlRuntimeState {
  identity: GitCheckoutIdentity;
  resolution: SourceControlResolution;
  /** The identity applied, but its account could not be bound to the project. */
  warning?: string;
}

const inFlight = new Map<string, Promise<SourceControlRuntimeState>>();
const rerun = new Set<string>();
const runtimeScopeKey = (projectId: string): string =>
  workspacePresentationKey("git-identity-runtime", projectId, null);

const sameIdentity = (a: SourceControlCommitIdentity, b: SourceControlCommitIdentity): boolean =>
  a.name === b.name && a.email === b.email;

/** What the profile asks of the checkout's own Git config besides its author. */
const checkoutSetup = (profile: SourceControlProfile | null) => ({
  sshKey: profile?.authentication.mode === "ssh-key" ? profile.authentication.identityFile ?? null : null,
  signingKey: profile?.signingKey ?? null,
  anonymous: profile?.authentication.mode === "anonymous",
});

const sameSetup = (identity: GitCheckoutIdentity, setup: ReturnType<typeof checkoutSetup>): boolean =>
  (identity.sshKey ?? null) === setup.sshKey
  && (identity.signingKey ?? null) === setup.signingKey
  && (identity.anonymous ?? false) === setup.anonymous;

/** An "account" identity signs Polyth's fetch/pull/push for the project in
 *  with its account: bind it unless it already is. A personal account applies
 *  to its owner without a binding. */
async function bindIdentityAccount(projectId: string, profile: SourceControlProfile | null): Promise<string | undefined> {
  const account = profile?.authentication.mode === "account" ? profile.hostingAccount : undefined;
  if (!account) return undefined;
  try {
    const { binding } = await sessionFetch<{ binding: SourceControlAccountBinding | null }>(`/api/git/account?projectId=${encodeURIComponent(projectId)}`);
    if (binding?.provider === account.provider && binding.accountId === account.accountId) return undefined;
    await sessionFetch(`/api/git/account`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, provider: account.provider, accountId: account.accountId }),
    });
    return undefined;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/personal accounts are not bound/i.test(message)) return undefined;
    return `@${account.login} could not be used for this project: ${message}`;
  }
}

async function reconcileOnce(projectId: string): Promise<SourceControlRuntimeState> {
  // Resolve the repository host before touching Git identity. This makes an
  // explicit provider-profile mismatch fail closed for existing repositories,
  // not only during clone.
  const remote = await repositorySourceControlRemote(projectId);
  let identity = await api.gitIdentity(projectId);
  let resolution = resolveStoredSourceControlContext({ projectId, remote, systemIdentity: identity });
  if (!resolution.ok) return { identity, resolution };
  // The checkout's own Git config is the instance owner's (Spaces §14.4);
  // everyone else commits with their own profile and never writes it.
  if (!mayWriteCheckoutIdentity(await loadPersonGitProfile())) return { identity, resolution };

  const target = resolution.profile?.commitAuthor ?? null;
  const setup = checkoutSetup(resolution.profile);
  const baseline = getSourceControlProfileState().repositorySystemIdentities[projectId] ?? null;

  if (target && (!sameIdentity(identity, target) || !sameSetup(identity, setup))) {
    if (!baseline) rememberRepositorySystemIdentity(projectId, identity);
    identity = await api.gitIdentitySet(projectId, { ...target, ...setup });
    resolution = resolveStoredSourceControlContext({ projectId, remote, systemIdentity: identity });
  } else if ((!resolution.profile || !target) && baseline) {
    // A profile without an explicit author inherits System Git rather than
    // accidentally retaining the previously selected profile's author.
    if (!sameIdentity(identity, baseline) || !sameSetup(identity, checkoutSetup(null))) {
      identity = await api.gitIdentitySet(projectId, { ...baseline, ...checkoutSetup(null) });
    }
    consumeRepositorySystemIdentity(projectId);
    resolution = resolveStoredSourceControlContext({ projectId, remote, systemIdentity: identity });
  }

  const warning = target ? await bindIdentityAccount(projectId, resolution.profile) : undefined;
  return { identity, resolution, ...(warning ? { warning } : {}) };
}

/**
 * Reconcile the resolved user-facing profile with repository Git config.
 * Only for the instance owner: everyone else reads it and never writes it.
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
  const key = runtimeScopeKey(projectId);
  const pending = inFlight.get(key);
  if (pending) {
    rerun.add(key);
    return pending;
  }

  const task = (async () => {
    let state: SourceControlRuntimeState;
    do {
      rerun.delete(key);
      state = await reconcileOnce(projectId);
    } while (rerun.delete(key));
    return state;
  })().finally(() => {
    inFlight.delete(key);
    rerun.delete(key);
  });

  inFlight.set(key, task);
  return task;
}
