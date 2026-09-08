import type { ChatProviderDto } from "@polyth/contracts";

const AUTH_ORIGINS = [
  "https://accounts.google.com",
  "https://appleid.apple.com",
  "https://login.microsoftonline.com",
  "https://github.com",
];

export const CHAT_PROVIDERS: ChatProviderDto[] = [
  { id: "chatgpt", name: "ChatGPT", homeUrl: "https://chatgpt.com", allowedOrigins: ["https://chatgpt.com", "https://auth.openai.com", "https://auth0.openai.com", "https://openai.com", ...AUTH_ORIGINS] },
  { id: "claude", name: "Claude", homeUrl: "https://claude.ai", allowedOrigins: ["https://claude.ai", "https://anthropic.com", "https://console.anthropic.com", ...AUTH_ORIGINS] },
  { id: "gemini", name: "Gemini", homeUrl: "https://gemini.google.com", allowedOrigins: ["https://gemini.google.com", "https://google.com", "https://accounts.youtube.com", ...AUTH_ORIGINS] },
  { id: "kimi", name: "Kimi", homeUrl: "https://www.kimi.com", allowedOrigins: ["https://www.kimi.com", "https://moonshot.cn", "https://kimi.moonshot.cn", ...AUTH_ORIGINS] },
  { id: "grok", name: "Grok", homeUrl: "https://grok.com", allowedOrigins: ["https://grok.com", "https://accounts.x.ai", "https://x.ai", "https://x.com", ...AUTH_ORIGINS] },
  { id: "deepseek", name: "DeepSeek", homeUrl: "https://chat.deepseek.com", allowedOrigins: ["https://chat.deepseek.com", "https://deepseek.com", ...AUTH_ORIGINS] },
  { id: "qwen", name: "Qwen", homeUrl: "https://chat.qwen.ai", allowedOrigins: ["https://chat.qwen.ai", "https://qwen.ai", "https://alibaba.com", "https://aliyun.com", ...AUTH_ORIGINS] },
  { id: "perplexity", name: "Perplexity", homeUrl: "https://www.perplexity.ai", allowedOrigins: ["https://www.perplexity.ai", "https://perplexity.ai", ...AUTH_ORIGINS] },
  { id: "custom", name: "Custom chat", homeUrl: "about:blank", allowedOrigins: [] },
];

export function providerById(id: string): ChatProviderDto | undefined {
  return CHAT_PROVIDERS.find((p) => p.id === id);
}
