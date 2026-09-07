import type { NormalizedAuthField, ProviderAuthPrompt } from "@polyth/contracts";

export type PromptValues = Record<string, string>;

export const promptVisible = (
  prompt: { when?: { key: string; op: "eq" | "neq"; value: string } },
  values: PromptValues,
): boolean => {
  if (!prompt.when) return true;
  const actual = values[prompt.when.key] ?? "";
  return prompt.when.op === "eq" ? actual === prompt.when.value : actual !== prompt.when.value;
};

export const visiblePrompts = <T extends { when?: { key: string; op: "eq" | "neq"; value: string } }>(
  prompts: readonly T[] | undefined,
  values: PromptValues,
): T[] => (prompts ?? []).filter((prompt) => promptVisible(prompt, values));

/** Drop answers for hidden conditional fields so stale values are not submitted. */
export const pruneHiddenValues = (
  fields: readonly NormalizedAuthField[] | readonly ProviderAuthPrompt[],
  values: PromptValues,
): PromptValues => {
  const next: PromptValues = {};
  for (const field of fields) {
    if (!promptVisible(field, values)) continue;
    const value = values[field.key];
    if (value !== undefined) next[field.key] = value;
  }
  return next;
};

export const secretFieldKeys = (fields: readonly NormalizedAuthField[]): string[] =>
  fields.filter((field) => field.secret || field.kind === "secret").map((field) => field.key);

export const clearSecretValues = (
  fields: readonly NormalizedAuthField[],
  values: PromptValues,
): PromptValues => {
  const secrets = new Set(secretFieldKeys(fields));
  const next: PromptValues = {};
  for (const [key, value] of Object.entries(values)) {
    if (!secrets.has(key)) next[key] = value;
  }
  return next;
};

const SECRET_KEY = /(secret|password|token|passwd|credential|api[_-]?key|(^|[_-])key$)/i;
const URL_KEY = /(url|uri|endpoint|origin|host|base[_-]?url)/i;
const EMAIL_KEY = /email/i;
const OTP_KEY = /(otp|one[_-]?time|verification[_-]?code|mfa|totp)/i;

export const inferFieldKind = (input: {
  type?: string;
  key: string;
  message?: string;
  placeholder?: string;
}): NormalizedAuthField["kind"] => {
  if (input.type === "select") return "select";
  if (input.type === "boolean") return "boolean";
  const key = input.key;
  const prose = `${input.message ?? ""} ${input.placeholder ?? ""}`;
  if (OTP_KEY.test(key) || OTP_KEY.test(prose)) return "otp";
  if (EMAIL_KEY.test(key) || EMAIL_KEY.test(prose)) return "email";
  if (URL_KEY.test(key) || URL_KEY.test(prose)) return "url";
  if (SECRET_KEY.test(key) || SECRET_KEY.test(prose) || key.toLowerCase() === "key") return "secret";
  return "text";
};

export const normalizePromptField = (prompt: ProviderAuthPrompt): NormalizedAuthField => {
  const kind = inferFieldKind(prompt);
  return {
    key: prompt.key,
    kind,
    label: prompt.message,
    ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
    ...(prompt.options ? { options: prompt.options } : {}),
    ...(prompt.when ? { when: prompt.when } : {}),
    secret: kind === "secret",
    ...(kind === "otp" ? { autocomplete: "one-time-code" } : {}),
    ...(kind === "email" ? { autocomplete: "email" } : {}),
    ...(kind === "url" ? { autocomplete: "url" } : {}),
    ...(kind === "secret" ? { autocomplete: "off" } : {}),
  };
};

/** First declared option — mirrors typical CLI select defaults. */
export const defaultSelectValue = (field: NormalizedAuthField): string | undefined =>
  field.kind === "select" ? field.options?.[0]?.value : undefined;

export const withSelectDefaults = (
  fields: readonly NormalizedAuthField[],
  values: PromptValues,
): PromptValues => {
  const next = { ...values };
  for (const field of fields) {
    if (field.kind !== "select") continue;
    if (!promptVisible(field, next)) continue;
    if ((next[field.key] ?? "") !== "") continue;
    const fallback = defaultSelectValue(field);
    if (fallback !== undefined) next[field.key] = fallback;
  }
  return next;
};

/** Visible text/secret/url/email/otp must be non-empty. Hidden fields are ignored. */
export const firstIncompleteField = (
  fields: readonly NormalizedAuthField[],
  values: PromptValues,
): string | undefined => {
  const resolved = withSelectDefaults(fields, values);
  for (const field of fields) {
    if (!promptVisible(field, resolved)) continue;
    if (field.kind === "boolean") continue;
    if (field.kind === "select") {
      const value = resolved[field.key] ?? "";
      if (!value || !(field.options ?? []).some((option) => option.value === value)) return field.key;
      continue;
    }
    if (!(resolved[field.key] ?? "").trim()) return field.key;
  }
};
