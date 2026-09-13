import type { ModelDescriptor, ModelRef } from "./index.ts";

export interface RuntimeModelPresentation {
  descriptor?: ModelDescriptor;
  name: string;
}

const WORD_CASE: Readonly<Record<string, string>> = {
  auto: "Auto",
  default: "Auto",
  claude: "Claude",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  gemini: "Gemini",
  pro: "Pro",
  flash: "Flash",
  codex: "Codex",
  max: "Max",
  mini: "Mini",
  nano: "Nano",
  turbo: "Turbo",
  grok: "Grok",
  coder: "Coder",
  instruct: "Instruct",
  thinking: "Thinking",
  preview: "Preview",
  latest: "Latest",
  free: "Free",
  chat: "Chat",
  llama: "Llama",
  mistral: "Mistral",
  devstral: "Devstral",
};

const technicalDateSuffix = (value: string): string => value
  .replace(/[-_.]20\d{6}$/i, "")
  .replace(/[-_.]20\d{2}[-_.]\d{2}[-_.]\d{2}$/i, "");

const titleToken = (token: string): string => {
  const lower = token.toLowerCase();
  if (WORD_CASE[lower]) return WORD_CASE[lower]!;
  if (/^o\d/i.test(token)) return `o${token.slice(1)}`;
  if (/^\d+(?:\.\d+)*(?:[bmk])$/i.test(token)) {
    return `${token.slice(0, -1)}${token.at(-1)!.toUpperCase()}`;
  }
  if (/^[A-Z0-9]+$/.test(token) && /[A-Z]/.test(token)) return token;
  return lower ? `${lower[0]!.toUpperCase()}${lower.slice(1)}` : token;
};

const joinNumericTail = (tokens: string[]): string[] => {
  const out: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (/^\d+$/.test(token)) {
      const parts = [token];
      let cursor = index + 1;
      while (cursor < tokens.length && /^\d+$/.test(tokens[cursor]!)) {
        parts.push(tokens[cursor]!);
        cursor += 1;
      }
      out.push(parts.join("."));
      index = cursor - 1;
      continue;
    }
    const prefixed = /^([vkm])([0-9]+)$/i.exec(token);
    if (prefixed && /^\d+$/.test(tokens[index + 1] ?? "")) {
      const parts = [prefixed[2]!];
      let cursor = index + 1;
      while (cursor < tokens.length && /^\d+$/.test(tokens[cursor]!)) {
        parts.push(tokens[cursor]!);
        cursor += 1;
      }
      out.push(`${prefixed[1]!.toUpperCase()}${parts.join(".")}`);
      index = cursor - 1;
      continue;
    }
    out.push(token);
  }
  return out;
};

/** Turn a transport id into conservative interface copy. This only formats
 * information already present in the id: provider paths and release-date
 * suffixes disappear, numeric version segments become dotted, and known
 * family casing is restored. It never invents capabilities or model aliases. */
export function friendlyModelId(modelID: string): string {
  let value = technicalDateSuffix(modelID.trim().split("/").filter(Boolean).at(-1) ?? "");
  if (!value || /^(?:auto|default)$/i.test(value)) return "Auto";
  value = value.replace(/:/g, "-");
  const raw = joinNumericTail(value.split(/[-_]+/).filter(Boolean));
  if (raw.length === 0) return "Auto";

  const first = raw[0]!.toLowerCase();
  if (first === "gpt") {
    const version = raw[1] ?? "";
    const tail = raw.slice(2).map(titleToken).join(" ");
    return [`GPT${version ? `-${version}` : ""}`, tail].filter(Boolean).join(" ");
  }
  if (/^gpt\d/i.test(raw[0]!)) {
    const family = raw[0]!.replace(/^gpt/i, "GPT-");
    return [family, ...raw.slice(1).map(titleToken)].join(" ");
  }
  if (first === "deepseek") return ["DeepSeek", ...raw.slice(1).map(titleToken)].join(" ");
  if (/^qwen\d/i.test(raw[0]!)) return [`Qwen${raw[0]!.slice(4)}`, ...raw.slice(1).map(titleToken)].join(" ");
  if (first === "qwen") return ["Qwen", ...raw.slice(1).map(titleToken)].join(" ");
  if (first === "minimax") return ["MiniMax", ...raw.slice(1).map(titleToken)].join(" ");
  if (first === "glm") return ["GLM", ...raw.slice(1).map(titleToken)].join(" ");
  if (first === "kimi") return ["Kimi", ...raw.slice(1).map(titleToken)].join(" ");

  return raw.map(titleToken).join(" ");
}

export function isTechnicalModelName(
  model: Pick<ModelDescriptor, "providerID" | "modelID" | "name">,
): boolean {
  const name = model.name?.trim().toLocaleLowerCase() ?? "";
  const id = model.modelID.trim().toLocaleLowerCase();
  return !name || name === id || name === `${model.providerID}/${model.modelID}`.toLocaleLowerCase();
}

/** Preserve a provider-authored display name; format only adapter-shaped ids. */
export function displayModelName(
  model: Pick<ModelDescriptor, "providerID" | "modelID" | "name">,
): string {
  return isTechnicalModelName(model) ? friendlyModelId(model.modelID) : model.name.trim();
}

/** Return a presentation-only descriptor without mutating the catalog. */
export function presentModelDescriptor(model: ModelDescriptor): ModelDescriptor {
  const name = displayModelName(model);
  return name === model.name ? model : { ...model, name };
}

/** Resolve the harness-qualified row first, then a generic row, then any
 * matching runtime row. The returned descriptor is a presentation copy only. */
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
  const descriptor = rawDescriptor ? presentModelDescriptor(rawDescriptor) : undefined;
  return {
    ...(descriptor ? { descriptor } : {}),
    name: descriptor?.name ?? friendlyModelId(model.modelID),
  };
}
