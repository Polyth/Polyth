// HTTP adapter for the single control-plane identity authority. Host wiring is
// explicit: never auto-enable this beside the legacy JSON/tenancy authority.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { controlError, digest } from '@polyth/control-plane';
import { newToken, validToken } from './validation.ts';
import type { IdentityService } from './index.ts';

const loopback = (address?: string): boolean => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '');
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
const statusFor: Readonly<Record<string, number>> = {
  unauthorized: 401, 'invalid-credentials': 401, 'invalid-claim': 401,
  forbidden: 403, 'wrong-origin': 403, 'insecure-transport': 403, 'reauth-required': 403, 'managed-identity': 403,
  'not-found': 404, conflict: 409, 'last-owner': 409, 'last-auth-method': 409, 'invalid-transition': 409, 'setup-completed': 409,
  'invalid-input': 400, 'request-timeout': 408, 'recovery-ack-required': 400, 'body-too-large': 413, 'rate-limited': 429,
  'recovery-required': 503, unavailable: 503,
};

export function createIdentityHttpAdapter(identity: IdentityService, options: {
  /** App/operator configuration, never req.headers.host or forwarded headers. */
  origin: string;
  /** Explicit local-only HTTP development/native listener; NOT an identity. */
  localOnly?: boolean;
}) {
  const url = new URL(options.origin);
  const origin = url.origin, secure = url.protocol === 'https:';
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || (!secure && !(url.protocol === 'http:' && options.localOnly === true && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
    throw controlError('invalid-input', 'Identity requires HTTPS or an explicitly local-only HTTP origin');
  }
  const cookieName = `${secure ? '__Host-' : ''}${identity.sessions.cookieName()}`;
  const csrfCookie = `${cookieName}_csrf`;
  const cookie = (name: string, value: string, maxAge?: number): string => `${name}=${value}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}${maxAge === undefined ? '' : `; Max-Age=${maxAge}`}`;
  const transport = (req: IncomingMessage): void => {
    if (secure ? (req.socket as typeof req.socket & { encrypted?: boolean }).encrypted !== true : (!loopback(req.socket.remoteAddress) || !loopback(req.socket.localAddress))) {
      throw controlError('insecure-transport', 'A secure identity transport is required');
    }
    if (req.headers.host?.toLowerCase() !== url.host.toLowerCase()) throw controlError('wrong-origin', 'Origin does not match this installation');
  };
  const sameOrigin = (req: IncomingMessage): void => {
    if (req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') throw controlError('wrong-origin', 'Same-origin request required');
  };
  const tokenOf = (req: IncomingMessage): string | null => cookieToken(req, cookieName);
  const requireHuman = (req: IncomingMessage) => { transport(req); return identity.sessions.require(tokenOf(req)); };
  return {
    cookieName,
    requireHuman,
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
          const nonce = cookieToken(req, csrfCookie) ?? newToken();
          if (!cookieToken(req, csrfCookie)) res.setHeader('Set-Cookie', cookie(csrfCookie, nonce));
          const actor = identity.sessions.resolve(token);
          send(200, { ...identity.setup.status(), required: true, authorized: !!actor, scope: actor ? 'ui-session' : 'anonymous', csrfToken: csrfFor(nonce) });
          return true;
        }
        if (req.method === 'GET') {
          const actor = requireHuman(req);
          if (path === '/api/auth/accounts') {
            const accounts = identity.accounts.list(token!);
            send(200, {
              currentAccountId: actor.userId,
              canManage: identity.accounts.canManage(token!),
              accounts: accounts.map(account => ({
                ...account,
                name: account.displayName,
                current: account.id === actor.userId,
              })),
            });
          } else if (path === '/api/auth/sessions') send(200, { sessions: identity.sessions.list(token!) });
          else if (path === '/api/auth/me') send(200, identity.accounts.current(token!));
          else if (path === '/api/auth/passkeys') send(200, { passkeys: identity.passkeys.list(token!) });
          else throw controlError('not-found', 'Authentication route not found');
          return true;
        }
        if (!['POST', 'DELETE'].includes(req.method ?? '')) throw controlError('not-found', 'Authentication route not found');
        sameOrigin(req);
        const nonce = cookieToken(req, csrfCookie);
        if (!nonce || !csrfMatches(req.headers['x-polyth-csrf'], nonce)) throw controlError('forbidden', 'CSRF validation failed');
        const body = await readBody(req);
        const issued = (result: { token: string; session: { expiresAt: number; createdAt: number } }): void => {
          const freshNonce = newToken();
          res.setHeader('Set-Cookie', [
            cookie(cookieName, result.token, Math.floor((result.session.expiresAt - result.session.createdAt) / 1000)),
            cookie(csrfCookie, freshNonce),
          ]);
          send(200, { ok: true, csrfToken: csrfFor(freshNonce) });
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
          requireHuman(req);
          if (req.method === 'POST' && path === '/api/auth/logout-all') {
            identity.sessions.logoutAll(token!); res.setHeader('Set-Cookie', cookie(cookieName, '', 0)); send(200, { ok: true });
          } else if (req.method === 'POST' && path === '/api/auth/reauthenticate') {
            await identity.credentials.reauthenticate(token!, text(body, 'password'), req.socket.remoteAddress); send(200, { ok: true });
          } else if (req.method === 'POST' && path === '/api/auth/password') {
            await identity.credentials.changePassword(token!, text(body, 'password')); res.setHeader('Set-Cookie', cookie(cookieName, '', 0)); send(200, { ok: true });
          } else if (req.method === 'POST' && path === '/api/auth/accounts') {
            const account = await identity.accounts.createLocal(token!, {
              login: text(body, 'login'), name: text(body, 'name'), password: text(body, 'password'),
            });
            send(200, { ...account, name: account.displayName, current: false });
          } else if (req.method === 'POST' && /^\/api\/auth\/accounts\/usr_[a-f0-9-]+\/status$/.test(path)) {
            const userId = path.slice('/api/auth/accounts/'.length, -'/status'.length);
            const status = text(body, 'status');
            const account = identity.accounts.setStatus(
              token!, userId,
              status as 'active' | 'suspended' | 'offboarding' | 'disabled',
              Number(body.expectedRevision),
            );
            send(200, { ...account, name: account.displayName, current: account.id === identity.accounts.current(token!).id });
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
