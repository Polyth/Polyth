import { nativeLinkAvailable, type ConnectionMetadata } from "./polythLink.ts";
import type { ConnectionPhase } from "./connectionController.ts";

export interface ConnectionUiState {
  nativeAvailable: boolean;
  showSecurePairing: boolean;
  showUnavailableBanner: boolean;
  autoStartPairing: boolean;
  preservePendingPair: boolean;
  legacyIsSecure: false;
}

/** Decide what the connection screen may expose. Secure pairing is never the
 *  primary action unless a real native adapter is installed. */
export function connectionUiState(opts: {
  nativeAvailable?: boolean;
  pendingPair?: string;
}): ConnectionUiState {
  const nativeAvailable = opts.nativeAvailable ?? nativeLinkAvailable();
  const pending = Boolean(opts.pendingPair);
  return {
    nativeAvailable,
    showSecurePairing: nativeAvailable,
    showUnavailableBanner: !nativeAvailable,
    autoStartPairing: nativeAvailable && pending,
    preservePendingPair: pending,
    legacyIsSecure: false,
  };
}

/** How long the hub waits for a launch to leave this page. WKWebView drops a
 *  failed navigation to the loopback proxy without any page event. */
export const LAUNCH_STALL_MS = 8_000;

/** A resume bounce re-opens its server automatically at most this often, so
 *  a page that keeps failing settles on the hub instead of looping. */
export const RESUME_COOLDOWN_MS = 60_000;

export function shouldAutoReconnect(opts: {
  selectServer?: boolean;
  pendingPair?: string;
  hasPendingPush?: boolean;
  deepLinkPath?: string;
  /** The hub was reached because the open server's page lost its local
   *  proxy; its path belongs to that server, unlike an OS deep link. */
  resume?: boolean;
  lastResumeAt?: number | null;
  now?: number;
}): boolean {
  if (opts.selectServer || opts.pendingPair || opts.hasPendingPush) return false;
  if (opts.resume) {
    return opts.lastResumeAt == null
      || (opts.now ?? Date.now()) - opts.lastResumeAt >= RESUME_COOLDOWN_MS;
  }
  return !opts.deepLinkPath;
}

/** The server to re-open automatically: on a resume the one that is still
 *  connected natively (the page came from it), otherwise the newest. */
export function autoReconnectCandidate(
  connections: readonly ConnectionMetadata[],
  activeConnectionId: string | null,
  resume = false,
): ConnectionMetadata | undefined {
  const active = resume
    ? preferredTrustedConnection(connections.filter((connection) => connection.id === activeConnectionId))
    : undefined;
  return active ?? preferredTrustedConnection(connections);
}

export function preferredTrustedConnection(
  connections: readonly ConnectionMetadata[],
): ConnectionMetadata | undefined {
  return [...connections]
    .filter((connection) =>
      !connection.revoked
      && connection.pairingState !== "revoked"
      && connection.pairingState !== "prepared"
      && connection.hasSecureIdentity
    )
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
}

export function bootstrapUrlWithNext(bootstrapUrl: string, next = "/"): string {
  const target = new URL(bootstrapUrl);
  if (next !== "/") target.searchParams.set("next", next);
  return target.toString();
}

/** How long an automatic open may run behind the launch veil before the hub
 *  shows its own controls (its server row keeps saying it is connecting). */
export const HUB_LAUNCH_PATIENCE_MS = 8_000;

/** An automatic open still running after this gets a status line under the mark. */
export const HUB_LAUNCH_STATUS_AFTER_MS = 1_200;

/** Phases of an automatic open the user does not need to see or act on. */
const LAUNCH_PHASES: ReadonlySet<ConnectionPhase> = new Set([
  "idle",
  "loading-trusted-connections",
  "switching",
  "reconnecting",
  "recovering",
  "connected",
]);

export type HubPresentation = "launch" | "hub";

/**
 * While the hub opens a trusted server by itself it stays behind
 * the launch veil (the native splash's twin), so a warm start goes straight
 * from the splash to the workspace. Its controls appear only when the user
 * has something to do or to read: no server to open, pairing, a failure, or
 * an open that is taking long. Once shown they stay.
 */
export function hubPresentation(opts: {
  veilActive: boolean;
  nativeAvailable: boolean;
  trustedLoaded: boolean;
  phase: ConnectionPhase | null;
  error?: string | null;
  /** The hub will open, or is opening, a server by itself. */
  autoOpening: boolean;
  hubShown: boolean;
  elapsedMs: number;
}): HubPresentation {
  if (!opts.veilActive || opts.hubShown || !opts.nativeAvailable) return "hub";
  if (opts.error || opts.elapsedMs >= HUB_LAUNCH_PATIENCE_MS) return "hub";
  if (!opts.trustedLoaded) return "launch";
  if (!opts.autoOpening) return "hub";
  return opts.phase !== null && LAUNCH_PHASES.has(opts.phase) ? "launch" : "hub";
}
