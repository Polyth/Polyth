import { controlError } from '@polyth/control-plane';
import { canonicalHttpsIssuer } from '../framework.ts';
import type {
  IdentityProviderAdapter,
  NormalizedExternalIdentity,
  ProviderBeginInput,
  ProviderBeginResult,
  ProviderExchangeInput,
  ProviderNetworkBroker,
  ProviderNetworkResponse,
} from '../types.ts';

const ISSUER = 'https://github.com';
const API = 'https://api.github.com';
const AUTHORIZE = `${ISSUER}/login/oauth/authorize`;
const TOKEN = `${ISSUER}/login/oauth/access_token`;
const API_VERSION = '2026-03-10';
const MAX_RESPONSE = 256 * 1024;
const CLIENT_ID = /^[A-Za-z0-9_-]{8,200}$/;

interface GitHubConfig { clientId: string; allowSignup?: boolean; deviceFlow?: boolean }
interface GitHubToken { accessToken: string; scope: string[] }

function config(value: Readonly<Record<string, unknown>>): GitHubConfig {
  const clientId = value.clientId;
  if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) throw controlError('invalid-input', 'GitHub client id is invalid');
  if (value.allowSignup !== undefined && typeof value.allowSignup !== 'boolean') throw controlError('invalid-input', 'GitHub allowSignup must be boolean');
  if (value.deviceFlow !== undefined && typeof value.deviceFlow !== 'boolean') throw controlError('invalid-input', 'GitHub deviceFlow must be boolean');
  return { clientId, ...(value.allowSignup !== undefined ? { allowSignup: value.allowSignup } : {}), ...(value.deviceFlow !== undefined ? { deviceFlow: value.deviceFlow } : {}) };
}
function responseJson(response: ProviderNetworkResponse): Record<string, unknown> {
  if (response.status < 200 || response.status >= 300 || typeof response.body !== 'string' || response.body.length > MAX_RESPONSE) {
    throw controlError('provider-unavailable', 'GitHub identity service is unavailable');
  }
  try {
    const value = JSON.parse(response.body) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
    return value as Record<string, unknown>;
  } catch { throw controlError('invalid-provider-response', 'GitHub returned an invalid response'); }
}
async function request(network: ProviderNetworkBroker, providerId: string, request: Parameters<ProviderNetworkBroker['request']>[2]) {
  try { return await network.request(providerId, ISSUER, request); }
  catch { throw controlError('provider-unavailable', 'GitHub identity service is unavailable'); }
}
function scopeList(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.split(/[ ,]+/).map(scope => scope.trim()).filter(Boolean);
}
function safeAccessToken(value: unknown): string {
  if (typeof value !== 'string' || value.length < 16 || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) {
    throw controlError('invalid-provider-response', 'GitHub token response is invalid');
  }
  return value;
}

/** Dedicated identity OAuth adapter. Code-hosting/repository authorization is separate. */
export const githubIdentityAdapter: IdentityProviderAdapter<GitHubToken> = {
  kind: 'github',
  // Device flow is deliberately not advertised through the generic browser
  // framework; it is enabled only by an explicit headless-client workflow.
  capabilities: { web: true, device: false, refresh: false, revoke: false, discovery: false },
  canonicalizeIssuer(value) {
    const issuer = canonicalHttpsIssuer(value);
    if (issuer !== ISSUER) throw controlError('invalid-input', 'GitHub identity issuer must be https://github.com');
    return issuer;
  },
  begin(input: ProviderBeginInput): ProviderBeginResult {
    const cfg = config(input.publicConfig);
    if (input.issuer !== ISSUER) throw controlError('invalid-input', 'GitHub identity issuer mismatch');
    const url = new URL(AUTHORIZE);
    url.searchParams.set('client_id', cfg.clientId);
    url.searchParams.set('redirect_uri', input.callbackUrl);
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', input.pkceChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('prompt', 'select_account');
    if (cfg.allowSignup === false) url.searchParams.set('allow_signup', 'false');
    // No identity scope is required for GET /user to identify the token owner.
    // Never request repo/gist/code-hosting access from the login adapter.
    return { authorizationUrl: url.href };
  },
  async exchange(input: ProviderExchangeInput, network: ProviderNetworkBroker): Promise<GitHubToken> {
    const cfg = config(input.publicConfig);
    if (input.issuer !== ISSUER || !input.clientSecret) throw controlError('invalid-input', 'GitHub OAuth app secret is required');
    const body = new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.callbackUrl,
      code_verifier: input.pkceVerifier,
    });
    const value = responseJson(await request(network, input.providerId, {
      url: TOKEN, method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }));
    if (typeof value.error === 'string') throw controlError('invalid-credentials', 'GitHub authorization was not accepted');
    const token = safeAccessToken(value.access_token);
    if (typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer') throw controlError('invalid-provider-response', 'GitHub token type is invalid');
    const scopes = scopeList(value.scope);
    // A dedicated login app must never silently become a code-hosting token.
    // GitHub can retain scopes previously granted to the same OAuth app, so
    // reject broad tokens even though this flow itself requested no scopes.
    const broad = scopes.some(scope => scope === 'repo' || scope.startsWith('repo:') || scope === 'gist' || scope.startsWith('admin:') || scope.startsWith('write:'));
    if (broad) throw controlError('provider-scope-escalation', 'GitHub login returned code-hosting permissions; use a dedicated identity app');
    return { accessToken: token, scope: scopes };
  },
  async resolveIdentity(token: GitHubToken, network: ProviderNetworkBroker): Promise<NormalizedExternalIdentity> {
    const value = responseJson(await request(network, 'github', {
      url: `${API}/user`, method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token.accessToken}`,
        'x-github-api-version': API_VERSION,
      },
    }));
    if (!(typeof value.id === 'number' && Number.isSafeInteger(value.id) && value.id > 0)
      || typeof value.login !== 'string' || !value.login || value.login.length > 100) {
      throw controlError('invalid-provider-response', 'GitHub user identity is invalid');
    }
    const displayName = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : value.login;
    // Public/private email visibility is irrelevant to identity: numeric id is stable.
    return { issuer: ISSUER, subject: String(value.id), displayName };
  },
};

export function githubDeviceFlowConfigured(publicConfig: Readonly<Record<string, unknown>>): boolean {
  return config(publicConfig).deviceFlow === true;
}
