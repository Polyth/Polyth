export interface DiscoveredPolyth {
  id: string;
  serviceName: string;
  hostLabel: string;
  hostEndpointId: string;
  protocolVersion: 1;
  port: number;
  addresses: string[];
  numericPairing: boolean;
}

export type DiscoveryState = "discovering" | "empty" | "results" | "permission-required" | "error";

export interface DiscoveryUpdate {
  state: DiscoveryState;
  results: DiscoveredPolyth[];
  error?: string;
}

function stringField(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  if (!clean || clean.length > max || /[\u0000-\u001f\u007f]/u.test(clean)) return undefined;
  return clean;
}

function endpointField(value: unknown): string | undefined {
  const endpoint = stringField(value, 64);
  if (!endpoint || endpoint.length < 32 || !/^[A-Za-z0-9]+$/u.test(endpoint)) return undefined;
  return endpoint;
}

function addressField(value: unknown): string | undefined {
  const address = stringField(value, 64);
  if (!address || /[\s/@?#\\]/u.test(address)) return undefined;
  return address;
}

export function normalizeDiscoveredPolyth(value: unknown): DiscoveredPolyth | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const endpoint = endpointField(raw.hostEndpointId);
  const serviceName = stringField(raw.serviceName, 128);
  const hostLabel = stringField(raw.hostLabel, 80);
  const port = raw.port;
  if (!endpoint || !serviceName || !hostLabel || raw.protocolVersion !== 1) return undefined;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) return undefined;

  const addresses = Array.isArray(raw.addresses)
    ? Array.from(new Set(raw.addresses.map(addressField).filter((item): item is string => Boolean(item)))).slice(0, 16)
    : [];

  return {
    id: endpoint,
    serviceName,
    hostLabel,
    hostEndpointId: endpoint,
    protocolVersion: 1,
    port: port as number,
    addresses,
    numericPairing: raw.numericPairing === true,
  };
}

export function normalizeDiscoveryUpdate(value: unknown): DiscoveryUpdate {
  if (!value || typeof value !== "object") return { state: "error", results: [], error: "discovery-invalid" };
  const raw = value as Record<string, unknown>;
  const state = raw.state;
  const validState: DiscoveryState = state === "discovering"
    || state === "empty"
    || state === "results"
    || state === "permission-required"
    || state === "error"
    ? state
    : "error";
  const byEndpoint = new Map<string, DiscoveredPolyth>();
  if (Array.isArray(raw.results)) {
    for (const item of raw.results) {
      const normalized = normalizeDiscoveredPolyth(item);
      if (normalized) byEndpoint.set(normalized.hostEndpointId, normalized);
    }
  }
  const results = [...byEndpoint.values()].sort((left, right) => left.hostLabel.localeCompare(right.hostLabel));
  return {
    state: results.length > 0 && validState !== "error" && validState !== "permission-required" ? "results" : validState,
    results,
    error: stringField(raw.error, 128),
  };
}
