import type { QuotaSnapshot } from "@polyth/contracts";
import type { QuotaRuntime } from "../opencodeAuth.ts";
import type { DiscoverableProvider } from "./adapters.ts";

/**
 * Command Code exposes live account credits and rolling-window meters through
 * its native `/usage` command and Studio. It does not currently document a
 * machine-readable account-quota CLI/API surface.
 *
 * Keep this provider deliberately unavailable rather than reading the
 * CLI-managed `~/.commandcode/auth.json`, copying credentials, scraping the
 * TUI/Studio, or calling undocumented `/alpha/*` endpoints. Per-turn token and
 * cost telemetry is integrated separately through Command Code's documented
 * headless AgentEvent/result stream.
 */
export const createCommandCodeProvider = (_runtime: QuotaRuntime): DiscoverableProvider => ({
  id: "command-code",
  isConfigured: () => false,
  async fetch(_signal): Promise<QuotaSnapshot> {
    throw new Error(
      "Command Code account limits are not exposed through a documented machine-readable surface; run /usage in Command Code for the native live meters",
    );
  },
});
