// Person-owned connected accounts (Spaces §14.4, stage 3).
//
// Pure types and the owner-resolution rule. Browser-safe: no Node imports, so
// a UI can explain a refusal with the same table the server enforces.
import type { SecureSafeService } from "@polyth/contracts";
import type { PackageOpaqueVault } from "./connections.ts";

/** One package's storage for one person, outside every Space. */
export interface PersonPackageStorage {
  /** `<dataRoot>/people/<userId>/packages/<packageId>`, created on demand. */
  root: string;
  /** Validated, escape-proof path under `root` (no traversal or symlink escape). */
  path(relative: string): string;
}

/** Space policy for one package's shared *service account*. */
export interface PackageServicePolicy {
  /** May agents and system work use the Space service account? Default false. */
  agentsMayUseService: boolean;
}

/**
 * Person-owned data for the calling package. The server binds this facade to
 * the package it hands the host to: every `packageId` argument must be that
 * package's own id (anything else is `forbidden`), so one package can never
 * read another's person storage, secrets or enablement.
 *
 * Membership is not encoded here: removing someone from a Space deletes
 * nothing, their enablement for that Space is simply ignored because
 * `isMember` fails. Deleting the account deletes `people/<userId>` entirely.
 */
export interface PeopleHost {
  storage(userId: string, packageId: string): PersonPackageStorage;
  /** Opaque secrets partitioned by (person, package), stored like the Space Credential Vault. */
  vault(userId: string, packageId: string): PackageOpaqueVault;
  /**
   * The whole person-owned Credential Vault store behind `vault(userId,
   * packageId)` — handle entries as well as opaque keys. Credential Vault
   * keeps each person's own credentials here; other packages need only `vault`.
   */
  credentialVault?(userId: string, packageId: string): SecureSafeService;
  /** Connection ids this person turned on in this Space (stored with the person, not the Space). */
  enabled(userId: string, spaceId: string, packageId: string): string[];
  setEnabled(userId: string, spaceId: string, packageId: string, connectionId: string, on: boolean): void;
  /** Stored in the Space. Unknown Spaces read as the default (off). */
  servicePolicy(spaceId: string, packageId: string): PackageServicePolicy;
  /** The caller's route must enforce Space-admin before writing. */
  setServicePolicy(spaceId: string, packageId: string, policy: PackageServicePolicy): void;
  /** Is this person an active member of this Space? False for unknown ids. */
  isMember(userId: string, spaceId: string): boolean;
}

export type ConnectionOrigin = "person-ui" | "agent" | "system";

export type ConnectionOwner =
  | { kind: "personal"; userId: string }
  | { kind: "service" }
  | { kind: "refused"; reason: "connect-your-account" | "not-a-member" | "service-not-allowed" };

export interface ResolveConnectionOwnerInput {
  /** The signed-in person (UI) or the session's acting person (agent). Never request input. */
  actorUserId?: string | undefined;
  spaceId: string;
  isMember(userId: string, spaceId: string): boolean;
  /** The ACTOR's connections enabled in `spaceId` (`people.enabled(actor, spaceId, pkg)`). */
  personalEnabled: readonly string[];
  /** Does the Space have a service account for this package? */
  hasService: boolean;
  policy: PackageServicePolicy;
  origin: ConnectionOrigin;
}

/**
 * Whose account a package may use, in this order:
 *
 * - an actor who is not an active member of the Space is refused (`not-a-member`);
 * - the actor's own connection enabled in this Space;
 * - the Space service account: for `person-ui` whenever it exists (a member
 *   explicitly using it), for `agent` only when the Space policy allows it;
 * - otherwise `connect-your-account`.
 *
 * Work with no person (`system`, or an `agent` turn nobody started) never uses
 * a personal account: the service account under policy, else
 * `service-not-allowed`. The result never names anyone but the actor.
 */
export function resolveConnectionOwner(input: ResolveConnectionOwnerInput): ConnectionOwner {
  const actor = input.origin === "system" ? undefined : input.actorUserId || undefined;
  const serviceByPolicy = input.hasService && input.policy.agentsMayUseService === true;
  if (!actor) {
    if (input.origin === "person-ui") return { kind: "refused", reason: "not-a-member" };
    return serviceByPolicy ? { kind: "service" } : { kind: "refused", reason: "service-not-allowed" };
  }
  if (!input.isMember(actor, input.spaceId)) return { kind: "refused", reason: "not-a-member" };
  if (input.personalEnabled.length > 0) return { kind: "personal", userId: actor };
  if (input.origin === "person-ui" ? input.hasService : serviceByPolicy) return { kind: "service" };
  return { kind: "refused", reason: "connect-your-account" };
}
