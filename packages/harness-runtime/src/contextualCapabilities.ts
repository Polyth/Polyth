import type {
  AgentCapabilityContribution,
  AgentCapabilityContributionRegistry,
  AgentCapabilityDescriptor,
  Disposable,
  HarnessContext,
} from "@polyth/contracts";
import { createCapabilityContributionRegistry as createBaseRegistry } from "./capabilities.ts";

/**
 * Package-owned desired state sometimes depends on the active project (for
 * example managed project skills). Keep that resolution inside the canonical
 * capability registry so every harness sees the same desired set.
 *
 * This is intentionally a structural extension rather than a second public
 * registry contract: ordinary static contributions remain unchanged.
 */
export interface ContextualCapabilityContribution extends AgentCapabilityContribution {
  resolveCapabilities(context: HarnessContext): readonly AgentCapabilityDescriptor[];
}

const contextual = (
  contribution: AgentCapabilityContribution,
): contribution is ContextualCapabilityContribution =>
  typeof (contribution as Partial<ContextualCapabilityContribution>).resolveCapabilities === "function";

export function createCapabilityContributionRegistry(): AgentCapabilityContributionRegistry {
  const base = createBaseRegistry();
  const resolvers = new Map<string, {
    owner: string;
    resolve(context: HarnessContext): readonly AgentCapabilityDescriptor[];
    execute: AgentCapabilityContribution["execute"];
  }>();

  return {
    register(owner, contribution) {
      const registered = base.register(owner, contribution);
      if (!contextual(contribution)) return registered;
      const id = contribution.descriptor.id;
      resolvers.set(id, {
        owner,
        resolve: contribution.resolveCapabilities,
        execute: contribution.execute,
      });
      return {
        dispose(): void | Promise<void> {
          if (resolvers.get(id)?.resolve === contribution.resolveCapabilities) resolvers.delete(id);
          return registered.dispose();
        },
      } satisfies Disposable;
    },
    list: () => base.list().filter((item) => !contextual(item)),
    resolve(context) {
      const resolved = base.resolve(context).filter((descriptor) => !resolvers.has(descriptor.id));
      const ids = new Set(resolved.map((descriptor) => descriptor.id));

      for (const { owner, resolve, execute } of resolvers.values()) {
        for (const descriptor of resolve(context)) {
          // Reuse the canonical registry's existing validation, scope matching,
          // ownership enforcement and semantic revision normalization instead of
          // maintaining a second validator for dynamic descriptors.
          const verifier = createBaseRegistry();
          verifier.register(owner, {
            descriptor: { ...descriptor, owner },
            execute,
          });
          const normalized = verifier.resolve(context)[0];
          if (!normalized) continue;
          if (ids.has(normalized.id)) {
            throw Object.assign(new Error(`capability already resolved: ${normalized.id}`), { code: "conflict" });
          }
          ids.add(normalized.id);
          resolved.push(normalized);
        }
      }
      return resolved.sort((a, b) => a.id.localeCompare(b.id));
    },
    contribution: (id) => base.contribution(id),
    executor: (id) => base.executor(id),
  };
}
