import { resolvePackageErrorCode, type PackageErrorCode } from "./errors.ts";

export const PROTOCOL_CHANNEL = "polyth-package";
export const PROTOCOL_VERSION = 1;
export const MAX_PAYLOAD_BYTES = 256 * 1024;
export const MAX_IN_FLIGHT = 8;
export const REQUEST_TIMEOUT_MS = 20_000;
export const MAX_REQUESTS_PER_WINDOW = 60;
export const RATE_WINDOW_MS = 10_000;

export type EnvelopeKind = "request" | "response" | "event";

export interface ProtocolEnvelope {
  channel: typeof PROTOCOL_CHANNEL;
  v: typeof PROTOCOL_VERSION;
  kind: EnvelopeKind;
  id?: string;
  method?: string;
  ok?: boolean;
  payload?: unknown;
  error?: { code: PackageErrorCode; message: string };
}

export interface HandshakeReady {
  protocolVersion: number;
  packageId: string;
  packageVersion: string;
  runtimeInstanceId: string;
  surfaceId: string;
  capabilities: string[];
  theme: { mode: "light" | "dark" };
  locale: string;
}

/** Node-safe handshake payload. Omits session, project, space, and grant snapshots. */
export function sandboxHandshakeReady(input: {
  packageId: string;
  packageVersion: string;
  runtimeInstanceId: string;
  surfaceId: string;
  capabilities: readonly string[];
  theme: { mode: "light" | "dark" };
  locale: string;
}): HandshakeReady {
  return {
    protocolVersion: PROTOCOL_VERSION,
    packageId: input.packageId,
    packageVersion: input.packageVersion,
    runtimeInstanceId: input.runtimeInstanceId,
    surfaceId: input.surfaceId,
    capabilities: [...input.capabilities],
    theme: input.theme,
    locale: input.locale,
  };
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

export function payloadSize(value: unknown): number {
  try {
    const json = JSON.stringify(value) ?? "null";
    return new TextEncoder().encode(json).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function parseEnvelope(value: unknown): ProtocolEnvelope | null {
  const raw = asRecord(value);
  if (!raw) return null;
  if (raw.channel !== PROTOCOL_CHANNEL) return null;
  if (raw.v !== PROTOCOL_VERSION) return null;
  if (raw.kind !== "request" && raw.kind !== "response" && raw.kind !== "event") {
    return null;
  }
  if (payloadSize(raw) > MAX_PAYLOAD_BYTES) return null;
  if (raw.kind === "request") {
    if (typeof raw.id !== "string" || !raw.id) return null;
    if (typeof raw.method !== "string" || !raw.method) return null;
    return {
      channel: PROTOCOL_CHANNEL,
      v: PROTOCOL_VERSION,
      kind: "request",
      id: raw.id,
      method: raw.method,
      ...(raw.payload !== undefined ? { payload: raw.payload } : {}),
    };
  }
  if (raw.kind === "event") {
    if (typeof raw.method !== "string" || !raw.method) return null;
    return {
      channel: PROTOCOL_CHANNEL,
      v: PROTOCOL_VERSION,
      kind: "event",
      method: raw.method,
      ...(raw.payload !== undefined ? { payload: raw.payload } : {}),
    };
  }
  if (typeof raw.id !== "string" || !raw.id) return null;
  if (raw.ok === true) {
    return {
      channel: PROTOCOL_CHANNEL,
      v: PROTOCOL_VERSION,
      kind: "response",
      id: raw.id,
      ok: true,
      ...(raw.payload !== undefined ? { payload: raw.payload } : {}),
    };
  }
  const error = asRecord(raw.error);
  const message = typeof error?.message === "string" && error.message.trim()
    ? error.message.trim()
    : "request failed";
  const code = resolvePackageErrorCode(typeof error?.code === "string" ? error.code : undefined);
  return {
    channel: PROTOCOL_CHANNEL,
    v: PROTOCOL_VERSION,
    kind: "response",
    id: raw.id,
    ok: false,
    error: { code, message },
  };
}

export function requestEnvelope(id: string, method: string, payload?: unknown): ProtocolEnvelope {
  return {
    channel: PROTOCOL_CHANNEL,
    v: PROTOCOL_VERSION,
    kind: "request",
    id,
    method,
    ...(payload !== undefined ? { payload } : {}),
  };
}

export function responseOk(id: string, payload?: unknown): ProtocolEnvelope {
  return {
    channel: PROTOCOL_CHANNEL,
    v: PROTOCOL_VERSION,
    kind: "response",
    id,
    ok: true,
    ...(payload !== undefined ? { payload } : {}),
  };
}

export function responseError(id: string, code: PackageErrorCode, message: string): ProtocolEnvelope {
  return {
    channel: PROTOCOL_CHANNEL,
    v: PROTOCOL_VERSION,
    kind: "response",
    id,
    ok: false,
    error: { code, message },
  };
}

export function eventEnvelope(method: string, payload?: unknown): ProtocolEnvelope {
  return {
    channel: PROTOCOL_CHANNEL,
    v: PROTOCOL_VERSION,
    kind: "event",
    method,
    ...(payload !== undefined ? { payload } : {}),
  };
}

export interface RateLimiter {
  take(): boolean;
}

export function createRateLimiter(limit = MAX_REQUESTS_PER_WINDOW, windowMs = RATE_WINDOW_MS): RateLimiter {
  const stamps: number[] = [];
  return {
    take() {
      const now = Date.now();
      while (stamps.length > 0 && now - stamps[0]! >= windowMs) stamps.shift();
      if (stamps.length >= limit) return false;
      stamps.push(now);
      return true;
    },
  };
}

export type HostMethodHandler = (ctx: HostMethodContext, payload: unknown) => unknown | Promise<unknown>;

export interface HostMethodContext {
  packageId: string;
  runtimeInstanceId: string;
  surfaceId: string;
  /** Granted capability names. */
  capabilities: ReadonlySet<string>;
  /** Declared capability names from the installed manifest. */
  declared?: ReadonlySet<string>;
}

export function verifySandboxHello(input: {
  eventSource: unknown;
  expectedSource: unknown;
  data: unknown;
  mountNonce: string;
}): boolean {
  if (!input.mountNonce || input.eventSource !== input.expectedSource) return false;
  const raw = asRecord(input.data);
  if (!raw) return false;
  return raw.channel === PROTOCOL_CHANNEL
    && raw.kind === "hello"
    && raw.mountNonce === input.mountNonce;
}

export interface HostMethod {
  method: string;
  capability?: string;
  invoke: HostMethodHandler;
}

export function createMethodRegistry(methods: readonly HostMethod[]) {
  const map = new Map(methods.map((item) => [item.method, item]));
  return {
    get(method: string): HostMethod | undefined {
      return map.get(method);
    },
    async invoke(method: string, ctx: HostMethodContext, payload: unknown): Promise<unknown> {
      const handler = map.get(method);
      if (!handler) {
        throw Object.assign(new Error(`unknown method "${method}"`), { code: "INVALID_REQUEST" });
      }
      if (handler.capability) {
        if (ctx.declared && !ctx.declared.has(handler.capability)) {
          throw Object.assign(new Error(`capability "${handler.capability}" is not declared`), {
            code: "CAPABILITY_UNDECLARED",
          });
        }
        if (!ctx.capabilities.has(handler.capability)) {
          throw Object.assign(new Error(`capability "${handler.capability}" is not granted`), {
            code: "CAPABILITY_DENIED",
          });
        }
      }
      return handler.invoke(ctx, payload);
    },
  };
}
