import { isAbsolute, win32 } from "node:path";
import {
  isUiSlot,
  type TrustClass,
  type UiSlot,
  type WidgetAudience,
  type WidgetContributionDescriptor,
  type WidgetScope,
  type WidgetSize,
} from "@polyth/contracts";

const TRUST_CLASSES: TrustClass[] = ["ui-only", "pure", "workspace", "network", "device", "privileged", "credentialed"];

/** Grant text shown at install/enable time; the UI must render it verbatim. */
export const TRUST_GRANTS: Record<TrustClass, string> = {
  "ui-only": "No workspace, network, or device access.",
  pure: "No workspace, network, or device access.",
  workspace: "Project-scoped file and process access, gated by permission checks.",
  network: "Network access to the origins it declares.",
  device: "Browser/device APIs (camera, microphone, clipboard).",
  privileged: "Broad access. Requires explicit confirmation at install and runtime.",
  credentialed: "Holds credentials. Requires explicit confirmation at install and runtime.",
};

export interface ManagedPluginManifest {
  id: string;
  name: string;
  version: string;
  trust: TrustClass;
  capabilities?: string[];
  contributions?: Array<{ slot: UiSlot; id: string; module: string }>;
  widgets?: WidgetContributionDescriptor[];
  entries?: {
    server?: string;
    ui?: string;
  };
}

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

const optionalSize = (value: unknown, field: string): WidgetSize | undefined => {
  if (value === undefined) return undefined;
  const size = value as Partial<WidgetSize> | null;
  if (
    !size || typeof size !== "object"
    || typeof size.w !== "number" || !Number.isFinite(size.w) || size.w <= 0
    || typeof size.h !== "number" || !Number.isFinite(size.h) || size.h <= 0
  ) {
    throw err("invalid-input", `${field} must contain positive numeric w and h`);
  }
  return { w: size.w, h: size.h };
};

const optionalStrings = (value: unknown, field: string): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw err("invalid-input", `${field} must be an array of strings`);
  }
  return [...new Set(value)];
};

const parseEntries = (value: unknown): ManagedPluginManifest["entries"] => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw err("invalid-input", "manifest entries must be an object");
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== "server" && key !== "ui") {
      throw err("invalid-input", `unknown manifest entry key "${key}"`);
    }
  }
  const entries: NonNullable<ManagedPluginManifest["entries"]> = {};
  for (const key of ["server", "ui"] as const) {
    if (!(key in raw)) continue;
    const entry = raw[key];
    if (
      typeof entry !== "string"
      || !entry
      || entry.includes("\\")
      || isAbsolute(entry)
      || win32.isAbsolute(entry)
      || entry.split("/").includes("..")
    ) {
      throw err(
        "invalid-input",
        `manifest entries.${key} must be a relative path without ".." or backslashes`,
      );
    }
    entries[key] = entry;
  }
  return entries;
};

function parseWidget(value: unknown): WidgetContributionDescriptor {
  const widget = value as Partial<WidgetContributionDescriptor> | null;
  if (!widget || typeof widget !== "object") throw err("invalid-input", "each widget must be an object");
  for (const field of ["id", "module", "title", "description"] as const) {
    if (typeof widget[field] !== "string" || !widget[field].trim()) {
      throw err("invalid-input", `each widget needs a non-empty ${field}`);
    }
  }
  if (widget.kind !== "widget" && widget.kind !== "mini-widget") {
    throw err("invalid-input", 'widget kind must be "widget" or "mini-widget"');
  }
  if (typeof widget.defaultSlot !== "string" || !isUiSlot(widget.defaultSlot)) {
    throw err("invalid-input", `unknown widget default slot "${String(widget.defaultSlot)}"`);
  }
  if (
    !Array.isArray(widget.supportedSlots) || widget.supportedSlots.length === 0
    || widget.supportedSlots.some((slot) => typeof slot !== "string" || !isUiSlot(slot))
  ) {
    throw err("invalid-input", "widget supportedSlots must contain known UI slots");
  }
  const supportedSlots = [...new Set(widget.supportedSlots)] as UiSlot[];
  if (!supportedSlots.includes(widget.defaultSlot)) {
    throw err("invalid-input", "widget supportedSlots must include defaultSlot");
  }
  const audience = widget.audience as WidgetAudience | undefined;
  if (audience !== undefined && audience !== "simple" && audience !== "standard" && audience !== "power") {
    throw err("invalid-input", "widget audience is invalid");
  }
  const scope = widget.scope as WidgetScope | undefined;
  if (scope !== undefined && scope !== "global" && scope !== "workspace" && scope !== "plugin") {
    throw err("invalid-input", "widget scope is invalid");
  }
  const showIn = optionalStrings(widget.showIn, "widget showIn") as WidgetAudience[] | undefined;
  if (showIn?.some((item) => item !== "simple" && item !== "standard" && item !== "power")) {
    throw err("invalid-input", "widget showIn contains an invalid audience");
  }
  return {
    id: widget.id!,
    module: widget.module!,
    title: widget.title!,
    description: widget.description!,
    kind: widget.kind,
    defaultSlot: widget.defaultSlot,
    supportedSlots,
    ...(typeof widget.order === "number" && Number.isFinite(widget.order) ? { order: widget.order } : {}),
    ...(typeof widget.category === "string" ? { category: widget.category } : {}),
    ...(optionalStrings(widget.capabilities, "widget capabilities")
      ? { capabilities: optionalStrings(widget.capabilities, "widget capabilities")! }
      : {}),
    ...(optionalSize(widget.recommendedSize, "widget recommendedSize")
      ? { recommendedSize: optionalSize(widget.recommendedSize, "widget recommendedSize")! }
      : {}),
    ...(optionalSize(widget.defaultSize, "widget defaultSize")
      ? { defaultSize: optionalSize(widget.defaultSize, "widget defaultSize")! }
      : {}),
    ...(optionalSize(widget.minSize, "widget minSize")
      ? { minSize: optionalSize(widget.minSize, "widget minSize")! }
      : {}),
    ...(optionalSize(widget.maxSize, "widget maxSize")
      ? { maxSize: optionalSize(widget.maxSize, "widget maxSize")! }
      : {}),
    ...(audience ? { audience } : {}),
    ...(showIn ? { showIn } : {}),
    ...(scope ? { scope } : {}),
    ...(typeof widget.resizable === "boolean" ? { resizable: widget.resizable } : {}),
    ...(typeof widget.duplicatable === "boolean" ? { duplicatable: widget.duplicatable } : {}),
    ...(typeof widget.recommended === "boolean" ? { recommended: widget.recommended } : {}),
    ...(typeof widget.defaultVisible === "boolean" ? { defaultVisible: widget.defaultVisible } : {}),
  };
}

export function parseManifest(raw: string): ManagedPluginManifest {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw err("invalid-input", "polyth-plugin.json is not valid JSON");
  }
  const m = data as Partial<ManagedPluginManifest>;
  if (!m || typeof m !== "object") throw err("invalid-input", "manifest must be an object");
  if (typeof m.id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(m.id)) {
    throw err("invalid-input", "manifest id must be a short lowercase identifier");
  }
  if (typeof m.name !== "string" || !m.name.trim()) throw err("invalid-input", "manifest name required");
  if (typeof m.version !== "string" || !/^\d+\.\d+\.\d+/.test(m.version)) {
    throw err("invalid-input", "manifest version must be semver");
  }
  if (!TRUST_CLASSES.includes(m.trust as TrustClass)) {
    throw err("invalid-input", `manifest trust must be one of: ${TRUST_CLASSES.join(", ")}`);
  }
  const capabilities = Array.isArray(m.capabilities)
    ? m.capabilities.filter((c): c is string => typeof c === "string")
    : [];
  const contributions: ManagedPluginManifest["contributions"] = [];
  for (const c of Array.isArray(m.contributions) ? m.contributions : []) {
    const item = c as { slot?: unknown; id?: unknown; module?: unknown };
    if (typeof item.slot !== "string" || typeof item.id !== "string" || typeof item.module !== "string") {
      throw err("invalid-input", "each contribution needs slot, id, and module strings");
    }
    if (!isUiSlot(item.slot)) {
      throw err("invalid-input", `unknown ui slot "${item.slot}"`);
    }
    contributions.push({ slot: item.slot, id: item.id, module: item.module });
  }
  const widgets = (Array.isArray(m.widgets) ? m.widgets : []).map(parseWidget);
  const widgetIds = new Set<string>();
  for (const widget of widgets) {
    if (widgetIds.has(widget.id)) throw err("invalid-input", `duplicate widget id "${widget.id}"`);
    widgetIds.add(widget.id);
  }
  const entries = parseEntries(m.entries);
  return {
    id: m.id,
    name: m.name.trim(),
    version: m.version,
    trust: m.trust as TrustClass,
    capabilities,
    contributions,
    widgets,
    ...(entries ? { entries } : {}),
  };
}
