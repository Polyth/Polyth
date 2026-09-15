import type { AvailableProviderDescriptor, ProviderAuthMethod, ProviderAuthPrompt, ProviderAuthorization } from "@polyth/contracts";
import type { ProviderHttpClient, ProviderHttpTransport } from "./providerHttp.ts";

type Row = Record<string, unknown>;
const record = (value: unknown): Row | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
const failure = (message: string, code = "protocol-response-invalid"): Error => Object.assign(new Error(`OpenCode V2 ${message}`), { code });
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const rows = (body: unknown, route: string): Row[] => {
  const data = record(body)?.data;
  if (!Array.isArray(data) || data.some((item) => !record(item) || !text(item.id))) throw failure(`${route} returned an invalid inventory`);
  return data as Row[];
};

interface MethodBinding { providerID: string; integrationID: string; method: Row }
interface Attempt { path: string; expires: number; mode: "auto" | "code" }

/** Released V2 authenticates integrations and stores credential IDs. The
 * numeric method index and OAuth attempt ID stay behind Polyth's auth seam. */
export const createV2ProviderClient = (options: {
  locate(path: string): string;
  transport: ProviderHttpTransport;
  ready?(): Promise<void>;
  callbackDeadlineMs?: number;
}): ProviderHttpClient => {
  const methods = new Map<number, MethodBinding>();
  const methodIndices = new Map<string, number>();
  const attempts = new Map<string, Attempt>();
  const query = (path: string) => options.transport.queryRequired(options.locate(path));
  const mutate = async (method: "POST" | "DELETE", path: string, body?: unknown): Promise<unknown> => {
    const raw = record(await options.transport.mutate(method, options.locate(path), body));
    if (raw?.kind === "unknown") throw failure(`${method} ${path} outcome is unknown; do not retry automatically`, "unavailable");
    if (typeof raw?.status !== "number") throw failure(`${method} ${path} returned no mutation receipt`);
    if (raw.status < 200 || raw.status >= 300) throw failure(`${method} ${path} failed (HTTP ${raw.status})`, raw.status === 401 || raw.status === 403 ? "auth-rejected" : `http-${raw.status}`);
    return raw.body;
  };
  const inventory = async () => {
    await options.ready?.();
    const [providerBody, integrationBody] = await Promise.all([query("/api/provider"), query("/api/integration")]);
    const providers = rows(providerBody, "/api/provider");
    const integrations = rows(integrationBody, "/api/integration");
    for (const integration of integrations) {
      if (!text(integration.name) || !Array.isArray(integration.methods) || !Array.isArray(integration.connections)) throw failure("/api/integration returned invalid methods or connections");
      if (integration.methods.some((method) => !record(method) || !["key", "oauth", "env", "command"].includes(String(record(method)?.type)))) throw failure("/api/integration returned an invalid method");
      if (integration.connections.some((connection) => {
        const item = record(connection);
        return !item || (item.type === "credential" ? !text(item.id) : item.type === "env" ? !text(item.name) : true);
      })) throw failure("/api/integration returned an invalid connection");
    }
    const referenced = new Set<string>();
    const available = providers.map((provider) => {
      if (!text(provider.name) || (provider.integrationID !== undefined && !text(provider.integrationID))) throw failure("/api/provider returned an invalid provider");
      const integrationID = provider.integrationID ?? provider.id;
      referenced.add(String(integrationID));
      return { provider, integration: integrations.find((item) => item.id === integrationID) };
    });
    // /api/provider contains only available providers. Disconnected accounts
    // must remain discoverable from /api/integration so users can connect them.
    return [...available, ...integrations.filter((item) => !referenced.has(String(item.id)))
      .map((integration) => ({ provider: { id: integration.id, name: integration.name }, integration }))];
  };
  const lookup = async (providerID: string) => {
    const item = (await inventory()).find((entry) => entry.provider.id === providerID);
    if (!item?.integration) throw failure(`provider ${providerID} has no authentication integration`, "unsupported");
    return item.integration;
  };
  const prompts = (method: Row): ProviderAuthPrompt[] | undefined => {
    if (method.form === undefined) return [];
    if (!Array.isArray(method.form) || !method.form.length) throw failure("integration method returned an invalid form");
    const result: ProviderAuthPrompt[] = [];
    for (const value of method.form) {
      const field = record(value);
      // The existing auth UI can faithfully represent text and single-select
      // inputs. Other native form types remain unavailable through this seam.
      if (!field || field.type !== "string" || !text(field.key)) return undefined;
      const conditions = field.when;
      if (conditions !== undefined && (!Array.isArray(conditions) || conditions.length > 1)) return undefined;
      const when = Array.isArray(conditions) ? record(conditions[0]) : undefined;
      if (when && (!text(when.key) || !["eq", "neq"].includes(String(when.op)) || typeof when.value !== "string")) return undefined;
      const choices = field.options;
      if (choices !== undefined && (!Array.isArray(choices) || choices.some((choice) => !text(record(choice)?.value) || !text(record(choice)?.label)))) throw failure("integration form returned invalid options");
      // A custom value alongside choices needs richer auth UI support.
      if (Array.isArray(choices) && choices.length && field.custom === true) return undefined;
      result.push({ key: field.key, message: String(field.title ?? field.description ?? field.key), type: Array.isArray(choices) && choices.length ? "select" : "text",
        ...(typeof field.placeholder === "string" ? { placeholder: field.placeholder } : {}),
        ...(Array.isArray(choices) && choices.length ? { options: choices.map((choice) => ({ value: String(choice.value), label: String(choice.label) })) } : {}),
        ...(when ? { when: { key: String(when.key), op: when.op as "eq" | "neq", value: String(when.value) } } : {}),
      });
    }
    return result;
  };
  const binding = async (providerID: string, index: number): Promise<MethodBinding> => {
    const previous = methods.get(index);
    if (!previous || previous.providerID !== providerID) throw failure("authentication method is stale; refresh provider settings", "unsupported");
    const integration = await lookup(providerID);
    if (integration.id !== previous.integrationID || !(integration.methods as Row[]).some((method) => JSON.stringify(method) === JSON.stringify(previous.method))) throw failure("authentication method changed; refresh provider settings", "unsupported");
    return previous;
  };
  return {
    async listAllProviders(): Promise<AvailableProviderDescriptor[]> {
      return (await inventory()).map(({ provider, integration }) => {
        const env = (integration?.methods as Row[] | undefined)?.flatMap((method) => method.type === "env" && Array.isArray(method.names) ? method.names.filter(text) : []) ?? [];
        return { id: String(provider.id), name: String(provider.name), ...(env.length ? { env } : {}) };
      });
    },
    async providerAuthMethods() {
      const result: Record<string, ProviderAuthMethod[]> = {};
      for (const { provider, integration } of await inventory()) {
        if (!integration) continue;
        result[String(provider.id)] = (integration.methods as Row[]).flatMap((method) => {
          if (method.type !== "key" && method.type !== "oauth") return [];
          if (method.type === "oauth" && (!text(method.id) || !text(method.label))) throw failure("integration returned an invalid OAuth method");
          const fields = prompts(method);
          if (!fields) return [];
          const key = JSON.stringify([provider.id, integration.id, method]);
          let index = methodIndices.get(key);
          if (index === undefined) { index = methodIndices.size; methodIndices.set(key, index); }
          methods.set(index, { providerID: String(provider.id), integrationID: String(integration.id), method: structuredClone(method) });
          return [{ type: method.type === "key" ? "api" as const : "oauth" as const, label: String(method.label ?? "API key"), upstreamIndex: index, ...(fields.length ? { prompts: fields } : {}) }];
        });
      }
      return result;
    },
    async providerAuthorize(providerID, index, inputs): Promise<ProviderAuthorization> {
      const selected = await binding(providerID, index);
      if (selected.method.type !== "oauth") throw failure("selected method is not OAuth", "unsupported");
      const attemptKey = `${providerID}\0${index}`;
      const previous = attempts.get(attemptKey);
      if (previous) { await mutate("DELETE", previous.path); attempts.delete(attemptKey); }
      const path = `/api/integration/${encodeURIComponent(selected.integrationID)}/connect/oauth`;
      const body = record(record(await mutate("POST", path, { methodID: selected.method.id, ...(inputs ? { answer: inputs } : {}) }))?.data);
      const time = record(body?.time);
      if (!body || !text(body.attemptID) || !text(body.url) || typeof body.instructions !== "string" || !["auto", "code"].includes(String(body.mode)) || typeof time?.expires !== "number" || !Number.isFinite(time.expires)) throw failure("OAuth connect returned an invalid attempt");
      const mode = body.mode as "auto" | "code";
      attempts.set(attemptKey, { path: `${path}/${encodeURIComponent(body.attemptID)}`, expires: time.expires, mode });
      return { url: body.url, method: mode, instructions: body.instructions };
    },
    async providerAuthCallback(providerID, index, code) {
      const key = `${providerID}\0${index}`;
      const attempt = attempts.get(key);
      if (!attempt) throw failure("OAuth attempt is no longer available; start authentication again", "unsupported");
      try {
        if (attempt.mode === "code") {
          if (!code) throw failure("OAuth verification code is required", "invalid-input");
          await mutate("POST", `${attempt.path}/complete`, { code });
        }
        const deadline = Math.min(attempt.expires, Date.now() + (options.callbackDeadlineMs ?? 120_000));
        while (Date.now() < deadline) {
          if (attempts.get(key) !== attempt) throw failure("OAuth attempt was superseded", "unsupported");
          const state = record(record(await query(attempt.path))?.data);
          if (state?.status === "complete") return true;
          if (state?.status === "failed") throw failure("OAuth authorization was rejected", "auth-rejected");
          if (state?.status === "expired") throw failure("OAuth authorization expired", "auth-expired");
          if (state?.status !== "pending") throw failure("OAuth status returned an invalid response");
          await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(1, deadline - Date.now()))));
        }
        throw failure("OAuth authorization deadline expired", "auth-expired");
      } finally { if (attempts.get(key) === attempt) attempts.delete(key); }
    },
    async setProviderApiKey(providerID, key, metadata) {
      const integration = await lookup(providerID);
      const method = (integration.methods as Row[]).find((item) => item.type === "key");
      if (!method || !prompts(method)) throw failure("API key method is unavailable", "unsupported");
      await mutate("POST", `/api/integration/${encodeURIComponent(String(integration.id))}/connect/key`, { key, ...(metadata ? { answer: metadata } : {}) });
      return true;
    },
    async removeProviderAuth(providerID) {
      const integration = await lookup(providerID);
      const connections = integration.connections as Row[];
      if (connections.some((item) => item.type === "env")) throw failure("credentials supplied by the environment must be removed from that environment", "unsupported");
      // The generic action is provider logout, so remove each stored account
      // for its integration. Each confirmed deletion is separate; never replay.
      for (const connection of connections) await mutate("DELETE", `/api/credential/${encodeURIComponent(String(connection.id))}`);
      return true;
    },
  };
};
