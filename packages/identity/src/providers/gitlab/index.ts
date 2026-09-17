import { isIP } from 'node:net';
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

const MAX_RESPONSE = 256 * 1024;
const BROAD_SCOPE = new Set(['api', 'read_api', 'sudo', 'admin_mode', 'read_repository', 'write_repository', 'create_runner', 'manage_runner']);
const CLIENT_ID = /^[A-Za-z0-9_-]{8,256}$/;

export interface GitLabOidcVerificationInput {
  providerId: string;
  expectedIssuer: string;
  discoveryUrl: string;
  clientId: string;
  nonce: string;
  idToken: string;
  privateNetworkApproved: boolean;
  network: ProviderNetworkBroker;
}
export interface GitLabOidcVerifier {
  /** Must validate discovery issuer, signature/alg/kid/JWKS, aud/azp, exp/nbf,
   * nonce and bounded clock skew with a maintained OIDC/JWT implementation. */
  verify(input: GitLabOidcVerificationInput): Promise<NormalizedExternalIdentity>;
}
interface GitLabConfig {
  clientId: string;
  privateNetworkApproved: boolean;
  testedVersion: string;
}
interface GitLabExchange {
  issuer: string;
  accessToken: string;
  idToken: string;
  nonce: string;
  clientId: string;
  privateNetworkApproved: boolean;
}

function config(value: Readonly<Record<string, unknown>>): GitLabConfig {
  if (typeof value.clientId !== 'string' || !CLIENT_ID.test(value.clientId)) throw controlError('invalid-input', 'GitLab client id is invalid');
  if (value.privateNetworkApproved !== undefined && typeof value.privateNetworkApproved !== 'boolean') throw controlError('invalid-input', 'GitLab privateNetworkApproved must be boolean');
  if (typeof value.testedVersion !== 'string' || !/^19\.(?:[0-9]|1[0-2])(?:\.[0-9]+)?$/.test(value.testedVersion)) {
    throw controlError('invalid-input', 'GitLab testedVersion must record a reviewed GitLab 19.x version');
  }
  return { clientId: value.clientId, privateNetworkApproved: value.privateNetworkApproved === true, testedVersion: value.testedVersion };
}
function path(base: string, suffix: string): string {
  return `${base.replace(/\/$/, '')}${suffix}`;
}
function discovery(base: string): string { return path(base, '/.well-known/openid-configuration'); }
function literalPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const family = isIP(h);
  if (family === 4) {
    const p = h.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) || (p[0] === 192 && p[1] === 168) || p[0] === 0;
  }
  if (family === 6) return h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || /^fe[89ab]/.test(h);
  return false;
}
function issuer(value: string, cfg: GitLabConfig): string {
  const canonical = canonicalHttpsIssuer(value);
  const url = new URL(canonical);
  if (literalPrivateHost(url.hostname) && !cfg.privateNetworkApproved) throw controlError('private-network-approval-required', 'Private GitLab identity issuer requires explicit administrator approval');
  return canonical;
}
function json(response: ProviderNetworkResponse, code = 'invalid-provider-response'): Record<string, unknown> {
  if (response.status < 200 || response.status >= 300 || typeof response.body !== 'string' || response.body.length > MAX_RESPONSE) {
    throw controlError(response.status >= 500 ? 'provider-unavailable' : code, 'GitLab identity service did not return a valid response');
  }
  try {
    const value = JSON.parse(response.body) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
    return value as Record<string, unknown>;
  } catch { throw controlError(code, 'GitLab identity service returned malformed JSON'); }
}
async function request(network: ProviderNetworkBroker, providerId: string, expectedIssuer: string, req: Parameters<ProviderNetworkBroker['request']>[2]) {
  try { return await network.request(providerId, expectedIssuer, req); }
  catch { throw controlError('provider-unavailable', 'GitLab identity service is unavailable'); }
}
function token(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 16 || value.length > 32_768 || /[\x00-\x20\x7f]/.test(value)) throw controlError('invalid-provider-response', `GitLab ${label} is invalid`);
  return value;
}
function scopes(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value.split(/[ ,]+/).map(v => v.trim()).filter(Boolean);
}

export function createGitLabIdentityAdapter(oidc: GitLabOidcVerifier): IdentityProviderAdapter<GitLabExchange> {
  return {
    kind: 'gitlab',
    capabilities: { web: true, device: false, refresh: false, revoke: false, discovery: true },
    canonicalizeIssuer(value) {
      // Configuration validation that depends on private-network approval happens
      // in begin/exchange; canonical issuer itself is exact and path-preserving.
      return canonicalHttpsIssuer(value);
    },
    begin(input: ProviderBeginInput): ProviderBeginResult {
      const cfg = config(input.publicConfig), base = issuer(input.issuer, cfg);
      const url = new URL(path(base, '/oauth/authorize'));
      url.searchParams.set('client_id', cfg.clientId);
      url.searchParams.set('redirect_uri', input.callbackUrl);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('state', input.state);
      url.searchParams.set('scope', 'openid profile');
      url.searchParams.set('code_challenge', input.pkceChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('nonce', input.nonce);
      return { authorizationUrl: url.href };
    },
    async exchange(input: ProviderExchangeInput, network: ProviderNetworkBroker): Promise<GitLabExchange> {
      const cfg = config(input.publicConfig), base = issuer(input.issuer, cfg);
      const body = new URLSearchParams({
        client_id: cfg.clientId,
        code: input.code,
        grant_type: 'authorization_code',
        redirect_uri: input.callbackUrl,
        code_verifier: input.pkceVerifier,
      });
      if (input.clientSecret) body.set('client_secret', input.clientSecret);
      const value = json(await request(network, input.providerId, base, {
        url: path(base, '/oauth/token'), method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(),
      }), 'invalid-credentials');
      if (typeof value.error === 'string') throw controlError('invalid-credentials', 'GitLab authorization was not accepted');
      if (typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer') throw controlError('invalid-provider-response', 'GitLab token type is invalid');
      const granted = scopes(value.scope);
      if (granted.some(scope => BROAD_SCOPE.has(scope))) throw controlError('provider-scope-escalation', 'GitLab login returned API or repository permissions; use a dedicated identity application');
      return {
        issuer: base,
        accessToken: token(value.access_token, 'access token'),
        idToken: token(value.id_token, 'ID token'),
        nonce: input.nonce,
        clientId: cfg.clientId,
        privateNetworkApproved: cfg.privateNetworkApproved,
      };
    },
    async resolveIdentity(exchange: GitLabExchange, network: ProviderNetworkBroker): Promise<NormalizedExternalIdentity> {
      const cfgIssuer = canonicalHttpsIssuer(exchange.issuer);
      const verified = await oidc.verify({
        providerId: 'gitlab', expectedIssuer: cfgIssuer, discoveryUrl: discovery(cfgIssuer), clientId: exchange.clientId,
        nonce: exchange.nonce, idToken: exchange.idToken, privateNetworkApproved: exchange.privateNetworkApproved, network,
      });
      if (canonicalHttpsIssuer(verified.issuer) !== cfgIssuer || typeof verified.subject !== 'string' || !verified.subject) {
        throw controlError('invalid-identity', 'GitLab OIDC subject is invalid');
      }
      const info = json(await request(network, 'gitlab', cfgIssuer, {
        url: path(cfgIssuer, '/oauth/userinfo'), method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${exchange.accessToken}` },
      }));
      if (typeof info.sub !== 'string' || info.sub !== verified.subject) throw controlError('invalid-identity', 'GitLab userinfo subject does not match the verified ID token');
      const result: NormalizedExternalIdentity = { issuer: cfgIssuer, subject: verified.subject };
      const name = typeof info.name === 'string' && info.name.trim() ? info.name.trim() : verified.displayName;
      if (name) result.displayName = name;
      if (info.email_verified === true && typeof info.email === 'string') { result.email = info.email; result.emailVerified = true; }
      return result;
    },
  };
}
