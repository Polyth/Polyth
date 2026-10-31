// A Judgment use is one feature that asks Judgment questions: a reviewer
// verdict, a completion check, a permission second opinion. The consuming
// package registers a descriptor through JUDGMENT_SERVICE; Settings → Judgment
// renders every registered use with its switch and parameters, and the
// consumer reads its resolved state before it asks anything. Browser-safe: no
// Node, network or secret access.
import type { JudgmentConfig } from "./types.ts";
import { record, safeId } from "./validation.ts";

export type JudgmentUseValue = string | number | boolean;
interface ParamBase { id: string; label: string; hint?: string }
/** A probability in [0, 1], shown as a percentage. */
export interface JudgmentUseProbabilityParam extends ParamBase { kind: "probability"; default: number }
export interface JudgmentUseIntegerParam extends ParamBase { kind: "integer"; min: number; max: number; default: number; unit?: string }
export interface JudgmentUseBooleanParam extends ParamBase { kind: "boolean"; default: boolean }
export interface JudgmentUseChoiceParam extends ParamBase { kind: "choice"; options: Array<{ value: string; label: string }>; default: string }
export interface JudgmentUseTextParam extends ParamBase { kind: "text"; maxLength: number; default: string; multiline?: boolean }
export type JudgmentUseParam = JudgmentUseProbabilityParam | JudgmentUseIntegerParam | JudgmentUseBooleanParam
  | JudgmentUseChoiceParam | JudgmentUseTextParam;

export interface JudgmentUseDescriptor {
  /** Stable id, e.g. `workflow.review-verdict`. Stored configuration is keyed by it. */
  id: string;
  /** Owning package, for grouping and diagnostics. */
  packageId: string;
  title: string;
  /** What is asked, in one sentence. */
  description: string;
  /** What Polyth does with the answer, in one sentence. Judgment itself never acts. */
  effect: string;
  /** Versioned question scope the use sends; `scopes[scope]` overrides its engine/provider/model. */
  scope: string;
  /** `short` evidence fits small local models; `long` needs a hosted model's context. */
  evidence: "short" | "long";
  /** Uses are opt-in unless the owner states otherwise. */
  defaultEnabled: boolean;
  params: JudgmentUseParam[];
  /** Sort key within the Uses list; lower first. */
  order?: number;
}
export interface JudgmentUseConfig { enabled?: boolean; params?: Record<string, JudgmentUseValue> }
export type JudgmentUseOffReason = "judgment-off" | "use-off" | "unknown-use";
export interface JudgmentUseState {
  useId: string;
  scope?: string;
  enabled: boolean;
  /** Why the use is off; absent when enabled. */
  reason?: JudgmentUseOffReason;
  /** Every declared parameter: default ← all projects ← this project. */
  params: Record<string, JudgmentUseValue>;
}

const invalid = (message = "Invalid Judgment use") => Object.assign(new Error(message), { code: "invalid-input" });
const text = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max;

/** Whether `value` is acceptable for `param`; stored values that fail fall back to the default. */
export function validUseValue(param: JudgmentUseParam, value: unknown): value is JudgmentUseValue {
  switch (param.kind) {
    case "probability": return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
    case "integer": return Number.isSafeInteger(value) && (value as number) >= param.min && (value as number) <= param.max;
    case "boolean": return typeof value === "boolean";
    case "choice": return typeof value === "string" && param.options.some((option) => option.value === value);
    case "text": return typeof value === "string" && value.length <= param.maxLength;
  }
}

export function validateUseDescriptor(descriptor: JudgmentUseDescriptor): void {
  if (!record(descriptor) || !safeId(descriptor.id) || !safeId(descriptor.packageId) || !safeId(descriptor.scope)
    || !text(descriptor.title, 120) || !text(descriptor.description, 600) || !text(descriptor.effect, 600)
    || !["short", "long"].includes(descriptor.evidence) || typeof descriptor.defaultEnabled !== "boolean"
    || !Array.isArray(descriptor.params) || descriptor.params.length > 16
    || (descriptor.order !== undefined && !Number.isFinite(descriptor.order))) throw invalid();
  const ids = new Set<string>();
  for (const param of descriptor.params) {
    if (!record(param) || !safeId(param.id) || ids.has(param.id) || !text(param.label, 120)
      || (param.hint !== undefined && !text(param.hint, 400))) throw invalid();
    ids.add(param.id);
    if (param.kind === "integer" && (!Number.isSafeInteger(param.min) || !Number.isSafeInteger(param.max) || param.min > param.max)) throw invalid();
    if (param.kind === "choice" && (!Array.isArray(param.options) || param.options.length < 2 || param.options.length > 16
      || param.options.some((option) => !text(option.value, 64) || !text(option.label, 120)))) throw invalid();
    if (param.kind === "text" && (!Number.isSafeInteger(param.maxLength) || param.maxLength < 1 || param.maxLength > 8_000)) throw invalid();
    if (!["probability", "integer", "boolean", "choice", "text"].includes(param.kind) || !validUseValue(param, param.default)) throw invalid();
  }
}

/** Structural check of stored `uses`; values are checked against descriptors when known. */
export function validateUsesConfig(value: unknown): void {
  if (!record(value) || Object.keys(value).length > 128) throw invalid("Invalid Judgment settings");
  for (const [id, entry] of Object.entries(value)) {
    if (!safeId(id) || !record(entry) || Object.keys(entry).some((key) => key !== "enabled" && key !== "params")) throw invalid("Invalid Judgment settings");
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") throw invalid("Invalid Judgment settings");
    if (entry.params !== undefined) {
      if (!record(entry.params) || Object.keys(entry.params).length > 16) throw invalid("Invalid Judgment settings");
      for (const [key, param] of Object.entries(entry.params)) {
        if (!safeId(key) || !["string", "number", "boolean"].includes(typeof param)
          || (typeof param === "number" && !Number.isFinite(param)) || (typeof param === "string" && param.length > 8_000)) throw invalid("Invalid Judgment settings");
      }
    }
  }
}

/** Rejects stored values for a registered use that its descriptor would not accept. */
export function validateUseConfigAgainst(descriptor: JudgmentUseDescriptor, config: JudgmentUseConfig): void {
  for (const [key, value] of Object.entries(config.params ?? {})) {
    const param = descriptor.params.find((entry) => entry.id === key);
    if (!param || !validUseValue(param, value)) throw invalid(`Invalid value for ${descriptor.title}: ${param?.label ?? key}`);
  }
}

/** Resolves one use: project overrides all projects; Judgment itself must be on. */
export function resolveUseState(descriptor: JudgmentUseDescriptor | undefined, useId: string,
  global: Partial<JudgmentConfig> | undefined, project: Partial<JudgmentConfig> | undefined, judgmentEnabled = true): JudgmentUseState {
  if (!descriptor) return { useId, enabled: false, reason: "unknown-use", params: {} };
  const layers = [global?.uses?.[useId], project?.uses?.[useId]];
  const params: Record<string, JudgmentUseValue> = {};
  for (const param of descriptor.params) {
    params[param.id] = param.default;
    for (const layer of layers) {
      const value = layer?.params?.[param.id];
      if (value !== undefined && validUseValue(param, value)) params[param.id] = value;
    }
  }
  const useOn = layers.reduce<boolean>((on, layer) => layer?.enabled ?? on, descriptor.defaultEnabled);
  const on = (project?.enabled ?? global?.enabled ?? true) && judgmentEnabled;
  const reason: JudgmentUseOffReason | undefined = !on ? "judgment-off" : !useOn ? "use-off" : undefined;
  return { useId, scope: descriptor.scope, enabled: !reason, ...(reason ? { reason } : {}), params };
}
