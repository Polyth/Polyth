import { Buffer } from 'node:buffer';
import { controlError } from '@polyth/control-plane';
import type {
  IdentityProviderAdapter,
  NormalizedExternalIdentity,
  ProviderBeginInput,
  ProviderBeginResult,
  ProviderExchangeInput,
  ProviderNetworkBroker,
  ProviderNetworkResponse,
} from '../types.ts';

const ISSUER = 'https://bitbucket.org';
const AUTHORIZE = `${ISSUER}/site/oauth2/authorize`;
const TOKEN = `${ISSUER}/site/oauth2/access_token`;
const API_USER = 'https://api.bitbucket.org/2.0/user';
const CLIENT_ID = /^[A-Za-z0-9_-]{8,256}$/;
const UUID = /^\{?([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\}?$/i;
const MAX_RESPONSE = 256 * 1024;
const CODE_HOSTING_SCOPE = /(?:repository|pullrequest|project|pipeline|webhook|snippet|issue|wiki|runner|ssh|gpg)(?::|$)/;

interface BitbucketConfig {
  clientId: string;
  registeredCallbackUrl: string;
  declaredScopes: string[];
}
interface BitbucketExchange { accessToken: string }

function callback(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw controlError('invalid-input', 'Bitbucket callback URL is invalid');
  let url: URL;
  try { url = new URL(value); } catch { throw controlError('invalid-input', 'Bitbucket callback URL is invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw controlError('invalid-input', 'Bitbucket callback URL must be HTTPS');
  return url.href;
}
function config(value: Readonly<Record<string, unknown>>): BitbucketConfig {
  if (typeof value.clientId !== 'string' || !CLIENT_ID.test(value.clientId)) throw controlError('invalid-input', 'Bitbucket consumer key is invalid');
  const registeredCallbackUrl = callback(value.registeredCallbackUrl);
  if (!Array.isArray(value.declaredScopes) || value.declaredScopes.some(scope => typeof scope !== 'string')) throw controlError('invalid-input', 'Bitbucket consumer scopes must be recorded');
  const declaredScopes = [...new Set(value.declaredScopes as string[])].sort();
  if (declaredScopes.length !== 1 || declaredScopes[0] !== 'account') {
    throw controlError('provider-scope-escalation', 'Bitbucket login requires a dedicated consumer with only the account scope');
  }
  return { clientId: value.clientId, registeredCallbackUrl, declaredScopes };
}
function json(response: ProviderNetworkResponse, code = 'invalid-provider-response'): Record<string, unknown> {
  if (response.status < 200 || response.status >= 300 || typeof response.body !== 'string' || response.body.length > MAX_RESPONSE) {
    throw controlError(response.status >= 500 ? 'provider-unavailable' : code, 'Bitbucket identity service did not return a valid response');
  }
  try {
    const value = JSON.parse(response.body) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
    return value as Record<string, unknown>;
  } catch { throw controlError(code, 'Bitbucket identity service returned malformed JSON'); }
}
async function request(network: ProviderNetworkBroker, providerId: string, req: Parameters<ProviderNetworkBroker['request']>[2]) {
  try { return await network.request(providerId, ISSUER, req); }
  catch { throw controlError('provider-unavailable', 'Bitbucket identity service is unavailable'); }
}
function accessToken(value: unknown): string {
  if (typeof value !== 'string' || value.length < 16 || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) throw controlError('invalid-provider-response', 'Bitbucket access token is invalid');
  return value;
}
function returnedScopes(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/[ ,]+/).map(v => v.trim()).filter(Boolean);
  if (Array.isArray(value) && value.every(v => typeof v === 'string')) return value as string[];
  return [];
}

export const bitbucketIdentityAdapter: IdentityProviderAdapter<BitbucketExchange> = {
  kind: 'bitbucket',
  capabilities: { web: true, device: false, refresh: false, revoke: false, discovery: false },
  canonicalizeIssuer(value) {
    let url: URL;
    try { url = new URL(value); } catch { throw controlError('invalid-input', 'Bitbucket identity issuer is invalid'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || `${url.origin}${url.pathname.replace(/\/$/, '')}` !== ISSUER) {
      throw controlError('invalid-input', 'Bitbucket Cloud identity issuer must be https://bitbucket.org');
    }
    return ISSUER;
  },
  begin(input: ProviderBeginInput): ProviderBeginResult {
    if (input.issuer !== ISSUER) throw controlError('invalid-input', 'Bitbucket issuer mismatch');
    const cfg = config(input.publicConfig);
    if (callback(input.callbackUrl) !== cfg.registeredCallbackUrl) throw controlError('callback-mismatch', 'Bitbucket callback must exactly match the registered consumer callback');
    const url = new URL(AUTHORIZE);
    url.searchParams.set('client_id', cfg.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', input.state);
    // Bitbucket scopes are configured statically on the consumer. Current official
    // Authorization Code docs do not declare PKCE/device support for this flow;
    // do not send guessed code_challenge or scope parameters.
    return { authorizationUrl: url.href };
  },
  async exchange(input: ProviderExchangeInput, network: ProviderNetworkBroker): Promise<BitbucketExchange> {
    if (input.issuer !== ISSUER) throw controlError('invalid-input', 'Bitbucket issuer mismatch');
    const cfg = config(input.publicConfig);
    if (callback(input.callbackUrl) !== cfg.registeredCallbackUrl) throw controlError('callback-mismatch', 'Bitbucket callback must exactly match the registered consumer callback');
    if (!input.clientSecret) throw controlError('invalid-input', 'Bitbucket consumer secret is required');
    const basic = Buffer.from(`${cfg.clientId}:${input.clientSecret}`, 'utf8').toString('base64');
    const body = new URLSearchParams({ grant_type: 'authorization_code', code: input.code });
    const value = json(await request(network, input.providerId, {
      url: TOKEN, method: 'POST',
      headers: { accept: 'application/json', authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }), 'invalid-credentials');
    if (typeof value.error === 'string') throw controlError('invalid-credentials', 'Bitbucket authorization was not accepted');
    if (typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer') throw controlError('invalid-provider-response', 'Bitbucket token type is invalid');
    const granted = returnedScopes(value.scopes ?? value.scope);
    if (granted.some(scope => CODE_HOSTING_SCOPE.test(scope) || scope !== 'account')) {
      throw controlError('provider-scope-escalation', 'Bitbucket login token includes non-identity permissions; use a dedicated identity consumer');
    }
    return { accessToken: accessToken(value.access_token) };
  },
  async resolveIdentity(exchange: BitbucketExchange, network: ProviderNetworkBroker): Promise<NormalizedExternalIdentity> {
    const value = json(await request(network, 'bitbucket', {
      url: API_USER, method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${exchange.accessToken}` },
    }));
    const match = typeof value.uuid === 'string' ? UUID.exec(value.uuid) : null;
    if (!match || value.type !== 'user' || typeof value.display_name !== 'string' || !value.display_name.trim() || value.display_name.length > 160) {
      throw controlError('invalid-provider-response', 'Bitbucket account identity is incomplete');
    }
    return { issuer: ISSUER, subject: match[1]!.toLowerCase(), displayName: value.display_name.trim() };
  },
};
