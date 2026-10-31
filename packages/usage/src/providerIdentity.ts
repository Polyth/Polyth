import type { SessionProjection } from "@polyth/contracts";

const PLACEHOLDER_PROVIDER_IDS = new Set(["default", "__default__"]);

export function isPlaceholderProviderId(providerId: string | undefined): boolean {
  if (!providerId?.trim()) return true;
  return PLACEHOLDER_PROVIDER_IDS.has(providerId.trim().toLowerCase());
}

export function canonicalProviderId(providerId: string): string {
  const trimmed = providerId.trim();
  if (!trimmed || isPlaceholderProviderId(trimmed)) return "";
  const normalized = trimmed.toLowerCase();
  if (normalized === "claude" || normalized === "claude-code") return "anthropic";
  if (normalized === "codex" || normalized === "chatgpt") return "openai";
  if (normalized === "github-copilot-addon") return "github-copilot";
  if (normalized === "gemini") return "google";
  return trimmed;
}

export function resolveSessionUsageProviderId(session: SessionProjection): string | undefined {
  const modelProvider = session.model?.providerID;
  if (modelProvider && !isPlaceholderProviderId(modelProvider)) {
    const canonical = canonicalProviderId(modelProvider);
    return canonical || undefined;
  }

  const resolved = session.resolvedHarnessId?.trim();
  if (!resolved || isPlaceholderProviderId(resolved)) return undefined;
  // Every account of a harness bills the same provider as the harness itself.
  const harnessId = harnessAccountOf(resolved)?.harnessId ?? resolved;
  const canonical = canonicalProviderId(harnessId);
  return canonical || undefined;
}

/** Bucket for observations recorded without a harness, so they stay visible instead of vanishing from a share. */
export const UNKNOWN_HARNESS_ID = "unknown";

/** Harness ids are lowercase slugs; a missing or blank id is the explicit unknown bucket. */
export function canonicalHarnessId(harnessId: string | undefined): string {
  return harnessId?.trim().toLowerCase() || UNKNOWN_HARNESS_ID;
}

const KNOWN_HARNESSES: Readonly<Record<string, string>> = {
  antigravity: "Antigravity",
  claude: "Claude Code",
  // Legacy spelling of the default Claude Code harness, not an account.
  "claude-code": "Claude Code",
  codex: "Codex",
  commandcode: "Command Code",
  cursor: "Cursor",
  fx: "FX",
  grok: "Grok Build",
  omp: "OMP",
  opencode: "OpenCode",
  pi: "Pi",
};

const prettify = (id: string): string => id
  .replace(/[-_]+/g, " ")
  .replace(/\b\w/g, (letter) => letter.toUpperCase());

/**
 * A multi-account harness registers each extra account as `<harness>-<account>`
 * (for example `claude-work` beside the default `claude`). Returns the known
 * base harness and the account slug, or undefined for any other id.
 */
export function harnessAccountOf(harnessId: string | undefined): { harnessId: string; account: string } | undefined {
  const normalized = canonicalHarnessId(harnessId);
  if (KNOWN_HARNESSES[normalized]) return undefined;
  for (const base of Object.keys(KNOWN_HARNESSES)) {
    if (normalized.startsWith(`${base}-`) && normalized.length > base.length + 1) {
      return { harnessId: base, account: normalized.slice(base.length + 1) };
    }
  }
  return undefined;
}

/**
 * Names match each backend's registered descriptor; an account of a known
 * harness reads `<harness> · <account>`, and an unlisted harness falls back to
 * its prettified id. A live registry name (with the account's real label) is
 * preferred where the server has one.
 */
export function displayHarness(harnessId: string): string {
  const normalized = canonicalHarnessId(harnessId);
  if (normalized === UNKNOWN_HARNESS_ID) return "Unknown harness";
  const known = KNOWN_HARNESSES[normalized];
  if (known) return known;
  const account = harnessAccountOf(normalized);
  return account
    ? `${KNOWN_HARNESSES[account.harnessId]} · ${prettify(account.account)}`
    : prettify(normalized);
}

export function displayProvider(providerId: string): string {
  if (isPlaceholderProviderId(providerId)) return "";
  const normalized = providerId.trim().toLowerCase();
  const known: Record<string, string> = {
    anthropic: "Claude",
    openai: "OpenAI",
    opencode: "OpenCode",
    "opencode-go": "OpenCode Go",
    "opencode-zen": "OpenCode Zen",
    openrouter: "OpenRouter",
    google: "Gemini",
    "github-copilot": "GitHub Copilot",
    xai: "xAI",
    antigravity: "Antigravity",
    commandcode: "CommandCode",
    "command-code": "CommandCode",
    chutes: "Chutes AI",
    synthetic: "Synthetic",
    kilo: "Kilo Gateway",
    "kimi-for-coding": "Kimi Code (CN)",
    "kimi-code": "Kimi Code (CN)",
    kimi: "Kimi Code (CN)",
    "kimi-code-plan-cn": "Kimi Code (CN)",
    "kimi-code-plan-global": "Kimi Code (Global)",
    xiaomi: "Xiaomi MiMo",
    "xiaomi-mimo": "Xiaomi MiMo",
    "xiaomi-token-plan-cn": "Xiaomi MiMo",
    "xiaomi-token-plan-ams": "Xiaomi MiMo",
    "xiaomi-token-plan-sgp": "Xiaomi MiMo",
    alibaba: "Alibaba Coding Plan",
    "alibaba-coding-plan": "Alibaba Coding Plan",
    "alibaba-token-plan": "Alibaba Personal Token Plan",
  };
  return known[normalized] ?? providerId
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
