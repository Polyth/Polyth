import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AgentDescriptor,
  AvailableProviderDescriptor,
  JsonObject,
  ModelDescriptor,
  ModelMessage,
  MutationOutcome,
  MutationTransportResult,
  OpenCodeTransport,
  ProtocolAdapter,
  ProtocolCapabilities,
  ProviderAuthMethod,
  ProviderAuthorization,
  RuntimeEndpoint,
  RuntimeEvent,
  RuntimeLocation,
  RuntimeReconciliationBinding,
  RuntimeSession,
  RuntimeSessionBinding,
  RuntimeSessionMessage,
  RuntimeSnapshot,
  RuntimeTurnBinding,
} from "@polyth/contracts";
import { formatBrowserContextForModel } from "@polyth/contracts";
import {
  comparableStatusRevision,
  createTranslateState,
  type ObservationBinding,
} from "./events.ts";
import { createProviderHttpClient } from "./providerHttp.ts";
import { appendPulledEvents } from "./reconciliationEvents.ts";

export type LegacyPromptPath = "prompt_async" | "message";

interface LegacyProviderList {
  all?: Array<{
    id: string;
    name?: string;
    models?: Record<string, {
      id?: string;
      name?: string;
      limit?: { context?: number };
      cost?: { input?: number; output?: number };
      capabilities?: {
        attachment?: boolean;
        toolcall?: boolean;
        input?: Record<string, boolean>;
        output?: Record<string, boolean>;
      };
      variants?: Record<string, unknown>;
    }>;
  }>;
  connected?: string[];
}

interface LegacyAgent {
  name: string;
  description?: string;
  mode?: string;
  prompt?: string;
  model?: { providerID?: string; modelID?: string };
  options?: unknown;
}

interface LegacySession {
  id: string;
  title?: string;
  parentID?: string;
  operationID?: string;
  operationId?: string;
  time?: { created?: number; updated?: number };
}

interface LegacyMessage {
  info?: { role?: string; id?: string };
  parts?: Array<{ type?: string; text?: string }>;
}

export interface CreateLegacyProtocolAdapterOptions {
  transport: OpenCodeTransport;
  endpoint: RuntimeEndpoint;
  deadlineMs?: number;
  /** Read-only OpenAPI negotiation result. */
  promptPaths?: ReadonlyArray<LegacyPromptPath>;
}

const NEVER_REPLAY = { kind: "never" } as const;

const protocolCapabilities: ProtocolCapabilities = {
  eventReplay: "none",
  pendingSnapshot: "partial",
  idempotentMutations: new Set(),
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const unwrap = (value: unknown): unknown => asRecord(value)?.data ?? value;

const asArray = (value: unknown): unknown[] => {
  const unwrapped = unwrap(value);
  return Array.isArray(unwrapped) ? unwrapped : [];
};

const withLocation = (path: string, location: RuntimeLocation): string => {
  const params = new URLSearchParams({ directory: location.directory });
  if (location.workspace) params.set("workspace", location.workspace);
  return `${path}${path.includes("?") ? "&" : "?"}${params.toString()}`;
};

const sameLocation = (left: RuntimeLocation, right: RuntimeLocation): boolean =>
  left.directory === right.directory
  && (left.workspace ?? "") === (right.workspace ?? "");

const bindingError = (
  binding: RuntimeSessionBinding,
  endpoint: RuntimeEndpoint,
): string | undefined => {
  if (binding.authorityId !== endpoint.authorityId) return "authority does not match endpoint";
  if (binding.generation !== endpoint.generation) return "endpoint generation is stale";
  if (!sameLocation(binding.location, endpoint.location)) return "location does not match endpoint";
  return undefined;
};

const safeMessage = (body: unknown, fallback: string): string => {
  if (typeof body === "string" && body.trim()) return body.slice(0, 500);
  const record = asRecord(body);
  const error = asRecord(record?.error);
  const data = asRecord(record?.data) ?? asRecord(error?.data);
  for (const candidate of [
    record?.message,
    typeof record?.error === "string" ? record.error : undefined,
    error?.message,
    data?.message,
  ]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.slice(0, 500);
  }
  return fallback;
};

const responseCode = (body: unknown): string => {
  const record = asRecord(body);
  const error = asRecord(record?.error);
  for (const candidate of [
    record?.code,
    record?.name,
    record?._tag,
    error?.code,
    error?.name,
    error?._tag,
    typeof record?.error === "string" ? record.error : undefined,
  ]) {
    if (typeof candidate === "string" && candidate) return candidate.toLowerCase();
  }
  return "";
};

const isUnsupported = (status: number, body: unknown): boolean => {
  const text = `${responseCode(body)} ${safeMessage(body, "")}`.toLowerCase();
  return status === 405
    || text.includes("unsupported")
    || text.includes("not implemented")
    || text.includes("capability");
};

/**
 * Operation-specific adapters provide the 2xx decoder. This shared classifier
 * is deliberately conservative: an unclassified 5xx remains unknown.
 */
export const classifyLegacyMutationResponse = <T>(
  result: MutationTransportResult<unknown>,
  operationId: string,
  confirmed: (body: unknown) => T | undefined,
): MutationOutcome<T> => {
  if (result.kind === "unknown") {
    return {
      kind: "unknown",
      operationId,
      message: result.message,
    };
  }
  if (result.status >= 200 && result.status < 300) {
    const value = confirmed(result.body);
    if (value !== undefined) return { kind: "confirmed", value };
    return {
      kind: "unknown",
      operationId,
      message: "OpenCode returned an unrecognized success response",
    };
  }
  if (isUnsupported(result.status, result.body)) {
    return {
      kind: "rejected",
      code: "capability-unsupported",
      message: safeMessage(result.body, "OpenCode operation is unsupported"),
    };
  }
  if (
    result.status === 400
    || result.status === 401
    || result.status === 403
    || result.status === 404
    || result.status === 409
    || result.status === 415
    || result.status === 422
  ) {
    const code =
      result.status === 400 || result.status === 415 || result.status === 422
        ? "validation"
        : `http-${result.status}`;
    return {
      kind: "rejected",
      code,
      message: safeMessage(result.body, `OpenCode rejected the operation (${result.status})`),
    };
  }
  return {
    kind: "unknown",
    operationId,
    message: safeMessage(
      result.body,
      `OpenCode returned an ambiguous HTTP ${result.status} response`,
    ),
  };
};

export const legacyPromptPathsFromDocument = (document: unknown): LegacyPromptPath[] => {
  const root = asRecord(document);
  const paths = asRecord(root?.paths) ?? asRecord(asRecord(root?.data)?.paths);
  if (!paths) return [];
  const names = Object.keys(paths);
  const result: LegacyPromptPath[] = [];
  if (names.some((path) => /\/session\/\{[^}]+\}\/prompt_async$/.test(path))) {
    result.push("prompt_async");
  }
  if (names.some((path) => /\/session\/\{[^}]+\}\/message$/.test(path))) {
    result.push("message");
  }
  return result;
};

const attachmentParts = (
  input: RuntimeTurnBinding,
): JsonObject[] => {
  const parts: JsonObject[] = [];
  // The server guarantees any `_inbox/*` attachment is materialized into the
  // runtime cwd before the turn, so resolving against the session directory is
  // always correct here — no project-root awareness needed.
  const root = resolve(input.session.location.directory);
  for (const attachment of input.attachments ?? []) {
    if (attachment.kind === "browser-context") {
      const ctx = attachment.browserContext;
      if (ctx) {
        parts.push({
          type: "text",
          text: formatBrowserContextForModel(ctx),
        });
        const shot = ctx.crop ?? ctx.screenshot;
        if (shot?.localPath && shot.mime.startsWith("image/")) {
          parts.push({
            type: "file",
            mime: shot.mime,
            filename: attachment.name || `${ctx.type}-capture`,
            url: pathToFileURL(shot.localPath).href,
          });
        }
      }
      continue;
    }
    if (attachment.kind === "url") {
      if (attachment.url && /^https?:\/\//i.test(attachment.url)) {
        parts.push({
          type: "text",
          text: `[Attached link: ${attachment.name}] ${attachment.url}`,
        });
      }
      continue;
    }
    if (!attachment.path) continue;
    const absolute = resolve(root, attachment.path);
    const pathFromRoot = relative(root, absolute);
    if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) continue;
    let url = pathToFileURL(absolute).href;
    if (attachment.kind === "range" && attachment.range) {
      url += `?start=${attachment.range[0]}&end=${attachment.range[1]}`;
    }
    parts.push({
      type: "file",
      mime: attachment.mime,
      filename: attachment.name,
      url,
    });
  }
  return parts;
};

const turnBody = (input: RuntimeTurnBinding): JsonObject => {
  const body: JsonObject = {
    parts: [
      { type: "text", text: input.text },
      ...attachmentParts(input),
    ],
  };
  if (input.model) {
    body.model = {
      providerID: input.model.providerID,
      modelID: input.model.modelID,
    };
    if (input.model.variant) body.variant = input.model.variant;
  }
  if (input.agent) body.agent = input.agent;
  return body;
};

const queryOptional = async (
  transport: OpenCodeTransport,
  path: string,
  deadlineMs: number,
): Promise<{ ok: true; value: unknown } | { ok: false }> => {
  try {
    const result = await transport.query<unknown>({ method: "GET", path, deadlineMs });
    const response = asRecord(result);
    if (typeof response?.status === "number") {
      if (response.status < 200 || response.status >= 300) return { ok: false };
      return { ok: true, value: response.body };
    }
    return {
      ok: true,
      value: result,
    };
  } catch {
    return { ok: false };
  }
};

const queryRequired = async <T,>(
  transport: OpenCodeTransport,
  path: string,
  deadlineMs: number,
): Promise<T> => {
  const result = await transport.query<unknown>({ method: "GET", path, deadlineMs });
  const response = asRecord(result);
  if (typeof response?.status !== "number") return result as T;
  if (response.status < 200 || response.status >= 300) {
    throw Object.assign(new Error(`OpenCode GET ${path} returned ${response.status}`), {
      code: `http-${response.status}`,
    });
  }
  return response.body as T;
};

/** OpenCode only generates a semantic title when creation omits placeholder
 * titles. Polyth placeholders are UI state, not user-authored backend titles. */
const createBody = (title?: string, sessionId?: string): JsonObject => {
  const normalized = title?.trim();
  const value = normalized?.toLowerCase() ?? "";
  const placeholder = !normalized
    || normalized === sessionId
    || value === "new session"
    || value === "untitled"
    || value === "untitled session"
    || value === "(untitled)"
    || value === "(untitled session)"
    || value === "polyth multirun"
    || value === "polyth small-model task"
    || /^new session - \d{4}-\d{2}-\d{2}t/.test(value)
    || normalized.startsWith("ses_")
    || /^[0-9a-f-]{8,}$/i.test(normalized);
  return placeholder ? {} : { title: normalized };
};

export const flattenLegacyModels = (body: LegacyProviderList): ModelDescriptor[] => {
  const connected = new Set(body.connected ?? []);
  const hasConnectedSignal = connected.size > 0;
  return (body.all ?? []).flatMap((provider) =>
    Object.entries(provider.models ?? {}).map(([key, model]) => {
      const capabilities: string[] = [];
      if (model.capabilities?.attachment) capabilities.push("attachment");
      if (model.capabilities?.toolcall) capabilities.push("toolcall");
      for (const direction of ["input", "output"] as const) {
        const reported = model.capabilities?.[direction];
        if (reported === undefined) continue;
        const modalities = Object.entries(reported)
          .filter(([, supported]) => supported)
          .map(([modality]) => modality)
          .sort();
        if (modalities.length === 0) capabilities.push(`${direction}:none`);
        else for (const modality of modalities) capabilities.push(`${direction}:${modality}`);
      }
      return {
        providerID: provider.id,
        modelID: model.id ?? key,
        name: model.name ?? key,
        ...(provider.name ? { providerName: provider.name } : {}),
        ...(typeof model.limit?.context === "number"
          ? { context: model.limit.context }
          : {}),
        ...(typeof model.cost?.input === "number" && typeof model.cost.output === "number"
          ? { cost: { input: model.cost.input, output: model.cost.output } }
          : {}),
        ...(capabilities.length > 0 || model.capabilities
          ? { capabilities }
          : {}),
        ...(model.variants && Object.keys(model.variants).length > 0
          ? { variants: Object.keys(model.variants) }
          : {}),
        connected: hasConnectedSignal ? connected.has(provider.id) : true,
      };
    }));
};

interface HistoryEntry {
  role: "user" | "assistant";
  text: string;
}

const mergeHistoryEntry = (
  target: HistoryEntry[],
  role: "user" | "assistant",
  text: string,
): void => {
  if (!text) return;
  const previous = target.at(-1);
  if (previous?.role === role) previous.text = `${previous.text}\n${text}`;
  else target.push({ role, text });
};

const backendMessageEntries = (
  messages: LegacyMessage[],
): Array<HistoryEntry & { id: string }> =>
  messages.flatMap((message) => {
    const role = message.info?.role;
    const id = message.info?.id;
    if ((role !== "user" && role !== "assistant") || typeof id !== "string") return [];
    const text = (message.parts ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim();
    return [{ id, role, text }];
  });

const normalizedBackendHistory = (
  entries: Array<HistoryEntry & { id?: string }>,
): HistoryEntry[] => {
  const result: HistoryEntry[] = [];
  for (const entry of entries) mergeHistoryEntry(result, entry.role, entry.text);
  return result;
};

const normalizedCanonicalHistory = (messages: ModelMessage[]): HistoryEntry[] => {
  const result: HistoryEntry[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => "text" in part ? part.text : "")
      .join("\n")
      .trim();
    mergeHistoryEntry(result, message.role, text);
  }
  return result;
};

const sameHistory = (left: HistoryEntry[], right: HistoryEntry[]): boolean =>
  left.length === right.length
  && left.every((entry, index) =>
    entry.role === right[index]?.role && entry.text === right[index]?.text);

const confirmedEmpty = (): Record<string, never> => ({});

const completedHistoryTerminalState = (
  value: unknown,
): RuntimeSnapshot["state"] | undefined => {
  const messages = asArray(unwrap(value));
  const latest = [...messages].reverse().map(asRecord).find((message) => {
    const role = asRecord(message?.info)?.role;
    return role === "user" || role === "assistant";
  });
  const info = asRecord(latest?.info);
  const completed = asRecord(info?.time)?.completed;
  if (
    info?.role !== "assistant"
    || typeof completed !== "number"
    || !Number.isSafeInteger(completed)
    || completed < 0
  ) {
    return undefined;
  }
  return {
    value: "idle",
    watermark: String(completed),
    comparison: {
      domain: "legacy-history:assistant-completed",
      order: completed,
    },
  };
};

const statusAllowsHistoryTerminal = (
  value: unknown,
  backendSessionId: string,
): boolean => {
  const map = asRecord(unwrap(value));
  if (!map) return false;
  const status = map[backendSessionId];
  if (status === undefined) return true;
  const kind = typeof status === "string"
    ? status
    : typeof asRecord(status)?.type === "string"
      ? String(asRecord(status)?.type)
      : "";
  return kind === "idle";
};

const statusFor = (
  value: unknown,
  backendSessionId: string,
): RuntimeSnapshot["state"] => {
  const unwrapped = unwrap(value);
  const map = asRecord(unwrapped);
  const status = map?.[backendSessionId];
  const kind = typeof status === "string"
    ? status
    : typeof asRecord(status)?.type === "string"
      ? String(asRecord(status)?.type)
      : "";
  const statusRecord = asRecord(status);
  const revision = explicitRevision(statusRecord);
  const comparable = comparableStatusRevision(statusRecord);
  // Busy is positive current evidence. Terminal/idle claims are destructive
  // admission evidence and require a protocol-provided comparable revision.
  if (kind === "busy" || kind === "running") {
    return {
      value: "running",
      ...(revision ? { watermark: revision } : {}),
      ...(comparable ? { comparison: comparable.comparison } : {}),
    };
  }
  if (kind === "idle" && comparable) return { value: "idle", ...comparable };
  if (kind === "failed" && comparable) return { value: "failed", ...comparable };
  if (kind === "interrupted" && comparable) {
    return { value: "interrupted", ...comparable };
  }
  return { value: "unknown" };
};

const explicitRevision = (
  value: Record<string, unknown> | undefined,
): string | undefined => {
  for (const key of ["revision", "version", "seq", "sequence", "updatedAt"]) {
    const revision = value?.[key];
    if (typeof revision === "string" && revision) return revision;
    if (typeof revision === "number" && Number.isFinite(revision)) return String(revision);
  }
  return undefined;
};

const requestRevision = (
  value: Record<string, unknown> | undefined,
  fallback: string,
): string => explicitRevision(value) ?? fallback;

const permissionOf = (
  value: unknown,
  backendSessionId: string,
): RuntimeSnapshot["permissions"][number] | undefined => {
  const request = asRecord(value);
  if (!request || request.sessionID !== backendSessionId || typeof request.id !== "string") {
    return undefined;
  }
  const patterns = Array.isArray(request.patterns)
    ? request.patterns.filter((item): item is string => typeof item === "string")
    : Array.isArray(request.pattern)
      ? request.pattern.filter((item): item is string => typeof item === "string")
      : typeof request.pattern === "string"
        ? [request.pattern]
        : [];
  return {
    requestId: request.id,
    permission: typeof request.permission === "string"
      ? request.permission
      : typeof request.type === "string"
        ? request.type
        : "unknown",
    patterns,
    revision: requestRevision(request, "pending"),
  };
};

const questionOf = (
  value: unknown,
  backendSessionId: string,
): RuntimeSnapshot["questions"][number] | undefined => {
  const request = asRecord(value);
  if (!request || request.sessionID !== backendSessionId || typeof request.id !== "string") {
    return undefined;
  }
  return {
    requestId: request.id,
    questions: Array.isArray(request.questions)
      ? request.questions.filter(
          (question): question is JsonObject =>
            question !== null && typeof question === "object" && !Array.isArray(question),
        )
      : [],
    revision: requestRevision(request, "pending"),
  };
};

export const createLegacyProtocolAdapter = (
  options: CreateLegacyProtocolAdapterOptions,
): ProtocolAdapter => {
  const deadlineMs = options.deadlineMs ?? 10_000;
  let promptPaths = options.promptPaths ? [...options.promptPaths] : undefined;
  let reconciliationOrdinal = 0;
  const freshSessionEvidence = new Map<string, string>();

  const negotiatePromptPaths = async (): Promise<LegacyPromptPath[]> => {
    if (promptPaths) return promptPaths;
    const document = await queryOptional(
      options.transport,
      withLocation("/doc", options.endpoint.location),
      deadlineMs,
    );
    promptPaths = document.ok ? legacyPromptPathsFromDocument(document.value) : [];
    // Some compatible legacy servers omit /doc (or publish an incomplete
    // document) while still implementing OpenCode's long-standing async
    // prompt endpoint. Choose exactly this one known endpoint; a definitive
    // unsupported response removes it for later operations, never replaying
    // the current turn against another route.
    if (promptPaths.length === 0) promptPaths = ["prompt_async"];
    return promptPaths;
  };

  const providerHttp = createProviderHttpClient({
    locate: (path) => withLocation(path, options.endpoint.location),
    transport: {
      queryRequired: (path) => queryRequired(options.transport, path, deadlineMs),
      queryOptional: (path) => queryOptional(options.transport, path, deadlineMs),
      mutate: async (method, path, body, extra) => options.transport.mutate<unknown>({
        method,
        path,
        body,
        deadlineMs: extra?.deadlineMs ?? deadlineMs,
        replay: { kind: "never" },
        operationId: extra?.operationId ?? `provider-${method}-${path}`,
      }),
    },
    deadlineMs,
    authMethodsOptional: true,
    operationIdFor: (kind, providerID) => {
      if (kind === "authorize") return `provider-oauth-authorize-${providerID}`;
      if (kind === "callback") return `provider-oauth-callback-${providerID}`;
      if (kind === "auth-remove") return `provider-auth-remove-${providerID}`;
      return `provider-auth-${providerID}`;
    },
  });

  return {
    protocol: "legacy",
    async capabilities() {
      await negotiatePromptPaths();
      return protocolCapabilities;
    },
    async models(): Promise<ModelDescriptor[]> {
      const body = await queryRequired<LegacyProviderList>(
        options.transport,
        withLocation("/provider", options.endpoint.location),
        deadlineMs,
      );
      return flattenLegacyModels(body);
    },
    async agents(): Promise<AgentDescriptor[]> {
      const rows = await queryRequired<LegacyAgent[]>(
        options.transport,
        withLocation("/agent", options.endpoint.location),
        deadlineMs,
      );
      return rows.map((agent) => ({
        name: agent.name,
        ...(agent.description ? { description: agent.description } : {}),
        mode: asRecord(agent.options)?.["polyth.mode"] === "auto"
          || agent.mode === "auto"
          ? "auto"
          : agent.mode === "subagent" || agent.mode === "all" || agent.mode === "primary"
            ? agent.mode
            : "primary",
        ...(agent.prompt ? { prompt: agent.prompt } : {}),
        ...(agent.model?.providerID && agent.model.modelID
          ? { model: { providerID: agent.model.providerID, modelID: agent.model.modelID } }
          : {}),
      }));
    },
    async listAllProviders(): Promise<AvailableProviderDescriptor[]> {
      return providerHttp.listAllProviders();
    },
    async providerAuthMethods(): Promise<Record<string, ProviderAuthMethod[]>> {
      return providerHttp.providerAuthMethods();
    },
    async providerAuthorize(providerID, method, inputs): Promise<ProviderAuthorization> {
      return providerHttp.providerAuthorize(providerID, method, inputs);
    },
    async providerAuthCallback(providerID, method, code): Promise<boolean> {
      return providerHttp.providerAuthCallback(providerID, method, code);
    },
    async setProviderApiKey(providerID, key, metadata): Promise<boolean> {
      return providerHttp.setProviderApiKey(providerID, key, metadata);
    },
    async removeProviderAuth(providerID): Promise<boolean> {
      return providerHttp.removeProviderAuth(providerID);
    },
    async sessions(): Promise<RuntimeSession[]> {
      const rows = await queryRequired<LegacySession[]>(
        options.transport,
        withLocation("/session", options.endpoint.location),
        deadlineMs,
      );
      return rows.map((session) => ({
        id: session.id,
        title: session.title || "Untitled session",
        ...(session.parentID ? { parentId: session.parentID } : {}),
        ...((session.operationID ?? session.operationId)
          ? { operationId: session.operationID ?? session.operationId }
          : {}),
        createdAt: session.time?.created ?? Date.now(),
        updatedAt: session.time?.updated ?? session.time?.created ?? Date.now(),
      }));
    },
    async history(input: RuntimeSessionBinding): Promise<RuntimeSessionMessage[]> {
      const mismatch = bindingError(input, options.endpoint);
      if (mismatch) throw Object.assign(new Error(mismatch), { code: "binding-mismatch" });
      if (!input.backendSessionId) {
        throw Object.assign(new Error("history requires a backend session binding"), {
          code: "binding-missing",
        });
      }
      const rows = await queryRequired<LegacyMessage[]>(
        options.transport,
        withLocation(
          `/session/${encodeURIComponent(input.backendSessionId)}/message?limit=1000`,
          input.location,
        ),
        deadlineMs,
      );
      return rows.flatMap((message) => {
        const role = message.info?.role;
        if (role !== "user" && role !== "assistant") return [];
        const text = (message.parts ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n")
          .slice(0, 20_000);
        const reasoning = (message.parts ?? [])
          .filter((part) => part.type === "reasoning")
          .map((part) => part.text ?? "")
          .join("\n")
          .slice(0, 50_000);
        return text || reasoning ? [{ role, text, ...(reasoning ? { reasoning } : {}) }] : [];
      });
    },
    eventStreamPath() {
      return withLocation("/event", options.endpoint.location);
    },
    async ensureSession(
      input: RuntimeSessionBinding,
      operationId: string,
      title?: string,
    ): Promise<MutationOutcome<{ backendSessionId: string }>> {
      const mismatch = bindingError(input, options.endpoint);
      if (mismatch) {
        return { kind: "rejected", code: "binding-mismatch", message: mismatch };
      }
      if (input.backendSessionId) {
        return {
          kind: "confirmed",
          value: { backendSessionId: input.backendSessionId },
        };
      }
      const result = await options.transport.mutate<unknown>({
        method: "POST",
        path: withLocation("/session", input.location),
        body: createBody(title, input.canonicalSessionId),
        operationId,
        deadlineMs,
        replay: NEVER_REPLAY,
      });
      const outcome = classifyLegacyMutationResponse(result, operationId, (body) => {
        const id = asRecord(unwrap(body))?.id;
        return typeof id === "string" && id ? { backendSessionId: id } : undefined;
      });
      if (outcome.kind === "confirmed") {
        freshSessionEvidence.set(outcome.value.backendSessionId, operationId);
        return {
          ...outcome,
          receipt: outcome.value.backendSessionId,
        };
      }
      return outcome;
    },
    async resetSession(input, title, operationId) {
      const mismatch = bindingError(input, options.endpoint);
      if (mismatch) {
        return { kind: "rejected", code: "binding-mismatch", message: mismatch };
      }
      const result = await options.transport.mutate<unknown>({
        method: "POST",
        path: withLocation("/session", input.location),
        body: createBody(title, input.canonicalSessionId),
        operationId,
        deadlineMs,
        replay: NEVER_REPLAY,
      });
      const outcome = classifyLegacyMutationResponse(result, operationId, (body) => {
        const id = asRecord(unwrap(body))?.id;
        return typeof id === "string" && id ? { backendSessionId: id } : undefined;
      });
      if (outcome.kind === "confirmed") {
        freshSessionEvidence.set(outcome.value.backendSessionId, operationId);
        return {
          ...outcome,
          receipt: outcome.value.backendSessionId,
        };
      }
      return outcome;
    },
    async branchSession(input, operationId) {
      const sourceMismatch = bindingError(input.source, options.endpoint);
      const targetMismatch = bindingError(input.target, options.endpoint);
      const mismatch = sourceMismatch ?? targetMismatch;
      if (mismatch) {
        return { kind: "rejected", code: "binding-mismatch", message: mismatch };
      }
      const wanted = normalizedCanonicalHistory(input.history);
      if (wanted.length === 0) {
        const result = await options.transport.mutate<unknown>({
          method: "POST",
          path: withLocation("/session", input.target.location),
          body: createBody(input.title, input.target.canonicalSessionId),
          operationId,
          deadlineMs,
          replay: NEVER_REPLAY,
        });
        const outcome = classifyLegacyMutationResponse(result, operationId, (body) => {
          const id = asRecord(unwrap(body))?.id;
          return typeof id === "string" && id ? { backendSessionId: id } : undefined;
        });
        if (outcome.kind === "confirmed") {
          freshSessionEvidence.set(outcome.value.backendSessionId, operationId);
          return {
            ...outcome,
            receipt: outcome.value.backendSessionId,
          };
        }
        return outcome;
      }
      const sourceBackendId = input.source.backendSessionId;
      if (!sourceBackendId) {
        return {
          kind: "rejected",
          code: "binding-missing",
          message: "branch requires a source backend session binding",
        };
      }
      const rows = await queryRequired<LegacyMessage[]>(
        options.transport,
        withLocation(
          `/session/${encodeURIComponent(sourceBackendId)}/message?limit=1000`,
          input.source.location,
        ),
        deadlineMs,
      );
      const entries = backendMessageEntries(rows);
      let boundary = -1;
      const accumulated: HistoryEntry[] = [];
      for (let index = 0; index < entries.length; index += 1) {
        mergeHistoryEntry(accumulated, entries[index]!.role, entries[index]!.text);
        if (sameHistory(accumulated, wanted)) {
          boundary = index + 1;
          break;
        }
      }
      if (boundary < 0) {
        return {
          kind: "rejected",
          code: "history-mismatch",
          message: "requested history prefix is not present in the backend session",
        };
      }
      const body: JsonObject = boundary < entries.length
        ? { messageID: entries[boundary]!.id }
        : {};
      const result = await options.transport.mutate<unknown>({
        method: "POST",
        path: withLocation(
          `/session/${encodeURIComponent(sourceBackendId)}/fork`,
          input.source.location,
        ),
        body,
        operationId,
        deadlineMs,
        replay: NEVER_REPLAY,
      });
      const forked = classifyLegacyMutationResponse(result, operationId, (responseBody) => {
        const id = asRecord(unwrap(responseBody))?.id;
        return typeof id === "string" && id ? { backendSessionId: id } : undefined;
      });
      if (forked.kind !== "confirmed") return forked;
      let childRows: LegacyMessage[];
      try {
        childRows = await queryRequired<LegacyMessage[]>(
          options.transport,
          withLocation(
            `/session/${encodeURIComponent(forked.value.backendSessionId)}/message?limit=1000`,
            input.target.location,
          ),
          deadlineMs,
        );
      } catch {
        return {
          kind: "unknown",
          operationId,
          message: "backend branch exists but exact history could not be verified",
        };
      }
      if (!sameHistory(normalizedBackendHistory(backendMessageEntries(childRows)), wanted)) {
        return {
          kind: "unknown",
          operationId,
          message: "backend branch exists with an unexpected history",
        };
      }
      freshSessionEvidence.set(forked.value.backendSessionId, operationId);
      return {
        ...forked,
        receipt: forked.value.backendSessionId,
      };
    },
    async submit(
      input: RuntimeTurnBinding,
      operationId: string,
    ): Promise<MutationOutcome<{ admissionId?: string }>> {
      const mismatch = bindingError(input.session, options.endpoint);
      if (mismatch) {
        return { kind: "rejected", code: "binding-mismatch", message: mismatch };
      }
      const backendSessionId = input.session.backendSessionId;
      if (!backendSessionId) {
        return {
          kind: "rejected",
          code: "binding-missing",
          message: "prompt submission requires a backend session binding",
        };
      }
      const negotiated = await negotiatePromptPaths();
      const selected = negotiated[0];
      if (!selected) {
        return {
          kind: "rejected",
          code: "capability-unsupported",
          message: "legacy endpoint exposes no read-only prompt capability contract",
        };
      }
      // A submitted turn makes the create/fork receipt insufficient as
      // evidence of the session's current idle state, even if this request's
      // own response is later ambiguous.
      freshSessionEvidence.delete(backendSessionId);
      const result = await options.transport.mutate<unknown>({
        method: "POST",
        path: withLocation(
          `/session/${encodeURIComponent(backendSessionId)}/${selected}`,
          input.session.location,
        ),
        body: turnBody(input),
        operationId,
        deadlineMs,
        replay: NEVER_REPLAY,
      });
      const outcome = classifyLegacyMutationResponse(result, operationId, (body) => {
        if (result.kind !== "response" || result.status === 204) return {};
        const response = asRecord(unwrap(body));
        const admissionId =
          typeof response?.admissionId === "string" ? response.admissionId
            : typeof response?.id === "string" ? response.id
              : typeof asRecord(response?.info)?.id === "string"
                ? String(asRecord(response?.info)?.id)
                : undefined;
        return admissionId ? { admissionId } : {};
      });
      // A complete unsupported response may refine only a future operation.
      // The current operation is never sent to the alternate endpoint.
      if (
        outcome.kind === "rejected"
        && outcome.code === "capability-unsupported"
        && promptPaths?.[0] === selected
      ) {
        promptPaths = promptPaths.slice(1);
      }
      return outcome;
    },
    async steer(input, operationId) {
      const mismatch = bindingError(input.session, options.endpoint);
      if (mismatch) {
        return { kind: "rejected", code: "binding-mismatch", message: mismatch };
      }
      if (!input.session.backendSessionId) {
        return {
          kind: "rejected",
          code: "binding-missing",
          message: "steering requires a backend session binding",
        };
      }
      const selected = (await negotiatePromptPaths())[0];
      if (!selected) return {
        kind: "rejected",
        code: "capability-unsupported",
        message: "legacy endpoint exposes no read-only steering capability contract",
      };
      const result = await options.transport.mutate<unknown>({
        method: "POST",
        path: withLocation(
          `/session/${encodeURIComponent(input.session.backendSessionId)}/${selected}`,
          input.session.location,
        ),
        body: turnBody(input),
        operationId,
        deadlineMs,
        replay: NEVER_REPLAY,
      });
      return classifyLegacyMutationResponse(result, operationId, confirmedEmpty);
    },
    async abort(input, operationId) {
      const mismatch = bindingError(input, options.endpoint);
      if (mismatch) {
        return { kind: "rejected", code: "binding-mismatch", message: mismatch };
      }
      if (!input.backendSessionId) return {
        kind: "rejected",
        code: "binding-missing",
        message: "abort requires a backend session binding",
      };
      const result = await options.transport.mutate<unknown>({
        method: "POST",
        path: withLocation(
          `/session/${encodeURIComponent(input.backendSessionId)}/abort`,
          input.location,
        ),
        operationId,
        deadlineMs,
        replay: NEVER_REPLAY,
      });
      return classifyLegacyMutationResponse(result, operationId, confirmedEmpty);
    },
    async deleteSession(input, operationId) {
      const mismatch = bindingError(input, options.endpoint);
      if (mismatch) {
        return { kind: "rejected", code: "binding-mismatch", message: mismatch };
      }
      if (!input.backendSessionId) return {
        kind: "rejected",
        code: "binding-missing",
        message: "delete requires a backend session binding",
      };
      const result = await options.transport.mutate<unknown>({
        method: "DELETE",
        path: withLocation(
          `/session/${encodeURIComponent(input.backendSessionId)}`,
          input.location,
        ),
        operationId,
        deadlineMs,
        replay: NEVER_REPLAY,
      });
      return classifyLegacyMutationResponse(result, operationId, confirmedEmpty);
    },
    async replyPermission(input, requestId, reply, operationId) {
      const mismatch = bindingError(input, options.endpoint);
      if (mismatch) {
        return { kind: "rejected", code: "binding-mismatch", message: mismatch };
      }
      if (!input.backendSessionId) return {
        kind: "rejected",
        code: "binding-missing",
        message: "permission reply requires a backend session binding",
      };
      const result = await options.transport.mutate<unknown>({
        method: "POST",
        path: withLocation(
          `/session/${encodeURIComponent(input.backendSessionId)}/permissions/${encodeURIComponent(requestId)}`,
          input.location,
        ),
        body: { response: reply },
        operationId,
        deadlineMs,
        replay: NEVER_REPLAY,
      });
      return classifyLegacyMutationResponse(result, operationId, confirmedEmpty);
    },
    async replyQuestion(input, requestId, answers, operationId) {
      const mismatch = bindingError(input, options.endpoint);
      if (mismatch) {
        return { kind: "rejected", code: "binding-mismatch", message: mismatch };
      }
      if (!input.backendSessionId) return {
        kind: "rejected",
        code: "binding-missing",
        message: "question reply requires a backend session binding",
      };
      const reject = answers.action === "reject";
      const list = Array.isArray(answers.answers) ? answers.answers : [answers];
      const result = await options.transport.mutate<unknown>({
        method: "POST",
        path: withLocation(
          `/question/${encodeURIComponent(requestId)}/${reject ? "reject" : "reply"}`,
          input.location,
        ),
        ...(reject ? {} : { body: { answers: list } }),
        operationId,
        deadlineMs,
        replay: NEVER_REPLAY,
      });
      return classifyLegacyMutationResponse(result, operationId, confirmedEmpty);
    },
    async reconcile(input: RuntimeReconciliationBinding): Promise<RuntimeSnapshot> {
      const mismatch = bindingError(input, options.endpoint);
      if (mismatch) {
        throw Object.assign(new Error(mismatch), { code: "binding-mismatch" });
      }
      const backendSessionId = input.backendSessionId;
      if (!backendSessionId) {
        throw Object.assign(
          new Error("legacy reconciliation requires a backend session binding"),
          { code: "binding-missing" },
        );
      }
      const requestedOrdinal = input.reconciliationOrdinal;
      const ordinal =
        Number.isSafeInteger(requestedOrdinal) && (requestedOrdinal ?? -1) >= 0
          ? requestedOrdinal!
          : ++reconciliationOrdinal;
      reconciliationOrdinal = Math.max(reconciliationOrdinal, ordinal);
      const observed: ObservationBinding = {
        authorityId: input.authorityId,
        generation: input.generation,
        location: input.location,
        backendSessionId,
        reconciliationOrdinal: ordinal,
      };
      const [status, messages, permissionsResult, questionsResult] = await Promise.all([
        queryOptional(
          options.transport,
          withLocation("/session/status", input.location),
          deadlineMs,
        ),
        queryOptional(
          options.transport,
          withLocation(
            `/session/${encodeURIComponent(backendSessionId)}/message?limit=1000`,
            input.location,
          ),
          deadlineMs,
        ),
        queryOptional(
          options.transport,
          withLocation("/permission", input.location),
          deadlineMs,
        ),
        queryOptional(
          options.transport,
          withLocation("/question", input.location),
          deadlineMs,
        ),
      ]);

      const events: RuntimeSnapshot["events"] = [];
      const acceptedOperations: NonNullable<RuntimeSnapshot["acceptedOperations"]> = [];
      const state = createTranslateState();
      // Pulled reconciliation replays the full backend history. OpenCode's
      // session rows replay as `message.updated` with the CURRENT session
      // title, so a pulled `title:...` observation identity would race the
      // live title snapshot; skip title-only rows in the replay stream.
      const isTitleOnly = (info: Record<string, unknown> | undefined): boolean =>
        Boolean(info) && Object.keys(info!).length <= 2 && typeof info!.title === "string";
      for (const rowValue of messages.ok ? asArray(messages.value) : []) {
        const row = asRecord(rowValue);
        if (!row) continue;
        const info = asRecord(row.info);
        const operationId =
          typeof info?.operationID === "string" ? info.operationID
            : typeof info?.operationId === "string" ? info.operationId
              : undefined;
        if (operationId && typeof info?.id === "string") {
          acceptedOperations.push({
            operationId,
            mutationKind: "turn-submit",
            receipt: info.id,
            entityId: info.id,
            backendSessionId,
          });
        }
        if (!isTitleOnly(info)) {
          appendPulledEvents(
            events,
            {
              type: "message.updated",
              properties: { sessionID: backendSessionId, info: info ?? {} },
            },
            observed,
            state,
          );
        }
        for (const part of Array.isArray(row.parts) ? row.parts : []) {
          appendPulledEvents(
            events,
            {
              type: "message.part.updated",
              properties: {
                sessionID: backendSessionId,
                part,
                ...(info?.role === "user" ? { role: "user" } : {}),
              },
            },
            observed,
            state,
          );
        }
      }

      const permissions = (permissionsResult.ok ? asArray(permissionsResult.value) : [])
        .map((value) => permissionOf(value, backendSessionId))
        .filter((value): value is RuntimeSnapshot["permissions"][number] => value !== undefined);

      const questions = (questionsResult.ok ? asArray(questionsResult.value) : [])
        .map((value) => questionOf(value, backendSessionId))
        .filter((value): value is RuntimeSnapshot["questions"][number] => value !== undefined);

      let snapshotState = status.ok
        ? statusFor(status.value, backendSessionId)
        : { value: "unknown" as const };
      if (messages.ok) {
        const historyTerminal = completedHistoryTerminalState(messages.value);
        if (historyTerminal && (snapshotState.value === "unknown" || snapshotState.value === "running")) {
          // Legacy status may remain "running" after the latest assistant
          // message completed. A newer user message would be the latest entry,
          // so the completed assistant is the terminal boundary here.
          snapshotState = historyTerminal;
        } else if (
          snapshotState.value === "unknown"
          && status.ok
          && statusAllowsHistoryTerminal(status.value, backendSessionId)
        ) {
          snapshotState = historyTerminal ?? snapshotState;
        }
      }
      const createOperationId = freshSessionEvidence.get(backendSessionId);
      if (snapshotState.value === "unknown" && createOperationId) {
        snapshotState = {
          value: "idle",
          causalOperationId: createOperationId,
        };
      }
      return {
        authorityId: input.authorityId,
        generation: input.generation,
        location: input.location,
        backendSessionId,
        reconciliationOrdinal: ordinal,
        state: snapshotState,
        completeness: {
          events: "partial",
          permissions: "partial",
          questions: "partial",
        },
        permissions,
        questions,
        events,
        ...(acceptedOperations.length > 0 ? { acceptedOperations } : {}),
      };
    },
  };
};
