// Validation and normalization of a person's routing policy. Pure, but it
// hashes with node:crypto, so it is server-only; the web entry never imports it.
import { createHash } from "node:crypto";
import {
  BUILTIN_ROLE_IDS,
  CUSTOM_ROLE_PREFIX,
  DEFAULT_POLICY,
  POLICY_LIMITS,
  isBuiltinRole,
  modelKey,
  type ExhaustedBehavior,
  type ModelChoice,
  type RoutingMode,
  type RoutingPolicy,
  type RoutingRole,
} from "./contracts.ts";

const CUSTOM_ID = /^custom-[a-z0-9-]{1,32}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const HAS_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const MAX_ID_CHARS = 200;

const invalid = (message: string): Error => Object.assign(new Error(message), { code: "invalid-input" });

/** Copy of Usage's `parseFavoriteKey` (packages must not import each other). */
export function parseModelKey(key: string): { harnessId: string; providerID: string; modelID: string } | undefined {
  const split = key.indexOf("::");
  const harnessId = split > 0 ? key.slice(0, split) : "opencode";
  const rest = split > 0 ? key.slice(split + 2) : key;
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return undefined;
  return { harnessId, providerID: rest.slice(0, slash), modelID: rest.slice(slash + 1) };
}

/** One line of person-written text: control characters stripped, whitespace collapsed. */
export const oneLine = (value: string): string => value.replace(CONTROL, " ").replace(/\s+/g, " ").trim();

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const intIn = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;

function choiceOf(raw: unknown, where: string, strict: boolean): ModelChoice | undefined {
  if (!isObject(raw)) {
    if (strict) throw invalid(`${where} must be an object`);
    return undefined;
  }
  const field = (name: "harnessId" | "providerID" | "modelID"): string | undefined => {
    const value = raw[name];
    const text = typeof value === "string" ? value.trim() : "";
    if (!text || text.length > MAX_ID_CHARS || HAS_CONTROL.test(text)) {
      if (strict) throw invalid(`${where}.${name} must be a non-empty string of at most ${MAX_ID_CHARS} characters`);
      return undefined;
    }
    return text;
  };
  const harnessId = field("harnessId");
  const providerID = field("providerID");
  const modelID = field("modelID");
  if (harnessId === undefined || providerID === undefined || modelID === undefined) return undefined;
  if (harnessId.includes("::")) {
    if (strict) throw invalid(`${where}.harnessId must not contain "::"`);
    return undefined;
  }
  if (providerID.includes("/")) {
    if (strict) throw invalid(`${where}.providerID must not contain "/"`);
    return undefined;
  }
  const choice: ModelChoice = { harnessId, providerID, modelID };
  if (raw.maxConcurrent !== undefined) {
    const n = intIn(raw.maxConcurrent, POLICY_LIMITS.maxConcurrent.min, POLICY_LIMITS.maxConcurrent.max);
    if (n === undefined) {
      if (strict) throw invalid(`${where}.maxConcurrent must be an integer ${POLICY_LIMITS.maxConcurrent.min}..${POLICY_LIMITS.maxConcurrent.max}`);
    } else choice.maxConcurrent = n;
  }
  return choice;
}

function modelsOf(raw: unknown, where: string, strict: boolean): ModelChoice[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    if (strict) throw invalid(`${where}.models must be a list`);
    return [];
  }
  if (strict && raw.length > POLICY_LIMITS.modelsPerRole) throw invalid(`${where} holds at most ${POLICY_LIMITS.modelsPerRole} models`);
  const seen = new Set<string>();
  const out: ModelChoice[] = [];
  raw.forEach((item, index) => {
    const choice = choiceOf(item, `${where}.models[${index}]`, strict);
    if (!choice) return;
    const key = modelKey(choice);
    if (seen.has(key)) {
      if (strict) throw invalid(`${where} lists ${key} twice`);
      return;
    }
    if (out.length >= POLICY_LIMITS.modelsPerRole) return;
    seen.add(key);
    out.push(choice);
  });
  return out;
}

function rolesOf(raw: unknown, strict: boolean): RoutingRole[] {
  if (raw !== undefined && !Array.isArray(raw)) {
    if (strict) throw invalid("roles must be a list");
    raw = undefined;
  }
  const list = (raw ?? []) as unknown[];
  const builtin = new Map<string, RoutingRole>();
  const custom: RoutingRole[] = [];
  const ids = new Set<string>();
  list.forEach((item, index) => {
    const where = `roles[${index}]`;
    if (!isObject(item)) {
      if (strict) throw invalid(`${where} must be an object`);
      return;
    }
    const id = typeof item.id === "string" ? item.id : "";
    if (ids.has(id) && id) {
      if (strict) throw invalid(`${where}: duplicate role id "${id}"`);
      return;
    }
    const enabled = item.enabled === undefined ? true : item.enabled === true;
    if (strict && item.enabled !== undefined && typeof item.enabled !== "boolean") throw invalid(`${where}.enabled must be true or false`);
    if (isBuiltinRole(id)) {
      ids.add(id);
      builtin.set(id, { id, enabled, models: modelsOf(item.models, where, strict) });
      return;
    }
    if (!CUSTOM_ID.test(id)) {
      if (strict) throw invalid(`${where}.id must be a built-in role or match ${CUSTOM_ROLE_PREFIX}<a-z0-9-> (1..32)`);
      return;
    }
    const label = typeof item.label === "string" ? oneLine(item.label) : "";
    const when = typeof item.when === "string" ? oneLine(item.when) : "";
    if (label.length < 1 || label.length > POLICY_LIMITS.labelChars) {
      if (strict) throw invalid(`${where}.label must be 1..${POLICY_LIMITS.labelChars} characters`);
      return;
    }
    if (when.length < 1 || when.length > POLICY_LIMITS.whenChars) {
      if (strict) throw invalid(`${where}.when must be 1..${POLICY_LIMITS.whenChars} characters`);
      return;
    }
    if (custom.length >= POLICY_LIMITS.customRoles) {
      if (strict) throw invalid(`At most ${POLICY_LIMITS.customRoles} custom roles`);
      return;
    }
    ids.add(id);
    custom.push({ id, label, when, enabled, models: modelsOf(item.models, where, strict) });
  });
  return [
    ...BUILTIN_ROLE_IDS.map((id) => builtin.get(id) ?? { id, enabled: true, models: [] }),
    ...custom,
  ];
}

function excludedOf(raw: unknown, strict: boolean): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    if (strict) throw invalid("excluded must be a list");
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const parsed = typeof item === "string" && item.length <= 3 * MAX_ID_CHARS ? parseModelKey(item.trim()) : undefined;
    if (!parsed) {
      if (strict) throw invalid(`excluded: "${typeof item === "string" ? oneLine(item).slice(0, 60) : typeof item}" is not a harness::provider/model key`);
      continue;
    }
    const key = modelKey(parsed);
    if (seen.has(key)) continue;
    if (out.length >= POLICY_LIMITS.excluded) {
      if (strict) throw invalid(`excluded holds at most ${POLICY_LIMITS.excluded} models`);
      break;
    }
    seen.add(key);
    out.push(key);
  }
  return out;
}

function build(input: unknown, strict: boolean): RoutingPolicy {
  if (!isObject(input)) {
    if (strict) throw invalid("policy must be an object");
    input = {};
  }
  const raw = input as Record<string, unknown>;
  let mode: RoutingMode = DEFAULT_POLICY.mode;
  if (raw.mode === "auto" || raw.mode === "roles") mode = raw.mode;
  else if (strict) throw invalid('mode must be "auto" or "roles"');
  let whenExhausted: ExhaustedBehavior = DEFAULT_POLICY.whenExhausted;
  if (raw.whenExhausted === "shortlist" || raw.whenExhausted === "direct") whenExhausted = raw.whenExhausted;
  else if (strict) throw invalid('whenExhausted must be "shortlist" or "direct"');

  let quotaCeiling = DEFAULT_POLICY.quotaCeiling;
  const q = intIn(raw.quotaCeiling, POLICY_LIMITS.quotaCeiling.min, POLICY_LIMITS.quotaCeiling.max);
  if (q !== undefined) quotaCeiling = q;
  else if (strict) throw invalid(`quotaCeiling must be an integer ${POLICY_LIMITS.quotaCeiling.min}..${POLICY_LIMITS.quotaCeiling.max}`);

  let overPaceCeiling: number | null = DEFAULT_POLICY.overPaceCeiling;
  if (raw.overPaceCeiling === null) overPaceCeiling = null;
  else {
    const o = intIn(raw.overPaceCeiling, POLICY_LIMITS.overPaceCeiling.min, quotaCeiling);
    if (o !== undefined) overPaceCeiling = o;
    else if (strict) throw invalid(`overPaceCeiling must be null or an integer ${POLICY_LIMITS.overPaceCeiling.min}..${quotaCeiling}`);
    else if (overPaceCeiling !== null && overPaceCeiling > quotaCeiling) overPaceCeiling = quotaCeiling;
  }

  let maxChildren = DEFAULT_POLICY.maxChildren;
  const m = intIn(raw.maxChildren, POLICY_LIMITS.maxChildren.min, POLICY_LIMITS.maxChildren.max);
  if (m !== undefined) maxChildren = m;
  else if (strict) throw invalid(`maxChildren must be an integer ${POLICY_LIMITS.maxChildren.min}..${POLICY_LIMITS.maxChildren.max}`);

  return {
    mode,
    roles: rolesOf(raw.roles, strict),
    quotaCeiling,
    overPaceCeiling,
    whenExhausted,
    maxChildren,
    excluded: excludedOf(raw.excluded, strict),
  };
}

/** Strict, for writes: throws `invalid-input` naming the first problem. */
export function parsePolicy(input: unknown): RoutingPolicy {
  return build(input, true);
}

/** Lenient, for reads: drops what is invalid, fills defaults, never throws. */
export function normalizeStoredPolicy(raw: unknown): RoutingPolicy {
  try {
    return build(raw, false);
  } catch {
    return build({}, false);
  }
}

const canonical = (policy: RoutingPolicy): string => JSON.stringify({
  mode: policy.mode,
  roles: policy.roles.map((role) => ({
    id: role.id,
    ...(role.label !== undefined ? { label: role.label } : {}),
    ...(role.when !== undefined ? { when: role.when } : {}),
    enabled: role.enabled,
    models: role.models.map((c) => ({
      harnessId: c.harnessId,
      providerID: c.providerID,
      modelID: c.modelID,
      ...(c.maxConcurrent !== undefined ? { maxConcurrent: c.maxConcurrent } : {}),
    })),
  })),
  quotaCeiling: policy.quotaCeiling,
  overPaceCeiling: policy.overPaceCeiling,
  whenExhausted: policy.whenExhausted,
  maxChildren: policy.maxChildren,
  excluded: policy.excluded,
});

/** 12 hex of sha256 over the canonical JSON. The unsaved default is `"default"` (see the store). */
export function policyRevision(policy: RoutingPolicy): string {
  return createHash("sha256").update(canonical(policy)).digest("hex").slice(0, 12);
}
