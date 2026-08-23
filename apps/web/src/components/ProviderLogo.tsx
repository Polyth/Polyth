const MARKS: Record<string, string> = {
  anthropic: "AI",
  claude: "AI",
  openai: "◉",
  google: "G",
  gemini: "✦",
  github: "GH",
  copilot: "GH",
  xai: "x",
  groq: "GQ",
  mistral: "M",
  openrouter: "OR",
};

export default function ProviderLogo({
  providerID,
  providerName,
  className = "",
}: {
  providerID?: string;
  providerName?: string;
  className?: string;
}) {
  const id = (providerID || providerName || "polyth").toLowerCase();
  const key = Object.keys(MARKS).find((candidate) => id.includes(candidate));
  const mark = key ? MARKS[key] : (providerName || providerID || "P").slice(0, 2).toUpperCase();
  const label = providerName || providerID || "Polyth";
  return (
    <span
      className={`provider-logo provider-${key ?? "other"}${className ? ` ${className}` : ""}`}
      role="img"
      aria-label={`${label} provider`}
      title={label}
    >{mark}</span>
  );
}
