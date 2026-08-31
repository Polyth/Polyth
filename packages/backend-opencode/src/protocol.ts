import type {
  OpenCodeTransport,
  ProtocolAdapter,
  RuntimeEndpoint,
  RuntimeLocation,
} from "@polyth/contracts";
import {
  createLegacyProtocolAdapter,
  legacyPromptPathsFromDocument,
  type LegacyPromptPath,
} from "./protocolLegacy.ts";
import {
  createV2ProtocolAdapter,
  hasV2ProtocolDocument,
} from "./protocolV2.ts";

export type { MutationOutcome, ProtocolAdapter, RuntimeSnapshot } from "@polyth/contracts";

export type ProtocolSelection = "auto" | "legacy" | "v2";

export interface CreateProtocolAdapterOptions {
  protocol: ProtocolSelection;
  transport: OpenCodeTransport;
  endpoint: RuntimeEndpoint;
  deadlineMs?: number;
}

/** Read-only protocol evidence. It deliberately contains no generated SDK
 * names and is cached only for one transport and endpoint generation. */
export interface ProtocolProbe {
  protocol?: "legacy" | "v2";
  legacyPromptPaths: ReadonlyArray<LegacyPromptPath>;
}

const probeCache = new WeakMap<
  OpenCodeTransport,
  Map<string, Promise<ProtocolProbe>>
>();

const cacheKey = (endpoint: RuntimeEndpoint): string =>
  `${endpoint.authorityId}\u0000${endpoint.generation}\u0000${endpoint.url}`;

const withLocation = (path: string, location: RuntimeLocation): string => {
  const separator = path.includes("?") ? "&" : "?";
  const params = new URLSearchParams({ directory: location.directory });
  if (location.workspace) params.set("workspace", location.workspace);
  return `${path}${separator}${params.toString()}`;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const protocolMarker = (value: unknown): "legacy" | "v2" | undefined => {
  const body = asRecord(value);
  const nested = asRecord(body?.data);
  for (const candidate of [
    body?.protocol,
    body?.api,
    body?.apiVersion,
    nested?.protocol,
    nested?.api,
    nested?.apiVersion,
  ]) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.toLowerCase();
    if (normalized === "v2" || normalized === "2" || normalized === "beta-v2") return "v2";
    if (normalized === "legacy" || normalized === "v1" || normalized === "1") return "legacy";
  }
  const capabilities = asRecord(body?.capabilities) ?? asRecord(nested?.capabilities);
  if (capabilities?.v2 === true) return "v2";
  return undefined;
};

const queryOptional = async (
  transport: OpenCodeTransport,
  endpoint: RuntimeEndpoint,
  path: string,
  deadlineMs: number,
): Promise<unknown> => {
  try {
    const result = await transport.query<unknown>({
      method: "GET",
      path: withLocation(path, endpoint.location),
      deadlineMs,
    });
    const response = asRecord(result);
    if (typeof response?.status !== "number") return result;
    if (response.status < 200 || response.status >= 300) return undefined;
    return response.body;
  } catch {
    return undefined;
  }
};

const performProbe = async (
  transport: OpenCodeTransport,
  endpoint: RuntimeEndpoint,
  deadlineMs: number,
): Promise<ProtocolProbe> => {
  const document = await queryOptional(transport, endpoint, "/doc", deadlineMs);
  const legacyPromptPaths = legacyPromptPathsFromDocument(document);
  // OpenCode 1.x can advertise its experimental V2 routes alongside the
  // stable legacy session API. Its V2 session mutations may still target the
  // unpopulated V2 store, while the legacy contract remains fully usable.
  // Prefer that proven session contract whenever it is advertised; callers
  // can explicitly select V2 when operating a V2-only endpoint.
  if (legacyPromptPaths.length > 0) return { protocol: "legacy", legacyPromptPaths };
  if (hasV2ProtocolDocument(document)) return { protocol: "v2", legacyPromptPaths };

  const apiHealth = await queryOptional(transport, endpoint, "/api/health", deadlineMs);
  const apiMarker = protocolMarker(apiHealth);
  if (apiMarker) return { protocol: apiMarker, legacyPromptPaths };

  const globalHealth = await queryOptional(
    transport,
    endpoint,
    "/global/health",
    deadlineMs,
  );
  const globalMarker = protocolMarker(globalHealth);
  if (globalMarker) return { protocol: globalMarker, legacyPromptPaths };

  // /global/health is a pinned legacy endpoint. Its mere successful response
  // identifies the protocol, but does not prove either prompt mutation path.
  if (globalHealth !== undefined) return { protocol: "legacy", legacyPromptPaths };
  return { legacyPromptPaths };
};

export const probeProtocol = (
  transport: OpenCodeTransport,
  endpoint: RuntimeEndpoint,
  deadlineMs = 5_000,
): Promise<ProtocolProbe> => {
  let byGeneration = probeCache.get(transport);
  if (!byGeneration) {
    byGeneration = new Map();
    probeCache.set(transport, byGeneration);
  }
  const key = cacheKey(endpoint);
  const cached = byGeneration.get(key);
  if (cached) return cached;
  const pending = performProbe(transport, endpoint, deadlineMs);
  byGeneration.set(key, pending);
  return pending;
};

export const createProtocolAdapter = async (
  options: CreateProtocolAdapterOptions,
): Promise<ProtocolAdapter> => {
  const probe = await probeProtocol(
    options.transport,
    options.endpoint,
    options.deadlineMs,
  );
  const selected = options.protocol === "auto" ? probe.protocol : options.protocol;
  if (!selected) {
    throw Object.assign(
      new Error("OpenCode endpoint does not expose a supported protocol contract"),
      { code: "protocol-unsupported" },
    );
  }
  if (selected === "legacy") {
    return createLegacyProtocolAdapter({
      transport: options.transport,
      endpoint: options.endpoint,
      deadlineMs: options.deadlineMs,
      // An absent contract is distinct from a selected list: let the legacy
      // adapter use its single compatible prompt_async fallback for older
      // servers that expose /global/health but no useful /doc.
      ...(probe.legacyPromptPaths.length > 0 ? { promptPaths: probe.legacyPromptPaths } : {}),
    });
  }
  return createV2ProtocolAdapter({
    transport: options.transport,
    endpoint: options.endpoint,
    deadlineMs: options.deadlineMs,
  });
};
