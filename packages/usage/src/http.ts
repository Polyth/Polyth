// Config-driven HTTP quota adapter (F13 quota half). Real providers are
// declared server-side (data/quota-providers.json); bearer credentials are
// referenced by environment-variable *name* so tokens never sit in the config
// file and never reach the browser. The endpoint must already answer with
// quota windows as JSON — either a { windows: [...] } body, a bare array, or
// an array located by a dot path. Window sanitization happens in the usage
// service, so a misbehaving endpoint degrades to stale-with-reason.
import type { QuotaSnapshot, QuotaWindow } from "@polyth/contracts";
import type { QuotaProvider } from "./index.ts";

export interface HttpQuotaProviderSpec {
  id: string;
  url: string;
  /** Static request headers. Do not put secrets here — use bearerEnv. */
  headers?: Record<string, string>;
  /** Env var whose value is sent as "Authorization: Bearer <value>". */
  bearerEnv?: string;
  accountLabel?: string;
  /** Dot path to the windows array inside the response body (e.g. "data.windows"). */
  windowsPath?: string;
}

export interface HttpQuotaProviderOptions {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

const isStringMap = (value: unknown): value is Record<string, string> =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  Object.values(value).every((v) => typeof v === "string");

/** Validate the quota-providers config file contents. Accepts a bare array or
 *  { providers: [...] }. Throws with the entry index on the first malformed
 *  spec so misconfiguration surfaces at boot instead of as silent absence. */
export function parseQuotaProviderSpecs(raw: unknown): HttpQuotaProviderSpec[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { providers?: unknown })?.providers)
      ? (raw as { providers: unknown[] }).providers
      : null;
  if (!list) throw new Error("quota providers config must be an array or { providers: [...] }");
  const out: HttpQuotaProviderSpec[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const entry = list[i] as Partial<HttpQuotaProviderSpec>;
    const at = `quota provider [${i}]`;
    if (typeof entry?.id !== "string" || !entry.id.trim()) throw new Error(`${at}: missing id`);
    if (seen.has(entry.id)) throw new Error(`${at}: duplicate id "${entry.id}"`);
    if (typeof entry.url !== "string" || !/^https?:\/\//.test(entry.url)) {
      throw new Error(`${at}: url must be http(s)`);
    }
    if (entry.headers !== undefined && !isStringMap(entry.headers)) throw new Error(`${at}: headers must be a string map`);
    for (const field of ["bearerEnv", "accountLabel", "windowsPath"] as const) {
      if (entry[field] !== undefined && typeof entry[field] !== "string") throw new Error(`${at}: ${field} must be a string`);
    }
    seen.add(entry.id);
    out.push({
      id: entry.id.trim(),
      url: entry.url,
      ...(entry.headers ? { headers: entry.headers } : {}),
      ...(entry.bearerEnv ? { bearerEnv: entry.bearerEnv } : {}),
      ...(entry.accountLabel ? { accountLabel: entry.accountLabel } : {}),
      ...(entry.windowsPath ? { windowsPath: entry.windowsPath } : {}),
    });
  }
  return out;
}

const locateWindows = (body: unknown, path: string | undefined): unknown => {
  if (path) {
    let node: unknown = body;
    for (const key of path.split(".")) {
      if (typeof node !== "object" || node === null) return undefined;
      node = (node as Record<string, unknown>)[key];
    }
    return node;
  }
  if (Array.isArray(body)) return body;
  return (body as { windows?: unknown })?.windows;
};

export function createHttpQuotaProvider(
  spec: HttpQuotaProviderSpec,
  opts: HttpQuotaProviderOptions = {},
): QuotaProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  return {
    id: spec.id,
    async fetch(signal: AbortSignal): Promise<QuotaSnapshot> {
      const headers: Record<string, string> = { accept: "application/json", ...spec.headers };
      if (spec.bearerEnv) {
        const token = env[spec.bearerEnv];
        if (!token) throw new Error(`credential env var ${spec.bearerEnv} is not set`);
        headers.authorization = `Bearer ${token}`;
      }
      const res = await fetchImpl(spec.url, { headers, signal });
      if (!res.ok) throw new Error(`quota endpoint answered HTTP ${res.status}`);
      const body = (await res.json()) as unknown;
      const windows = locateWindows(body, spec.windowsPath);
      if (!Array.isArray(windows)) throw new Error("quota endpoint did not return a windows array");
      const bodyLabel = (body as { accountLabel?: unknown })?.accountLabel;
      const accountLabel = spec.accountLabel ?? (typeof bodyLabel === "string" ? bodyLabel : undefined);
      return {
        providerId: spec.id,
        ...(accountLabel ? { accountLabel } : {}),
        windows: windows as QuotaWindow[],
        fetchedAt: now(),
        stale: false,
      };
    },
  };
}
