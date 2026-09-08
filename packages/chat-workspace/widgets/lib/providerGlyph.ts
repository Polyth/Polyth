const PROVIDER_LABEL: Record<string, string> = {
  chatgpt: "G",
  claude: "C",
  gemini: "Ge",
  kimi: "K",
  grok: "X",
  deepseek: "D",
  qwen: "Q",
  perplexity: "P",
  custom: "•",
};

export function providerGlyph(id: string): string {
  return PROVIDER_LABEL[id] ?? id.slice(0, 2).toUpperCase();
}
