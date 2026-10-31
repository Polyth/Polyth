// HTTP adapter for the single control-plane identity authority. Host wiring is
// explicit: never auto-enable this beside the legacy JSON/tenancy authority.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { controlError, digest } from '@polyth/control-plane';
import { newToken, validToken } from './validation.ts';
import type { IdentitySession } from './types.ts';
import type { IdentityService } from './index.ts';

const loopback = (address?: string): boolean => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '');

/**
 * Set by the listener — never by this adapter and never from a header — when a
 * TLS-terminating proxy the operator explicitly trusts handled this request.
 * Identity still enforces its own origin/Host and same-origin checks.
 */
export const TERMINATED_TLS = Symbol.for('polyth.identity.terminatedTls');
const terminatedTls = (req: IncomingMessage): boolean =>
  (req as unknown as Record<symbol, unknown>)[TERMINATED_TLS] === true;
const csrfFor = (token: string): string => digest(`csrf:${token}`);
const csrfMatches = (received: unknown, nonce: string): boolean => typeof received === 'string' && /^[a-f0-9]{64}$/.test(received)
  && timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(csrfFor(nonce), 'hex'));
const cookieToken = (request: IncomingMessage, name: string): string | null => {
  const cookie = request.headers.cookie;
  if (!cookie || cookie.length > 16_384) return null;
  const matches = cookie.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const token = matches[0]!.slice(name.length + 1);
  return validToken(token) ? token : null;
};
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) throw controlError('invalid-input', 'JSON content type required');
  if (Number(req.headers['content-length']) > 16_384) {
    req.once('error', () => {}); req.resume();
    throw controlError('body-too-large', 'Request is too large');
  }
  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0, settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('aborted', aborted); req.off('error', failed);
      if (error) { req.once('error', () => {}); req.resume(); reject(error); }
      else resolve(Buffer.concat(chunks));
    };
    const data = (part: Buffer | string): void => {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      bytes += chunk.length;
      if (bytes > 16_384) finish(controlError('body-too-large', 'Request is too large'));
      else chunks.push(chunk);
    };
    const end = (): void => finish();
    const aborted = (): void => finish(controlError('invalid-input', 'Request was interrupted'));
    const failed = (): void => finish(controlError('invalid-input', 'Request could not be read'));
    const timer = setTimeout(() => finish(controlError('request-timeout', 'Request body timed out')), 10_000);
    timer.unref();
    req.on('data', data); req.once('end', end); req.once('aborted', aborted); req.once('error', failed);
  });
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); }
  catch { throw controlError('invalid-input', 'Invalid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw controlError('invalid-input', 'JSON object required');
  return value as Record<string, unknown>;
}
const text = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  if (typeof value !== 'string') throw controlError('invalid-input', 'Required string field is missing');
  return value;
};
const returnTo = (body: Record<string, unknown>): string => typeof body.returnTo === 'string' ? body.returnTo : '/';
const statusFor: Readonly<Record<string, number>> = {
  unauthorized: 401, 'invalid-credentials': 401, 'invalid-claim': 401,
  forbidden: 403, 'wrong-origin': 403, 'insecure-transport': 403, 'reauth-required': 403, 'managed-identity': 403,
  'not-found': 404, expired: 410,
  conflict: 409, 'last-owner': 409, 'last-auth-method': 409, 'invalid-transition': 409, 'setup-completed': 409,
  replayed: 409, cancelled: 409, 'uncertain-exchange': 409, 'provider-scope-escalation': 409,
  'private-network-approval-required': 409, 'owner-credential-required': 409,
  'owner-confirmation-required': 403,
  'invalid-input': 400, 'invalid-provider-transaction': 400, 'callback-mismatch': 400,
  'request-timeout': 408, 'recovery-ack-required': 400, 'body-too-large': 413, 'rate-limited': 429,
  'invalid-provider-response': 502, 'invalid-identity': 502,
  'recovery-required': 503, unavailable: 503, 'provider-unavailable': 503,
};
const accountStatusPath = /^\/api\/auth\/accounts\/([A-Za-z0-9][A-Za-z0-9_-]{0,199})\/status$/;
const accountGuardrailsPath = /^\/api\/auth\/accounts\/([A-Za-z0-9][A-Za-z0-9_-]{0,199})\/guardrails$/;
const accountLimitsPath = /^\/api\/auth\/accounts\/([A-Za-z0-9][A-Za-z0-9_-]{0,199})\/limits$/;
const accountPermissionsPath = /^\/api\/auth\/accounts\/([A-Za-z0-9][A-Za-z0-9_-]{0,199})\/permissions$/;
const accountProfilePath = /^\/api\/auth\/accounts\/([A-Za-z0-9][A-Za-z0-9_-]{0,199})\/profile$/;
const accountPasswordPath = /^\/api\/auth\/accounts\/([A-Za-z0-9][A-Za-z0-9_-]{0,199})\/password$/;
const providerEnabledPath = /^\/api\/auth\/providers\/([a-z0-9][a-z0-9_-]{0,63})\/enabled$/;
const linkPath = /^\/api\/auth\/links\/(lid_[a-f0-9-]{36})$/;
const cliTokenPath = /^\/api\/auth\/cli\/tokens\/(tok_[a-f0-9-]{36})$/;
const bearerOf = (req: IncomingMessage): string | null => {
  const raw = req.headers.authorization;
  if (typeof raw !== 'string' || raw.length > 256) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  return match ? match[1]! : null;
};

export function createIdentityHttpAdapter(identity: IdentityService, options: {
  /** App/operator configuration, never req.headers.host or forwarded headers. */
  origin: string;
  /** Explicit local-only HTTP development/native listener; NOT an identity. */
  localOnly?: boolean;
  /** Operator-scoped debug override: loopback-direct sockets count as a
   *  trusted local transport even when the canonical origin is HTTPS. */
  loopbackTrusted?: boolean;
  /** Host-validated local debug identity, resolved anew for each request.
   * Used only on a trusted direct-loopback socket for browser bootstrap;
   * it grants no human-session identity administration. */
  resolveLocalAccountId?: (req: IncomingMessage) => string | undefined;
}) {
  const url = new URL(options.origin);
  const origin = url.origin, secure = url.protocol === 'https:';
  const loopbackTrusted = options.loopbackTrusted === true;
  const loopbackDirectSocket = (req: IncomingMessage): boolean =>
    loopback(req.socket.remoteAddress) && loopback(req.socket.localAddress);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || (!secure && !(url.protocol === 'http:' && options.localOnly === true && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
    throw controlError('invalid-input', 'Identity requires HTTPS or an explicitly local-only HTTP origin');
  }
  const providerCallbackUrl = `${origin}/auth/provider/callback`;
  const cookieName = `${secure ? '__Host-' : ''}${identity.sessions.cookieName()}`;
  const csrfCookie = `${cookieName}_csrf`;
  const cookie = (name: string, value: string, maxAge?: number): string => `${name}=${value}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}${maxAge === undefined ? '' : `; Max-Age=${maxAge}`}`;
  const transport = (req: IncomingMessage): void => {
    const encrypted = (req.socket as typeof req.socket & { encrypted?: boolean }).encrypted === true
      || terminatedTls(req);
    if (secure ? (!encrypted && !(loopbackTrusted && loopbackDirectSocket(req))) : (!loopback(req.socket.remoteAddress) || !loopback(req.socket.localAddress))) {
      throw controlError('insecure-transport', 'A secure identity transport is required');
    }
    if (!(loopbackTrusted && loopbackDirectSocket(req)) && req.headers.host?.toLowerCase() !== url.host.toLowerCase()) throw controlError('wrong-origin', 'Origin does not match this installation');
  };
  const sameOrigin = (req: IncomingMessage): void => {
    if (req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') throw controlError('wrong-origin', 'Same-origin request required');
  };
  const tokenOf = (req: IncomingMessage): string | null => cookieToken(req, cookieName);
  const localAccountId = (req: IncomingMessage): string | undefined =>
    loopbackTrusted && loopbackDirectSocket(req) ? options.resolveLocalAccountId?.(req) : undefined;
  const requireHuman = (req: IncomingMessage) => { transport(req); return identity.sessions.require(tokenOf(req)); };
  // Local-only loopback trust means "this machine's own browser is the active
  // owner" (agent beta / local debug agent access). Reporting an authorized
  // local-user without a usable identity session would strand the browser UI on
  // a lock screen that no credential can satisfy, so direct loopback mints one
  // reusable owner session. It is never reissued for an unready installation,
  // and a public origin or non-loopback transport keeps the strict path.
  let loopbackSession: { token: string; session: IdentitySession } | null = null;
  const loopbackOwnerSession = (): { token: string; session: IdentitySession } | null => {
    if (!loopbackTrusted || options.localOnly !== true) return null;
    const userId = identity.accounts.activeOwnerUserId();
    if (!userId) return null;
    if (loopbackSession) {
      const live = identity.sessions.resolve(loopbackSession.token);
      if (live && live.userId === userId) return { token: loopbackSession.token, session: live };
    }
    const issued = identity.issueLoopbackOwnerSession('Loopback local owner');
    if (!issued) return null;
    loopbackSession = issued;
    return issued;
  };
  const providerService = () => {
    if (!identity.providers) throw controlError('unavailable', 'External identity providers are unavailable');
    return identity.providers;
  };
  const providerLoginService = () => {
    if (!identity.providerLogin) throw controlError('unavailable', 'External identity login is unavailable');
    return identity.providerLogin;
  };
  const linkService = () => {
    if (!identity.links) throw controlError('unavailable', 'External identity linking is unavailable');
    return identity.links;
  };
  /** The `/api/auth/status` answer, minting the CSRF nonce and (direct
   *  loopback, local-only profile) owner session cookies it relies on. */
  const authStatus = (req: IncomingMessage, res: ServerResponse, token: string | null) => {
    const nonce = cookieToken(req, csrfCookie) ?? newToken();
    const state = identity.setup.status();
    const session = identity.sessions.resolve(token);
    const debugAuthority = options.resolveLocalAccountId !== undefined;
    const localAccount = localAccountId(req);
    // A resolver-backed debug authority must stay sessionless and
    // non-administrative; the generic local-only adapter retains its
    // reusable owner session for the standalone beta profile.
    const auto = debugAuthority || session || state.state !== 'ready' ? null
      : (loopbackDirectSocket(req) ? loopbackOwnerSession() : null);
    const actor = session ?? auto?.session ?? null;
    const cookies: string[] = [];
    if (!cookieToken(req, csrfCookie)) cookies.push(cookie(csrfCookie, nonce));
    if (auto) cookies.push(cookie(cookieName, auto.token, Math.floor((auto.session.expiresAt - auto.session.createdAt) / 1000)));
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    const localTrust = debugAuthority
      ? Boolean(localAccount)
      : loopbackTrusted && loopbackDirectSocket(req);
    return {
      ...state,
      // `local`: no credential exists; only the Polyth Desktop app on this
      // machine can open this installation (its sign-in screen says so).
      ...(state.state === 'ready' ? { accessMode: identity.accessMode() } : {}),
      required: true,
      authorized: !!actor || localTrust,
      scope: actor ? 'ui-session' : localTrust ? 'local-user' : 'anonymous',
      ...(actor ? { accountId: actor.userId } : {}),
      csrfToken: csrfFor(nonce),
    };
  };
  return {
    cookieName,
    requireHuman,
    /** The auth status embedded in the served HTML shell, so boot needs no
     *  status round trip. Null when this transport could not ask for it. The
     *  CSRF token stays out: the page is HTML and the nonce is fetched lazily
     *  by the first mutation that needs it. */
    shellStatus(req: IncomingMessage, res: ServerResponse): Record<string, unknown> | null {
      try { transport(req); } catch { return null; }
      const { csrfToken: _csrf, ...status } = authStatus(req, res, tokenOf(req));
      return status;
    },
    authorizeUpgrade(req: IncomingMessage) {
      transport(req); sameOrigin(req);
      if (req.url !== '/ws') throw controlError('not-found', 'WebSocket route not found');
      return identity.sessions.require(tokenOf(req));
    },
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      if (!req.url?.startsWith('/api/auth/')) return false;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const send = (status: number, body: unknown): void => { res.statusCode = status; res.end(JSON.stringify(body)); };
      try {
        transport(req);
        const path = req.url;
        if (path.includes('?') || path.includes('#')) throw controlError('invalid-input', 'Authentication parameters belong in the request body');
        const token = tokenOf(req);
        if (req.method === 'GET' && path === '/api/auth/status') {
          send(200, authStatus(req, res, token));
          return true;
        }
        if (req.method === 'GET' && path === '/api/auth/providers') {
          send(200, { providers: providerService().list().filter(provider => provider.enabled).map(({ id, kind, issuer }) => ({ id, kind, issuer })) });
          return true;
        }
        if (req.method === 'GET') {
          if (path === '/api/auth/accounts' && !identity.sessions.resolve(token)) {
            const accountId = localAccountId(req);
            if (accountId) {
              send(200, { currentAccountId: accountId, canManage: false, accounts: [] });
              return true;
            }
          }
          const actor = requireHuman(req);
          if (path === '/api/auth/accounts') {
            const accounts = identity.accounts.list(token!);
            const canManage = identity.accounts.canManage(token!);
            send(200, {
              currentAccountId: actor.userId,
              canManage,
              accounts: accounts.map(account => ({
                ...account, name: account.displayName, current: account.id === actor.userId,
                ...(canManage && identity.guardrails.forUser(account.id).guardrails !== null ? { guarded: true } : {}),
                // The owner's list shows each account's limits and today's use
                // without one request per account.
                ...(canManage ? {
                  limits: identity.limits.forUser(account.id).limits,
                  usage: identity.limits.usage(account.id),
                  permissions: identity.permissions.forUser(account.id).permissions,
                } : {}),
              })),
            });
          } else if (path === '/api/auth/sessions') send(200, { sessions: identity.sessions.list(token!) });
          else if (path === '/api/auth/me') {
            send(200, {
              ...identity.accounts.current(token!),
              guardrails: identity.guardrails.forUser(actor.userId).guardrails,
              limits: identity.limits.forUser(actor.userId).limits,
              usage: identity.limits.usage(actor.userId),
              permissions: identity.permissions.forUser(actor.userId).permissions,
            });
          } else if (accountGuardrailsPath.test(path)) {
            send(200, identity.guardrails.get(token!, accountGuardrailsPath.exec(path)![1]!));
          } else if (accountLimitsPath.test(path)) {
            send(200, identity.limits.get(token!, accountLimitsPath.exec(path)![1]!));
          } else if (accountPermissionsPath.test(path)) {
            send(200, identity.permissions.get(token!, accountPermissionsPath.exec(path)![1]!));
          }
          else if (path === '/api/auth/cli') {
            const canManageTrust = identity.accounts.canManage(token!);
            const trust = identity.accessTokens.trust.get();
            send(200, {
              tokens: identity.accessTokens.list(token!),
              profiles: identity.accessTokens.profiles(),
              trust: canManageTrust ? trust : { mode: trust.mode, revision: trust.revision },
              canManageTrust,
            });
          }
          else if (path === '/api/auth/passkeys') send(200, { passkeys: identity.passkeys.list(token!) });
          else if (path === '/api/auth/links') send(200, { links: linkService().list(token!) });
          else if (path === '/api/auth/providers/manage') {
            if (!identity.accounts.canManage(token!)) throw controlError('forbidden', 'Instance owner access required');
            send(200, { providers: providerService().list() });
          } else throw controlError('not-found', 'Authentication route not found');
          return true;
        }
        if (!['POST', 'DELETE'].includes(req.method ?? '')) throw controlError('not-found', 'Authentication route not found');
        // Command-line device flow. These calls carry no cookie authority (a
        // secret device code or a bearer token instead), so the browser
        // same-origin/CSRF pair does not apply; a browser-originated request
        // is refused outright so a web page can never drive them.
        if (req.method === 'POST' && (path === '/api/auth/cli/device' || path === '/api/auth/cli/device/token' || path === '/api/auth/cli/logout')) {
          if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) throw controlError('forbidden', 'Command-line endpoint');
          if (path === '/api/auth/cli/logout') {
            const bearer = bearerOf(req);
            send(200, { ok: bearer ? identity.accessTokens.revokeSelf(bearer) : false });
            return true;
          }
          const body = await readBody(req);
          if (path === '/api/auth/cli/device') {
            send(200, {
              ...identity.accessTokens.device.start({ label: body.label, profile: body.profile, address: req.socket.remoteAddress }),
              // The web UI's Settings → Command line page confirms the code.
              verificationPath: '/?settings=command-line',
            });
          } else {
            send(200, identity.accessTokens.device.redeem(body.deviceCode));
          }
          return true;
        }
        sameOrigin(req);
        const nonce = cookieToken(req, csrfCookie);
        if (!nonce || !csrfMatches(req.headers['x-polyth-csrf'], nonce)) throw controlError('forbidden', 'CSRF validation failed');
        const body = await readBody(req);
        const issued = (result: { token: string; session: { expiresAt: number; createdAt: number } }, extra: Record<string, unknown> = {}): void => {
          const freshNonce = newToken();
          res.setHeader('Set-Cookie', [
            cookie(cookieName, result.token, Math.floor((result.session.expiresAt - result.session.createdAt) / 1000)),
            cookie(csrfCookie, freshNonce),
          ]);
          send(200, { ok: true, csrfToken: csrfFor(freshNonce), ...extra });
        };
        if (req.method === 'POST' && path === '/api/auth/setup/claim') {
          send(200, identity.setup.bindClaim(text(body, 'claimToken'), nonce));
        } else if (req.method === 'POST' && path === '/api/auth/setup/recovery') {
          send(200, identity.setup.prepareRecovery(text(body, 'claimToken'), nonce));
        } else if (req.method === 'POST' && path === '/api/auth/setup/complete') {
          const result = await identity.setup.complete({ claimToken: text(body, 'claimToken'), browserBinding: nonce,
            name: text(body, 'name'), organizationName: text(body, 'organizationName'), login: text(body, 'login'),
            password: text(body, 'password'), recoverySetId: text(body, 'recoverySetId'), recoveryAcknowledged: body.recoveryAcknowledged === true });
          issued(result);
        } else if (req.method === 'POST' && path === '/api/auth/login') {
          issued(await identity.credentials.login({ login: text(body, 'login'), password: text(body, 'password'), address: req.socket.remoteAddress, label: req.headers['user-agent'] }));
        } else if (req.method === 'POST' && path === '/api/auth/providers/login/begin') {
          if (!secure) throw controlError('unavailable', 'External browser identity requires an HTTPS Polyth origin');
          send(200, await providerLoginService().begin({
            providerId: text(body, 'providerId'), browserBinding: nonce,
            callbackUrl: providerCallbackUrl, returnTo: returnTo(body),
          }));
        } else if (req.method === 'POST' && path === '/api/auth/providers/login/complete') {
          const completed = await providerLoginService().complete({
            providerId: text(body, 'providerId'), state: text(body, 'state'), browserBinding: nonce,
            code: text(body, 'code'), label: req.headers['user-agent'],
          });
          issued(completed, { returnTo: completed.returnTo });
        } else if (req.method === 'POST' && path === '/api/auth/passkeys/authenticate/options') {
          send(200, identity.passkeys.beginAuthentication());
        } else if (req.method === 'POST' && path === '/api/auth/passkeys/authenticate/complete') {
          issued(identity.passkeys.completeAuthentication({
            credentialId: text(body, 'credentialId'), clientDataJSON: text(body, 'clientDataJSON'),
            authenticatorData: text(body, 'authenticatorData'), signature: text(body, 'signature'),
            userHandle: body.userHandle === null || typeof body.userHandle === 'string' ? body.userHandle : undefined,
            label: req.headers['user-agent'],
          }));
        } else if (req.method === 'POST' && path === '/api/auth/recover') {
          await identity.credentials.recover({ login: text(body, 'login'), code: text(body, 'code'), password: text(body, 'password'), address: req.socket.remoteAddress });
          res.setHeader('Set-Cookie', cookie(cookieName, '', 0)); send(200, { ok: true });
        } else if (req.method === 'POST' && path === '/api/auth/logout') {
          identity.sessions.logout(token); res.setHeader('Set-Cookie', cookie(cookieName, '', 0)); send(200, { ok: true });
        } else {
          const actor = requireHuman(req);
          const requireOwner = (elevated = false): void => {
            if (elevated) identity.sessions.require(token!, true);
            if (!identity.accounts.canManage(token!)) throw controlError('forbidden', 'Instance owner access required');
          };
          if (req.method === 'POST' && path === '/api/auth/logout-all') {
            identity.sessions.logoutAll(token!); res.setHeader('Set-Cookie', cookie(cookieName, '', 0)); send(200, { ok: true });
          } else if (req.method === 'POST' && path === '/api/auth/reauthenticate') {
            await identity.credentials.reauthenticate(token!, text(body, 'password'), req.socket.remoteAddress); send(200, { ok: true });
          } else if (req.method === 'POST' && path === '/api/auth/password') {
            await identity.credentials.changePassword(token!, text(body, 'password')); res.setHeader('Set-Cookie', cookie(cookieName, '', 0)); send(200, { ok: true });
          } else if (req.method === 'POST' && path === '/api/auth/me') {
            send(200, identity.accounts.renameSelf(token!, text(body, 'name'), Number(body.expectedRevision)));
          } else if (req.method === 'POST' && path === '/api/auth/accounts') {
            const account = await identity.accounts.createLocal(token!, {
              login: text(body, 'login'), name: text(body, 'name'), password: text(body, 'password'),
            });
            send(200, { ...account, name: account.displayName, current: false });
          } else if (req.method === 'POST' && path === '/api/auth/owner-credential/recovery') {
            send(200, identity.ownerCredential.prepareRecovery(token!));
          } else if (req.method === 'POST' && path === '/api/auth/owner-credential') {
            send(200, await identity.ownerCredential.establish(token!, {
              password: text(body, 'password'), recoverySetId: text(body, 'recoverySetId'),
              recoveryAcknowledged: body.recoveryAcknowledged === true,
            }));
          } else if (req.method === 'POST' && path === '/api/auth/providers/configure') {
            identity.requireOwnerCredential();
            requireOwner(true);
            const publicConfig = body.publicConfig === undefined ? undefined : body.publicConfig as Record<string, unknown>;
            const clientSecret = body.clientSecret === null || typeof body.clientSecret === 'string' ? body.clientSecret : undefined;
            send(200, await providerService().configure({
              id: text(body, 'id'), kind: text(body, 'kind'), issuer: text(body, 'issuer'), publicConfig, clientSecret,
            }));
          } else if (req.method === 'POST' && providerEnabledPath.test(path)) {
            identity.requireOwnerCredential();
            requireOwner(true);
            const match = providerEnabledPath.exec(path)!;
            if (typeof body.enabled !== 'boolean') throw controlError('invalid-input', 'Provider enabled state must be boolean');
            send(200, providerService().setEnabled(match[1]!, Number(body.expectedRevision), body.enabled));
          } else if (req.method === 'POST' && path === '/api/auth/links/begin') {
            if (!secure) throw controlError('unavailable', 'External browser identity requires an HTTPS Polyth origin');
            send(200, await linkService().begin(token!, {
              providerId: text(body, 'providerId'), browserBinding: nonce,
              callbackUrl: providerCallbackUrl, returnTo: returnTo(body),
            }));
          } else if (req.method === 'POST' && path === '/api/auth/links/complete') {
            send(200, await linkService().complete(token!, {
              providerId: text(body, 'providerId'), state: text(body, 'state'), browserBinding: nonce, code: text(body, 'code'),
            }));
          } else if (req.method === 'DELETE' && linkPath.test(path)) {
            const match = linkPath.exec(path)!;
            linkService().unlink(token!, match[1]!, Number(body.expectedRevision)); send(200, { ok: true });
          } else {
            const statusMatch = req.method === 'POST' ? accountStatusPath.exec(path) : null;
            const guardrailsMatch = req.method === 'POST' ? accountGuardrailsPath.exec(path) : null;
            const limitsMatch = req.method === 'POST' ? accountLimitsPath.exec(path) : null;
            const permissionsMatch = req.method === 'POST' ? accountPermissionsPath.exec(path) : null;
            const profileMatch = req.method === 'POST' ? accountProfilePath.exec(path) : null;
            const passwordMatch = req.method === 'POST' ? accountPasswordPath.exec(path) : null;
            if (guardrailsMatch) {
              if (!Object.hasOwn(body, 'guardrails')) throw controlError('invalid-input', 'guardrails is required');
              send(200, identity.guardrails.set(token!, guardrailsMatch[1]!, body.guardrails, Number(body.expectedRevision)));
            } else if (limitsMatch) {
              if (!Object.hasOwn(body, 'limits')) throw controlError('invalid-input', 'limits is required');
              send(200, identity.limits.set(token!, limitsMatch[1]!, body.limits, Number(body.expectedRevision)));
            } else if (permissionsMatch) {
              if (!Object.hasOwn(body, 'permissions')) throw controlError('invalid-input', 'permissions is required');
              send(200, identity.permissions.set(token!, permissionsMatch[1]!, body.permissions, Number(body.expectedRevision)));
            } else if (profileMatch) {
              const account = identity.accounts.renameAccount(token!, profileMatch[1]!, text(body, 'name'), Number(body.expectedRevision));
              send(200, { ...account, name: account.displayName, current: account.id === actor.userId });
            } else if (passwordMatch) {
              const account = await identity.accounts.resetPassword(token!, passwordMatch[1]!, text(body, 'password'));
              send(200, { ...account, name: account.displayName, current: false });
            } else if (statusMatch) {
              const status = text(body, 'status');
              const account = identity.accounts.setStatus(
                token!, statusMatch[1]!,
                status as 'active' | 'suspended' | 'offboarding' | 'disabled',
                Number(body.expectedRevision),
              );
              send(200, { ...account, name: account.displayName, current: account.id === identity.accounts.current(token!).id });
            } else if (req.method === 'POST' && path === '/api/auth/cli/tokens') {
              send(200, identity.accessTokens.create(token!, {
                label: body.label, profile: body.profile, grants: body.grants, spaceId: body.spaceId, expiresInDays: body.expiresInDays,
              }));
            } else if (req.method === 'DELETE' && cliTokenPath.test(path)) {
              identity.accessTokens.revoke(token!, cliTokenPath.exec(path)![1]!, Number(body.expectedRevision)); send(200, { ok: true });
            } else if (req.method === 'POST' && path === '/api/auth/cli/device/lookup') {
              send(200, identity.accessTokens.device.lookup(token!, body.userCode));
            } else if (req.method === 'POST' && path === '/api/auth/cli/device/decide') {
              if (typeof body.approve !== 'boolean') throw controlError('invalid-input', 'approve must be boolean');
              identity.accessTokens.device.decide(token!, body.userCode, body.approve); send(200, { ok: true });
            } else if (req.method === 'POST' && path === '/api/auth/cli/trust') {
              send(200, identity.accessTokens.trust.set(token!, body.mode, Number(body.expectedRevision)));
            } else if (req.method === 'POST' && path === '/api/auth/passkeys/register/options') {
              send(200, identity.passkeys.beginRegistration(token!, text(body, 'name')));
            } else if (req.method === 'POST' && path === '/api/auth/passkeys/register/complete') {
              send(200, identity.passkeys.completeRegistration(token!, {
                name: text(body, 'name'), clientDataJSON: text(body, 'clientDataJSON'),
                attestationObject: text(body, 'attestationObject'),
                ...(typeof body.credentialId === 'string' ? { credentialId: body.credentialId } : {}),
              }));
            } else if (req.method === 'DELETE' && /^\/api\/auth\/passkeys\/pky_[a-f0-9-]{36}$/.test(path)) {
              identity.passkeys.remove(token!, path.slice('/api/auth/passkeys/'.length), body.expectedRevision as number); send(200, { ok: true });
            } else if (req.method === 'DELETE' && /^\/api\/auth\/sessions\/ses_[a-f0-9-]{36}$/.test(path)) {
              identity.sessions.revoke(token!, path.slice('/api/auth/sessions/'.length), body.expectedRevision as number); send(200, { ok: true });
            } else throw controlError('not-found', 'Authentication route not found');
          }
          void actor;
        }
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        const safeCode = typeof code === 'string' && Object.hasOwn(statusFor, code) ? code : 'internal-error';
        if (safeCode === 'body-too-large' || safeCode === 'request-timeout') res.setHeader('Connection', 'close');
        if (safeCode === 'rate-limited') {
          const retry = (error as { retryAfterSec?: number }).retryAfterSec;
          res.setHeader('Retry-After', Number.isSafeInteger(retry) && retry! > 0 ? retry! : 1);
        }
        send(statusFor[safeCode] ?? 500, { error: safeCode });
      }
      return true;
    },
  };
}
