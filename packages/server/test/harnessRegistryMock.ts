import type { HarnessProvider, HarnessRegistry } from "@polyth/contracts";

export function mockHarnessRegistry(...providers: HarnessProvider[]): HarnessRegistry {
  const list = () => providers;
  return {
    register: () => ({ dispose() {} }),
    providers: list,
    get: (id) => providers.find((provider) => provider.descriptor.id === id),
    probe: async () => [],
    resolve: async (_context, selection) => {
      const id = selection.mode === "pinned" ? selection.harnessId : providers[0]?.descriptor.id;
      const provider = providers.find((row) => row.descriptor.id === id);
      if (!provider) throw new Error(`harness ${id ?? "unknown"} is not registered`);
      return provider;
    },
  };
}
