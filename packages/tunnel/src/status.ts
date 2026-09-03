import type { PolythLinkPathPolicy, TunnelDiagnosticsDto, TunnelStatusDto } from "@polyth/contracts";

export interface TunnelLiveSnapshot {
  platformSupported: boolean;
  hostBinaryFound: boolean;
  hostProcessReady: boolean;
  endpointBound: boolean;
  ingressReady: boolean;
  identityAvailable: boolean;
  hostFingerprint: string | null;
  identityError?: string;
  lastErrorCode?: string;
  activePolicy: PolythLinkPathPolicy | null;
  relayConfigured: boolean;
  activeConnections: number;
  activeDevices: number;
  directConnections: number;
  relayConnections: number;
  appVersion?: string;
  irohVersion?: string;
  recentErrors?: TunnelDiagnosticsDto["recentErrors"];
}

export function pairingAvailableFrom(snapshot: TunnelLiveSnapshot): boolean {
  return snapshot.platformSupported
    && snapshot.hostBinaryFound
    && snapshot.hostProcessReady
    && snapshot.identityAvailable
    && snapshot.endpointBound
    && snapshot.ingressReady;
}

export function buildTunnelStatus(snapshot: TunnelLiveSnapshot): TunnelStatusDto {
  const pairingAvailable = pairingAvailableFrom(snapshot);
  const fingerprint = snapshot.hostFingerprint;
  const policy = snapshot.activePolicy;
  return {
    enabled: snapshot.platformSupported && snapshot.hostBinaryFound,
    available: pairingAvailable,
    pairingAvailable,
    hostBinaryFound: snapshot.hostBinaryFound,
    hostProcessReady: snapshot.hostProcessReady,
    endpointBound: snapshot.endpointBound,
    ingressReady: snapshot.ingressReady,
    activePolicy: policy,
    mode: policy ?? "direct-preferred",
    identityAvailable: snapshot.identityAvailable,
    hostFingerprint: fingerprint,
    fingerprint,
    relayConfigured: snapshot.relayConfigured,
    activeConnections: snapshot.activeConnections,
    activeDevices: snapshot.activeDevices,
    directConnections: snapshot.directConnections,
    relayConnections: snapshot.relayConnections,
    ...(snapshot.identityError ? { identityError: snapshot.identityError } : {}),
    ...(snapshot.lastErrorCode ? { lastErrorCode: snapshot.lastErrorCode } : {}),
    ...(snapshot.platformSupported ? {} : { unsupportedPlatform: true }),
  };
}

export function buildTunnelDiagnostics(snapshot: TunnelLiveSnapshot): TunnelDiagnosticsDto {
  const status = buildTunnelStatus(snapshot);
  return {
    appVersion: snapshot.appVersion ?? "unknown",
    irohVersion: snapshot.irohVersion ?? "unknown",
    hostFingerprint: status.hostFingerprint,
    relayUrls: [],
    recentErrors: snapshot.recentErrors ?? [],
    packageStatus: !snapshot.platformSupported
      ? "unsupported-platform"
      : !snapshot.hostBinaryFound
        ? "host-binary-missing"
        : snapshot.hostProcessReady
          ? (snapshot.endpointBound ? "running" : "endpoint-unbound")
          : "host-process-unavailable",
  };
}
