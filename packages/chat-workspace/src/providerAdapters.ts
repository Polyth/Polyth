export type ChatWorkspaceProviderId =
  | "chatgpt"
  | "claude"
  | "gemini"
  | "kimi"
  | "grok"
  | "deepseek"
  | "qwen"
  | "perplexity"
  | "custom";

export interface ChatWorkspaceProviderAdapter {
  providerId: ChatWorkspaceProviderId;
  /** Candidate selectors are intentionally isolated here so provider DOM churn
   * fails one adapter without leaking brittle selectors into core UI/runtime. */
  assistantMessageSelectors: readonly string[];
  /** Optional native action/footer regions near an assistant message. */
  actionHostSelectors: readonly string[];
  /** Optional selectors that signal a response is still streaming. */
  streamingSelectors: readonly string[];
}

const adapter = (
  providerId: ChatWorkspaceProviderId,
  assistantMessageSelectors: readonly string[],
  actionHostSelectors: readonly string[] = [],
  streamingSelectors: readonly string[] = [],
): ChatWorkspaceProviderAdapter => ({
  providerId,
  assistantMessageSelectors,
  actionHostSelectors,
  streamingSelectors,
});

/**
 * Selectors favor semantic/provider-owned attributes over generated classes.
 * They are fallbacks, not assumptions: consumers must feature-detect and hide
 * Polyth actions when no unique response block can be identified.
 */
export const CHAT_WORKSPACE_PROVIDER_ADAPTERS: Readonly<Record<ChatWorkspaceProviderId, ChatWorkspaceProviderAdapter>> = {
  chatgpt: adapter(
    "chatgpt",
    [
      '[data-message-author-role="assistant"]',
      'article[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
    ],
    ['[data-message-author-role="assistant"] [data-testid*="copy"]', 'article [data-testid*="copy"]'],
    ['[data-message-author-role="assistant"] [data-testid*="stop"]'],
  ),
  claude: adapter(
    "claude",
    [
      '[data-is-streaming][data-testid*="assistant"]',
      '[data-testid*="assistant-message"]',
      'div.font-claude-response',
    ],
    ['[data-testid*="message-actions"]'],
    ['[data-is-streaming="true"]'],
  ),
  gemini: adapter(
    "gemini",
    ['model-response', 'message-content[data-message-author="model"]'],
    ['model-response [aria-label*="Copy"]', 'model-response [data-test-id*="actions"]'],
    ['model-response [aria-label*="Stop"]'],
  ),
  kimi: adapter("kimi", ['[data-role="assistant"]', '[data-testid*="assistant"]']),
  grok: adapter("grok", ['[data-role="assistant"]', '[data-testid*="assistant"]']),
  deepseek: adapter("deepseek", ['[data-role="assistant"]', '[data-testid*="assistant"]']),
  qwen: adapter("qwen", ['[data-role="assistant"]', '[data-testid*="assistant"]']),
  perplexity: adapter("perplexity", ['[data-role="assistant"]', '[data-testid*="answer"]']),
  custom: adapter("custom", []),
};

export function providerAdapter(id: string): ChatWorkspaceProviderAdapter | null {
  return CHAT_WORKSPACE_PROVIDER_ADAPTERS[id as ChatWorkspaceProviderId] ?? null;
}

export interface ExternalChatHandoff {
  sourceKind: "external-llm-chat";
  providerId: string;
  providerName: string;
  profileId: string;
  tabId: string;
  projectId: string;
  url?: string;
  title?: string;
  scope: "selection" | "response" | "latest-response";
  text: string;
  capturedAt: number;
}

export function normalizeExternalChatText(raw: string, maxChars = 120_000): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, maxChars);
}

/** Keep useful provenance without leaking provider auth/tracking query params or fragments. */
export function sanitizeExternalChatUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

export function buildExternalChatHandoff(input: Omit<ExternalChatHandoff, "sourceKind" | "text" | "capturedAt" | "url"> & {
  text: string;
  url?: string;
  capturedAt?: number;
}): ExternalChatHandoff {
  const { url: rawUrl, capturedAt, text, ...rest } = input;
  const url = sanitizeExternalChatUrl(rawUrl);
  return {
    ...rest,
    ...(url ? { url } : {}),
    sourceKind: "external-llm-chat",
    text: normalizeExternalChatText(text),
    capturedAt: capturedAt ?? Date.now(),
  };
}
