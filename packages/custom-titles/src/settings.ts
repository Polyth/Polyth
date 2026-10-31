export const CUSTOM_TITLES_PACKAGE_ID = "custom-titles";
export const CUSTOM_TITLES_SETTINGS_VERSION = 1;
export const CUSTOM_TITLE_FALLBACK_DELAY_MS = 5_000;

export type CustomTitleMode = "fallback" | "always";

export type CustomTitleGenerator =
  | { kind: "opencode-free" }
  | {
      kind: "custom";
      harnessId: string;
      providerID: string;
      modelID: string;
    };

export interface CustomTitleSettings {
  mode: CustomTitleMode;
  generator: CustomTitleGenerator;
  /** "auto" follows the user's prompt language; any other value is an explicit language instruction. */
  language: string;
  style: string;
  rules: string;
}

export const DEFAULT_CUSTOM_TITLE_SETTINGS: Readonly<CustomTitleSettings> = Object.freeze({
  mode: "fallback",
  generator: Object.freeze({ kind: "opencode-free" }),
  language: "auto",
  style: "Concise and specific, usually 3–7 words",
  rules: "",
});

const invalid = (message: string): never => {
  throw Object.assign(new Error(message), { code: "invalid-input" });
};

const boundedText = (value: unknown, label: string, max: number, fallback = ""): string => {
  if (typeof value !== "string") return invalid(`${label} must be a string`);
  const normalized = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim();
  if (normalized.length > max) return invalid(`${label} must be at most ${max} characters`);
  return normalized || fallback;
};

const identifier = (value: unknown, label: string): string => {
  const text = boundedText(value, label, 256);
  if (!text) return invalid(`${label} is required`);
  return text;
};

export function parseCustomTitleSettings(value: unknown): CustomTitleSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("settings must be an object");
  const input = value as Record<string, unknown>;
  if (input.mode !== "fallback" && input.mode !== "always") {
    return invalid("mode must be fallback or always");
  }
  if (!input.generator || typeof input.generator !== "object" || Array.isArray(input.generator)) {
    return invalid("generator must be an object");
  }
  const generator = input.generator as Record<string, unknown>;
  let parsedGenerator: CustomTitleGenerator;
  if (generator.kind === "opencode-free") {
    parsedGenerator = { kind: "opencode-free" };
  } else if (generator.kind === "custom") {
    parsedGenerator = {
      kind: "custom",
      harnessId: identifier(generator.harnessId, "generator.harnessId"),
      providerID: identifier(generator.providerID, "generator.providerID"),
      modelID: identifier(generator.modelID, "generator.modelID"),
    };
  } else {
    return invalid("generator.kind must be opencode-free or custom");
  }
  return {
    mode: input.mode,
    generator: parsedGenerator,
    language: boundedText(input.language, "language", 64, "auto"),
    style: boundedText(input.style, "style", 240, DEFAULT_CUSTOM_TITLE_SETTINGS.style),
    rules: boundedText(input.rules, "rules", 2_000),
  };
}

export function customTitleSettingsEqual(left: CustomTitleSettings, right: CustomTitleSettings): boolean {
  return left.mode === right.mode
    && left.language === right.language
    && left.style === right.style
    && left.rules === right.rules
    && left.generator.kind === right.generator.kind
    && (left.generator.kind !== "custom" || (
      right.generator.kind === "custom"
      && left.generator.harnessId === right.generator.harnessId
      && left.generator.providerID === right.generator.providerID
      && left.generator.modelID === right.generator.modelID
    ));
}
