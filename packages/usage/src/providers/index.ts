import type { QuotaProvider } from "../index.ts";
import {
  resolveQuotaRuntime,
  type QuotaDiscoveryOptions,
} from "../opencodeAuth.ts";
import { createStandardProviders, type DiscoverableProvider } from "./adapters.ts";
import { createClaudeProvider } from "./claude.ts";
import { createXaiProvider } from "./xai.ts";

const registry = (opts: QuotaDiscoveryOptions = {}): DiscoverableProvider[] => {
  const runtime = resolveQuotaRuntime(opts);
  return [
    createClaudeProvider(runtime),
    ...createStandardProviders(runtime),
    createXaiProvider(runtime),
  ];
};

export const listConfiguredQuotaProviders = (opts: QuotaDiscoveryOptions = {}): string[] => {
  const configured: string[] = [];
  for (const provider of registry(opts)) {
    try {
      if (provider.isConfigured()) configured.push(provider.id);
    } catch {
      // One malformed provider credential must not hide the others.
    }
  }
  return configured;
};

export const discoverQuotaProviders = (opts: QuotaDiscoveryOptions = {}): QuotaProvider[] =>
  registry(opts).filter((provider) => {
    try {
      return provider.isConfigured();
    } catch {
      return false;
    }
  });

export type { QuotaDiscoveryOptions, QuotaDiscoveryPaths } from "../opencodeAuth.ts";
export {
  mapProviderUsage,
  mapProviderUsage as mapOpen\u0043hamberUsage,
} from "../ocWindows.ts";
