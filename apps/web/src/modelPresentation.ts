import type { ModelDescriptor, ModelRef } from "@polyth/contracts";

export interface RuntimeModelPresentation {
  descriptor?: ModelDescriptor;
  name: string;
}

const TOKEN_CASE: Readonly<Record<string, string>> = {
  gpt: "GPT",
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  grok: "Grok",
  qwen: "Qwen",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  glm: "GLM",
  minimax: "MiniMax",
  llama: "Llama",
  mistral: "Mistral",
  devstral: "Devstral",
  command: "Command",
  cohere: "Cohere",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  flash: "Flash",
  pro: "Pro",
  max: "Max",
  mini: "Mini",
  nano: "Nano",
  turbo: "Turbo",
  preview: "Preview",
  latest: "Latest",
  thinking: "Thinking",
  coder: "Coder",
  instruct: "Instruct",
  chat: "Chat",
  oss: "OSS",
  vl: "VL",
  free: "Free",
  plus: "Plus",
};

function displayToken(token: string): string {
  const lower = token.toLowerCase();
  const known = TOKEN_CASE[lower];
  if (known) return known;

  const qwen = /^qwen(.+)$/i.exec(token);
  if (qwen) return `Qwen${qwen[1]}`;
  const deepseek = /^deepseek(.+)$/i.exec(token);
  if (deepseek) return `DeepSeek${deepseek[1]}`;
  const minimax = /^minimax(.+)$/i.exec(token);
  if (minimax) return `MiniMax${minimax[1]}`;

  if (/^o\d/i.test(token)) return `o${token.slice(1)}`;
  if (/^[vrmk]\d/i.test(token)) return `${token[0]!.toUpperCase()}${token.slice(1)}`;
  if (/^\d+(?:\.\d+)*(?:[bmk])$/i.test(token)) {
    return `${token.slice(0, -1)}${token.at(-1)!.toUpperCase()}`;
  }
  if (/^\d+(?:\.\d+)*$/.test(token)) return token;
  if (/^[A-Z0-9]+$/.test(token) && /[A-Z]/.test(token)) return token;
  return lower ? `${lower[0]!.toUpperCase()}${lower.slice(1)}` : token;
}

/** Runtime IDs are transport details, not interface copy. Keep the fallback
 * conservative: drop provider paths and release-date suffixes, normalize
 * semantic-version separators, then title known model-family tokens. */
export function friendlyModelId(modelID: string): string {
  let value = modelID.trim().split("/").filter(Boolean).at(-1) ?? "";
  if (!value || /^(?:auto|default)$/i.test(value)) return "Auto";

  value = value
    .replace(/[-_.]20\d{6}$/i, "")
    .replace(/[-_.]20\d{2}[-_.]\d{2}[-_.]\d{2}$/i, "")
    .replace(/[-_.]\d{2}[-_.]\d{2}$/i, "")
    .replace(/:/g, "-")
    .replace(/(\d)-(\d)(?=(?:[-_]|$))/g, "$1.$2");

  const words = value.split(/[-_]+/).filter(Boolean).map(displayToken);
  return words.join(" ") || "Auto";
}

function isTechnicalModelName(model: Pick<ModelDescriptor, "providerID" | "modelID" | "name">): boolean {
  const rawName = model.name?.trim().toLowerCase() ?? "";
  return !rawName
    || rawName === model.modelID.toLowerCase()
    || rawName === `${model.providerID}/${model.modelID}`.toLowerCase();
}

/** Normalize only adapter-shaped labels. Provider-authored display names are
 * preserved verbatim; raw ids become concise names once at the presentation
 * boundary so every harness-backed chat surface speaks the same vocabulary. */
export function normalizeModelDescriptor(model: ModelDescriptor): ModelDescriptor {
  if (!isTechnicalModelName(model)) return model;
  const name = friendlyModelId(model.modelID);
  return name === model.name ? model : { ...model, name };
}

/** Resolve the harness-qualified catalog row first, then a generic row, then
 * any matching runtime row. A genuine catalog display name always wins; an
 * adapter that only echoes an ID gets the friendly fallback instead. */
export function resolveModelPresentation(
  model: ModelRef | null | undefined,
  catalog: readonly ModelDescriptor[],
  harnessId?: string,
): RuntimeModelPresentation {
  if (!model) return { name: "Auto" };

  const matches = catalog.filter((candidate) =>
    candidate.providerID === model.providerID && candidate.modelID === model.modelID);
  const rawDescriptor = (harnessId
    ? matches.find((candidate) => candidate.harnessId === harnessId)
    : undefined)
    ?? matches.find((candidate) => !candidate.harnessId)
    ?? matches[0];
  const descriptor = rawDescriptor ? normalizeModelDescriptor(rawDescriptor) : undefined;

  return {
    ...(descriptor ? { descriptor } : {}),
    name: descriptor?.name ?? friendlyModelId(model.modelID),
  };
}
