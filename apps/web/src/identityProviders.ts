import { authJson } from "./authClient.ts";

export interface LoginProvider {
  id: string;
  kind: string;
  issuer: string;
}

export interface ManagedProvider extends LoginProvider {
  enabled: boolean;
  publicConfig: Readonly<Record<string, unknown>>;
  revision: number;
}

export interface LinkedIdentity {
  id: string;
  providerId: string;
  issuer: string;
  subject: string;
  createdAt: number;
  revision: number;
}

type ProviderPurpose = "login" | "link";
interface PendingProviderFlow {
  providerId: string;
  purpose: ProviderPurpose;
  state: string;
  returnTo: string;
}

const PENDING_KEY = "polyth.provider-flow.v1";

const fail = (response: Response, body: Record<string, unknown>): Error => Object.assign(
  new Error(typeof body.message === "string"
    ? body.message
    : typeof body.error === "string" ? body.error.replace(/-/g, " ") : `HTTP ${response.status}`),
  { status: response.status, code: typeof body.error === "string" ? body.error : undefined },
);

const getJson = async <T>(path: string): Promise<T> => {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin" });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw fail(response, body);
  return body as T;
};

const rememberPending = (value: PendingProviderFlow): void => {
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(value));
};
const readPending = (): PendingProviderFlow | null => {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingProviderFlow>;
    if ((value.purpose !== "login" && value.purpose !== "link")
      || typeof value.providerId !== "string" || typeof value.state !== "string" || typeof value.returnTo !== "string") return null;
    return value as PendingProviderFlow;
  } catch { return null; }
};
const clearPending = (): void => { try { sessionStorage.removeItem(PENDING_KEY); } catch { /* private mode */ } };

export async function listLoginProviders(): Promise<LoginProvider[]> {
  const result = await getJson<{ providers?: unknown }>("/api/auth/providers");
  return Array.isArray(result.providers) ? result.providers as LoginProvider[] : [];
}

export async function listManagedProviders(): Promise<ManagedProvider[]> {
  const result = await getJson<{ providers?: unknown }>("/api/auth/providers/manage");
  return Array.isArray(result.providers) ? result.providers as ManagedProvider[] : [];
}

export async function listLinkedIdentities(): Promise<LinkedIdentity[]> {
  const result = await getJson<{ links?: unknown }>("/api/auth/links");
  return Array.isArray(result.links) ? result.links as LinkedIdentity[] : [];
}

export async function beginProviderFlow(providerId: string, purpose: ProviderPurpose, returnTo = "/"): Promise<never> {
  const path = purpose === "login" ? "/api/auth/providers/login/begin" : "/api/auth/links/begin";
  const { response, body } = await authJson<{
    authorizationUrl?: unknown; state?: unknown; error?: string; message?: string;
  }>(path, { providerId, returnTo });
  if (!response.ok) throw fail(response, body);
  if (typeof body.authorizationUrl !== "string" || typeof body.state !== "string") throw new Error("Invalid provider authorization response");
  rememberPending({ providerId, purpose, state: body.state, returnTo });
  window.location.assign(body.authorizationUrl);
  return await new Promise<never>(() => undefined);
}

export function hasPendingProviderCallback(): boolean {
  return typeof window !== "undefined" && window.location.pathname === "/auth/provider/callback";
}

export async function completePendingProviderCallback(): Promise<{ returnTo: string; purpose: ProviderPurpose }> {
  if (!hasPendingProviderCallback()) throw new Error("No provider callback is pending");
  const params = new URLSearchParams(window.location.search);
  const pending = readPending();
  const state = params.get("state") ?? "";
  const code = params.get("code") ?? "";
  const providerError = params.get("error");
  if (!pending || !state || pending.state !== state) {
    clearPending();
    throw Object.assign(new Error("Provider callback does not match the active sign-in attempt"), { code: "invalid-provider-transaction" });
  }
  if (providerError || !code) {
    clearPending();
    throw Object.assign(new Error("Provider authorization was cancelled or denied"), { code: providerError ?? "invalid-credentials" });
  }

  const path = pending.purpose === "login" ? "/api/auth/providers/login/complete" : "/api/auth/links/complete";
  const { response, body } = await authJson(path, {
    providerId: pending.providerId,
    state,
    code,
  });
  if (!response.ok) {
    clearPending();
    throw fail(response, body);
  }
  clearPending();
  const serverReturnTo = typeof body.returnTo === "string" ? body.returnTo : pending.returnTo;
  return { returnTo: serverReturnTo, purpose: pending.purpose };
}

export async function configureProvider(input: {
  id: string;
  kind: string;
  issuer: string;
  publicConfig: Record<string, unknown>;
  clientSecret?: string | null;
}): Promise<ManagedProvider> {
  const { response, body } = await authJson("/api/auth/providers/configure", input);
  if (!response.ok) throw fail(response, body);
  return body as unknown as ManagedProvider;
}

export async function setProviderEnabled(provider: Pick<ManagedProvider, "id" | "revision">, enabled: boolean): Promise<ManagedProvider> {
  const { response, body } = await authJson(`/api/auth/providers/${encodeURIComponent(provider.id)}/enabled`, {
    enabled,
    expectedRevision: provider.revision,
  });
  if (!response.ok) throw fail(response, body);
  return body as unknown as ManagedProvider;
}

export async function unlinkIdentity(link: Pick<LinkedIdentity, "id" | "revision">): Promise<void> {
  const { response, body } = await authJson(`/api/auth/links/${encodeURIComponent(link.id)}`, {
    expectedRevision: link.revision,
  }, "DELETE");
  if (!response.ok) throw fail(response, body);
}
