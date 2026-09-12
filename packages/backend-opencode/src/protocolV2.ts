import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AgentDescriptor,
  AvailableProviderDescriptor,
  JsonObject,
  ModelDescriptor,
  MutationOutcome,
  MutationTransportResult,
  OpenCodeTransport,
  ProtocolAdapter,
  ProtocolCapabilities,
  ProviderAuthMethod,
  ProviderAuthWrite,
  ProviderAuthorization,
  RuntimeEndpoint,
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
  createTranslateState,
  type ObservationBinding,
} from "./events.ts";
import { createProviderHttpClient } from "./providerHttp.ts";
import { appendPulledEvents } from "./reconciliationEvents.ts";
import {
  pulledV2MessageEvents,
  v2PermissionOf,
  v2QuestionOf,
} from "./v2Reconciliation.ts";

export interface CreateV2ProtocolAdapterOptions {
  transport: OpenCodeTransport;
  endpoint: RuntimeEndpoint;
  deadlineMs?: number;
}

interface V2Model {
  id?: unknown;
  providerID?: unknown;
  name?: unknown;
  enabled?: unknown;
  capabilities?: unknown;
  variants?: unknown;
  limit?: unknown;
  cost?: unknown;
}

interface V2Provider {
  id?: unknown;
  name?: unknown;
  disabled?: unknown;
  env?: unknown;
  docs?: unknown;
}

interface V2Agent {
  id?: unknown;
  description?: unknown;
  mode?: unknown;
  system?: unknown;
  model?: unknown;
  options?: unknown;
  hidden?: unknown;
}

interface V2Session {
  id?: unknown;
  title?: unknown;
  parentID?: unknown;
  time?: unknown;
}

const NEVER_REPLAY = { kind: "never" } as const;
const V2_PAGE_LIMIT = 200;
const MODEL_READINESS_RETRY_DELAYS_MS = [100, 250, 500, 1_000] as const;

const protocolCapabilities: ProtocolCapabilities = {
  eventReplay: "none",
  pendingSnapshot: "partial",
  idempotentMutations: new Set(),
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

export const hasV2ProtocolDocument = (document: unknown): boolean => {
  const body = asRecord(document);
  const nested = asRecord(body?.data);
  const paths = asRecord(body?.paths) ?? asRecord(nested?.paths);
  const names = paths ? Object.keys(paths) : [];
  return names.includes("/api/session")
    && names.some((path) => /\/api\/session\/\{[^}]+\}\/prompt$/.test(path));
};

const withLocation = (
  path: string,
  location: RuntimeLocation,
  style: "flat" | "deep" = "flat",
): string => {
  const [pathname, query = ""] = path.split("?", 2);
  const params = new URLSearchParams(query);
  const key = (name: string): string => style === "deep" ? `location[${name}]` : name;
  params.set(key("directory"), location.directory);
  if (location.workspace) params.set(key("workspace"), location.workspace);
  return `${pathname}?${params.toString()}`;
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

const unsupported = <T>(operation: string): MutationOutcome<T> => ({
  kind: "rejected",
  code: "capability-unsupported",
  message: `OpenCode V2 does not expose a ${operation} endpoint`,
});

const requiredBindingId = <T>(
  binding: RuntimeSessionBinding,
  operation: string,
): { id: string } | MutationOutcome<T> => binding.backendSessionId
  ? { id: binding.backendSessionId }
  : {
      kind: "rejected",
      code: "binding-missing",
      message: `${operation} requires a backend session binding`,
    };

const invalidResponse = (path: string, expected: string): Error =>
  Object.assign(
    new Error(`OpenCode GET ${path} returned an invalid response; expected ${expected}`),
    { code: "protocol-response-invalid" },
  );

const queryRequired = async (
  transport: OpenCodeTransport,
  path: string,
  deadlineMs: number,
): Promise<unknown> => {
  const result = await transport.query<unknown>({ method: "GET", path, deadlineMs });
  const response = asRecord(result);
  if (typeof response?.status !== "number") return result;
  if (response.status < 200 || response.status >= 300) {
    throw Object.assign(
      new Error(
        mutationMessage(
          response.body,
          `OpenCode GET ${path} returned HTTP ${response.status}`,
        ),
      ),
      {
        code: `http-${response.status}`,
        status: response.status,
        path,
      },
    );
  }
  return response.body;
};

const queryOptional = async (
  transport: OpenCodeTransport,
  path: string,
  deadlineMs: number,
): Promise<{ ok: true; value: unknown } | { ok: false }> => {
  try {
    return { ok: true, value: await queryRequired(transport, path, deadlineMs) };
  } catch {
    return { ok: false };
  }
};

const optionalDataArray = (body: unknown): unknown[] | undefined => {
  const record = asRecord(body);
  const value = record && "data" in record ? record.data : body;
  return Array.isArray(value) ? value : undefined;
};

/** One-shot provider-auth write (no session/replay semantics apply). */
const mutateRequired = async (
  transport: OpenCodeTransport,
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body: unknown,
  deadlineMs: number,
): Promise<unknown> => {
  const result = await transport.mutate<unknown>({
    method, path, body, operationId: randomUUID(), deadlineMs, replay: NEVER_REPLAY,
  });
  if (result.kind === "unknown") {
    throw Object.assign(new Error(result.message), { code: "unavailable" });
  }
  if (result.status < 200 || result.status >= 300) {
    throw Object.assign(
      new Error(mutationMessage(result.body, `OpenCode ${method} ${path} returned HTTP ${result.status}`)),
      { code: `http-${result.status}`, status: result.status },
    );
  }
  return result.body;
};

// OpenCode's auto/device OAuth callback intentionally blocks while the user
// signs in (upstream currently allows five minutes).
const PROVIDER_OAUTH_CALLBACK_DEADLINE_MS = 15 * 60 * 1000;

const requiredData = (body: unknown, path: string): unknown => {
  const record = asRecord(body);
  if (!record || !Object.hasOwn(record, "data")) {
    throw invalidResponse(path, "a JSON object with a data field");
  }
  return record.data;
};

const requiredDataArray = (body: unknown, path: string): unknown[] => {
  const data = requiredData(body, path);
  if (!Array.isArray(data)) throw invalidResponse(path, "a JSON data array");
  return data;
};

const mutationMessage = (body: unknown, fallback: string): string => {
  if (typeof body === "string" && body.trim()) return body.slice(0, 500);
  const record = asRecord(body);
  const error = asRecord(record?.error);
  for (const candidate of [record?.message, error?.message]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.slice(0, 500);
  }
  return fallback;
};

const classifyMutation = <T>(
  result: MutationTransportResult<unknown>,
  operationId: string,
  confirmed: (body: unknown) => T | undefined,
): MutationOutcome<T> => {
  if (result.kind === "unknown") {
    return { kind: "unknown", operationId, message: result.message };
  }
  if (result.status >= 200 && result.status < 300) {
    const value = confirmed(result.body);
    return value === undefined
      ? {
          kind: "unknown",
          operationId,
          message: "OpenCode V2 returned an unrecognized success response",
        }
      : { kind: "confirmed", value };
  }
  if (result.status === 405 || result.status === 501) {
    return {
      kind: "rejected",
      code: "capability-unsupported",
      message: mutationMessage(result.body, "OpenCode V2 operation is unsupported"),
    };
  }
  if ([400, 401, 403, 404, 409, 415, 422].includes(result.status)) {
    const code = [400, 415, 422].includes(result.status)
      ? "validation"
      : `http-${result.status}`;
    return {
      kind: "rejected",
      code,
      message: mutationMessage(
        result.body,
        `OpenCode V2 rejected the operation (HTTP ${result.status})`,
      ),
    };
  }
  return {
    kind: "unknown",
    operationId,
    message: mutationMessage(
      result.body,
      `OpenCode V2 returned an ambiguous HTTP ${result.status} response`,
    ),
  };
};

const confirmedEmpty = (): Record<string, never> => ({});

const providerRows = (body: unknown): V2Provider[] =>
  requiredDataArray(body, "/api/provider").map((value, index) => {
    const provider = asRecord(value) as V2Provider | undefined;
    if (
      !provider
      || typeof provider.id !== "string"
      || !provider.id
      || typeof provider.name !== "string"
      || !provider.name
    ) {
      throw invalidResponse(
        "/api/provider",
        `string id and name fields at data[${index}]`,
      );
    }
    return provider;
  });

const hasConnectedProvider = (body: unknown): boolean =>
  providerRows(body).some((provider) => provider.disabled !== true);

const variantNames = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const name = typeof entry === "string"
      ? entry
      : typeof record?.id === "string"
        ? record.id
        : typeof record?.name === "string"
          ? record.name
          : undefined;
    if (name && !result.includes(name)) result.push(name);
  }
  return result;
};

const capabilityTags = (value: unknown): string[] => {
  const capabilities = asRecord(value);
  if (!capabilities) return [];
  const result: string[] = [];
  if (capabilities.tools === true) result.push("toolcall");
  for (const direction of ["input", "output"] as const) {
    const reported = capabilities[direction];
    if (!Array.isArray(reported)) continue;
    const modalities = reported
      .filter((item): item is string => typeof item === "string" && item.length > 0)
      .filter((item, index, all) => all.indexOf(item) === index)
      .sort();
    if (modalities.length === 0) result.push(`${direction}:none`);
    else for (const modality of modalities) result.push(`${direction}:${modality}`);
  }
  return result;
};

/**
 * Flatten the native V2 model and provider envelopes into Polyth's protocol
 * neutral catalog. An empty result is possible only for an empty/upstream
 * disabled catalog; malformed successful responses throw.
 */
export const flattenV2Models = (
  modelBody: unknown,
  providerBody: unknown,
): ModelDescriptor[] => {
  const rows = requiredDataArray(modelBody, "/api/model");
  const providers = new Map(
    providerRows(providerBody).flatMap((provider) =>
      typeof provider.id === "string" ? [[provider.id, provider] as const] : []),
  );
  return rows.flatMap((value, index) => {
    const model = asRecord(value) as V2Model | undefined;
    if (!model) throw invalidResponse("/api/model", `an object at data[${index}]`);
    if (model.enabled === false) return [];
    if (
      typeof model.id !== "string"
      || !model.id
      || typeof model.providerID !== "string"
      || !model.providerID
      || typeof model.name !== "string"
      || !model.name
    ) {
      throw invalidResponse(
        "/api/model",
        `string id, providerID, and name fields at data[${index}]`,
      );
    }
    const provider = providers.get(model.providerID);
    const limit = asRecord(model.limit);
    const firstCost = Array.isArray(model.cost) ? asRecord(model.cost[0]) : undefined;
    const capabilities = capabilityTags(model.capabilities);
    const variants = variantNames(model.variants);
    return [{
      providerID: model.providerID,
      modelID: model.id,
      name: model.name,
      ...(typeof provider?.name === "string" && provider.name
        ? { providerName: provider.name }
        : {}),
      ...(typeof limit?.context === "number" ? { context: limit.context } : {}),
      ...(typeof firstCost?.input === "number" && typeof firstCost.output === "number"
        ? { cost: { input: firstCost.input, output: firstCost.output } }
        : {}),
      ...(asRecord(model.capabilities) ? { capabilities } : {}),
      ...(variants.length > 0 ? { variants } : {}),
      connected: provider !== undefined && provider.disabled !== true,
    }];
  });
};

const withCursor = (path: string, cursor: string): string => {
  const [pathname, query = ""] = path.split("?", 2);
  const params = new URLSearchParams(query);
  // The cursor carries the original ordering. In particular, V2 message
  // pagination rejects requests that combine cursor and order.
  params.delete("order");
  params.set("cursor", cursor);
  return `${pathname}?${params.toString()}`;
};

const queryAllPages = async (
  transport: OpenCodeTransport,
  initialPath: string,
  deadlineMs: number,
): Promise<unknown[]> => {
  const rows: unknown[] = [];
  const seen = new Set<string>();
  let path = initialPath;
  for (let page = 0; page < 100; page += 1) {
    const body = await queryRequired(transport, path, deadlineMs);
    rows.push(...requiredDataArray(body, path));
    const next = asRecord(asRecord(body)?.cursor)?.next;
    if (typeof next !== "string" || !next) return rows;
    if (seen.has(next)) {
      throw invalidResponse(path, "a non-repeating cursor.next");
    }
    seen.add(next);
    path = withCursor(initialPath, next);
  }
  throw invalidResponse(initialPath, "at most 100 cursor pages");
};

const sleep = (delayMs: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs));

const normalizeAgents = (body: unknown, path: string): AgentDescriptor[] =>
  requiredDataArray(body, path).flatMap((value, index) => {
    const agent = asRecord(value) as V2Agent | undefined;
    if (!agent || typeof agent.id !== "string" || !agent.id) {
      throw invalidResponse(path, `an agent with a string id at data[${index}]`);
    }
    if (agent.hidden === true) return [];
    const model = asRecord(agent.model);
    const options = asRecord(agent.options);
    const auto = options?.["polyth.mode"] === "auto";
    return [{
      name: agent.id,
      ...(typeof agent.description === "string" && agent.description
        ? { description: agent.description }
        : {}),
      mode: auto || agent.mode === "auto"
        ? "auto"
        : agent.mode === "subagent" || agent.mode === "all"
          ? agent.mode
          : "primary",
      ...(typeof agent.system === "string" && agent.system ? { prompt: agent.system } : {}),
      ...(typeof model?.providerID === "string" && typeof model.id === "string"
        ? { model: { providerID: model.providerID, modelID: model.id } }
        : {}),
    }];
  });

const normalizeSessions = (body: unknown, path: string): RuntimeSession[] =>
  requiredDataArray(body, path).map((value, index) => {
    const session = asRecord(value) as V2Session | undefined;
    const time = asRecord(session?.time);
    if (!session || typeof session.id !== "string" || !session.id) {
      throw invalidResponse(path, `a session with a string id at data[${index}]`);
    }
    const createdAt = typeof time?.created === "number" ? time.created : Date.now();
    return {
      id: session.id,
      title: typeof session.title === "string" && session.title
        ? session.title
        : "Untitled session",
      ...(typeof session.parentID === "string" && session.parentID
        ? { parentId: session.parentID }
        : {}),
      createdAt,
      updatedAt: typeof time?.updated === "number" ? time.updated : createdAt,
    };
  });

const normalizeHistory = (body: unknown, path: string): RuntimeSessionMessage[] => {
  const result: RuntimeSessionMessage[] = [];
  for (const value of requiredDataArray(body, path)) {
    const message = asRecord(value);
    if (!message) continue;
    if (message.type === "user" && typeof message.text === "string") {
      result.push({ role: "user", text: message.text.slice(0, 20_000) });
      continue;
    }
    if (message.type !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content
      .map(asRecord)
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => String(part?.text))
      .join("\n")
      .slice(0, 20_000);
    const reasoning = content
      .map(asRecord)
      .filter((part) => part?.type === "reasoning" && typeof part.text === "string")
      .map((part) => String(part?.text))
      .join("\n")
      .slice(0, 50_000);
    if (text || reasoning) {
      result.push({ role: "assistant", text, ...(reasoning ? { reasoning } : {}) });
    }
  }
  return result;
};

const attachmentFiles = (input: RuntimeTurnBinding): JsonObject[] => {
  const files: JsonObject[] = [];
  // The server guarantees any `_inbox/*` attachment is materialized into the
  // runtime cwd before the turn, so resolving against the session directory is
  // always correct here — no project-root awareness needed.
  const root = resolve(input.session.location.directory);
  for (const attachment of input.attachments ?? []) {
    if (attachment.kind === "browser-context") {
      // Text is merged into prompt.text by promptBody; only visual evidence
      // rides as a file when a resolved local path is present.
      const shot = attachment.browserContext?.crop ?? attachment.browserContext?.screenshot;
      if (shot?.localPath && shot.mime.startsWith("image/")) {
        files.push({
          uri: pathToFileURL(shot.localPath).href,
          name: attachment.name || `${attachment.browserContext?.type ?? "browser"}-capture`,
        });
      }
      continue;
    }
    if (attachment.kind === "url") {
      if (attachment.url && /^https?:\/\//i.test(attachment.url)) {
        files.push({ uri: attachment.url, name: attachment.name });
      }
      continue;
    }
    if (!attachment.path) continue;
    const absolute = resolve(root, attachment.path);
    const pathFromRoot = relative(root, absolute);
    if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) continue;
    let uri = pathToFileURL(absolute).href;
    if (attachment.kind === "range" && attachment.range) {
      uri += `?start=${attachment.range[0]}&end=${attachment.range[1]}`;
    }
    files.push({ uri, name: attachment.name });
  }
  return files;
};

const promptBody = (input: RuntimeTurnBinding, delivery: "queue" | "steer"): JsonObject => {
  const files = attachmentFiles(input);
  const browserText = (input.attachments ?? [])
    .filter((a) => a.kind === "browser-context" && a.browserContext)
    .map((a) => formatBrowserContextForModel(a.browserContext!))
    .join("\n\n");
  const text = browserText
    ? (input.text.trim() ? `${input.text}\n\n${browserText}` : browserText)
    : input.text;
  return {
    prompt: {
      text,
      ...(files.length > 0 ? { files } : {}),
    },
    delivery,
  };
};

const sessionCreateBody = (location: RuntimeLocation): JsonObject => ({
  location: {
    directory: location.directory,
    ...(location.workspace ? { workspaceID: location.workspace } : {}),
  },
});

export const createV2ProtocolAdapter = (
  options: CreateV2ProtocolAdapterOptions,
): ProtocolAdapter => {
  const deadlineMs = options.deadlineMs ?? 10_000;
  let reconciliationOrdinal = 0;
  const freshSessionEvidence = new Map<string, string>();

  const createSession = async (
    input: RuntimeSessionBinding,
    operationId: string,
  ): Promise<MutationOutcome<{ backendSessionId: string }>> => {
    const result = await options.transport.mutate<unknown>({
      method: "POST",
      path: withLocation("/api/session", input.location),
      body: sessionCreateBody(input.location),
      operationId,
      deadlineMs,
      replay: NEVER_REPLAY,
    });
    const outcome = classifyMutation(result, operationId, (body) => {
      const id = asRecord(requiredData(body, "/api/session"))?.id;
      return typeof id === "string" && id ? { backendSessionId: id } : undefined;
    });
    if (outcome.kind === "confirmed") {
      freshSessionEvidence.set(outcome.value.backendSessionId, operationId);
      return { ...outcome, receipt: outcome.value.backendSessionId };
    }
    return outcome;
  };

  const selectTurnContext = async (
    input: RuntimeTurnBinding,
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>> | undefined> => {
    const backendSessionId = input.session.backendSessionId!;
    if (input.model) {
      const result = await options.transport.mutate<unknown>({
        method: "POST",
        path: withLocation(
          `/api/session/${encodeURIComponent(backendSessionId)}/model`,
          input.session.location,
        ),
        body: {
          model: {
            id: input.model.modelID,
            providerID: input.model.providerID,
            ...(input.model.variant ? { variant: input.model.variant } : {}),
          },
        },
        operationId,
        deadlineMs,
        replay: NEVER_REPLAY,
      });
      const outcome = classifyMutation(result, operationId, confirmedEmpty);
      if (outcome.kind !== "confirmed") return outcome;
    }
    if (input.agent) {
      const result = await options.transport.mutate<unknown>({
        method: "POST",
        path: withLocation(
          `/api/session/${encodeURIComponent(backendSessionId)}/agent`,
          input.session.location,
        ),
        body: { agent: input.agent },
        operationId,
        deadlineMs,
        replay: NEVER_REPLAY,
      });
      const outcome = classifyMutation(result, operationId, confirmedEmpty);
      if (outcome.kind !== "confirmed") return outcome;
    }
    return undefined;
  };

  const prompt = async (
    input: RuntimeTurnBinding,
    operationId: string,
    delivery: "queue" | "steer",
  ): Promise<MutationOutcome<{ admissionId?: string }>> => {
    const selected = await selectTurnContext(input, operationId);
    if (selected) return selected;
    const backendSessionId = input.session.backendSessionId!;
    freshSessionEvidence.delete(backendSessionId);
    const result = await options.transport.mutate<unknown>({
      method: "POST",
      path: withLocation(
        `/api/session/${encodeURIComponent(backendSessionId)}/prompt`,
        input.session.location,
      ),
      body: promptBody(input, delivery),
      operationId,
      deadlineMs,
      replay: NEVER_REPLAY,
    });
    return classifyMutation(result, operationId, (body) => {
      const data = asRecord(asRecord(body)?.data);
      return typeof data?.id === "string" ? { admissionId: data.id } : undefined;
    });
  };

  const providerHttp = createProviderHttpClient({
    locate: (path) => withLocation(path, options.endpoint.location),
    transport: {
      queryRequired: (path) => queryRequired(options.transport, path, deadlineMs),
      mutate: (method, path, body, extra) => mutateRequired(
        options.transport,
        method,
        path,
        body,
        extra?.deadlineMs ?? deadlineMs,
      ),
    },
    deadlineMs,
    oauthCallbackDeadlineMs: PROVIDER_OAUTH_CALLBACK_DEADLINE_MS,
    listAllRequireName: true,
    authorizeUnavailable: () => invalidResponse(
      withLocation("/provider/:id/oauth/authorize", options.endpoint.location),
      "url, method, and instructions",
    ),
    operationIdFor: () => randomUUID(),
  });

  return {
    protocol: "v2",
    async capabilities() {
      return protocolCapabilities;
    },
    async models(): Promise<ModelDescriptor[]> {
      const modelPath = withLocation("/api/model", options.endpoint.location, "deep");
      const providerPath = withLocation("/api/provider", options.endpoint.location, "deep");
      for (let attempt = 0; ; attempt += 1) {
        const [modelBody, providerBody] = await Promise.all([
          queryRequired(options.transport, modelPath, deadlineMs),
          queryRequired(options.transport, providerPath, deadlineMs),
        ]);
        const models = flattenV2Models(modelBody, providerBody);
        if (models.length > 0 || !hasConnectedProvider(providerBody)) return models;
        const retryDelayMs = MODEL_READINESS_RETRY_DELAYS_MS[attempt];
        if (retryDelayMs === undefined) {
          throw Object.assign(
            new Error(
              "OpenCode V2 model catalog is not ready: connected providers returned no models",
            ),
            { code: "backend-not-ready" },
          );
        }
        await sleep(retryDelayMs);
      }
    },
    async agents(): Promise<AgentDescriptor[]> {
      const path = withLocation("/api/agent", options.endpoint.location, "deep");
      return normalizeAgents(await queryRequired(options.transport, path, deadlineMs), path);
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
    async setProviderAuth(providerID, info: ProviderAuthWrite): Promise<boolean> {
      const path = withLocation(`/auth/${encodeURIComponent(providerID)}`, options.endpoint.location);
      const body = info.type === "api"
        ? { type: "api", key: info.key, ...(info.metadata ? { metadata: info.metadata } : {}) }
        : { type: "wellknown", key: info.key, token: info.token };
      return Boolean(await mutateRequired(options.transport, "PUT", path, body, deadlineMs));
    },
    async removeProviderAuth(providerID): Promise<boolean> {
      return providerHttp.removeProviderAuth(providerID);
    },
    async sessions(): Promise<RuntimeSession[]> {
      const path = withLocation(
        `/api/session?limit=${V2_PAGE_LIMIT}&order=desc`,
        options.endpoint.location,
      );
      const rows = await queryAllPages(options.transport, path, deadlineMs);
      return normalizeSessions({ data: rows }, path);
    },
    async history(input): Promise<RuntimeSessionMessage[]> {
      const mismatch = bindingError(input, options.endpoint);
      if (mismatch) throw Object.assign(new Error(mismatch), { code: "binding-mismatch" });
      if (!input.backendSessionId) {
        throw Object.assign(new Error("history requires a backend session binding"), {
          code: "binding-missing",
        });
      }
      const path = withLocation(
        `/api/session/${encodeURIComponent(input.backendSessionId)}/message?limit=${V2_PAGE_LIMIT}&order=asc`,
        input.location,
      );
      const rows = await queryAllPages(options.transport, path, deadlineMs);
      return normalizeHistory({ data: rows }, path);
    },
    eventStreamPath() {
      return "/api/event";
    },
    async ensureSession(input, operationId) {
      const mismatch = bindingError(input, options.endpoint);
      if (mismatch) return { kind: "rejected", code: "binding-mismatch", message: mismatch };
      if (input.backendSessionId) {
        return {
          kind: "confirmed",
          value: { backendSessionId: input.backendSessionId },
        };
      }
      return createSession(input, operationId);
    },
    async resetSession(input, _title, operationId) {
      const mismatch = bindingError(input, options.endpoint);
      if (mismatch) return { kind: "rejected", code: "binding-mismatch", message: mismatch };
      return createSession(input, operationId);
    },
    async branchSession(input, _operationId) {
      const mismatch = bindingError(input.source, options.endpoint)
        ?? bindingError(input.target, options.endpoint);
      if (mismatch) return { kind: "rejected", code: "binding-mismatch", message: mismatch };
      return unsupported("session fork/branch");
    },
    async submit(input, operationId) {
      const mismatch = bindingError(input.session, options.endpoint);
      if (mismatch) return { kind: "rejected", code: "binding-mismatch", message: mismatch };
      const bound = requiredBindingId<{ admissionId?: string }>(
        input.session,
        "prompt submission",
      );
      if ("kind" in bound) return bound;
      return prompt(input, operationId, "queue");
    },
    async steer(input, operationId) {
      const mismatch = bindingError(input.session, options.endpoint);
      if (mismatch) return { kind: "rejected", code: "binding-mismatch", message: mismatch };
      const bound = requiredBindingId<Record<string, never>>(input.session, "steering");
      if ("kind" in bound) return bound;
      const outcome = await prompt(input, operationId, "steer");
      if (outcome.kind !== "confirmed") return outcome;
      return { kind: "confirmed", value: {} };
    },
    async abort(input, operationId) {
      const mismatch = bindingError(input, options.endpoint);
      if (mismatch) return { kind: "rejected", code: "binding-mismatch", message: mismatch };
      const bound = requiredBindingId<Record<string, never>>(input, "abort");
      if ("kind" in bound) return bound;
      const result = await options.transport.mutate<unknown>({
        method: "POST",
        path: withLocation(
          `/api/session/${encodeURIComponent(bound.id)}/interrupt`,
          input.location,
        ),
        operationId,
        deadlineMs,
        replay: NEVER_REPLAY,
      });
      return classifyMutation(result, operationId, confirmedEmpty);
    },
    async deleteSession(input, _operationId) {
      const mismatch = bindingError(input, options.endpoint);
      if (mismatch) return { kind: "rejected", code: "binding-mismatch", message: mismatch };
      return unsupported("session delete");
    },
    async replyPermission(input, requestId, reply, operationId) {
      const mismatch = bindingError(input, options.endpoint);
      if (mismatch) return { kind: "rejected", code: "binding-mismatch", message: mismatch };
      const bound = requiredBindingId<Record<string, never>>(input, "permission reply");
      if ("kind" in bound) return bound;
      const result = await options.transport.mutate<unknown>({
        method: "POST",
        path: withLocation(
          `/api/session/${encodeURIComponent(bound.id)}/permission/${encodeURIComponent(requestId)}/reply`,
          input.location,
        ),
        body: { reply },
        operationId,
        deadlineMs,
        replay: NEVER_REPLAY,
      });
      return classifyMutation(result, operationId, confirmedEmpty);
    },
    async replyQuestion(input, requestId, answers, operationId) {
      const mismatch = bindingError(input, options.endpoint);
      if (mismatch) return { kind: "rejected", code: "binding-mismatch", message: mismatch };
      const bound = requiredBindingId<Record<string, never>>(input, "question reply");
      if ("kind" in bound) return bound;
      const reject = answers.action === "reject";
      const result = await options.transport.mutate<unknown>({
        method: "POST",
        path: withLocation(
          `/api/session/${encodeURIComponent(bound.id)}/question/${encodeURIComponent(requestId)}/${reject ? "reject" : "reply"}`,
          input.location,
        ),
        ...(reject
          ? {}
          : { body: { answers: Array.isArray(answers.answers) ? answers.answers : [] } }),
        operationId,
        deadlineMs,
        replay: NEVER_REPLAY,
      });
      return classifyMutation(result, operationId, confirmedEmpty);
    },
    async reconcile(input: RuntimeReconciliationBinding): Promise<RuntimeSnapshot> {
      const mismatch = bindingError(input, options.endpoint);
      if (mismatch) throw Object.assign(new Error(mismatch), { code: "binding-mismatch" });
      const backendSessionId = input.backendSessionId;
      if (!backendSessionId) {
        throw Object.assign(
          new Error("V2 reconciliation requires a backend session binding"),
          { code: "binding-missing" },
        );
      }
      const requestedOrdinal = input.reconciliationOrdinal;
      const ordinal =
        Number.isSafeInteger(requestedOrdinal) && (requestedOrdinal ?? -1) >= 0
          ? requestedOrdinal!
          : ++reconciliationOrdinal;
      reconciliationOrdinal = Math.max(reconciliationOrdinal, ordinal);

      const sessionPath = withLocation(
        `/api/session/${encodeURIComponent(backendSessionId)}`,
        input.location,
      );
      const activePath = withLocation("/api/session/active", input.location);
      const messagesPath = withLocation(
        `/api/session/${encodeURIComponent(backendSessionId)}/message?limit=${V2_PAGE_LIMIT}&order=asc`,
        input.location,
      );
      const todosPath = withLocation(
        `/api/session/${encodeURIComponent(backendSessionId)}/todo`,
        input.location,
      );
      const permissionsPath = withLocation(
        "/api/permission/request",
        input.location,
        "deep",
      );
      const questionsPath = withLocation("/api/question/request", input.location, "deep");
      const [sessionBody, activeBody, messageRows, todosResult, permissionsBody, questionsBody] =
        await Promise.all([
          queryRequired(options.transport, sessionPath, deadlineMs),
          queryRequired(options.transport, activePath, deadlineMs),
          queryAllPages(options.transport, messagesPath, deadlineMs),
          queryOptional(options.transport, todosPath, deadlineMs),
          queryRequired(options.transport, permissionsPath, deadlineMs),
          queryRequired(options.transport, questionsPath, deadlineMs),
        ]);
      if (!asRecord(requiredData(sessionBody, sessionPath))) {
        throw invalidResponse(sessionPath, "a JSON data object");
      }
      const active = asRecord(requiredData(activeBody, activePath));
      if (!active) throw invalidResponse(activePath, "a JSON data object");
      const permissionRows = requiredDataArray(permissionsBody, permissionsPath);
      const questionRows = requiredDataArray(questionsBody, questionsPath);

      const observed: ObservationBinding = {
        authorityId: input.authorityId,
        generation: input.generation,
        location: input.location,
        backendSessionId,
        reconciliationOrdinal: ordinal,
      };
      const events: RuntimeSnapshot["events"] = [];
      const state = createTranslateState();
      for (const row of messageRows) {
        for (const event of pulledV2MessageEvents(row, backendSessionId)) {
          appendPulledEvents(events, event, observed, state);
        }
      }
      const todoRows = todosResult.ok ? optionalDataArray(todosResult.value) : undefined;
      if (todoRows) {
        appendPulledEvents(
          events,
          {
            type: "todo.updated",
            properties: {
              sessionID: backendSessionId,
              todos: todoRows,
              revision: ordinal,
            },
          },
          observed,
          state,
        );
      }
      const permissions = permissionRows
        .map((value) => v2PermissionOf(value, backendSessionId))
        .filter((value): value is RuntimeSnapshot["permissions"][number] => value !== undefined);
      const questions = questionRows
        .map((value) => v2QuestionOf(value, backendSessionId))
        .filter((value): value is RuntimeSnapshot["questions"][number] => value !== undefined);

      const activeSession = asRecord(active[backendSessionId]);
      let snapshotState: RuntimeSnapshot["state"] = activeSession?.type === "running"
        ? { value: "running" }
        : { value: "unknown" };
      const createOperationId = freshSessionEvidence.get(backendSessionId);
      if (snapshotState.value === "unknown" && createOperationId) {
        snapshotState = { value: "idle", causalOperationId: createOperationId };
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
      };
    },
  };
};
