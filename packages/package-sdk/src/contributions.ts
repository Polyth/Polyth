import { parseRemoteUiTree, type RemoteUiNode } from "./remoteUi.ts";

export const CONTRIBUTION_RESULT_MAX_BYTES = 128 * 1024;
export const CONTRIBUTION_MAX_RESOURCES = 20;
export const CONTRIBUTION_MAX_CONTEXT_ITEMS = 12;
const PACKAGE_JSON_MAX_DEPTH = 12;
const PACKAGE_JSON_MAX_ITEMS = 512;
const PACKAGE_JSON_MAX_ARRAY_ITEMS = 128;
const PACKAGE_JSON_MAX_KEY = 160;
const DANGEROUS_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export type PackageJsonPrimitive = string | number | boolean | null;
export type PackageJsonValue = PackageJsonPrimitive | PackageJsonValue[] | { [key: string]: PackageJsonValue };
export type PackageJsonObject = { [key: string]: PackageJsonValue };

export interface ExternalResource {
  provider: string;
  resourceId: string;
  title: string;
  subtitle?: string;
  url?: string;
  summary?: string;
  text?: string;
  retrievedAt?: number;
  freshUntil?: number;
  metadata?: PackageJsonObject;
  provenance?: {
    source?: string;
    uri?: string;
    retrievedAt?: number;
  };
}

export interface StructuredContext {
  provider: string;
  sourceId: string;
  title: string;
  uri?: string;
  retrievedAt: number;
  freshUntil?: number;
  summary: string;
  content: string;
  metadata?: PackageJsonObject;
}

export type ContributionInvocationKind =
  | "composer-action"
  | "attachment-provider"
  | "message-action"
  | "session-action"
  | "command"
  | "tool-renderer"
  | "status-badge"
  | "settings-section"
  | "context-provider"
  | "widget"
  | "surface";

export interface ContributionInvocationBase {
  invocationId: string;
  lease: string;
  expiresAt: number;
  kind: ContributionInvocationKind;
  contributionId: string;
  spaceId: string;
  projectId?: string;
  sessionId?: string;
}

export interface MessageActionInvocation extends ContributionInvocationBase {
  kind: "message-action";
  message: {
    id: string;
    role: "user" | "assistant" | "tool";
    text?: string;
    toolName?: string;
  };
}

export interface SessionActionInvocation extends ContributionInvocationBase {
  kind: "session-action";
  session: {
    id: string;
    title: string;
    status?: string;
  };
}

export interface CommandInvocation extends ContributionInvocationBase {
  kind: "command";
  query: string;
  arguments: string;
}

export interface ToolRendererInvocation extends ContributionInvocationBase {
  kind: "tool-renderer";
  tool: {
    callId: string;
    name: string;
    input?: PackageJsonObject;
    output?: PackageJsonValue;
    error?: string;
  };
}

export interface ResourceInvocation extends ContributionInvocationBase {
  kind: "attachment-provider" | "context-provider";
  query?: string;
}

export interface UiContributionInvocation extends ContributionInvocationBase {
  kind: "composer-action" | "settings-section" | "status-badge" | "widget" | "surface";
  input?: PackageJsonObject;
}

export type ContributionInvocation =
  | MessageActionInvocation
  | SessionActionInvocation
  | CommandInvocation
  | ToolRendererInvocation
  | ResourceInvocation
  | UiContributionInvocation;

export interface ContributionResult {
  resources?: ExternalResource[];
  context?: StructuredContext[];
  ui?: RemoteUiNode;
  status?: {
    label: string;
    tone?: "neutral" | "info" | "success" | "warning" | "danger";
  };
  message?: string;
}

export interface ContributionCompletion {
  invocationId: string;
  lease: string;
  ok: boolean;
  result?: ContributionResult;
  error?: { message: string };
}

const invalid: (message: string) => never = (message) => {
  throw Object.assign(new Error(message), { code: "INVALID_REQUEST" });
};

const asRecord = (value: unknown, message: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(message);
  return value as Record<string, unknown>;
};

const boundedString = (value: unknown, label: string, max: number, required = false): string | undefined => {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") invalid(`${label} must be a string`);
  const text = value.trim();
  if ((required && !text) || text.length > max || /[\0\r]/.test(text)) invalid(`${label} is invalid`);
  return text || undefined;
};

const finiteNumber = (value: unknown, label: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(`${label} must be finite`);
  return value;
};

const httpsUrl = (value: unknown, label: string): string | undefined => {
  const raw = boundedString(value, label, 2_000);
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return invalid(`${label} must be an https URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) invalid(`${label} must be an https URL without credentials`);
  return parsed.toString();
};

function jsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? "null").byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function sanitizeJsonValue(
  value: unknown,
  label: string,
  depth: number,
  state: { items: number },
): PackageJsonValue {
  if (depth > PACKAGE_JSON_MAX_DEPTH) invalid(`${label} exceeds depth limit`);
  state.items += 1;
  if (state.items > PACKAGE_JSON_MAX_ITEMS) invalid(`${label} has too many items`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${label} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > PACKAGE_JSON_MAX_ARRAY_ITEMS) invalid(`${label} array is too large`);
    return value.map((item) => sanitizeJsonValue(item, label, depth + 1, state));
  }
  if (!value || typeof value !== "object") invalid(`${label} contains an unsupported value`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} contains a non-plain object`);
  const out: PackageJsonObject = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!key || key.length > PACKAGE_JSON_MAX_KEY || DANGEROUS_JSON_KEYS.has(key)) {
      invalid(`${label} contains an unsafe key`);
    }
    out[key] = sanitizeJsonValue(item, label, depth + 1, state);
  }
  return out;
}

function boundedJsonObject(value: unknown, label: string, maxBytes = 16 * 1024): PackageJsonObject | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || jsonBytes(value) > maxBytes) {
    invalid(`${label} is invalid or too large`);
  }
  const parsed = sanitizeJsonValue(value, label, 0, { items: 0 });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid(`${label} must be an object`);
  return parsed as PackageJsonObject;
}

function parseExternalResource(value: unknown): ExternalResource {
  const raw = asRecord(value, "extension resource must be an object");
  const provider = boundedString(raw.provider, "resource provider", 120, true)!;
  const resourceId = boundedString(raw.resourceId, "resource id", 240, true)!;
  const title = boundedString(raw.title, "resource title", 240, true)!;
  const subtitle = boundedString(raw.subtitle, "resource subtitle", 240);
  const url = httpsUrl(raw.url, "resource URL");
  const summary = boundedString(raw.summary, "resource summary", 4_000);
  const text = boundedString(raw.text, "resource text", 16_000);
  const retrievedAt = finiteNumber(raw.retrievedAt, "resource retrievedAt");
  const freshUntil = finiteNumber(raw.freshUntil, "resource freshUntil");
  const metadata = boundedJsonObject(raw.metadata, "resource metadata");
  let provenance: ExternalResource["provenance"];
  if (raw.provenance !== undefined) {
    const p = asRecord(raw.provenance, "resource provenance must be an object");
    const source = boundedString(p.source, "resource provenance source", 240);
    const uri = httpsUrl(p.uri, "resource provenance URI");
    const provenanceRetrievedAt = finiteNumber(p.retrievedAt, "resource provenance retrievedAt");
    provenance = {
      ...(source ? { source } : {}),
      ...(uri ? { uri } : {}),
      ...(provenanceRetrievedAt !== undefined ? { retrievedAt: provenanceRetrievedAt } : {}),
    };
  }
  return {
    provider,
    resourceId,
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(url ? { url } : {}),
    ...(summary ? { summary } : {}),
    ...(text ? { text } : {}),
    ...(retrievedAt !== undefined ? { retrievedAt } : {}),
    ...(freshUntil !== undefined ? { freshUntil } : {}),
    ...(metadata ? { metadata } : {}),
    ...(provenance && Object.keys(provenance).length ? { provenance } : {}),
  };
}

function parseStructuredContext(value: unknown): StructuredContext {
  const raw = asRecord(value, "extension context must be an object");
  const provider = boundedString(raw.provider, "context provider", 120, true)!;
  const sourceId = boundedString(raw.sourceId, "context source id", 240, true)!;
  const title = boundedString(raw.title, "context title", 240, true)!;
  const uri = httpsUrl(raw.uri, "context URI");
  const retrievedAt = finiteNumber(raw.retrievedAt, "context retrievedAt") ?? Date.now();
  const freshUntil = finiteNumber(raw.freshUntil, "context freshUntil");
  const summary = boundedString(raw.summary, "context summary", 4_000) ?? "";
  const content = boundedString(raw.content, "context content", 24_000, true)!;
  const metadata = boundedJsonObject(raw.metadata, "context metadata");
  return {
    provider,
    sourceId,
    title,
    ...(uri ? { uri } : {}),
    retrievedAt,
    ...(freshUntil !== undefined ? { freshUntil } : {}),
    summary,
    content,
    ...(metadata ? { metadata } : {}),
  };
}

export function parseContributionResult(value: unknown): ContributionResult {
  const raw = asRecord(value, "extension contribution result must be an object");
  if (jsonBytes(raw) > CONTRIBUTION_RESULT_MAX_BYTES) invalid("extension contribution result exceeds size limit");

  let resources: ExternalResource[] | undefined;
  if (raw.resources !== undefined) {
    if (!Array.isArray(raw.resources) || raw.resources.length > CONTRIBUTION_MAX_RESOURCES) {
      invalid("extension contribution returned too many resources");
    }
    resources = raw.resources.map(parseExternalResource);
  }

  let context: StructuredContext[] | undefined;
  if (raw.context !== undefined) {
    if (!Array.isArray(raw.context) || raw.context.length > CONTRIBUTION_MAX_CONTEXT_ITEMS) {
      invalid("extension contribution returned too many context items");
    }
    context = raw.context.map(parseStructuredContext);
  }

  const ui = raw.ui === undefined ? undefined : parseRemoteUiTree(raw.ui);
  let status: ContributionResult["status"];
  if (raw.status !== undefined) {
    const s = asRecord(raw.status, "extension contribution status must be an object");
    const label = boundedString(s.label, "extension contribution status label", 240, true)!;
    const tone = s.tone === "neutral" || s.tone === "info" || s.tone === "success" || s.tone === "warning" || s.tone === "danger"
      ? s.tone
      : s.tone === undefined ? undefined : invalid("extension contribution status tone is invalid");
    status = { label, ...(tone ? { tone } : {}) };
  }
  const message = boundedString(raw.message, "extension contribution message", 4_000);
  return {
    ...(resources?.length ? { resources } : {}),
    ...(context?.length ? { context } : {}),
    ...(ui ? { ui } : {}),
    ...(status ? { status } : {}),
    ...(message ? { message } : {}),
  };
}

export function parseContributionCompletion(value: unknown): ContributionCompletion {
  const raw = asRecord(value, "extension contribution completion must be an object");
  if (jsonBytes(raw) > CONTRIBUTION_RESULT_MAX_BYTES) invalid("extension contribution completion exceeds size limit");
  const invocationId = boundedString(raw.invocationId, "invocation id", 128, true)!;
  const lease = boundedString(raw.lease, "invocation lease", 256, true)!;
  if (typeof raw.ok !== "boolean") invalid("extension contribution completion ok must be boolean");
  const ok = raw.ok;
  const result = raw.result === undefined ? undefined : parseContributionResult(raw.result);
  let error: ContributionCompletion["error"];
  if (raw.error !== undefined) {
    const e = asRecord(raw.error, "extension contribution error must be an object");
    const message = boundedString(e.message, "extension contribution error message", 4_000, true)!;
    error = { message };
  }
  if (!ok && !error) invalid("failed extension contribution must include an error");
  if (!ok && result) invalid("failed extension contribution must not include a result");
  if (ok && error) invalid("successful extension contribution must not include an error");
  return {
    invocationId,
    lease,
    ok,
    ...(result ? { result } : {}),
    ...(error ? { error } : {}),
  };
}
