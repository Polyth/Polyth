import { createHash, randomUUID } from 'node:crypto';
import { controlError, digest, type ControlPlane } from '@polyth/control-plane';
import { newToken, tokenHash } from '../validation.ts';
import type {
  IdentityProviderAdapter,
  NormalizedExternalIdentity,
  ProviderConfiguration,
  ProviderNetworkBroker,
  ProviderPurpose,
  ProviderSecretBroker,
  ProviderTransactionStart,
} from './types.ts';

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SUBJECT_MAX = 512;
const CALLBACK_MAX = 2048;
const TX_MS = 10 * 60_000;
const SENSITIVE_KEY = /(?:secret|token|password|private[_-]?key|credential)/i;

function cleanId(value: unknown): string {
  if (typeof value !== 'string' || !PROVIDER_ID.test(value)) throw controlError('invalid-input', 'Invalid provider id');
  return value;
}
function purpose(value: unknown): ProviderPurpose {
  if (value !== 'setup' && value !== 'login' && value !== 'link') throw controlError('invalid-input', 'Invalid identity purpose');
  return value;
}
function returnPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')
    || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value) || /^[^?#]*:\/\//.test(value)) {
    throw controlError('invalid-input', 'Invalid return path');
  }
  return value;
}
function callback(value: unknown): string {
  if (typeof value !== 'string' || value.length > CALLBACK_MAX) throw controlError('invalid-input', 'Invalid callback URL');
  let url: URL;
  try { url = new URL(value); } catch { throw controlError('invalid-input', 'Invalid callback URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw controlError('invalid-input', 'Callback URL must be HTTPS');
  return url.href;
}
export function canonicalHttpsIssuer(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw controlError('invalid-input', 'Invalid identity issuer'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw controlError('invalid-input', 'Identity issuer must be an exact HTTPS issuer');
  }
  url.pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return url.href.replace(/\/$/, '');
}
function assertPublicConfig(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw controlError('invalid-input', 'Provider public config must be an object');
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { for (const item of node) visit(item); return; }
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) throw controlError('invalid-input', 'Secrets must use the provider secret broker');
      visit(child);
    }
  };
  visit(value);
  const encoded = JSON.stringify(value);
  if (encoded.length > 16_384) throw controlError('invalid-input', 'Provider public config is too large');
}
function safeIdentity(value: NormalizedExternalIdentity, expectedIssuer: string): NormalizedExternalIdentity {
  if (canonicalHttpsIssuer(value.issuer) !== expectedIssuer || typeof value.subject !== 'string' || !value.subject
    || value.subject.length > SUBJECT_MAX || /[\x00-\x1f\x7f]/.test(value.subject)) {
    throw controlError('invalid-identity', 'Provider returned an invalid external identity');
  }
  const result: NormalizedExternalIdentity = { issuer: expectedIssuer, subject: value.subject };
  if (typeof value.displayName === 'string' && value.displayName.trim() && value.displayName.length <= 160
    && !/[\x00-\x1f\x7f]/.test(value.displayName)) result.displayName = value.displayName.trim();
  if (typeof value.email === 'string' && value.email.length <= 320 && !/[\x00-\x1f\x7f]/.test(value.email)) result.email = value.email;
  if (typeof value.emailVerified === 'boolean') result.emailVerified = value.emailVerified;
  return result;
}
const challenge = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');
const adapterKey = (kind: string): string => kind.trim().toLowerCase();

type ProviderRow = {
  id: string; kind: string; issuer: string; enabled: number; revision: number;
  public_config_json: string; client_secret_ref: string | null;
};
type TransactionRow = {
  id: string; provider_config_id: string; purpose: ProviderPurpose; browser_binding_hash: string;
  secret_ref: string; return_to: string; expires_at_ms: number; exchange_started_at_ms: number | null; consumed_at_ms: number | null;
  cancelled_at_ms: number | null; result_json: string | null;
};

export function createProviderFramework(control: ControlPlane, opts: {
  adapters: IdentityProviderAdapter[];
  secrets: ProviderSecretBroker;
  network: ProviderNetworkBroker;
  now?: () => number;
  transactionMs?: number;
}) {
  const now = opts.now ?? Date.now;
  const ttl = opts.transactionMs ?? TX_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 60_000 || ttl > 30 * 60_000) throw controlError('invalid-input', 'Invalid provider transaction lifetime');
  const adapters = new Map<string, IdentityProviderAdapter>();
  for (const adapter of opts.adapters) {
    const key = adapterKey(adapter.kind);
    if (!PROVIDER_ID.test(key) || adapters.has(key)) throw controlError('invalid-input', 'Duplicate or invalid identity adapter');
    adapters.set(key, adapter);
  }
  const row = (id: string): ProviderRow | undefined => control.get<ProviderRow>(
    'SELECT id,kind,issuer,enabled,revision,public_config_json,client_secret_ref FROM identity_providers WHERE id=?', id,
  );
  const config = (provider: ProviderRow): ProviderConfiguration => ({
    id: provider.id, kind: provider.kind, issuer: provider.issuer, enabled: !!provider.enabled,
    publicConfig: JSON.parse(provider.public_config_json) as Record<string, unknown>, revision: provider.revision,
  });
  const enabled = (id: string): { provider: ProviderRow; adapter: IdentityProviderAdapter } => {
    const provider = row(cleanId(id));
    if (!provider || !provider.enabled) throw controlError('not-found', 'Identity provider is unavailable');
    const adapter = adapters.get(provider.kind);
    if (!adapter) throw controlError('unavailable', 'Identity adapter is unavailable');
    return { provider, adapter };
  };
  const transaction = (state: string): TransactionRow | undefined => control.get<TransactionRow>(
    `SELECT id,provider_config_id,purpose,browser_binding_hash,secret_ref,return_to,expires_at_ms,exchange_started_at_ms,consumed_at_ms,cancelled_at_ms,result_json
       FROM provider_transactions WHERE state_hash=?`, tokenHash('browser', `provider-state:${state}`),
  );
  const browserHash = (binding: string): string => tokenHash('browser', `provider-browser:${binding}`);
  const requestDigest = (value: unknown): string => digest(JSON.stringify(value));

  return {
    list(): ProviderConfiguration[] {
      return control.all<ProviderRow>('SELECT id,kind,issuer,enabled,revision,public_config_json,client_secret_ref FROM identity_providers ORDER BY id').map(config);
    },
    get(id: string): ProviderConfiguration | undefined {
      const provider = row(cleanId(id));
      return provider ? config(provider) : undefined;
    },
    async configure(input: { id: string; kind: string; issuer: string; publicConfig?: Record<string, unknown>; clientSecret?: string | null }) {
      const id = cleanId(input.id), kind = adapterKey(input.kind), adapter = adapters.get(kind);
      if (!adapter) throw controlError('invalid-input', 'Unknown identity adapter');
      const publicConfig = input.publicConfig ?? {};
      assertPublicConfig(publicConfig);
      const issuer = adapter.canonicalizeIssuer(canonicalHttpsIssuer(input.issuer));
      if (issuer !== canonicalHttpsIssuer(issuer)) throw controlError('invalid-input', 'Adapter returned a non-canonical issuer');
      if (input.clientSecret !== undefined && input.clientSecret !== null
        && (typeof input.clientSecret !== 'string' || !input.clientSecret || input.clientSecret.length > 8192)) {
        throw controlError('invalid-input', 'Invalid provider secret');
      }
      const prior = row(id);
      let nextSecret = prior?.client_secret_ref ?? null;
      let staged: string | null = null;
      if (typeof input.clientSecret === 'string') {
        staged = await opts.secrets.put(`identity-provider:${id}`, input.clientSecret);
        if (!staged || staged.length > 512) {
          if (staged) await opts.secrets.delete(staged).catch(() => undefined);
          throw controlError('unavailable', 'Secret broker returned an invalid reference');
        }
        nextSecret = staged;
      } else if (input.clientSecret === null) nextSecret = null;
      try {
        control.transaction(() => {
          const current = row(id);
          if (prior && (!current || current.revision !== prior.revision)) throw controlError('conflict', 'Provider changed; retry');
          if (current) {
            control.run(`UPDATE identity_providers SET kind=?,issuer=?,public_config_json=?,client_secret_ref=?,enabled=0,
              updated_at_ms=?,revision=revision+1 WHERE id=? AND revision=?`, kind, issuer, JSON.stringify(publicConfig), nextSecret, now(), id, current.revision);
          } else {
            control.run(`INSERT INTO identity_providers(id,issuer,kind,enabled,public_config_json,client_secret_ref,updated_at_ms)
              VALUES(?,?,?,0,?,?,?)`, id, issuer, kind, JSON.stringify(publicConfig), nextSecret, now());
          }
          control.bumpEpoch(); control.audit('operator:identity', current ? 'identity.provider-updated' : 'identity.provider-created', id);
        });
      } catch (cause) {
        if (staged) await opts.secrets.delete(staged).catch(() => undefined);
        throw cause;
      }
      if (prior?.client_secret_ref && prior.client_secret_ref !== nextSecret) await opts.secrets.delete(prior.client_secret_ref).catch(() => undefined);
      return config(row(id)!);
    },
    setEnabled(id: string, expectedRevision: number, value: boolean): ProviderConfiguration {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw controlError('invalid-input', 'Expected revision is required');
      return control.transaction(() => {
        const provider = row(cleanId(id));
        if (!provider) throw controlError('not-found', 'Identity provider not found');
        if (provider.revision !== expectedRevision) throw controlError('conflict', 'Provider changed; refresh before retrying');
        control.run('UPDATE identity_providers SET enabled=?,updated_at_ms=?,revision=revision+1 WHERE id=? AND revision=?', value ? 1 : 0, now(), provider.id, expectedRevision);
        control.bumpEpoch(); control.audit('operator:identity', value ? 'identity.provider-enabled' : 'identity.provider-disabled', provider.id);
        return config(row(provider.id)!);
      });
    },
    async begin(input: { providerId: string; purpose: ProviderPurpose; browserBinding: string; callbackUrl: string; returnTo: string }): Promise<ProviderTransactionStart> {
      const { provider, adapter } = enabled(input.providerId), flowPurpose = purpose(input.purpose);
      if (!adapter.capabilities.web) throw controlError('unavailable', 'Provider does not support browser login');
      if (typeof input.browserBinding !== 'string' || input.browserBinding.length < 32 || input.browserBinding.length > 512) throw controlError('invalid-input', 'Invalid browser binding');
      const callbackUrl = callback(input.callbackUrl), returnTo = returnPath(input.returnTo);
      const state = newToken(), nonce = newToken(), verifier = newToken();
      const started = await adapter.begin({
        providerId: provider.id, issuer: provider.issuer, purpose: flowPurpose,
        publicConfig: JSON.parse(provider.public_config_json) as Record<string, unknown>, callbackUrl,
        state, nonce, pkceChallenge: challenge(verifier),
      });
      let authUrl: URL;
      try { authUrl = new URL(started.authorizationUrl); } catch { throw controlError('invalid-provider-response', 'Provider returned an invalid authorization URL'); }
      if (authUrl.protocol !== 'https:' || authUrl.username || authUrl.password) throw controlError('invalid-provider-response', 'Provider authorization URL must be HTTPS');
      const secretRef = await opts.secrets.put(`identity-transaction:${provider.id}`, JSON.stringify({ nonce, verifier, callbackUrl }));
      const id = `ptx_${randomUUID()}`, createdAt = now(), expiresAt = createdAt + ttl;
      try {
        control.transaction(() => {
          control.run(`INSERT INTO provider_transactions(id,provider_config_id,purpose,state_hash,browser_binding_hash,secret_ref,return_to,created_at_ms,expires_at_ms)
            VALUES(?,?,?,?,?,?,?,?,?)`, id, provider.id, flowPurpose, tokenHash('browser', `provider-state:${state}`), browserHash(input.browserBinding), secretRef, returnTo, createdAt, expiresAt);
          control.audit('system:identity', 'identity.provider-flow-began', id);
        });
      } catch (cause) {
        await opts.secrets.delete(secretRef).catch(() => undefined);
        throw cause;
      }
      return { id, providerId: provider.id, purpose: flowPurpose, state, authorizationUrl: authUrl.href, expiresAt, returnTo };
    },
    async complete(input: { providerId: string; purpose: ProviderPurpose; state: string; browserBinding: string; code: string }) {
      const providerId = cleanId(input.providerId), flowPurpose = purpose(input.purpose);
      if (typeof input.state !== 'string' || !/^[a-f0-9]{64}$/.test(input.state)
        || typeof input.browserBinding !== 'string' || typeof input.code !== 'string' || !input.code || input.code.length > 8192) {
        throw controlError('invalid-input', 'Invalid provider callback');
      }
      const tx = transaction(input.state);
      if (!tx || tx.provider_config_id !== providerId || tx.purpose !== flowPurpose
        || tx.browser_binding_hash !== browserHash(input.browserBinding)) throw controlError('invalid-provider-transaction', 'Identity transaction does not match');
      if (tx.cancelled_at_ms !== null) throw controlError('cancelled', 'Identity transaction was cancelled');
      if (tx.consumed_at_ms !== null) throw controlError('replayed', 'Identity transaction was already consumed');
      if (tx.expires_at_ms <= now()) throw controlError('expired', 'Identity transaction expired');
      if (tx.exchange_started_at_ms !== null) throw controlError('uncertain-exchange', 'Identity exchange already started; begin a new login flow');
      const { provider, adapter } = enabled(providerId);
      // Fence before the external code exchange. If this process dies afterwards,
      // a retry never replays an exchange whose outcome is unknown.
      control.transaction(() => {
        const latest = transaction(input.state);
        if (!latest || latest.id !== tx.id || latest.exchange_started_at_ms !== null || latest.consumed_at_ms !== null
          || latest.cancelled_at_ms !== null || latest.expires_at_ms <= now()) throw controlError('replayed', 'Identity transaction is no longer active');
        control.run('UPDATE provider_transactions SET exchange_started_at_ms=?,revision=revision+1 WHERE id=? AND exchange_started_at_ms IS NULL', now(), tx.id);
        control.audit('system:identity', 'identity.provider-exchange-started', tx.id);
      });
      let secret: { nonce: string; verifier: string; callbackUrl: string };
      try { secret = JSON.parse(await opts.secrets.get(tx.secret_ref)) as typeof secret; }
      catch { throw controlError('unavailable', 'Identity transaction secret is unavailable'); }
      if (!secret || !/^[a-f0-9]{64}$/.test(secret.nonce) || !/^[a-f0-9]{64}$/.test(secret.verifier)) throw controlError('unavailable', 'Identity transaction secret is invalid');
      const clientSecret = provider.client_secret_ref ? await opts.secrets.get(provider.client_secret_ref) : null;
      const exchange = await adapter.exchange({
        providerId, issuer: provider.issuer, purpose: flowPurpose,
        publicConfig: JSON.parse(provider.public_config_json) as Record<string, unknown>,
        callbackUrl: callback(secret.callbackUrl), code: input.code, state: input.state,
        nonce: secret.nonce, pkceVerifier: secret.verifier, clientSecret,
      }, opts.network);
      const identity = safeIdentity(await adapter.resolveIdentity(exchange, opts.network), provider.issuer);
      const encoded = JSON.stringify(identity);
      control.transaction(() => {
        const latest = transaction(input.state);
        if (!latest || latest.id !== tx.id || latest.exchange_started_at_ms === null || latest.consumed_at_ms !== null || latest.cancelled_at_ms !== null || latest.expires_at_ms <= now()) {
          throw controlError('replayed', 'Identity transaction is no longer active');
        }
        control.run('UPDATE provider_transactions SET consumed_at_ms=?,result_json=?,revision=revision+1 WHERE id=? AND consumed_at_ms IS NULL AND cancelled_at_ms IS NULL', now(), encoded, tx.id);
        control.audit('system:identity', 'identity.provider-flow-completed', tx.id);
      });
      await opts.secrets.delete(tx.secret_ref).catch(() => undefined);
      return { identity, returnTo: tx.return_to, transactionId: tx.id };
    },
    async cancel(input: { state: string; browserBinding: string }): Promise<boolean> {
      if (typeof input.state !== 'string' || !/^[a-f0-9]{64}$/.test(input.state)) return false;
      const tx = transaction(input.state);
      if (!tx || tx.browser_binding_hash !== browserHash(input.browserBinding) || tx.consumed_at_ms !== null || tx.exchange_started_at_ms !== null) return false;
      if (tx.cancelled_at_ms === null) control.transaction(() => {
        control.run('UPDATE provider_transactions SET cancelled_at_ms=?,revision=revision+1 WHERE id=? AND cancelled_at_ms IS NULL AND consumed_at_ms IS NULL', now(), tx.id);
        control.audit('system:identity', 'identity.provider-flow-cancelled', tx.id);
      });
      await opts.secrets.delete(tx.secret_ref).catch(() => undefined);
      return true;
    },
    resolveLinkedUser(providerId: string, identity: NormalizedExternalIdentity): string | undefined {
      const { provider } = enabled(providerId);
      const normalized = safeIdentity(identity, provider.issuer);
      return control.get<{ user_id: string }>(
        `SELECT l.user_id FROM login_identities l JOIN principals p ON p.id=l.user_id
          WHERE l.provider_config_id=? AND l.issuer=? AND l.subject=? AND p.status='active' AND p.kind='user'`,
        provider.id, provider.issuer, normalized.subject,
      )?.user_id;
    },
    link(userId: string, providerId: string, identity: NormalizedExternalIdentity): void {
      const { provider } = enabled(providerId), normalized = safeIdentity(identity, provider.issuer);
      if (!control.get('SELECT 1 FROM users u JOIN principals p ON p.id=u.id WHERE u.id=? AND p.kind=\'user\' AND p.status=\'active\'', userId)) {
        throw controlError('not-found', 'Account not found');
      }
      control.transaction(() => {
        const existing = control.get<{ user_id: string }>(
          'SELECT user_id FROM login_identities WHERE provider_config_id=? AND issuer=? AND subject=?',
          provider.id, provider.issuer, normalized.subject,
        );
        if (existing && existing.user_id !== userId) throw controlError('conflict', 'External identity is already linked');
        if (!existing) control.run(
          'INSERT INTO login_identities(id,user_id,provider_config_id,issuer,subject,created_at_ms) VALUES(?,?,?,?,?,?)',
          `lid_${randomUUID()}`, userId, provider.id, provider.issuer, normalized.subject, now(),
        );
        control.bumpEpoch(); control.audit(userId, existing ? 'identity.link-observed' : 'identity.linked', provider.id);
      });
    },
    requestDigest,
  };
}
