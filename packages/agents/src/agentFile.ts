// Repository-defined agents: <project>/.agents/agents/<id>.md (format agent/v1).
// Frontmatter is flat `key: value`; structured values (budget, approvals,
// wakes) are one line of JSON, which is also valid YAML flow syntax. The body
// is the charter. Browser-safe: the editor's "Edit as file" uses the same
// parser and serializer, so form and file round-trip exactly.
import type { AgentEventTrigger } from "./agentEvents.ts";
import { validateHeartbeat, type AgentHeartbeat } from "./agentHeartbeat.ts";
import type { AgentNotifyPolicy } from "./agentReport.ts";
import type { AgentApprovalPolicy, AgentBudget, AgentColor, CatchUpPolicy, OverlapPolicy } from "./index.ts";

export const AGENT_FILE_FORMAT = "agent/v1";
export const AGENT_FILE_MAX_BYTES = 256 * 1024;

export interface AgentFileSpec {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  color?: AgentColor;
  /** Absent = wakes only by hand or on events. */
  schedule?: { cron: string; timeZone: string };
  enabled: boolean;
  context?: "fresh" | "rolling";
  rotateAt?: number;
  whenFull?: "new-session" | "compact";
  keepWarm?: "off" | "auto";
  overlap?: OverlapPolicy;
  catchUp?: CatchUpPolicy;
  agentProfile?: string;
  /** `provider/model`, optionally `#variant`. */
  model?: string;
  harness?: string;
  /** Backups in priority order; each pins its own harness. */
  fallbackModels?: AgentFileFallback[];
  budget?: AgentBudget;
  pauseAfterFailures?: number;
  approvals?: AgentApprovalPolicy;
  /** Event wakes; webhooks need a per-install secret and are set up in the app. */
  wakes?: AgentEventTrigger[];
  /** Light, frequent checks; needs `context: rolling`. */
  heartbeat?: AgentHeartbeat;
  /** Absent = alerts only. */
  notify?: AgentNotifyPolicy;
  charter: string;
}

/** One backup route in a file: `provider/model` (optionally `#variant`) on a harness. */
export interface AgentFileFallback { model: string; harness: string }

const MODEL_PATTERN = /^[^/\s]+\/[^\s#]+(#[^\s]+)?$/;

/** A harness-qualified model ref, as files spell it and the app stores it. */
export interface FileModelRef { providerID: string; modelID: string; variant?: string; harnessId?: string }

export const modelText = (ref: Pick<FileModelRef, "providerID" | "modelID" | "variant">): string =>
  `${ref.providerID}/${ref.modelID}${ref.variant ? `#${ref.variant}` : ""}`;

/** `provider/model#variant` (+ harness) → ref; undefined when it is not one. */
export function modelFromText(text: string | undefined, harness?: string): FileModelRef | undefined {
  if (!text || !MODEL_PATTERN.test(text)) return undefined;
  const [ref, variant] = text.split("#");
  const slash = ref!.indexOf("/");
  return {
    providerID: ref!.slice(0, slash),
    modelID: ref!.slice(slash + 1),
    ...(variant ? { variant } : {}),
    ...(harness ? { harnessId: harness } : {}),
  };
}

export const fallbacksToFile = (refs: readonly FileModelRef[] | undefined): AgentFileFallback[] =>
  (refs ?? []).filter((ref) => ref.harnessId).map((ref) => ({ model: modelText(ref), harness: ref.harnessId! }));

export const fallbacksFromFile = (items: readonly AgentFileFallback[] | undefined): FileModelRef[] =>
  (items ?? []).flatMap((item) => {
    const ref = modelFromText(item.model, item.harness);
    return ref ? [ref] : [];
  });

type Parsed = { spec: AgentFileSpec; error?: undefined } | { spec?: undefined; error: string };

const KEYS = [
  "format", "id", "name", "description", "icon", "color", "schedule", "timeZone", "enabled",
  "context", "rotateAt", "whenFull", "keepWarm", "overlap", "catchUp", "agentProfile", "model",
  "harness", "fallbackModels", "budget", "pauseAfterFailures", "approvals", "wakes", "heartbeat", "notify",
] as const;
const COLORS = ["neutral", "blue", "green", "amber", "purple", "red"];

const unquote = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try { return JSON.parse(trimmed) as string; } catch { return trimmed.slice(1, -1); }
  }
  return trimmed;
};

/** Quote a scalar when YAML would read it as something else. */
const scalar = (value: string): string =>
  /^[\w./@+-][\w ./@+:-]*$/.test(value) && !/^(true|false|null|yes|no|~)$/i.test(value) && !/:\s/.test(value) && !/\s$/.test(value)
    ? value
    : JSON.stringify(value);

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], key: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`${key} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function json<T>(value: string | undefined, key: string): T | undefined {
  if (value === undefined) return undefined;
  try { return JSON.parse(value) as T; } catch { throw new Error(`${key} must be one line of JSON`); }
}

function positive(value: string | undefined, key: string, integer = true): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) throw new Error(`${key} must be a positive ${integer ? "whole " : ""}number`);
  return n;
}

/** Strict parse. `validate` hooks let the server check cron and wakes with
 *  its own validators; the browser parses structure only. */
export function parseAgentFile(
  text: string,
  validate: { cron?: (cron: string, timeZone: string) => string | undefined; wake?: (raw: unknown) => AgentEventTrigger } = {},
): Parsed {
  if (new TextEncoder().encode(text).length > AGENT_FILE_MAX_BYTES) return { error: "agent file exceeds 256 KiB" };
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { error: "missing frontmatter (--- fenced block)" };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!kv) return { error: `invalid frontmatter line: ${line.slice(0, 60)}` };
    if (!(KEYS as readonly string[]).includes(kv[1]!)) return { error: `unknown key "${kv[1]}"` };
    if (kv[1]! in meta) return { error: `duplicate key "${kv[1]}"` };
    meta[kv[1]!] = kv[2]!.trim();
  }
  try {
    const format = meta.format ? unquote(meta.format) : AGENT_FILE_FORMAT;
    if (format !== AGENT_FILE_FORMAT) throw new Error(`format must be ${AGENT_FILE_FORMAT}`);
    const id = unquote(meta.id ?? "");
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new Error("id must be a short lowercase identifier");
    const charter = m[2]!.trim();
    if (!charter) throw new Error("the body (the agent's instructions) is empty");
    const cron = meta.schedule !== undefined ? unquote(meta.schedule) : "";
    const timeZone = meta.timeZone !== undefined ? unquote(meta.timeZone) : "UTC";
    if (cron) {
      const problem = validate.cron?.(cron, timeZone);
      if (problem) throw new Error(`schedule: ${problem}`);
    }
    const enabled = meta.enabled === undefined ? true : unquote(meta.enabled);
    if (enabled !== true && enabled !== "true" && enabled !== "false") throw new Error("enabled must be true or false");
    const rotateAt = meta.rotateAt !== undefined ? Number(unquote(meta.rotateAt)) : undefined;
    if (rotateAt !== undefined && !(rotateAt >= 0.2 && rotateAt <= 0.9)) throw new Error("rotateAt must be between 0.2 and 0.9");
    const budget = json<AgentBudget>(meta.budget, "budget");
    if (budget !== undefined) {
      if (!budget || typeof budget !== "object" || Array.isArray(budget)) throw new Error("budget must be a JSON object");
      for (const [key, value] of Object.entries(budget)) {
        if (!["runsPerDay", "tokensPerDay", "costPerDay"].includes(key)) throw new Error(`budget.${key} is not a known limit`);
        positive(String(value), `budget.${key}`, key !== "costPerDay");
      }
    }
    const approvals = json<AgentApprovalPolicy>(meta.approvals, "approvals");
    if (approvals !== undefined
      && (!approvals || !Number.isInteger(approvals.timeoutMinutes) || approvals.timeoutMinutes < 1
        || !["wait", "reject", "stop"].includes(approvals.onTimeout))) {
      throw new Error("approvals must be {\"timeoutMinutes\": n, \"onTimeout\": \"wait|reject|stop\"}");
    }
    const rawWakes = json<unknown[]>(meta.wakes, "wakes");
    if (rawWakes !== undefined && !Array.isArray(rawWakes)) throw new Error("wakes must be a JSON list");
    if (rawWakes?.some((wake) => (wake as { kind?: unknown })?.kind === "webhook")) {
      throw new Error("webhook wakes need a secret URL and are set up in the app, not in a file");
    }
    const wakes = rawWakes?.map((wake) => validate.wake ? validate.wake(wake) : wake as AgentEventTrigger);
    const rawHeartbeat = json<unknown>(meta.heartbeat, "heartbeat");
    let heartbeat: AgentHeartbeat | undefined;
    if (rawHeartbeat !== undefined) {
      try { heartbeat = validateHeartbeat(rawHeartbeat); } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
      }
      if (unquote(meta.context ?? "") !== "rolling") throw new Error("heartbeat needs context: rolling");
    }
    const notify = oneOf(meta.notify !== undefined ? unquote(meta.notify) : undefined, ["alerts", "updates", "off"] as const, "notify");
    const model = meta.model !== undefined ? unquote(meta.model) : undefined;
    if (model !== undefined && !MODEL_PATTERN.test(model)) throw new Error("model must look like provider/model");
    const rawFallbacks = json<unknown[]>(meta.fallbackModels, "fallbackModels");
    if (rawFallbacks !== undefined && !Array.isArray(rawFallbacks)) throw new Error("fallbackModels must be a JSON list");
    if (rawFallbacks && rawFallbacks.length > 8) throw new Error("fallbackModels holds at most 8 backups");
    const fallbackModels = rawFallbacks?.map((raw, index): AgentFileFallback => {
      const item = raw as Partial<AgentFileFallback> | null;
      if (typeof item?.model !== "string" || !MODEL_PATTERN.test(item.model)) throw new Error(`fallbackModels[${index}].model must look like provider/model`);
      if (typeof item.harness !== "string" || !item.harness.trim()) throw new Error(`fallbackModels[${index}].harness is required`);
      return { model: item.model, harness: item.harness.trim() };
    });
    const color = oneOf(meta.color !== undefined ? unquote(meta.color) : undefined, COLORS, "color") as AgentColor | undefined;
    const description = meta.description !== undefined ? unquote(meta.description).slice(0, 280) : undefined;
    const spec: AgentFileSpec = {
      id,
      name: meta.name !== undefined ? unquote(meta.name).slice(0, 80) || id : id,
      ...(description ? { description } : {}),
      ...(meta.icon !== undefined ? { icon: unquote(meta.icon) } : {}),
      ...(color ? { color } : {}),
      ...(cron ? { schedule: { cron, timeZone } } : {}),
      enabled: enabled !== "false",
      ...opt("context", oneOf(meta.context && unquote(meta.context), ["fresh", "rolling"] as const, "context")),
      ...(rotateAt !== undefined ? { rotateAt } : {}),
      ...opt("whenFull", oneOf(meta.whenFull && unquote(meta.whenFull), ["new-session", "compact"] as const, "whenFull")),
      ...opt("keepWarm", oneOf(meta.keepWarm && unquote(meta.keepWarm), ["off", "auto"] as const, "keepWarm")),
      ...opt("overlap", oneOf(meta.overlap && unquote(meta.overlap), ["skip", "queue", "parallel"] as const, "overlap")),
      ...opt("catchUp", oneOf(meta.catchUp && unquote(meta.catchUp), ["once", "skip"] as const, "catchUp")),
      ...(meta.agentProfile !== undefined ? { agentProfile: unquote(meta.agentProfile) } : {}),
      ...(model ? { model } : {}),
      ...(meta.harness !== undefined ? { harness: unquote(meta.harness) } : {}),
      ...(fallbackModels?.length ? { fallbackModels } : {}),
      ...(budget && Object.keys(budget).length ? { budget } : {}),
      ...opt("pauseAfterFailures", positive(meta.pauseAfterFailures && unquote(meta.pauseAfterFailures), "pauseAfterFailures")),
      ...(approvals ? { approvals: { timeoutMinutes: approvals.timeoutMinutes, onTimeout: approvals.onTimeout } } : {}),
      ...(wakes?.length ? { wakes } : {}),
      ...(heartbeat ? { heartbeat } : {}),
      ...(notify && notify !== "alerts" ? { notify } : {}),
      charter,
    };
    return { spec };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function opt<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : { [key]: value } as Record<K, V>;
}

/** Deterministic text for a spec: fixed key order, defaults omitted. */
export function serializeAgentFile(spec: AgentFileSpec): string {
  const lines = [`format: ${AGENT_FILE_FORMAT}`, `id: ${spec.id}`, `name: ${scalar(spec.name)}`];
  const push = (key: string, value: string | undefined) => { if (value !== undefined && value !== "") lines.push(`${key}: ${value}`); };
  push("description", spec.description ? scalar(spec.description) : undefined);
  push("icon", spec.icon);
  push("color", spec.color);
  if (spec.schedule) {
    push("schedule", JSON.stringify(spec.schedule.cron));
    push("timeZone", spec.schedule.timeZone);
  }
  if (!spec.enabled) push("enabled", "false");
  push("context", spec.context);
  push("rotateAt", spec.rotateAt !== undefined ? String(spec.rotateAt) : undefined);
  push("whenFull", spec.whenFull);
  push("keepWarm", spec.keepWarm);
  push("overlap", spec.overlap);
  push("catchUp", spec.catchUp);
  push("agentProfile", spec.agentProfile ? scalar(spec.agentProfile) : undefined);
  push("model", spec.model);
  push("harness", spec.harness);
  push("fallbackModels", spec.fallbackModels?.length ? JSON.stringify(spec.fallbackModels) : undefined);
  push("budget", spec.budget && Object.keys(spec.budget).length ? JSON.stringify(spec.budget) : undefined);
  push("pauseAfterFailures", spec.pauseAfterFailures !== undefined ? String(spec.pauseAfterFailures) : undefined);
  push("approvals", spec.approvals ? JSON.stringify(spec.approvals) : undefined);
  push("wakes", spec.wakes?.length ? JSON.stringify(spec.wakes) : undefined);
  push("heartbeat", spec.heartbeat ? JSON.stringify(spec.heartbeat) : undefined);
  push("notify", spec.notify && spec.notify !== "alerts" ? spec.notify : undefined);
  return `---\n${lines.join("\n")}\n---\n\n${spec.charter.trim()}\n`;
}

/** A filesystem-safe agent id derived from a name. */
export function agentIdFrom(name: string): string {
  const slug = name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug || "agent";
}
