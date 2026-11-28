import { createHash, randomBytes } from "node:crypto";
import type { NormalizedAuthMethod } from "@polyth/contracts";

/**
 * First-party PKCE providers.
 *
 * OpenCode exposes no OAuth method for these providers (its OpenRouter
 * integration offers only `key` and `env`), so Polyth mints the key itself:
 * `authorizeUrl` builds the vendor consent URL from a PKCE challenge, the user
 * authorizes, and `exchange` trades the returned code for an API key. The key
 * then takes the same path as a pasted one — `setProviderApiKey` — so it never
 * enters a DTO, log line or model context.
 */

export interface PkceAuthorizationUrlInput {
  challenge: string;
  state: string;
  /** Public callback; omitted means the vendor shows the code instead. */
  callbackUrl?: string;
  keyLabel?: string;
}

export interface PkceExchangeInput {
  code: string;
  verifier: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

export interface PkceProvider {
  /** Provider id as OpenCode names it, e.g. "openrouter". */
  id: string;
  label: string;
  /** Short human note shown while the attempt waits for the code. */
  instructions: string;
  authorizeUrl(input: PkceAuthorizationUrlInput): string;
  exchange(input: PkceExchangeInput): Promise<string>;
}

const base64url = (buffer: Buffer): string =>
  buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** RFC 7636 verifier (43 chars) and its S256 challenge. */
export const createPkcePair = (): PkcePair => {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
};

export const createPkceState = (): string => base64url(randomBytes(16));

const OPENROUTER_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";
const EXCHANGE_TIMEOUT_MS = 30_000;

const openRouter: PkceProvider = {
  id: "openrouter",
  label: "Sign in with OpenRouter",
  instructions: "Authorize Polyth on OpenRouter, then paste the authorization code or the callback URL below.",
  authorizeUrl: (input) => {
    const url = new URL("https://openrouter.ai/auth");
    if (input.callbackUrl) url.searchParams.set("callback_url", input.callbackUrl);
    url.searchParams.set("code_challenge", input.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (input.keyLabel) url.searchParams.set("key_label", input.keyLabel);
    url.searchParams.set("state", input.state);
    return url.toString();
  },
  exchange: async (input) => {
    const doFetch = input.fetch ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS);
    const abort = () => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await doFetch(OPENROUTER_EXCHANGE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: input.code,
          code_verifier: input.verifier,
          code_challenge_method: "S256",
        }),
        signal: controller.signal,
      });
      const text = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      const key = body && typeof body === "object" ? (body as { key?: unknown }).key : undefined;
      if (!response.ok || typeof key !== "string" || !key.trim()) {
        const detail = body && typeof body === "object"
          ? (body as { error?: { message?: unknown } | string }).error
          : undefined;
        const message = typeof detail === "string"
          ? detail
          : detail && typeof detail === "object" && typeof detail.message === "string"
            ? detail.message
            : `HTTP ${response.status}`;
        throw Object.assign(new Error(`OpenRouter key exchange failed: ${message}`), { status: response.status });
      }
      return key.trim();
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
    }
  },
};

export const PKCE_PROVIDERS: readonly PkceProvider[] = [openRouter];

export const pkceProvider = (providerId: string): PkceProvider | undefined =>
  PKCE_PROVIDERS.find((provider) => provider.id === providerId);

/** Synthetic method id suffix; the fingerprint carries the provider id. */
export const PKCE_METHOD_PREFIX = "polyth-pkce:";

export const isPkceMethodId = (methodId: string): boolean => methodId.includes(PKCE_METHOD_PREFIX);

export const pkceMethodFingerprint = (provider: PkceProvider): string => `${PKCE_METHOD_PREFIX}${provider.id}`;

export const isPkceFingerprint = (fingerprint: string): boolean =>
  fingerprint.startsWith(PKCE_METHOD_PREFIX) && Boolean(pkceProvider(fingerprint.slice(PKCE_METHOD_PREFIX.length)));

export const pkceProviderFromFingerprint = (fingerprint: string): PkceProvider | undefined =>
  fingerprint.startsWith(PKCE_METHOD_PREFIX)
    ? pkceProvider(fingerprint.slice(PKCE_METHOD_PREFIX.length))
    : undefined;

/** No upstream index exists for a method Polyth invents, so it reports -1. */
export const PKCE_UPSTREAM_INDEX = -1;

export const pkceAuthMethod = (provider: PkceProvider): NormalizedAuthMethod => ({
  id: `${provider.id}:${PKCE_UPSTREAM_INDEX}:${pkceMethodFingerprint(provider)}`,
  upstreamIndex: PKCE_UPSTREAM_INDEX,
  fingerprint: pkceMethodFingerprint(provider),
  provenance: "polyth",
  kind: "oauth",
  label: provider.label,
  fields: [],
  usable: true,
});

/**
 * Public callback for the vendor redirect, derived from the operator-declared
 * origin. Without one Polyth asks the vendor for the code on screen instead,
 * because a localhost redirect only works when the browser shares this host.
 */
export const pkceCallbackUrl = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const raw = (env.POLYTH_PUBLIC_ORIGIN ?? "").trim();
  if (!raw) return undefined;
  try {
    const origin = new URL(raw);
    if (origin.protocol !== "https:") return undefined;
    return `${origin.origin}/api/providers/auth/pkce/callback`;
  } catch {
    return undefined;
  }
};

export const PKCE_CALLBACK_PATH = "/api/providers/auth/pkce/callback";
