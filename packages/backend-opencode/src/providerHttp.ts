// Legacy OpenCode provider catalogue/auth HTTP. Released V2 uses the
// integration and credential API through providerV2.ts.
//
// mutate() may return { kind: "unknown" } — the request may or may not have
// reached OpenCode. That is never success. Confirmed non-2xx is a rejection.

import type {
  AvailableProviderDescriptor,
  ProviderAuthMethod,
  ProviderAuthorization,
} from "@polyth/contracts";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

export interface ProviderHttpTransport {
  queryRequired(path: string): Promise<unknown>;
  queryOptional?(path: string): Promise<{ ok: true; value: unknown } | { ok: false }>;
  mutate(
    method: "POST" | "PUT" | "DELETE",
    path: string,
    body: unknown,
    extra?: { deadlineMs?: number; operationId?: string },
  ): Promise<unknown>;
}

export interface ProviderHttpClient {
  listAllProviders(): Promise<AvailableProviderDescriptor[]>;
  providerAuthMethods(): Promise<Record<string, ProviderAuthMethod[]>>;
  providerAuthorize(
    providerID: string,
    method: number,
    inputs?: Record<string, string>,
  ): Promise<ProviderAuthorization>;
  providerAuthCallback(providerID: string, method: number, code?: string): Promise<boolean>;
  setProviderApiKey(
    providerID: string,
    key: string,
    metadata?: Record<string, string>,
  ): Promise<boolean>;
  removeProviderAuth(providerID: string): Promise<boolean>;
}

export function parseProviderCatalogue(body: unknown): AvailableProviderDescriptor[] {
  const rec = asRecord(body);
  const out: AvailableProviderDescriptor[] = [];
  // Legacy publishes `{ all: [...] }`. Do not fall back to a raw array
  // — that would treat an unexpected payload as a catalogue.
  for (const entry of Array.isArray(rec?.all) ? rec.all : []) {
    const provider = asRecord(entry);
    if (typeof provider?.id !== "string" || !provider.id) continue;
    const name = typeof provider.name === "string" ? provider.name : "";
    const env = Array.isArray(provider.env)
      ? provider.env.filter((item): item is string => typeof item === "string" && Boolean(item))
      : undefined;
    const docs = typeof provider.docs === "string" && provider.docs ? provider.docs : undefined;
    out.push({
      id: provider.id,
      name: name || provider.id,
      ...(env?.length ? { env } : {}),
      ...(docs ? { docs } : {}),
    });
  }
  return out;
}

const parseAuthMethodType = (value: unknown): "oauth" | "api" | undefined => {
  if (typeof value !== "string") return undefined;
  const raw = value.trim().toLowerCase().replaceAll("_", "-");
  if (raw === "api" || raw === "api-key" || raw === "apikey") return "api";
  if (raw === "oauth" || raw === "oauth2" || raw === "oidc") return "oauth";
  return undefined;
};

const parseAuthPrompt = (value: unknown): NonNullable<ProviderAuthMethod["prompts"]>[number] | undefined => {
  const record = asRecord(value);
  if (!record || typeof record.key !== "string" || !record.key || typeof record.message !== "string" || !record.message) {
    return undefined;
  }
  const when = asRecord(record.when);
  const options = Array.isArray(record.options)
    ? record.options.flatMap((option) => {
      const item = asRecord(option);
      if (!item || typeof item.label !== "string" || typeof item.value !== "string") return [];
      return [{
        label: item.label,
        value: item.value,
        ...(typeof item.hint === "string" && item.hint ? { hint: item.hint } : {}),
      }];
    })
    : undefined;
  return {
    type: record.type === "select" ? "select" : "text",
    key: record.key,
    message: record.message,
    ...(typeof record.placeholder === "string" ? { placeholder: record.placeholder } : {}),
    ...(options?.length ? { options } : {}),
    ...(when && typeof when.key === "string" && (when.op === "eq" || when.op === "neq") && typeof when.value === "string"
      ? { when: { key: when.key, op: when.op, value: when.value } }
      : {}),
  };
};

export function parseProviderAuthMethods(body: unknown): Record<string, ProviderAuthMethod[]> {
  const rec = asRecord(body) ?? {};
  const out: Record<string, ProviderAuthMethod[]> = {};
  for (const [id, methods] of Object.entries(rec)) {
    if (!Array.isArray(methods)) continue;
    const parsed: ProviderAuthMethod[] = [];
    methods.forEach((item, upstreamIndex) => {
      const record = asRecord(item);
      const label = typeof record?.label === "string" && record.label
        ? record.label
        : typeof record?.name === "string" && record.name ? record.name : undefined;
      if (!record || !label) return;
      const type = parseAuthMethodType(record.type);
      if (!type) return;
      const prompts = Array.isArray(record.prompts)
        ? record.prompts.flatMap((prompt) => {
          const parsedPrompt = parseAuthPrompt(prompt);
          return parsedPrompt ? [parsedPrompt] : [];
        })
        : undefined;
      parsed.push({
        type,
        label,
        upstreamIndex,
        ...(prompts?.length ? { prompts } : {}),
      });
    });
    if (parsed.length) out[id] = parsed;
  }
  return out;
}

const authFailure = (status: number, action: string): Error => {
  const code = status === 401 || status === 403
    ? "auth-rejected"
    : status >= 500
      ? "unavailable"
      : `http-${status}`;
  return Object.assign(new Error(`${action} failed (${status})`), { code, status });
};

/** Confirmed 2xx body, or throw. Transport unknown is never success. */
function requireMutationSuccess(raw: unknown, action: string): unknown {
  const rec = asRecord(raw);
  if (rec?.kind === "unknown") {
    throw Object.assign(
      new Error(typeof rec.message === "string" && rec.message.trim()
        ? rec.message
        : `${action} outcome unknown`),
      { code: "unavailable" },
    );
  }
  if (typeof rec?.status === "number") {
    if (rec.status < 200 || rec.status >= 300) throw authFailure(rec.status, action);
    return rec.body;
  }
  return raw;
}

export function parseProviderAuthorization(body: unknown): ProviderAuthorization | undefined {
  const rec = asRecord(body);
  if (typeof rec?.url !== "string" || typeof rec.method !== "string" || typeof rec.instructions !== "string") {
    return undefined;
  }
  return { url: rec.url, method: rec.method === "code" ? "code" : "auto", instructions: rec.instructions };
}

export function createProviderHttpClient(opts: {
  locate: (path: string) => string;
  transport: ProviderHttpTransport;
  deadlineMs: number;
  oauthCallbackDeadlineMs?: number;
  authMethodsOptional?: boolean;
  authorizeUnavailable?: () => Error;
  operationIdFor?: (kind: "authorize" | "callback" | "auth" | "auth-remove", providerID: string) => string;
}): ProviderHttpClient {
  const oauthDeadline = opts.oauthCallbackDeadlineMs ?? 120_000;
  const authorizeUnavailable = opts.authorizeUnavailable
    ?? (() => Object.assign(new Error("provider oauth unavailable"), { code: "unsupported" }));
  const operationIdFor = opts.operationIdFor
    ?? ((kind, providerID) => `provider-${kind}-${providerID}`);

  return {
    async listAllProviders() {
      const body = await opts.transport.queryRequired(opts.locate("/provider"));
      return parseProviderCatalogue(body);
    },

    async providerAuthMethods() {
      const path = opts.locate("/provider/auth");
      if (opts.authMethodsOptional && opts.transport.queryOptional) {
        const result = await opts.transport.queryOptional(path);
        if (!result.ok) return {};
        return parseProviderAuthMethods(result.value);
      }
      return parseProviderAuthMethods(await opts.transport.queryRequired(path));
    },

    async providerAuthorize(providerID, method, inputs) {
      const path = opts.locate(`/provider/${encodeURIComponent(providerID)}/oauth/authorize`);
      const raw = await opts.transport.mutate(
        "POST",
        path,
        { method, ...(inputs ? { inputs } : {}) },
        { deadlineMs: opts.deadlineMs, operationId: operationIdFor("authorize", providerID) },
      );
      const body = requireMutationSuccess(raw, "provider oauth authorize");
      const parsed = parseProviderAuthorization(asRecord(body) ?? body);
      if (!parsed) throw authorizeUnavailable();
      return parsed;
    },

    async providerAuthCallback(providerID, method, code) {
      const path = opts.locate(`/provider/${encodeURIComponent(providerID)}/oauth/callback`);
      const raw = await opts.transport.mutate(
        "POST",
        path,
        { method, ...(code ? { code } : {}) },
        { deadlineMs: oauthDeadline, operationId: operationIdFor("callback", providerID) },
      );
      requireMutationSuccess(raw, "provider oauth callback");
      return true;
    },

    async setProviderApiKey(providerID, key, metadata) {
      const path = opts.locate(`/auth/${encodeURIComponent(providerID)}`);
      const raw = await opts.transport.mutate(
        "PUT",
        path,
        { type: "api", key, ...(metadata ? { metadata } : {}) },
        { deadlineMs: opts.deadlineMs, operationId: operationIdFor("auth", providerID) },
      );
      requireMutationSuccess(raw, "provider API key write");
      return true;
    },

    async removeProviderAuth(providerID) {
      const path = opts.locate(`/auth/${encodeURIComponent(providerID)}`);
      const raw = await opts.transport.mutate(
        "DELETE",
        path,
        undefined,
        { deadlineMs: opts.deadlineMs, operationId: operationIdFor("auth-remove", providerID) },
      );
      requireMutationSuccess(raw, "provider auth delete");
      return true;
    },
  };
}
