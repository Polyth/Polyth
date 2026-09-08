// Cold model discovery for an ACP agent, so the composer can offer models
// before a Polyth session exists. ACP publishes the catalog on a session, not
// on the connection, so discovery opens a throwaway session, reads what the
// agent advertised, and terminates the process.
//
// That is a process spawn, so it is cached and deduped per (harness, command
// version, auth state). An agent that needs a native sign-in reports
// `auth-required` with a reason rather than being retried in a loop.
import type { HarnessAvailabilityState, ModelDescriptor } from "@polyth/contracts";
import { acpModelDescriptors, parseSessionConfig } from "./sessionConfig.ts";

export interface AcpDiscoveryProbe {
  /** Opens a connection, runs `session/new`, returns its raw result. */
  open(): Promise<{ result: unknown; close(): Promise<void> }>;
}

export interface AcpDiscoveryOptions {
  harnessId: string;
  /** Identity of the installed agent — a version bump invalidates the cache. */
  version: string;
  /** Auth-relevant identity, so a sign-in does not serve a stale answer. */
  authFingerprint: string;
  probe: AcpDiscoveryProbe;
  ttlMs?: number;
  now?: () => number;
}

export type AcpDiscoveryResult =
  | { state: "ready"; models: ModelDescriptor[] }
  | { state: Extract<HarnessAvailabilityState, "auth-required" | "degraded">; reason: string };

interface CacheEntry {
  value?: AcpDiscoveryResult;
  expiresAt: number;
  pending?: Promise<AcpDiscoveryResult>;
}

const cache = new Map<string, CacheEntry>();
const DEFAULT_TTL_MS = 5 * 60_000;
/** A refused sign-in is remembered longer: retrying cannot fix it. */
const AUTH_TTL_MS = 60_000;

const cacheKey = (options: AcpDiscoveryOptions): string =>
  JSON.stringify([options.harnessId, options.version, options.authFingerprint]);

export function invalidateAcpDiscovery(options?: Pick<AcpDiscoveryOptions, "harnessId">): void {
  if (!options) { cache.clear(); return; }
  for (const key of [...cache.keys()]) {
    if ((JSON.parse(key) as string[])[0] === options.harnessId) cache.delete(key);
  }
}

const authRefusal = (error: unknown): string | undefined => {
  const message = (error as { message?: string })?.message ?? "";
  const rpcCode = (error as { rpcCode?: number })?.rpcCode;
  if (rpcCode === -32000 || /auth|login|sign[ -]?in|credential|unauthori[sz]ed/i.test(message)) {
    return message.trim() || "authentication required";
  }
  return undefined;
};

export function discoverAcpModels(options: AcpDiscoveryOptions): Promise<AcpDiscoveryResult> {
  const now = options.now ?? Date.now;
  const key = cacheKey(options);
  const entry = cache.get(key);
  if (entry?.value && entry.expiresAt > now()) return Promise.resolve(entry.value);
  if (entry?.pending) return entry.pending;
  const pending = (async (): Promise<AcpDiscoveryResult> => {
    let session: Awaited<ReturnType<AcpDiscoveryProbe["open"]>> | undefined;
    try {
      session = await options.probe.open();
      const config = parseSessionConfig(session.result);
      return { state: "ready", models: acpModelDescriptors(config, options.harnessId) };
    } catch (error) {
      const auth = authRefusal(error);
      if (auth) return { state: "auth-required", reason: auth };
      return {
        state: "degraded",
        reason: (error as { message?: string })?.message?.trim() || "the agent could not be started",
      };
    } finally {
      await session?.close().catch(() => {});
    }
  })();
  cache.set(key, { expiresAt: entry?.expiresAt ?? 0, pending });
  return pending.then((value) => {
    cache.set(key, {
      value,
      expiresAt: now() + (options.ttlMs ?? (value.state === "auth-required" ? AUTH_TTL_MS : DEFAULT_TTL_MS)),
    });
    return value;
  }, (error) => {
    cache.delete(key);
    throw error;
  });
}
