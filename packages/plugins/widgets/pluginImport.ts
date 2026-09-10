import type {
  JsonObject,
  OpenCodePluginEntryDto,
  OpenCodePluginPreviewDto,
} from "@polyth/contracts";

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
export function describePluginSpec(spec: string): PluginSpecInfo {
  if (spec.startsWith("file:")) {
    const path = spec.slice("file:".length);
    const base = path.split("/").filter(Boolean).pop() ?? path;
    return { name: base.replace(/\.[cm]?[jt]s$/, ""), path, kind: "file", description: "Local plugin file" };
  }
  if (/^https?:/.test(spec)) {
    const base = spec.split("/").filter(Boolean).pop() ?? spec;
    return { name: base, path: spec, kind: "url", description: "Remote plugin script" };
  }
  const body = spec.startsWith("npm:") ? spec.slice("npm:".length) : spec;
  const match = /^(@[^/]+\/[^@]+|[^@]+)(?:@(.+))?$/.exec(body);
  if (!match) return { name: spec, path: spec, kind: "other", description: "Plugin" };
  const [, pkg, version] = match;
  const name = pkg!.includes("/") ? pkg!.split("/").pop()! : pkg!;
  return {
    name,
    path: spec,
    kind: "npm",
    ...(version ? { version } : {}),
    description: version ? `npm package · v${version}` : "npm package",
  };
}

const validSpec = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  const spec = value.trim();
  return spec.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(spec) ? spec : null;
};

const parseEntry = (raw: unknown, index: number): OpenCodePluginEntryDto | string => {
  if (typeof raw === "string") {
    const spec = validSpec(raw);
    return spec ? { spec } : `plugin entry ${index + 1} needs a valid non-empty package spec`;
  }
  if (Array.isArray(raw) && raw.length === 2) {
    const spec = validSpec(raw[0]);
    if (!spec) return `plugin entry ${index + 1} needs a valid non-empty package spec`;
    if (!isRecord(raw[1])) return `${spec}: tuple options must be a JSON object`;
    return { spec, options: raw[1] as JsonObject };
  }
  return `plugin entry ${index + 1} must be a package spec or [spec, options] tuple`;
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
export function parseOpenCodePluginJson(text: string): OpenCodePluginPreviewDto {
  const source = text.trim();
  if (!source) return { entries: [], errors: ["paste a plugin package spec, array, or OpenCode config"], ignoredKeys: [] };

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
      errors: [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
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
      return { entries: [], errors: ['expected a "plugin" array in the OpenCode config'], ignoredKeys };
    }
    rawEntries = plugin;
  } else {
    return { entries: [], errors: ["expected a plugin array or OpenCode config object"], ignoredKeys: [] };
  }

  if (rawEntries.length === 0) {
    return { entries: [], errors: ["no plugin entries found"], ignoredKeys };
  }
  const entries: OpenCodePluginEntryDto[] = [];
  const errors: string[] = [];
  rawEntries.forEach((raw, index) => {
    const result = parseEntry(raw, index);
    if (typeof result === "string") errors.push(result);
    else entries.push(result);
  });
  return { entries: dedupe(entries), errors, ignoredKeys };
}
