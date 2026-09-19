import { nativeLinkAvailable, type ConnectionMetadata } from "./polythLink.ts";

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

export function shouldAutoReconnect(opts: {
  selectServer?: boolean;
  pendingPair?: string;
  hasPendingPush?: boolean;
  deepLinkPath?: string;
}): boolean {
  return !opts.selectServer
    && !opts.pendingPair
    && !opts.hasPendingPush
    && !opts.deepLinkPath;
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
