const PROVIDERS = [
  ["opencode-go", ["opencode-go", "opencode go"]],
  ["opencode-zen", ["opencode-zen", "opencode zen"]],
  ["opencode", ["opencode"]],
  ["openrouter", ["openrouter"]],
  ["anthropic", ["anthropic", "claude"]],
  ["azure", ["azure"]],
  ["openai", ["openai", "chatgpt", "gpt"]],
  ["vertex", ["vertex"]],
  ["gemini", ["gemini", "google"]],
  ["copilot", ["copilot", "github"]],
  ["xai", ["xai", "grok"]],
  ["groq", ["groq"]],
  ["mistral", ["mistral"]],
  ["llama", ["llama", "meta"]],
  ["bedrock", ["bedrock", "amazon", "aws"]],
  ["together", ["together"]],
  ["fireworks", ["fireworks"]],
  ["deepseek", ["deepseek"]],
  ["ollama", ["ollama"]],
  ["nvidia", ["nvidia"]],
  ["huggingface", ["huggingface", "hugging face"]],
  ["cohere", ["cohere"]],
  ["perplexity", ["perplexity"]],
] as const;

type ProviderKey = (typeof PROVIDERS)[number][0];

const strokeProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: "false" as const,
};

function findProviderKey(value: string): ProviderKey | undefined {
  return PROVIDERS.find(([, aliases]) => aliases.some((alias) => value.includes(alias)))?.[0];
}

function SvgMark({ provider }: { provider: ProviderKey }) {
  if (provider === "opencode-zen") {
    return (
      <svg {...strokeProps} strokeWidth="1.9">
        <path d="M18.2 6.3A8 8 0 1 0 20 14.5" />
        <path d="M8 16.6c1.2-1.7 2.5-2.5 4-2.5s2.8.8 4 2.5M9.5 18.8h5" />
      </svg>
    );
  }
  if (provider === "opencode-go") {
    return (
      <svg {...strokeProps} strokeWidth="2">
        <path d="m4 6.5 6.5 5.5L4 17.5M11 6.5l6.5 5.5-6.5 5.5M20 6.5v11" />
      </svg>
    );
  }
  if (provider === "opencode") {
    return (
      <svg {...strokeProps} strokeWidth="2">
        <path d="m9 5-5.5 7L9 19M15 5l5.5 7-5.5 7M13.5 3.5l-3 17" />
      </svg>
    );
  }
  if (provider === "anthropic") {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
        <path d="M3.7 19 10 4.8h4L20.3 19h-3.5l-1.4-3.5H8.6L7.2 19H3.7Zm6-6.4h4.6L12 7l-2.3 5.6Z" />
      </svg>
    );
  }
  if (provider === "openai") {
    return (
      <svg {...strokeProps}>
        <ellipse cx="12" cy="8" rx="3.2" ry="4.8" />
        <ellipse cx="12" cy="8" rx="3.2" ry="4.8" transform="rotate(60 12 12)" />
        <ellipse cx="12" cy="8" rx="3.2" ry="4.8" transform="rotate(120 12 12)" />
        <circle cx="12" cy="12" r="2.25" />
      </svg>
    );
  }
  if (provider === "gemini") {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
        <path d="M12 2.8c.65 5.15 4.05 8.55 9.2 9.2-5.15.65-8.55 4.05-9.2 9.2-.65-5.15-4.05-8.55-9.2-9.2 5.15-.65 8.55-4.05 9.2-9.2Z" />
      </svg>
    );
  }
  if (provider === "copilot") {
    return (
      <svg {...strokeProps}>
        <path d="M5.2 9 7 5.1l3 2.1h4l3-2.1L18.8 9v6.1c0 2.7-2.8 4.5-6.8 4.5s-6.8-1.8-6.8-4.5V9Z" />
        <path d="M5.4 10.2c2.5-1.1 4.6-1.6 6.6-1.6s4.1.5 6.6 1.6M8.8 13.1h.1m6.2 0h.1M9.2 16.2c1.8.8 3.8.8 5.6 0" />
      </svg>
    );
  }
  if (provider === "xai") {
    return (
      <svg {...strokeProps} strokeWidth="2.2">
        <path d="m4.5 4.5 15 15M18.9 4.5 4.5 18.9M15.4 4.5h3.5v3.5" />
      </svg>
    );
  }
  if (provider === "groq") {
    return (
      <svg {...strokeProps} strokeWidth="2.3">
        <path d="M18.2 7.1A7.6 7.6 0 1 0 19.6 14H13v-3.8h7.2" />
        <circle cx="12" cy="12" r="2.1" />
      </svg>
    );
  }
  if (provider === "mistral") {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
        <path d="M3 4h4v3h2v3h2V7h2v3h2V7h2V4h4v16h-5v-6h-2v3h-4v-3H8v6H3V4Z" />
      </svg>
    );
  }
  if (provider === "openrouter") {
    return (
      <svg {...strokeProps}>
        <path d="M3 7h11.2a4 4 0 0 1 4 4v.8M15.2 4 19 7.1l-3.8 3.1M21 17H9.8a4 4 0 0 1-4-4v-.8M8.8 20 5 16.9l3.8-3.1" />
      </svg>
    );
  }
  if (provider === "vertex") {
    return (
      <svg {...strokeProps}>
        <path d="M12 3 3.8 18.7h16.4L12 3Z" />
        <path d="m12 3 2.6 10.7 5.6 5M12 3 9.4 13.7l-5.6 5M9.4 13.7h5.2" />
      </svg>
    );
  }
  if (provider === "llama") {
    return (
      <svg {...strokeProps} strokeWidth="2">
        <path d="M3.2 13.5c1.5-5 4-7.5 7-7.5 4.6 0 4.5 7.7 7.7 7.7 1.5 0 2.4-1 2.9-2.2M20.8 10.5c-1.5 5-4 7.5-7 7.5-4.6 0-4.5-7.7-7.7-7.7-1.5 0-2.4 1-2.9 2.2" />
      </svg>
    );
  }
  if (provider === "bedrock") {
    return (
      <svg {...strokeProps}>
        <path d="m12 3 7 3.8v7.9L12 21l-7-6.3V6.8L12 3Z" />
        <path d="m5 6.8 7 4 7-4M12 10.8V21M7.8 14.5l4.2 2.4 4.2-2.4" />
      </svg>
    );
  }
  if (provider === "azure") {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
        <path d="M10.1 3h6.2L9.9 18.6 3.5 17l6.6-14Zm1.1 13.1 3.1-7.6L21 20H8.3l2.9-3.9Z" />
      </svg>
    );
  }
  if (provider === "together") {
    return (
      <svg {...strokeProps}>
        <circle cx="9" cy="9" r="4.5" />
        <circle cx="15" cy="9" r="4.5" />
        <circle cx="12" cy="15" r="4.5" />
      </svg>
    );
  }
  if (provider === "fireworks") {
    return (
      <svg {...strokeProps}>
        <path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5M5.3 5.3l3.5 3.5M15.2 15.2l3.5 3.5M18.7 5.3l-3.5 3.5M8.8 15.2l-3.5 3.5" />
        <circle cx="12" cy="12" r="2.5" />
      </svg>
    );
  }
  if (provider === "deepseek") {
    return (
      <svg {...strokeProps}>
        <path d="M3 14.2c3.2 2.2 6.1 2.4 8.8.7 2.4-1.5 3.7-4.5 7.8-4.2-.7 5.4-4.1 8.3-9.3 8.3-3.5 0-6-1.6-7.3-4.8Z" />
        <path d="M7.2 14.3c-.1-4.5 2-7.6 6.2-9.3-.4 2.2.1 4 1.5 5.4M16.2 13.8h.1" />
      </svg>
    );
  }
  if (provider === "ollama") {
    return (
      <svg {...strokeProps}>
        <path d="M8 8V5.2C8 3.7 9 3 10.1 3c1.2 0 1.9.9 1.9 2.2V8m0 0V5.2C12 3.7 13 3 14.1 3 15.3 3 16 3.9 16 5.2V8" />
        <path d="M6.5 10.5C6.5 8.8 8 8 12 8s5.5.8 5.5 2.5V19H6.5v-8.5ZM9.5 12h.1m4.8 0h.1M9.5 15.3c1.7.7 3.3.7 5 0" />
      </svg>
    );
  }
  if (provider === "nvidia") {
    return (
      <svg {...strokeProps}>
        <path d="M3 12c2.4-3.3 5.5-5 9.2-5 3.4 0 6.4 1.5 8.8 4.5-2.2 3.6-5.2 5.5-9 5.5-3.7 0-6.7-1.7-9-5Z" />
        <path d="M7.2 12a5 5 0 0 1 8.9-3.1 3.7 3.7 0 1 1-6.7 2.2 2.4 2.4 0 1 1 4.4 1.8" />
      </svg>
    );
  }
  if (provider === "huggingface") {
    return (
      <svg {...strokeProps}>
        <circle cx="12" cy="12" r="7" />
        <path d="M9.3 10h.1m5.2 0h.1M8.8 14c1.8 2 4.6 2.3 6.4 0M5.5 6.5 3.2 4.2M18.5 6.5l2.3-2.3M5 17l-2.6 2M19 17l2.6 2" />
      </svg>
    );
  }
  if (provider === "cohere") {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
        <circle cx="8.2" cy="8.2" r="5.2" />
        <circle cx="17.7" cy="7.7" r="3.3" />
        <circle cx="16.4" cy="17" r="4" />
        <circle cx="7" cy="17.6" r="2.7" />
      </svg>
    );
  }
  if (provider === "perplexity") {
    return (
      <svg {...strokeProps}>
        <path d="M7 3v18M17 3v18M3 8h18M3 16h18M7 8l10 8M17 8 7 16M12 3v18" />
      </svg>
    );
  }
  return null;
}

export default function ProviderLogo({
  providerID,
  providerName,
  className = "",
}: {
  providerID?: string;
  providerName?: string;
  className?: string;
}) {
  const id = `${providerID ?? ""} ${providerName ?? ""}`.trim().toLowerCase() || "polyth";
  const key = findProviderKey(id);
  const fallback = (providerName || providerID || "P").trim().slice(0, 2).toUpperCase();
  const label = providerName || providerID || "Polyth";
  return (
    <span
      className={`provider-logo provider-${key ?? "other"}${className ? ` ${className}` : ""}`}
      data-provider={key ?? "other"}
      role="img"
      aria-label={`${label} provider`}
      title={label}
    >
      {key ? <SvgMark provider={key} /> : <span className="provider-logo-fallback">{fallback}</span>}
    </span>
  );
}
