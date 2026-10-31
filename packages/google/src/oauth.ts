// Google OAuth for an installed ("Desktop app") client: authorization code
// with PKCE (S256) and a loopback redirect, as Google recommends for desktop
// applications. The browser that completes consent may run on another device
// than the Polyth server (phone, remote desktop, container), where the
// loopback redirect cannot reach the server. Those users paste the final
// redirected URL instead; it is validated exactly like a loopback callback.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { GoogleError, googleError, type FetchLike } from "./http.ts";
import { parseScopes } from "./scopes.ts";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export interface OAuthClient {
  clientId: string;
  /** Desktop clients are issued a secret Google does not treat as confidential;
   * the token endpoint still expects it when one was issued. */
  clientSecret?: string;
}

export interface TokenGrant {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
  scopes: string[];
}

export interface GoogleUserInfo {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

const TIMEOUT_MS = 20_000;

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authorizationUrl(input: {
  client: OAuthClient;
  redirectUri: string;
  state: string;
  challenge: string;
  scopes: readonly string[];
  loginHint?: string;
}): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", input.client.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  // Consent is shown every time so Google always returns a refresh token that
  // covers the full requested set.
  url.searchParams.set("prompt", "consent");
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  return url.toString();
}

interface TokenEndpointResponse {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

async function postForm(fetcher: FetchLike, url: string, form: Record<string, string>): Promise<{ status: number; json: TokenEndpointResponse }> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
  } catch {
    return googleError("network-error", "Could not reach Google's sign-in service. Check the network connection and try again.");
  }
  const text = await response.text().catch(() => "");
  let json: TokenEndpointResponse = {};
  try { json = JSON.parse(text) as TokenEndpointResponse; } catch { /* classified by status below */ }
  return { status: response.status, json };
}

function tokenFailure(status: number, json: TokenEndpointResponse, during: "exchange" | "refresh"): GoogleError {
  const error = typeof json.error === "string" ? json.error : "";
  if (error === "invalid_grant") {
    return during === "refresh"
      ? new GoogleError("authorization-revoked", "Google no longer accepts this account's authorization (revoked, expired, or the password changed). Reconnect the account in Settings → Google.", { status, reason: error })
      : new GoogleError("authorization-required", "Google rejected the authorization code (expired, already used, or from another sign-in attempt). Start the connection again.", { status, reason: error });
  }
  if (error === "invalid_client" || error === "unauthorized_client") {
    return new GoogleError("not-configured", "Google did not accept this Google app's client ID or secret. Set up the Google app again in Settings → Google → Advanced.", { status, reason: error });
  }
  // Google's own explanation, e.g. "client_secret is missing.", is plain text
  // about the request and never echoes the code or a token.
  const detail = typeof json.error_description === "string" ? json.error_description.replace(/\s+/g, " ").trim().slice(0, 160) : "";
  if (error === "invalid_request" && /client_secret/i.test(detail)) {
    return new GoogleError("not-configured", "This Google app's client secret is missing. Add the Google app again in Settings → Google → Advanced, using the file Google gave you.", { status, reason: error });
  }
  if (status >= 500) return new GoogleError("google-unavailable", "Google's sign-in service is temporarily unavailable; try again shortly.", { status });
  const why = [error, detail].filter(Boolean).join(": ");
  return new GoogleError("invalid-request", `Google's sign-in service rejected the request${why ? ` (${why})` : ""}.`, { status, ...(error ? { reason: error } : {}) });
}

function grantFrom(json: TokenEndpointResponse, now: number): TokenGrant | null {
  if (typeof json.access_token !== "string" || !json.access_token) return null;
  const expiresIn = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
  return {
    accessToken: json.access_token,
    expiresAt: now + expiresIn * 1000,
    ...(typeof json.refresh_token === "string" && json.refresh_token ? { refreshToken: json.refresh_token } : {}),
    scopes: parseScopes(json.scope),
  };
}

export async function exchangeCode(input: {
  client: OAuthClient;
  code: string;
  verifier: string;
  redirectUri: string;
  fetch: FetchLike;
  now?: () => number;
}): Promise<TokenGrant> {
  const { status, json } = await postForm(input.fetch, GOOGLE_TOKEN_URL, {
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.redirectUri,
    client_id: input.client.clientId,
    ...(input.client.clientSecret ? { client_secret: input.client.clientSecret } : {}),
  });
  const grant = status >= 200 && status < 300 ? grantFrom(json, (input.now ?? Date.now)()) : null;
  if (!grant) throw tokenFailure(status, json, "exchange");
  return grant;
}

export async function refreshAccessToken(input: {
  client: OAuthClient;
  refreshToken: string;
  fetch: FetchLike;
  now?: () => number;
}): Promise<TokenGrant> {
  const { status, json } = await postForm(input.fetch, GOOGLE_TOKEN_URL, {
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.client.clientId,
    ...(input.client.clientSecret ? { client_secret: input.client.clientSecret } : {}),
  });
  const grant = status >= 200 && status < 300 ? grantFrom(json, (input.now ?? Date.now)()) : null;
  if (!grant) throw tokenFailure(status, json, "refresh");
  return grant;
}

/** Revoke the grant at Google. Revoking either token ends the whole grant for
 * this client and account. An already-invalid token counts as revoked. */
export async function revokeToken(token: string, fetcher: FetchLike): Promise<boolean> {
  try {
    const { status, json } = await postForm(fetcher, GOOGLE_REVOKE_URL, { token });
    return status === 200 || json.error === "invalid_token";
  } catch {
    return false;
  }
}

export async function fetchUserInfo(accessToken: string, fetcher: FetchLike): Promise<GoogleUserInfo> {
  let response: Response;
  try {
    response = await fetcher(GOOGLE_USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
  } catch {
    return googleError("network-error", "Could not reach Google to read the account profile.");
  }
  if (!response.ok) return googleError("google-unavailable", `Google did not return the account profile (HTTP ${response.status}).`, { status: response.status });
  const json = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof json.sub !== "string" || !/^[0-9A-Za-z_-]{1,128}$/.test(json.sub) || typeof json.email !== "string" || !json.email.includes("@")) {
    return googleError("google-unavailable", "Google returned an account profile without an account id or email.");
  }
  return {
    sub: json.sub,
    email: json.email,
    ...(typeof json.name === "string" && json.name ? { name: json.name.slice(0, 200) } : {}),
    ...(typeof json.picture === "string" && /^https:\/\//.test(json.picture) ? { picture: json.picture } : {}),
  };
}

// ---- pending authorizations ---------------------------------------------------

export type OAuthFlowStatus = "pending" | "completed" | "failed" | "cancelled";

export interface OAuthFlowView {
  state: string;
  status: OAuthFlowStatus;
  url: string;
  redirectUri: string;
  expiresAt: number;
  accountId?: string;
  email?: string;
  error?: { code: string; message: string };
}

/** Who a sign-in connects for: the person who started it, or the Space (a service account). */
export type OAuthFlowOwner = "person" | "space";

export interface OAuthCompletion {
  spaceId: string;
  /** The person who started the sign-in (and, for `person`, the account's owner). */
  userId: string;
  owner: OAuthFlowOwner;
  code: string;
  verifier: string;
  redirectUri: string;
  /** Account being reauthorized, when this is an incremental authorization. */
  accountId?: string;
}

interface Flow {
  spaceId: string;
  userId: string;
  owner: OAuthFlowOwner;
  state: string;
  verifier: string;
  url: string;
  redirectUri: string;
  expiresAt: number;
  accountId?: string;
  status: OAuthFlowStatus;
  result?: { accountId: string; email: string };
  error?: { code: string; message: string };
  server?: Server;
  timer?: ReturnType<typeof setTimeout>;
  completing?: Promise<void>;
}

export interface OAuthFlows {
  start(input: {
    spaceId: string;
    userId: string;
    owner: OAuthFlowOwner;
    client: OAuthClient;
    scopes: readonly string[];
    accountId?: string;
    loginHint?: string;
  }): Promise<OAuthFlowView>;
  status(spaceId: string, userId: string, state: string): OAuthFlowView;
  /** Complete from the URL the browser was redirected to (paste fallback). */
  completeFromUrl(spaceId: string, userId: string, pasted: string): Promise<OAuthFlowView>;
  cancel(spaceId: string, userId: string, state: string): OAuthFlowView;
  dispose(): void;
}

const FLOW_TTL_MS = 10 * 60_000;
const FINISHED_RETENTION_MS = 5 * 60_000;
const MAX_FLOWS = 64;

const sameSecret = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

const PAGE = (title: string, text: string): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#1f2328}h1{font-size:1.25rem}</style></head><body><h1>${title}</h1><p>${text}</p></body></html>`;

/**
 * Pending Google authorizations, each bound to the Space and user that started
 * it and to whom it connects for (that person, or the Space). A flow listens on 127.0.0.1 with an ephemeral port for exactly one valid
 * callback, accepts the same callback pasted from another device, and is
 * discarded after ten minutes. Codes, verifiers and tokens are never logged.
 */
export function createOAuthFlows(deps: {
  complete(completion: OAuthCompletion): Promise<{ accountId: string; email: string }>;
  /** Start a loopback listener per flow. Tests disable it. */
  listen?: boolean;
  now?: () => number;
}): OAuthFlows {
  const flows = new Map<string, Flow>();
  const now = deps.now ?? Date.now;
  const listen = deps.listen ?? true;

  const view = (flow: Flow): OAuthFlowView => ({
    state: flow.state,
    status: flow.status,
    url: flow.url,
    redirectUri: flow.redirectUri,
    expiresAt: flow.expiresAt,
    ...(flow.result ? { accountId: flow.result.accountId, email: flow.result.email } : {}),
    ...(flow.error ? { error: flow.error } : {}),
  });

  const closeListener = (flow: Flow): void => {
    if (flow.timer) clearTimeout(flow.timer);
    flow.timer = undefined;
    const server = flow.server;
    flow.server = undefined;
    if (!server) return;
    server.close();
    // Let the callback response that finished the flow reach the browser.
    setTimeout(() => server.closeAllConnections?.(), 2_000).unref?.();
  };

  const finish = (flow: Flow, status: Exclude<OAuthFlowStatus, "pending">, error?: { code: string; message: string }): void => {
    if (flow.status !== "pending") return;
    flow.status = status;
    if (error) flow.error = error;
    flow.verifier = "";
    closeListener(flow);
    flow.timer = setTimeout(() => { if (flows.get(flow.state) === flow) flows.delete(flow.state); }, FINISHED_RETENTION_MS);
    flow.timer.unref?.();
  };

  const prune = (): void => {
    const at = now();
    for (const flow of flows.values()) {
      if (flow.status === "pending" && flow.expiresAt <= at) finish(flow, "failed", { code: "cancelled", message: "The Google sign-in timed out. Start the connection again." });
    }
  };

  const owned = (spaceId: string, userId: string, state: string): Flow => {
    prune();
    const flow = typeof state === "string" ? flows.get(state) : undefined;
    // A foreign Space's flow is indistinguishable from a missing one.
    if (!flow || flow.spaceId !== spaceId || flow.userId !== userId) {
      return googleError("not-found", "This Google sign-in is no longer pending. Start the connection again.");
    }
    return flow;
  };

  const redeem = (flow: Flow, code: string): Promise<void> => {
    if (flow.completing) return flow.completing;
    const verifier = flow.verifier;
    flow.completing = deps.complete({
      spaceId: flow.spaceId,
      userId: flow.userId,
      owner: flow.owner,
      code,
      verifier,
      redirectUri: flow.redirectUri,
      ...(flow.accountId ? { accountId: flow.accountId } : {}),
    }).then((result) => {
      flow.result = result;
      finish(flow, "completed");
    }, (error: unknown) => {
      const failure = error instanceof GoogleError
        ? { code: error.code, message: error.message }
        : { code: "google-unavailable", message: "Connecting the Google account failed." };
      finish(flow, "failed", failure);
    });
    return flow.completing;
  };

  /** Validate redirect parameters against the flow. Returns the code to redeem. */
  const accept = (flow: Flow, params: URLSearchParams): string | null => {
    const state = params.get("state") ?? "";
    if (!sameSecret(state, flow.state)) return null;
    if (flow.status !== "pending") return null;
    const error = params.get("error");
    if (error) {
      finish(flow, error === "access_denied" ? "cancelled" : "failed", error === "access_denied"
        ? { code: "cancelled", message: "Google sign-in was cancelled." }
        : { code: "authorization-required", message: `Google sign-in failed (${error.slice(0, 64)}).` });
      return null;
    }
    const code = params.get("code");
    if (!code || code.length > 2048) {
      finish(flow, "failed", { code: "invalid-request", message: "Google returned no authorization code." });
      return null;
    }
    return code;
  };

  const startListener = (flow: Flow): Promise<string> => new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const reply = (status: number, title: string, text: string) => {
        res.writeHead(status, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
          "x-content-type-options": "nosniff",
        });
        res.end(PAGE(title, text));
      };
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method !== "GET" || url.pathname !== "/") { reply(404, "Not found", "This address only completes a Google sign-in for Polyth."); return; }
      const code = accept(flow, url.searchParams);
      if (code === null) {
        if (flow.status === "cancelled") reply(200, "Sign-in cancelled", "You can close this tab and return to Polyth.");
        else reply(400, "Sign-in not completed", "This sign-in request is invalid or has already finished. Return to Polyth and start again.");
        return;
      }
      void redeem(flow, code).then(() => {
        if (flow.status === "completed") reply(200, "Google account connected", "You can close this tab and return to Polyth.");
        else reply(400, "Sign-in not completed", "Polyth could not finish connecting the account. Return to Polyth for details.");
      });
    });
    server.on("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new Error("listener unavailable")); return; }
      flow.server = server;
      server.unref();
      resolve(`http://127.0.0.1:${address.port}/`);
    });
  });

  return {
    async start(input) {
      prune();
      if (!input.client.clientId) return googleError("not-configured", "Set up a Google OAuth client in Settings → Google first.");
      // One pending sign-in per user and Space: a new attempt supersedes the old one.
      for (const flow of flows.values()) {
        if (flow.spaceId === input.spaceId && flow.userId === input.userId && flow.status === "pending") {
          finish(flow, "cancelled", { code: "cancelled", message: "Superseded by a newer sign-in." });
        }
      }
      if ([...flows.values()].filter((flow) => flow.status === "pending").length >= MAX_FLOWS) {
        return googleError("rate-limited", "Too many Google sign-ins are pending; finish or cancel one first.");
      }
      const state = randomBytes(24).toString("base64url");
      const pkce = createPkce();
      const flow: Flow = {
        spaceId: input.spaceId,
        userId: input.userId,
        owner: input.owner,
        state,
        verifier: pkce.verifier,
        url: "",
        redirectUri: "",
        expiresAt: now() + FLOW_TTL_MS,
        ...(input.accountId ? { accountId: input.accountId } : {}),
        status: "pending",
      };
      try {
        // Without a listener the redirect still targets a loopback address the
        // user's browser cannot load; the pasted URL completes the flow.
        flow.redirectUri = listen ? await startListener(flow) : `http://127.0.0.1:${40_000 + (randomBytes(2).readUInt16BE() % 20_000)}/`;
      } catch {
        return googleError("google-unavailable", "Polyth could not open a local sign-in listener.");
      }
      flow.url = authorizationUrl({
        client: input.client,
        redirectUri: flow.redirectUri,
        state,
        challenge: pkce.challenge,
        scopes: input.scopes,
        ...(input.loginHint ? { loginHint: input.loginHint } : {}),
      });
      flow.timer = setTimeout(() => finish(flow, "failed", { code: "cancelled", message: "The Google sign-in timed out. Start the connection again." }), FLOW_TTL_MS);
      flow.timer.unref?.();
      flows.set(state, flow);
      return view(flow);
    },
    status(spaceId, userId, state) {
      return view(owned(spaceId, userId, state));
    },
    async completeFromUrl(spaceId, userId, pasted) {
      let url: URL;
      try {
        url = new URL(String(pasted ?? "").trim());
      } catch {
        return googleError("invalid-request", "Paste the full address from the browser's address bar after approving access.");
      }
      const flow = owned(spaceId, userId, url.searchParams.get("state") ?? "");
      const expected = new URL(flow.redirectUri);
      if (url.protocol !== "http:" || url.host !== expected.host || url.pathname !== expected.pathname) {
        return googleError("invalid-request", "That address is not this sign-in's Google redirect. Paste the address shown after approving access.");
      }
      if (flow.status !== "pending") return view(flow);
      const code = accept(flow, url.searchParams);
      if (code !== null) await redeem(flow, code);
      return view(flow);
    },
    cancel(spaceId, userId, state) {
      const flow = owned(spaceId, userId, state);
      finish(flow, "cancelled", { code: "cancelled", message: "Google sign-in was cancelled." });
      return view(flow);
    },
    dispose() {
      for (const flow of flows.values()) {
        finish(flow, "cancelled", { code: "cancelled", message: "Google sign-in was interrupted." });
        closeListener(flow);
      }
      flows.clear();
    },
  };
}
