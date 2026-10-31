import type {
  JsonObject,
  OpenCodePluginEntryDto,
  OpenCodePluginPreviewDto,
} from "@polyth/contracts";
import { englishTranslate, type Translate } from "./englishTranslate.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export interface PluginSpecInfo {
  /** Short human-readable label, e.g. "opencode-claude" for "@otto-assistant/opencode-claude@1.2.0". */
  name: string;
  /** The full spec, doubling as the on-disk path for file: entries. */
  path: string;
  kind: "npm" | "file" | "url" | "other";
  version?: string;
  description: string;
}

/** Package specs carry no metadata of their own — this derives a readable
 * name/path/description straight from the spec string for display. */
export function describePluginSpec(spec: string, t: Translate = englishTranslate): PluginSpecInfo {
  if (spec.startsWith("file:")) {
    const path = spec.slice("file:".length);
    const base = path.split("/").filter(Boolean).pop() ?? path;
    return { name: base.replace(/\.[cm]?[jt]s$/, ""), path, kind: "file", description: t("plugins.spec.localFile") };
  }
  if (/^https?:/.test(spec)) {
    const base = spec.split("/").filter(Boolean).pop() ?? spec;
    return { name: base, path: spec, kind: "url", description: t("plugins.spec.remoteScript") };
  }
  const body = spec.startsWith("npm:") ? spec.slice("npm:".length) : spec;
  const match = /^(@[^/]+\/[^@]+|[^@]+)(?:@(.+))?$/.exec(body);
  if (!match) return { name: spec, path: spec, kind: "other", description: t("plugins.spec.plugin") };
  const [, pkg, version] = match;
  const name = pkg!.includes("/") ? pkg!.split("/").pop()! : pkg!;
  return {
    name,
    path: spec,
    kind: "npm",
    ...(version ? { version } : {}),
    description: version ? t("plugins.spec.npmVersion", { version }) : t("plugins.spec.npm"),
  };
}

const validSpec = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  const spec = value.trim();
  return spec.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(spec) ? spec : null;
};

const parseEntry = (raw: unknown, index: number, t: Translate): OpenCodePluginEntryDto | string => {
  if (typeof raw === "string") {
    const spec = validSpec(raw);
    return spec ? { spec } : t("plugins.parse.entryInvalid", { n: index + 1 });
  }
  if (Array.isArray(raw) && raw.length === 2) {
    const spec = validSpec(raw[0]);
    if (!spec) return t("plugins.parse.entryInvalid", { n: index + 1 });
    if (!isRecord(raw[1])) return t("plugins.parse.tupleOptions", { spec });
    return { spec, options: raw[1] as JsonObject };
  }
  return t("plugins.parse.entryShape", { n: index + 1 });
};

const dedupe = (entries: OpenCodePluginEntryDto[]): OpenCodePluginEntryDto[] => {
  const bySpec = new Map<string, OpenCodePluginEntryDto>();
  const order: string[] = [];
  for (const entry of entries) {
    if (!bySpec.has(entry.spec)) order.push(entry.spec);
    bySpec.set(entry.spec, entry);
  }
  return order.map((spec) => bySpec.get(spec)!);
};

/** Parse an OpenCode config object, a bare plugin array, or a single package
 * spec. Never throws; callers preview all errors before making one write. */
export function parseOpenCodePluginJson(text: string, t: Translate = englishTranslate): OpenCodePluginPreviewDto {
  const source = text.trim();
  if (!source) return { entries: [], errors: [t("plugins.parse.paste")], ignoredKeys: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    // A bare package spec is also accepted without JSON quoting.
    const spec = validSpec(source);
    if (spec && !/^(?:\{|\[)/.test(source)) {
      return { entries: [{ spec }], errors: [], ignoredKeys: [] };
    }
    return {
      entries: [],
      errors: [t("plugins.parse.notValidJson", { message: error instanceof Error ? error.message : String(error) })],
      ignoredKeys: [],
    };
  }

  let rawEntries: unknown[];
  let ignoredKeys: string[] = [];
  if (Array.isArray(parsed)) {
    rawEntries = parsed;
  } else if (typeof parsed === "string") {
    rawEntries = [parsed];
  } else if (isRecord(parsed)) {
    const plugin = parsed.plugin;
    ignoredKeys = Object.keys(parsed).filter((key) => key !== "$schema" && key !== "plugin");
    if (!Array.isArray(plugin)) {
      return { entries: [], errors: [t("plugins.parse.expectPluginArray")], ignoredKeys };
    }
    rawEntries = plugin;
  } else {
    return { entries: [], errors: [t("plugins.parse.expectArrayOrConfig")], ignoredKeys: [] };
  }

  if (rawEntries.length === 0) {
    return { entries: [], errors: [t("plugins.parse.noEntries")], ignoredKeys };
  }
  const entries: OpenCodePluginEntryDto[] = [];
  const errors: string[] = [];
  rawEntries.forEach((raw, index) => {
    const result = parseEntry(raw, index, t);
    if (typeof result === "string") errors.push(result);
    else entries.push(result);
  });
  return { entries: dedupe(entries), errors, ignoredKeys };
}
