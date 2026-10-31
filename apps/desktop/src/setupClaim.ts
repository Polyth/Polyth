// First-run setup claim broker for the trusted main process. The claim is
// issued in-process and handed only to the trusted renderer, so the person
// never sees an operator token. A cached claim is reused while it can still
// cover a setup step (a reload keeps its browser binding and recovery codes);
// an expired one is never handed out again — that stranded setup on "invalid
// claim" until the app restarted. `fresh` lets the renderer start over after
// the server refused the current claim; issuing rotates out the old one.
import type { DesktopSetupClaim, DesktopSetupClaimRequest } from "./types.ts";

export interface IssuedSetupClaim {
  token: string;
  expiresAt: number;
}

/** A cached claim closer than this to expiry is replaced instead of reused. */
export const SETUP_CLAIM_REUSE_MARGIN_MS = 60_000;

const wantsFresh = (request: unknown): boolean =>
  typeof request === "object" && request !== null
  && (request as DesktopSetupClaimRequest).fresh === true;

export function createDesktopSetupClaimBroker(
  issue: () => IssuedSetupClaim,
  now: () => number = Date.now,
) {
  let current: IssuedSetupClaim | null = null;
  return {
    /** `request` crosses IPC, so it is validated rather than trusted. */
    request(request?: unknown): DesktopSetupClaim {
      if (wantsFresh(request) || !current || current.expiresAt - now() <= SETUP_CLAIM_REUSE_MARGIN_MS) {
        const claim = issue();
        current = { token: claim.token, expiresAt: claim.expiresAt };
      }
      return { claimToken: current.token, expiresAt: current.expiresAt };
    },
    /** Forget the cached claim when the setup server it belongs to goes away. */
    reset(): void {
      current = null;
    },
  };
}
