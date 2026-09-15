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

/** Both released protocols report application health; a successful HTML page
 * or an arbitrary JSON response is not evidence that OpenCode is ready. */
export const isOpenCodeHealth = (value: unknown): boolean => {
  const response = asRecord(value);
  if (!response) return false;
  if (typeof response.status === "number" && response.status !== 200) return false;
  const body = typeof response.status === "number" ? asRecord(response.body) : response;
  return body?.healthy === true
    && typeof body.version === "string" && body.version.trim().length > 0
    && (body.pid === undefined || (Number.isSafeInteger(body.pid) && (body.pid as number) >= 0));
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
    if ([404, 405, 501].includes(response.status)) return undefined;
    if (response.status < 200 || response.status >= 300) {
      throw Object.assign(new Error(`OpenCode protocol probe ${path} failed (HTTP ${response.status})`), {
        code: response.status === 401 || response.status === 403 ? "auth-rejected" : "unavailable",
        status: response.status,
      });
    }
    return response.body;
  } catch (error) {
    const status = asRecord(error)?.status;
    if (status === 404 || status === 405 || status === 501) return undefined;
    throw error;
  }
};

const performProbe = async (
  transport: OpenCodeTransport,
  endpoint: RuntimeEndpoint,
  deadlineMs: number,
): Promise<ProtocolProbe> => {
  // Probe the small health contracts before the generated OpenAPI document.
  const globalHealth = await queryOptional(
    transport,
    endpoint,
    "/global/health",
    deadlineMs,
  );
  if (isOpenCodeHealth(globalHealth)) return { protocol: "legacy", legacyPromptPaths: [] };

  const apiHealth = await queryOptional(transport, endpoint, "/api/health", deadlineMs);
  // Released V2 exposes this small process health contract. Legacy health wins
  // above even when a 1.x server also advertises experimental V2 routes.
  if (isOpenCodeHealth(apiHealth)) return { protocol: "v2", legacyPromptPaths: [] };

  const document = await queryOptional(transport, endpoint, "/doc", deadlineMs);
  const legacyPromptPaths = legacyPromptPathsFromDocument(document);
  // OpenCode 1.x can advertise its experimental V2 routes alongside the
  // stable legacy session API. Its V2 session mutations may still target the
  // unpopulated V2 store, while the legacy contract remains fully usable.
  // Prefer that proven session contract whenever it is advertised; callers
  // can explicitly select V2 when operating a V2-only endpoint.
  if (legacyPromptPaths.length > 0) return { protocol: "legacy", legacyPromptPaths };
  if (hasV2ProtocolDocument(document)) return { protocol: "v2", legacyPromptPaths };
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
  const pending = performProbe(transport, endpoint, deadlineMs).catch((error) => {
    // A failed probe is not a protocol decision. A repaired transport or
    // credential can be tried again without changing unrelated runtime state.
    byGeneration!.delete(key);
    throw error;
  });
  byGeneration.set(key, pending);
  return pending;
};

export const createProtocolAdapter = async (
  options: CreateProtocolAdapterOptions,
): Promise<ProtocolAdapter> => {
  if (options.protocol === "legacy") {
    return createLegacyProtocolAdapter({
      transport: options.transport,
      endpoint: options.endpoint,
      deadlineMs: options.deadlineMs,
    });
  }
  if (options.protocol === "v2") {
    return createV2ProtocolAdapter({
      transport: options.transport,
      endpoint: options.endpoint,
      deadlineMs: options.deadlineMs,
    });
  }

  const probe = await probeProtocol(
    options.transport,
    options.endpoint,
    options.deadlineMs,
  );
  const selected = probe.protocol;
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
