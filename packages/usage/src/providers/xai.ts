import type { QuotaProvider } from "../index.ts";
import {
  numberValue,
  objectValue,
  stringValue,
  type OpenCodeAuth,
  type QuotaRuntime,
} from "../opencodeAuth.ts";
import { mappolythUsage, ocWindow } from "../ocWindows.ts";
import type { DiscoverableProvider } from "./adapters.ts";

const USAGE_URL = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const EMPTY_GRPC_BODY = new Uint8Array([0, 0, 0, 0, 0]);

interface XaiEntry extends Record<string, unknown> {
  type: "oauth";
  access?: string;
  refresh?: string;
  expires?: number;
}

const xaiEntry = (runtime: QuotaRuntime): XaiEntry | null => {
  const entry = objectValue(runtime.readAuth().xai);
  if (entry?.type !== "oauth") return null;
  if (!stringValue(entry.access) && !stringValue(entry.refresh)) return null;
  return entry as XaiEntry;
};

const jwtExpiry = (token: string): number | null => {
  try {
    const payload = token.split(".")[1];
    return payload
      ? numberValue(objectValue(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")))?.exp)
      : null;
  } catch {
    return null;
  }
};

const readVarint = (bytes: Uint8Array, state: { index: number }): bigint | null => {
  let value = 0n;
  for (let shift = 0n; state.index < bytes.length && shift < 64n; shift += 7n) {
    const byte = bytes[state.index++]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
  }
  return null;
};

interface FixedField { path: number[]; value: number; order: number }
interface VarintField { path: number[]; value: bigint }
interface Scan { fixed: FixedField[]; varints: VarintField[] }

const scanMessage = (
  bytes: Uint8Array,
  path: number[] = [],
  depth = 0,
  order = { value: 0 },
): Scan | null => {
  const state = { index: 0 };
  const result: Scan = { fixed: [], varints: [] };
  while (state.index < bytes.length) {
    const key = readVarint(bytes, state);
    if (key === null || key === 0n) return null;
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    const fieldPath = [...path, field];
    if (wire === 0) {
      const value = readVarint(bytes, state);
      if (value === null) return null;
      result.varints.push({ path: fieldPath, value });
    } else if (wire === 1) {
      if (state.index + 8 > bytes.length) return null;
      state.index += 8;
    } else if (wire === 2) {
      const length = readVarint(bytes, state);
      if (length === null || length > BigInt(bytes.length - state.index)) return null;
      const end = state.index + Number(length);
      if (depth < 4 && length > 0n) {
        const nested = scanMessage(bytes.slice(state.index, end), fieldPath, depth + 1, order);
        if (nested) {
          result.fixed.push(...nested.fixed);
          result.varints.push(...nested.varints);
        }
      }
      state.index = end;
    } else if (wire === 5) {
      if (state.index + 4 > bytes.length) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset + state.index, 4);
      result.fixed.push({ path: fieldPath, value: view.getFloat32(0, true), order: order.value++ });
      state.index += 4;
    } else {
      return null;
    }
  }
  return result;
};

const framedMessages = (bytes: Uint8Array): Uint8Array[] => {
  if (bytes.length < 5 || (bytes[0]! & 0x7f) !== 0) return [bytes];
  const messages: Uint8Array[] = [];
  let index = 0;
  while (index < bytes.length) {
    if (index + 5 > bytes.length) throw new Error("xAI billing returned malformed gRPC-web framing");
    const flags = bytes[index++]!;
    const length = bytes[index]! * 0x1000000
      + (bytes[index + 1]! << 16)
      + (bytes[index + 2]! << 8)
      + bytes[index + 3]!;
    index += 4;
    const end = index + length;
    if (end > bytes.length) throw new Error("xAI billing returned malformed gRPC-web framing");
    if ((flags & 0x80) === 0) {
      messages.push(bytes.slice(index, end));
    } else {
      const trailer = new TextDecoder().decode(bytes.slice(index, end));
      const status = trailer.match(/(?:^|\r?\n)grpc-status:\s*(\d+)/i)?.[1];
      if (status && status !== "0") throw new Error(`xAI billing RPC failed with status ${status}`);
    }
    index = end;
  }
  return messages;
};

const samePath = (left: number[], right: number[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const parseUsage = (bytes: Uint8Array, now: number): { usedPercent: number; resetAt: number | null } => {
  const scan: Scan = { fixed: [], varints: [] };
  for (const message of framedMessages(bytes)) {
    const result = scanMessage(message);
    if (!result) throw new Error("xAI billing returned malformed protobuf");
    scan.fixed.push(...result.fixed);
    scan.varints.push(...result.varints);
  }
  const percent = scan.fixed
    .filter((field) =>
      (samePath(field.path, [1]) || samePath(field.path, [1, 1]))
      && Number.isFinite(field.value)
      && field.value >= 0
      && field.value <= 100)
    .sort((left, right) => left.path.length - right.path.length || left.order - right.order)[0]?.value;
  const resetCandidates = scan.varints
    .filter((field) => field.value >= 1_700_000_000n && field.value <= 2_100_000_000n)
    .map((field) => ({ ...field, resetAt: Number(field.value) * 1000 }))
    .filter((field) => field.resetAt > now);
  const preferred = resetCandidates.filter((field) => samePath(field.path, [1, 5, 1]));
  const resetAt = (preferred.length > 0 ? preferred : resetCandidates)
    .sort((left, right) => left.resetAt - right.resetAt)[0]?.resetAt ?? null;
  const hasPeriod = scan.varints.some((field) =>
    (field.path.length >= 2 && field.path[0] === 1 && field.path[1] === 6)
    || (samePath(field.path, [1, 8, 1]) && (field.value === 1n || field.value === 2n)));
  if (percent === undefined && resetAt !== null && hasPeriod) return { usedPercent: 0, resetAt };
  if (percent === undefined) throw new Error("xAI billing response had no usable current-period usage");
  return { usedPercent: percent, resetAt };
};

const freshAccess = async (
  runtime: QuotaRuntime,
  entry: XaiEntry,
  signal: AbortSignal,
): Promise<string> => {
  const access = stringValue(entry.access);
  const storedExpiry = numberValue(entry.expires);
  const jwt = access ? jwtExpiry(access) : null;
  const deadline = runtime.now() + 120_000;
  const needsRefresh = !access
    || (storedExpiry !== null && storedExpiry <= deadline)
    || (jwt !== null && jwt * 1000 <= deadline);
  if (!needsRefresh) return access;
  const refresh = stringValue(entry.refresh);
  if (!refresh) throw new Error("xAI OAuth access token is expired and has no usable refresh token");
  let response: Response;
  try {
    response = await runtime.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "b1a00492-073a-47ea-816f-4c329264a828",
        refresh_token: refresh,
        grant_type: "refresh_token",
      }),
      signal,
    });
  } catch {
    throw new Error("xAI OAuth refresh failed");
  }
  if (!response.ok) throw new Error(`xAI OAuth refresh failed with HTTP ${response.status}`);
  const payload = objectValue(await response.json().catch(() => null));
  const nextAccess = stringValue(payload?.access_token);
  if (!nextAccess) throw new Error("xAI OAuth refresh returned no access token");
  const next: XaiEntry = {
    ...entry,
    type: "oauth",
    access: nextAccess,
    refresh: stringValue(payload?.refresh_token) ?? refresh,
    expires: runtime.now() + (numberValue(payload?.expires_in) ?? 3600) * 1000,
  };
  const auth: OpenCodeAuth = runtime.readAuth();
  auth.xai = next;
  runtime.writeAuth(auth);
  return nextAccess;
};

export const createXaiProvider = (runtime: QuotaRuntime): DiscoverableProvider => {
  const provider: QuotaProvider = {
    id: "xai",
    async fetch(signal) {
      const entry = xaiEntry(runtime);
      if (!entry) throw new Error("xAI is not configured");
      const access = await freshAccess(runtime, entry, signal);
      let response: Response;
      try {
        response = await runtime.fetchImpl(USAGE_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${access}`,
            Origin: "https://grok.com",
            Referer: "https://grok.com/?_s=usage",
            Accept: "*/*",
            "Content-Type": "application/grpc-web+proto",
            "x-grpc-web": "1",
            "x-user-agent": "connect-es/2.1.1",
            "User-Agent": "polyth",
          },
          body: EMPTY_GRPC_BODY,
          signal,
        });
      } catch {
        throw new Error("xAI billing request failed");
      }
      const grpcStatus = response.headers.get("grpc-status");
      if (grpcStatus && grpcStatus !== "0") throw new Error(`xAI billing RPC failed with status ${grpcStatus}`);
      if (!response.ok) throw new Error(`xAI billing request failed with HTTP ${response.status}`);
      const usage = parseUsage(new Uint8Array(await response.arrayBuffer()), runtime.now());
      return {
        providerId: "xai",
        accountLabel: "xAI",
        windows: mappolythUsage({
          windows: {
            billing_cycle: ocWindow({ usedPercent: usage.usedPercent, resetAt: usage.resetAt }),
          },
        }),
        fetchedAt: runtime.now(),
        stale: false,
      };
    },
  };
  return { ...provider, isConfigured: () => Boolean(xaiEntry(runtime)) };
};
