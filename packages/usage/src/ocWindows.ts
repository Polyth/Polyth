import type { QuotaWindow } from "@polyth/contracts";
import { numberValue, objectValue, timestampValue } from "./opencodeAuth.ts";

export interface polythWindow extends Record<string, unknown> {
  usedPercent?: number | null;
  windowSeconds?: number | null;
  resetAt?: number | string | null;
  valueLabel?: string;
  used?: number;
  limit?: number;
  unit?: QuotaWindow["unit"];
}

export interface polythUsage {
  windows?: Record<string, polythWindow>;
  models?: Record<string, { windows?: Record<string, polythWindow> }>;
}

const titleWords = (value: string): string =>
  value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

const windowLabel = (key: string): string => {
  if (/^\d+(?:\.\d+)?[mhd]$/i.test(key)) return key.toLowerCase();
  if (key === "extra_usage") return "Extra usage";
  if (key === "credits_balance") return "Credits balance";
  if (key === "billing_cycle") return "Billing cycle";
  return titleWords(key);
};

const modelId = (name: string): string =>
  name.trim().toLowerCase().replace(/\s+/g, "-");

const moneyNumbers = (label: string): number[] =>
  [...label.matchAll(/(?:[$€£¥]|[A-Z]{3}\s*)?(-?\d+(?:,\d{3})*(?:\.\d+)?)/g)]
    .map((match) => Number(match[1]!.replaceAll(",", "")))
    .filter(Number.isFinite);

const moneyFromLabel = (label: string): { used: number; limit: number } | null => {
  const values = moneyNumbers(label);
  if (values.length >= 2 && /\bleft\b.*\bspent\b/i.test(label)) {
    return { used: values[1]!, limit: values[0]! + values[1]! };
  }
  if (values.length >= 2 && /\bremaining\s+of\b/i.test(label)) {
    return { used: Math.max(0, values[1]! - values[0]!), limit: values[1]! };
  }
  if (values.length >= 2) return { used: values[0]!, limit: values[1]! };
  if (values.length === 1) return { used: 0, limit: values[0]! };
  return null;
};

const mapOne = (
  id: string,
  label: string,
  value: polythWindow,
): QuotaWindow | null => {
  const explicitUsed = numberValue(value.used);
  const explicitLimit = numberValue(value.limit);
  const valueLabel = typeof value.valueLabel === "string" && value.valueLabel.trim()
    ? value.valueLabel.trim()
    : null;
  const hasCurrencyLabel = Boolean(valueLabel && /[$€£¥]|\b[A-Z]{3}\b/.test(valueLabel));
  const currency = value.unit === "currency" || hasCurrencyLabel
    ? (explicitUsed !== null && explicitLimit !== null
      ? { used: explicitUsed, limit: explicitLimit }
      : valueLabel ? moneyFromLabel(valueLabel) : null)
    : null;
  const usedPercent = numberValue(value.usedPercent);
  let used: number;
  let limit: number;
  let unit: QuotaWindow["unit"];
  if (currency) {
    ({ used, limit } = currency);
    unit = "currency";
  } else if (usedPercent !== null) {
    used = Math.max(0, usedPercent);
    limit = 100;
    unit = "percent";
  } else if (explicitUsed !== null && explicitLimit !== null) {
    used = Math.max(0, explicitUsed);
    limit = explicitLimit;
    unit = value.unit ?? "requests";
  } else if (valueLabel && /[$€£¥]|\b[A-Z]{3}\b/.test(valueLabel)) {
    const parsed = moneyFromLabel(valueLabel);
    if (!parsed) return null;
    ({ used, limit } = parsed);
    unit = "currency";
  } else {
    // The source supplied a textual status but no measurable denominator.
    // Keep it visible without inventing a percentage.
    used = 0;
    limit = 0;
    unit = value.unit ?? "requests";
  }
  if (![used, limit].every(Number.isFinite) || used < 0 || limit < 0) return null;
  const resetAt = timestampValue(value.resetAt);
  const windowSeconds = numberValue(value.windowSeconds);
  return {
    id,
    label: valueLabel ? `${label} · ${valueLabel}` : label,
    used,
    limit,
    unit,
    ...(resetAt !== null ? { resetsAt: resetAt } : {}),
    ...(windowSeconds !== null && windowSeconds > 0 ? { periodMs: windowSeconds * 1000 } : {}),
  };
};

export const mappolythUsage = (usage: unknown): QuotaWindow[] => {
  const root = objectValue(usage);
  if (!root) return [];
  const out: QuotaWindow[] = [];
  const windows = objectValue(root.windows) ?? {};
  for (const [key, raw] of Object.entries(windows)) {
    const value = objectValue(raw) as polythWindow | null;
    if (!value) continue;
    const mapped = mapOne(key, windowLabel(key), value);
    if (mapped) out.push(mapped);
  }
  const models = objectValue(root.models) ?? {};
  for (const [name, rawModel] of Object.entries(models)) {
    const model = objectValue(rawModel);
    const scopedWindows = objectValue(model?.windows) ?? {};
    for (const [key, raw] of Object.entries(scopedWindows)) {
      const value = objectValue(raw) as polythWindow | null;
      if (!value) continue;
      const id = `${modelId(name)}/${key}`;
      const mapped = mapOne(id, `${titleWords(name)} ${windowLabel(key)}`, value);
      if (mapped) out.push(mapped);
    }
  }
  return out;
};

export const ocWindow = (input: polythWindow): polythWindow => input;
