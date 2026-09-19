import type { SessionProjection } from "@polyth/contracts";

const PLACEHOLDER_PROVIDER_IDS = new Set(["default", "__default__"]);

export function isPlaceholderProviderId(providerId: string | undefined): boolean {
  if (!providerId?.trim()) return true;
  return PLACEHOLDER_PROVIDER_IDS.has(providerId.trim().toLowerCase());
}

/** Normalize provider aliases used by sessions, runtime usage events and quota adapters. */
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

/** Resolve the specific provider that served usage for a session projection. */
export function resolveSessionUsageProviderId(session: SessionProjection): string | undefined {
  const modelProvider = session.model?.providerID;
  if (modelProvider && !isPlaceholderProviderId(modelProvider)) {
    const canonical = canonicalProviderId(modelProvider);
    return canonical || undefined;
  }
  const harnessId = session.resolvedHarnessId?.trim();
  if (harnessId && !isPlaceholderProviderId(harnessId)) {
    const fromHarness = canonicalProviderId(harnessId);
    if (fromHarness && !isPlaceholderProviderId(fromHarness)) return fromHarness;
  }
  return undefined;
}

export function displayProvider(providerId: string): string {
  if (isPlaceholderProviderId(providerId)) return "";
  const normalized = providerId.trim().toLowerCase();
  const known: Record<string, string> = {
    anthropic: "Claude",
    claude: "Claude",
    "claude-code": "Claude",
    openai: "OpenAI",
    opencode: "OpenCode",
    "opencode-go": "OpenCode Go",
    "opencode-zen": "OpenCode Zen",
    openrouter: "OpenRouter",
    google: "Gemini",
    gemini: "Gemini",
    "github-copilot": "GitHub Copilot",
    xai: "xAI",
  };
  return known[normalized] ?? providerId
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function providerUsageLabel(providerId: string): string {
  return displayProvider(providerId);
}
