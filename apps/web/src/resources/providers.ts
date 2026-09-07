import type { ResourceProvider, ResourceRef, Unregister } from "@polyth/web-sdk";
import { resourceKey } from "@polyth/web-sdk";

const providers = new Map<string, ResourceProvider>();
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version++;
  for (const listener of [...listeners]) listener();
}

export function registerResourceProvider(provider: ResourceProvider): Unregister {
  providers.set(provider.scheme, provider);
  bump();
  return () => {
    if (providers.get(provider.scheme) === provider) {
      providers.delete(provider.scheme);
      bump();
    }
  };
}

export function getResourceProvider(scheme: string): ResourceProvider | undefined {
  return providers.get(scheme);
}

export function describeResource(ref: ResourceRef) {
  return providers.get(ref.scheme)?.describe(ref) ?? null;
}

export { resourceKey };

export function subscribeResourceProviders(listener: () => void): Unregister {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function resourceProvidersVersion(): number {
  return version;
}
