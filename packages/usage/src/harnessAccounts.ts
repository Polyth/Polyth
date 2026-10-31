// One Limits source per account of a multi-account harness. The harness owns
// where an account's native credentials live (`HarnessProvider.limitsAccount`);
// Usage only reads that account's own login and reports it under the
// harness id, so a session on `claude-work` sees that account's windows.
import type { HarnessProvider } from "@polyth/contracts";
import type { QuotaProvider, UsageLimitAccount, UsageLimitService } from "./limits.ts";
import { resolveQuotaRuntime, type QuotaDiscoveryOptions, type QuotaRuntime } from "./opencodeAuth.ts";
import { createAntigravityProvider } from "./providers/antigravity.ts";
import { createClaudeProvider } from "./providers/claude.ts";
import { createCodexProvider } from "./providers/codex.ts";

type AccountSourceFactory = (
  runtime: QuotaRuntime,
  source: { configDir: string; account(): UsageLimitAccount },
) => QuotaProvider;

/** Limits families that can read a single account's credentials. */
const ACCOUNT_SOURCES: Readonly<Record<string, AccountSourceFactory>> = {
  claude: createClaudeProvider,
  codex: createCodexProvider,
  antigravity: createAntigravityProvider,
};

export interface HarnessAccountLimitsOptions {
  limits: Pick<UsageLimitService, "register" | "unregister">;
  /** Registered harness providers; read on every reconcile. */
  harnesses(): readonly HarnessProvider[];
  /** Source ids registered by other means; an account never replaces one. */
  reserved: ReadonlySet<string>;
  discovery?: QuotaDiscoveryOptions;
}

export function createHarnessAccountLimits(opts: HarnessAccountLimitsOptions): { reconcile(): void } {
  const runtime = resolveQuotaRuntime(opts.discovery);
  const owned = new Map<string, { family: string; configDir: string }>();
  return {
    reconcile() {
      const wanted = new Map<string, { harness: HarnessProvider; family: string; configDir: string }>();
      for (const harness of opts.harnesses()) {
        const id = harness.descriptor.id;
        let location: ReturnType<NonNullable<HarnessProvider["limitsAccount"]>>;
        try {
          location = harness.limitsAccount?.();
        } catch {
          continue;
        }
        // The family's default account is already the family's own source.
        if (!location?.configDir || id === location.family || opts.reserved.has(id)) continue;
        if (!ACCOUNT_SOURCES[location.family]) continue;
        wanted.set(id, { harness, family: location.family, configDir: location.configDir });
      }
      for (const [id, current] of owned) {
        const next = wanted.get(id);
        if (next && next.family === current.family && next.configDir === current.configDir) continue;
        opts.limits.unregister(id);
        owned.delete(id);
      }
      for (const [id, { harness, family, configDir }] of wanted) {
        if (owned.has(id)) continue;
        const account = (): UsageLimitAccount => ({
          family,
          harnessId: id,
          label: harness.descriptor.accountLabel?.trim()
            || (id.startsWith(`${family}-`) ? id.slice(family.length + 1) : harness.descriptor.name),
        });
        opts.limits.register(ACCOUNT_SOURCES[family]!(runtime, { configDir, account }));
        owned.set(id, { family, configDir });
      }
    },
  };
}
