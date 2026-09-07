import type { PackageRegistry } from "./packages.ts";
import type { RouteRegistry } from "./routeRegistry.ts";

export interface PackageLifecycleHooks {
  onEnable?: () => void | Promise<void>;
  onDisable?: () => void | Promise<void>;
  stopIngress?: () => void | Promise<void>;
}

export interface PackageLifecycle {
  register(id: string, hooks: PackageLifecycleHooks): void;
  enable(id: string): Promise<void>;
  disable(id: string): Promise<void>;
  stopIngress(): Promise<void>;
  startEnabled(registry: PackageRegistry): Promise<void>;
}

export function createPackageLifecycle(routeRegistry: RouteRegistry): PackageLifecycle {
  const hooksById = new Map<string, PackageLifecycleHooks>();
  const enabled = new Set<string>();
  const locks = new Map<string, Promise<void>>();

  // Route ownership is implemented by registered hooks. Retaining this
  // dependency in the lifecycle constructor keeps one composition seam for
  // package-owned server resources.
  void routeRegistry;

  const withLock = async (id: string, fn: () => Promise<void>): Promise<void> => {
    const previous = locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.then(() => gate);
    locks.set(id, current);
    await previous;
    try {
      await fn();
    } finally {
      release();
      if (locks.get(id) === current) locks.delete(id);
    }
  };

  const enable = (id: string): Promise<void> => withLock(id, async () => {
    if (enabled.has(id)) return;
    await hooksById.get(id)?.onEnable?.();
    enabled.add(id);
  });

  const disable = (id: string): Promise<void> => withLock(id, async () => {
    if (!enabled.has(id)) return;
    await hooksById.get(id)?.onDisable?.();
    enabled.delete(id);
  });

  return {
    register(id, hooks) {
      if (hooksById.has(id)) throw new Error(`package lifecycle already registered: ${id}`);
      hooksById.set(id, hooks);
    },
    enable,
    disable,
    async stopIngress() {
      for (const [id, hooks] of hooksById) {
        try {
          await hooks.stopIngress?.();
        } catch (error) {
          // Isolate a broken detach so remaining owners still stop. A silent
          // swallow leaves HTTP drain waiting the full timeout with no cause.
          console.warn(`[polyth] package "${id}" failed to stop ingress`, error);
        }
      }
    },
    async startEnabled(registry) {
      for (const descriptor of registry.list()) {
        if (!registry.isEnabled(descriptor.id)) continue;
        try {
          await enable(descriptor.id);
        } catch {
          // Package boot is isolated: one optional package cannot prevent the
          // remaining enabled packages from starting.
        }
      }
    },
  };
}
