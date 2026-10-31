// Most limits sources are host-wide: every Space on a server reads the same
// harness/provider accounts. A source marked `scope: "space"` (the Alibaba
// Coding Plan estimate, computed from one Space's own history) is tenant data,
// and the limits response names the server and Space it answered for. Browser
// state may restore or merge such a source only under that same identity.
import type { UsageLimitSnapshotDto, UsageLimitsResponse } from "./limitsClient.ts";

export interface UsageLimitsIdentity {
  serverInstanceId: string;
  spaceId: string;
}

export const isSpaceScopedLimit = (provider: Pick<UsageLimitSnapshotDto, "scope">): boolean =>
  provider.scope === "space";

/** The response's server/Space identity, or null when it names none. */
export function limitsIdentity(response: Pick<UsageLimitsResponse, "serverInstanceId" | "spaceId"> | null | undefined): UsageLimitsIdentity | null {
  const serverInstanceId = response?.serverInstanceId;
  const spaceId = response?.spaceId;
  return typeof serverInstanceId === "string" && serverInstanceId && typeof spaceId === "string" && spaceId
    ? { serverInstanceId, spaceId }
    : null;
}

export function sameLimitsIdentity(
  a: Pick<UsageLimitsResponse, "serverInstanceId" | "spaceId"> | null | undefined,
  b: Pick<UsageLimitsResponse, "serverInstanceId" | "spaceId"> | null | undefined,
): boolean {
  const left = limitsIdentity(a);
  const right = limitsIdentity(b);
  return left !== null && right !== null && left.serverInstanceId === right.serverInstanceId && left.spaceId === right.spaceId;
}

/** The sources every Space shares: what may be shown before the Space is confirmed. */
export const hostWideLimits = (providers: readonly UsageLimitSnapshotDto[]): UsageLimitSnapshotDto[] =>
  providers.filter((provider) => !isSpaceScopedLimit(provider));

/**
 * The response's per-Space sources, only when it says which Space they belong
 * to; an unattributed per-Space source is dropped rather than guessed.
 */
export const spaceScopedLimits = (response: UsageLimitsResponse): UsageLimitSnapshotDto[] =>
  limitsIdentity(response) ? response.providers.filter(isSpaceScopedLimit) : [];

/** The response without anything it cannot attribute to a confirmed Space. */
export const attributableLimits = (response: UsageLimitsResponse): UsageLimitSnapshotDto[] =>
  limitsIdentity(response) ? [...response.providers] : hostWideLimits(response.providers);
