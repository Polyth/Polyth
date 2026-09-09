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
  open(signal?: AbortSignal): Promise<{
    result: unknown;
    setConfigOption?(configId: string, value: string): Promise<unknown>;
    close(): Promise<void>;
  }>;
}

export interface AcpDiscoveryOptions {
  harnessId: string;
  /** Identity of the installed agent — a version bump invalidates the cache. */
  version: string;
  /** Auth-relevant identity, so a sign-in does not serve a stale answer. */
  authFingerprint: string;
  /** Project/runtime identity because ACP options may depend on cwd or account scope. */
  cacheIdentity?: string;
  probe: AcpDiscoveryProbe;
  ttlMs?: number;
  timeoutMs?: number;
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
const DEFAULT_TIMEOUT_MS = 10_000;

const cacheKey = (options: AcpDiscoveryOptions): string =>
  JSON.stringify([options.harnessId, options.version, options.authFingerprint, options.cacheIdentity ?? ""]);

const withoutVariants = (model: ModelDescriptor): ModelDescriptor => {
  const { variants: _variants, defaultVariant: _defaultVariant, ...rest } = model;
  return rest;
};

/** Config options are dependent state: changing the model may add, remove, or
 * alter thought levels. Probe each model on the throwaway session instead of
 * claiming the current model's levels for every row. */
const discoverDescriptors = async (
  opened: Awaited<ReturnType<AcpDiscoveryProbe["open"]>>,
  harnessId: string,
): Promise<ModelDescriptor[]> => {
  const initial = parseSessionConfig(opened.result);
  const models = acpModelDescriptors(initial, harnessId).map(withoutVariants);
  if (!initial.model || !opened.setConfigOption) return models;
  for (const model of models) {
    try {
      const result = initial.model.currentValue === model.modelID
        ? opened.result
        : await opened.setConfigOption(initial.model.id, model.modelID);
      const selected = acpModelDescriptors(parseSessionConfig(result), harnessId)
        .find((candidate) => candidate.modelID === model.modelID);
      if (selected?.variants?.length) model.variants = selected.variants;
    } catch {
      // Keep the model usable, but do not invent capabilities the agent did
      // not confirm for it.
    }
  }
  return models;
};

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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref();
    try {
      const opened = options.probe.open(controller.signal);
      const timedOut = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(Object.assign(
          new Error("ACP model discovery timed out"),
          { code: "discovery-unavailable" },
        )), { once: true });
      });
      void opened.then((late) => {
        if (controller.signal.aborted) void late.close().catch(() => {});
      }, () => {});
       session = await Promise.race([opened, timedOut]);
       return {
         state: "ready",
         models: await Promise.race([discoverDescriptors(session, options.harnessId), timedOut]),
       };
    } catch (error) {
      const auth = authRefusal(error);
      if (auth) return { state: "auth-required", reason: auth };
      return {
        state: "degraded",
        reason: (error as { message?: string })?.message?.trim() || "the agent could not be started",
      };
    } finally {
      clearTimeout(timer);
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
