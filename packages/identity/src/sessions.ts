import { controlError, digest, type ControlPlane } from '@polyth/control-plane';
import { newToken, opaqueId, tokenHash, validToken } from './validation.ts';
import type { IdentitySession, SessionSummary } from './types.ts';

export interface IssuedSession { token: string; session: IdentitySession }
interface SessionRow extends IdentitySession { lastSeenAt: number }
export interface SessionService {
  resolve(token: string | null | undefined): IdentitySession | null;
  require(token: string | null | undefined, elevated?: boolean): IdentitySession;
  issue(userId: string, label?: string): IssuedSession;
  logout(token: string | null): void;
  logoutAll(token: string): void;
  list(token: string): SessionSummary[];
  revoke(token: string, id: string, expectedRevision: number): void;
  cookieName(): string;
}

export function createSessions(control: ControlPlane, opts: { now: () => number; idleMs?: number; absoluteMs?: number }): SessionService {
  const idleMs = opts.idleMs ?? 7 * 24 * 60 * 60_000;
  const absoluteMs = opts.absoluteMs ?? 30 * 24 * 60 * 60_000;
  if (!Number.isSafeInteger(idleMs) || !Number.isSafeInteger(absoluteMs) || idleMs <= 0 || absoluteMs < idleMs) {
    throw controlError('invalid-input', 'Invalid session lifetime');
  }
  const { now } = opts;
  const dto = (row: IdentitySession): IdentitySession => ({ id: row.id, userId: row.userId, displayName: row.displayName, userRevision: row.userRevision, createdAt: row.createdAt, expiresAt: row.expiresAt, elevatedAt: row.elevatedAt });
  const service: SessionService = {
    cookieName: () => `polyth_auth_${digest(control.installation().id).slice(0, 16)}`,
    resolve(token) {
      if (!validToken(token)) return null;
      if (control.installation().state !== 'ready') return null;
      const time = now();
      const row = control.get<SessionRow>(
        `SELECT s.id,s.user_id AS userId,u.display_name AS displayName,p.revision AS userRevision,
                s.created_at_ms AS createdAt,s.expires_at_ms AS expiresAt,s.elevated_at_ms AS elevatedAt,s.last_seen_at_ms AS lastSeenAt
         FROM auth_sessions s JOIN users u ON u.id=s.user_id JOIN principals p ON p.id=u.id
         WHERE s.token_hash=? AND p.status='active' AND p.kind='user' AND s.auth_epoch=p.auth_epoch
           AND s.expires_at_ms>? AND s.last_seen_at_ms>? AND s.created_at_ms<=?`,
        tokenHash('session', token), time, time - idleMs, time,
      );
      if (!row) return null;
      // Never let the write coalescing interval exceed a short test/policy idle
      // window. It is an optimization, not a second authority or expiry rule.
      if (time - row.lastSeenAt >= Math.min(60_000, Math.max(1, Math.floor(idleMs / 4)))) {
        control.transaction(() => control.run('UPDATE auth_sessions SET last_seen_at_ms=? WHERE id=? AND last_seen_at_ms=?', time, row.id, row.lastSeenAt));
      }
      return dto(row);
    },
    require(token, elevated = false) {
      const session = service.resolve(token);
      if (!session) throw controlError('unauthorized', 'Authentication required');
      if (elevated && (session.elevatedAt === null || now() - session.elevatedAt >= 5 * 60_000 || session.elevatedAt > now())) {
        throw controlError('reauth-required', 'Sign in again to confirm this action');
      }
      return session;
    },
    // Called only by verified login/setup in an existing domain transaction.
    issue(userId, label = '') {
      const user = control.get<{ display_name: string; revision: number; auth_epoch: number }>(
        "SELECT u.display_name,p.revision,p.auth_epoch FROM users u JOIN principals p ON p.id=u.id WHERE u.id=? AND p.status='active' AND p.kind='user'", userId,
      );
      if (!user || control.installation().state !== 'ready') throw controlError('unauthorized', 'Authentication required');
      const token = newToken(), id = opaqueId('ses'), time = now();
      const session: IdentitySession = { id, userId, displayName: user.display_name, userRevision: user.revision, createdAt: time, expiresAt: time + absoluteMs, elevatedAt: time };
      control.run('INSERT INTO auth_sessions(id,user_id,token_hash,created_at_ms,last_seen_at_ms,expires_at_ms,label,auth_epoch,elevated_at_ms) VALUES(?,?,?,?,?,?,?,?,?)', id, userId, tokenHash('session', token), time, time, session.expiresAt, label.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120), user.auth_epoch, time);
      control.audit(userId, 'auth.session-created', id);
      return { token, session };
    },
    logout(token) {
      if (!validToken(token)) return;
      control.transaction(() => {
        const row = control.get<{ id: string; user_id: string }>('SELECT id,user_id FROM auth_sessions WHERE token_hash=?', tokenHash('session', token));
        if (!row) return;
        control.run('DELETE FROM auth_sessions WHERE id=?', row.id);
        control.bumpEpoch();
        control.audit(row.user_id, 'auth.logout', row.id);
      });
    },
    logoutAll(token) {
      control.transaction(() => {
        const actor = service.require(token);
        control.run('UPDATE principals SET auth_epoch=auth_epoch+1 WHERE id=?', actor.userId);
        control.run('DELETE FROM auth_sessions WHERE user_id=?', actor.userId);
        control.bumpEpoch(); control.audit(actor.userId, 'auth.logout-all', actor.userId);
      });
    },
    list(token) {
      const actor = service.require(token);
      const time = now();
      return control.all<SessionSummary>(
        `SELECT id,label,created_at_ms AS createdAt,last_seen_at_ms AS lastSeenAt,expires_at_ms AS expiresAt,revision
         FROM auth_sessions WHERE user_id=? AND auth_epoch=(SELECT auth_epoch FROM principals WHERE id=?)
           AND expires_at_ms>? AND last_seen_at_ms>? AND created_at_ms<=? ORDER BY created_at_ms DESC,id`,
        actor.userId, actor.userId, time, time - idleMs, time,
      ).map(row => ({ ...row, current: row.id === actor.id }));
    },
    revoke(token, id, expectedRevision) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw controlError('invalid-input', 'Expected revision is required');
      control.transaction(() => {
        const actor = service.require(token);
        const row = control.get<{ revision: number }>('SELECT revision FROM auth_sessions WHERE id=? AND user_id=?', id, actor.userId);
        if (!row) throw controlError('not-found', 'Session not found');
        if (row.revision !== expectedRevision) throw controlError('conflict', 'Session changed; refresh before retrying');
        control.run('DELETE FROM auth_sessions WHERE id=? AND user_id=? AND revision=?', id, actor.userId, expectedRevision);
        control.bumpEpoch(); control.audit(actor.userId, 'auth.session-revoked', id);
      });
    },
  };
  return service;
}
