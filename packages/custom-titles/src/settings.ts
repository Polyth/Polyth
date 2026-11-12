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

/** How titles read: the part of the settings a project may set for itself. */
export interface CustomTitleRules {
  /** "auto" follows the user's prompt language; any other value is an explicit language instruction. */
  language: string;
  style: string;
  rules: string;
}

export interface CustomTitleSettings extends CustomTitleRules {
  mode: CustomTitleMode;
  generator: CustomTitleGenerator;
  /** Projects with their own language, style and rules, keyed by project id.
   * Such a project uses them in place of the shared ones above; every other
   * project uses the shared ones. Mode and generator are always shared. */
  projectRules: Record<string, CustomTitleRules>;
}

/** Bounds the document a Space can grow; far above any real project count. */
export const CUSTOM_TITLE_PROJECT_RULES_MAX = 500;

export const DEFAULT_CUSTOM_TITLE_SETTINGS: Readonly<CustomTitleSettings> = Object.freeze({
  mode: "fallback",
  generator: Object.freeze({ kind: "opencode-free" }),
  language: "auto",
  style: "Concise and specific, usually 3–7 words",
  rules: "",
  projectRules: Object.freeze({}) as Record<string, CustomTitleRules>,
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

const parseRules = (input: Record<string, unknown>, label = ""): CustomTitleRules => ({
  language: boundedText(input.language, `${label}language`, 64, "auto"),
  style: boundedText(input.style, `${label}style`, 240, DEFAULT_CUSTOM_TITLE_SETTINGS.style),
  rules: boundedText(input.rules, `${label}rules`, 2_000),
});

const parseProjectRules = (value: unknown): Record<string, CustomTitleRules> => {
  // Settings saved before projects could have their own rules have none.
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("projectRules must be an object");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > CUSTOM_TITLE_PROJECT_RULES_MAX) {
    return invalid(`projectRules may name at most ${CUSTOM_TITLE_PROJECT_RULES_MAX} projects`);
  }
  // A null-prototype map: a project id is data, never an object key with meaning.
  const parsed = Object.create(null) as Record<string, CustomTitleRules>;
  for (const [projectId, rules] of entries) {
    const id = identifier(projectId, "projectRules project id");
    if (id !== projectId) return invalid("projectRules project id is malformed");
    if (!rules || typeof rules !== "object" || Array.isArray(rules)) return invalid(`projectRules.${id} must be an object`);
    parsed[id] = parseRules(rules as Record<string, unknown>, `projectRules.${id}.`);
  }
  return parsed;
};

/** The language, style and rules that name a session in this project. */
export function customTitleRulesFor(settings: CustomTitleSettings, projectId: string | undefined): CustomTitleRules {
  const own = projectId !== undefined && Object.hasOwn(settings.projectRules, projectId)
    ? settings.projectRules[projectId]
    : undefined;
  const source = own ?? settings;
  return { language: source.language, style: source.style, rules: source.rules };
}

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
    ...parseRules(input),
    projectRules: parseProjectRules(input.projectRules),
  };
}

const rulesEqual = (left: CustomTitleRules, right: CustomTitleRules): boolean =>
  left.language === right.language && left.style === right.style && left.rules === right.rules;

export function customTitleSettingsEqual(left: CustomTitleSettings, right: CustomTitleSettings): boolean {
  const leftProjects = Object.keys(left.projectRules);
  return left.mode === right.mode
    && rulesEqual(left, right)
    && leftProjects.length === Object.keys(right.projectRules).length
    && leftProjects.every((id) => Object.hasOwn(right.projectRules, id)
      && rulesEqual(left.projectRules[id]!, right.projectRules[id]!))
    && left.generator.kind === right.generator.kind
    && (left.generator.kind !== "custom" || (
      right.generator.kind === "custom"
      && left.generator.harnessId === right.generator.harnessId
      && left.generator.providerID === right.generator.providerID
      && left.generator.modelID === right.generator.modelID
    ));
}
