// Whose Git identity and credentials a Polyth-performed Git operation uses
// (Spaces §14.4, Git). The acting person is the signed-in member for a UI
// request, a session's actor for work done for a session, and nobody for pure
// system work. The host's own Git configuration, credential helpers, `gh`
// logins and `~/.ssh` keys are an installation account: only the instance
// owner on a local-trusted install may fall back to them.
import { readFileSync, rmSync } from "node:fs";
import type { AuthPrincipal, SpaceContext } from "@polyth/contracts";
import type { SourceControlCommitIdentity } from "@polyth/contracts/source-control";
import type { ConnectionOrigin, PeopleHost } from "@polyth/plugins/people";
import { atomicWriteSync } from "@polyth/plugins/atomic-write";

export interface GitActor {
  spaceId: string;
  /** The actor's own Space context, when known: providers list the accounts
   *  this context may use. */
  space?: SpaceContext;
  /** The acting person; absent for system work. */
  userId?: string;
  origin: ConnectionOrigin;
  /** The instance owner on a local-trusted install: may use the host's own
   *  Git configuration, credential helpers, `gh` and `~/.ssh`. */
  ambient: boolean;
}

/** Instance owner by the server-minted marker. A context without one is the
 *  pre-canonical single local person (never a `system:` principal). */
export function contextIsInstanceOwner(space: SpaceContext, principal?: Pick<AuthPrincipal, "kind">): boolean {
  const marker = (space as SpaceContext & { instanceOwner?: boolean }).instanceOwner;
  if (marker !== undefined) return marker === true;
  if (principal) return principal.kind === "local-user";
  return !space.userId.startsWith("system:");
}

/** May this context use the installation's ambient Git/GitHub credentials? */
export const contextMayUseInstallation = (space: SpaceContext, principal?: Pick<AuthPrincipal, "kind">): boolean =>
  space.deployment === "local-trusted" && contextIsInstanceOwner(space, principal);

/** The acting person of a UI request. */
export const requestGitActor = (request: { space: SpaceContext; principal?: Pick<AuthPrincipal, "kind"> }): GitActor => ({
  spaceId: request.space.spaceId,
  space: request.space,
  ...(request.space.userId && !request.space.userId.startsWith("system:") ? { userId: request.space.userId } : {}),
  origin: "person-ui",
  ambient: contextMayUseInstallation(request.space, request.principal),
});

const refusal = (code: string, message: string, extra: Record<string, unknown> = {}): Error =>
  Object.assign(new Error(message), { code, status: 409, mutationOutcome: "not-started", ...extra });

export const GIT_IDENTITY_REQUIRED = "git-identity-required";
export const GIT_ACCOUNT_REQUIRED = "git-account-required";

export const gitIdentityRequired = (): Error =>
  refusal(GIT_IDENTITY_REQUIRED, "Set your git name and email in Profile → Git.");

/** `reason` is `resolveConnectionOwner`'s refusal, or `ssh` / `installation`. */
export const gitAccountRequired = (reason: string, host?: string): Error => refusal(
  GIT_ACCOUNT_REQUIRED,
  reason === "not-a-member" ? "You are no longer a member of this Space."
    : reason === "service-not-allowed" ? `No account may be used for ${host ?? "this remote"} here: agents may not use the Space service account. Connect your GitHub/GitLab account, or ask a Space admin to allow it.`
    : reason === "ssh" ? `${host ?? "This remote"} signs in with this server's SSH keys, which only the instance owner may use. Connect your GitHub/GitLab account and use the HTTPS remote.`
    : `Connect your GitHub/GitLab account${host ? ` for ${host}` : ""} in Profile → Accounts and turn it on for this Space.`,
  { reason },
);

// ---- the person's Git profile ------------------------------------------------

export interface PersonGitProfile extends SourceControlCommitIdentity {
  updatedAt: number;
}

const PERSON_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const isPersonId = (userId: string | undefined): userId is string => !!userId && PERSON_ID.test(userId);

const TEXT = /^[^\0-\x1f\x7f<>]+$/;
const invalid = (message: string, field: string): Error =>
  Object.assign(new Error(message), { code: "invalid-input", field, mutationOutcome: "not-started" });

/** A commit identity Git accepts unchanged, or a field-tagged `invalid-input`. */
export function normalizeGitIdentity(input: unknown): SourceControlCommitIdentity {
  const row = (input ?? {}) as { name?: unknown; email?: unknown };
  const name = typeof row.name === "string" ? row.name.trim() : "";
  const email = typeof row.email === "string" ? row.email.trim() : "";
  if (!name || name.length > 256 || !TEXT.test(name)) throw invalid("Enter the name your commits should carry.", "name");
  if (email.length > 256 || !TEXT.test(email) || !/^[^\s@]+@[^\s@]+$/.test(email)) throw invalid("Enter a valid email address.", "email");
  return { name, email };
}

export interface PersonGitProfiles {
  read(userId: string | undefined): PersonGitProfile | null;
  save(userId: string, input: unknown): PersonGitProfile;
  clear(userId: string): void;
}

/** One `{name, email}` per person in `people/<userId>/packages/git/profile.json`,
 *  outside every Space. Without a people host nobody has a profile. */
export function createPersonGitProfiles(people: PeopleHost | undefined, packageId = "git"): PersonGitProfiles {
  const file = (userId: string): string | null => {
    if (!people || !isPersonId(userId)) return null;
    return people.storage(userId, packageId).path("profile.json");
  };
  return {
    read(userId) {
      if (!isPersonId(userId)) return null;
      const path = file(userId);
      if (!path) return null;
      try {
        const value = JSON.parse(readFileSync(path, "utf8")) as Partial<PersonGitProfile>;
        const identity = normalizeGitIdentity(value);
        return { ...identity, updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0 };
      } catch {
        return null;
      }
    },
    save(userId, input) {
      const path = file(userId);
      if (!path) throw Object.assign(new Error("Git profiles are unavailable for this account."), { code: "unavailable", mutationOutcome: "not-started" });
      const profile = { ...normalizeGitIdentity(input), updatedAt: Date.now() };
      atomicWriteSync(path, JSON.stringify(profile), 0o600);
      return profile;
    },
    clear(userId) {
      const path = file(userId);
      if (path) rmSync(path, { force: true });
    },
  };
}

/** A commit identity for one Polyth-run Git child. `unsigned`: the checkout's
 *  signing setup belongs to its owner's identity, so this commit must not use it. */
export type ActingCommitIdentity = SourceControlCommitIdentity & { unsigned?: boolean };

/**
 * The commit identity of a Polyth-performed commit, or null to keep the
 * checkout's own configuration:
 *
 * - the instance owner: the project's own identity (Settings → Source control)
 *   when one applies, else their Git profile, else the checkout's configuration;
 * - any other person: their Git profile, never signed with the checkout's key;
 *   without one they are refused (`git-identity-required`, nothing started);
 * - system work: the project's identity (the Space's service identity) when
 *   one is configured, else the checkout's configuration (unchanged behaviour).
 */
export function resolveGitCommitIdentity(input: {
  actor: GitActor;
  profiles: Pick<PersonGitProfiles, "read">;
  serviceIdentity?: () => SourceControlCommitIdentity | null | undefined;
  /** The identity chosen for the project the commit lands in. */
  projectIdentity?: () => SourceControlCommitIdentity | null | undefined;
}): ActingCommitIdentity | null {
  const { actor } = input;
  if (!actor.userId) return input.projectIdentity ? input.projectIdentity() ?? null : input.serviceIdentity?.() ?? null;
  if (actor.ambient) {
    const project = input.projectIdentity?.();
    if (project) return project;
  }
  const profile = input.profiles.read(actor.userId);
  if (profile) return { name: profile.name, email: profile.email, ...(actor.ambient ? {} : { unsigned: true }) };
  if (actor.ambient) return null;
  throw gitIdentityRequired();
}
