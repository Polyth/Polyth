import { controlError, type ControlPlane } from '@polyth/control-plane';
import type { SessionService } from './sessions.ts';

/** Account permissions as stored. The vocabulary is owned by
 *  `@polyth/contracts` (`AccountPermission`); identity persists it opaquely
 *  through the host's normalizer so this package stays contract-free. */
export interface StoredPermissions {
  userId: string;
  permissions: string[];
  /** 0 before the first write. */
  revision: number;
}
/** Validates untrusted input into the canonical list; throws `invalid-input`. */
export type PermissionsNormalizer = (raw: unknown) => string[];

export function createPermissions(
  control: ControlPlane,
  sessions: SessionService,
  now: () => number,
  normalize: PermissionsNormalizer,
) {
  const isInstanceOwner = (userId: string): boolean => !!control.get(
    "SELECT 1 FROM instance_roles WHERE user_id=? AND role='owner'",
    userId,
  );
  const requireUser = (userId: string): void => {
    if (!control.get("SELECT 1 FROM users u JOIN principals p ON p.id=u.id WHERE u.id=? AND p.kind='user'", userId)) {
      throw controlError('not-found', 'Account not found');
    }
  };
  // Read on every request context; a write is always this process's own
  // `set`, so a per-user cache stays exact.
  const cache = new Map<string, StoredPermissions>();
  const forUser = (userId: string): StoredPermissions => {
    const cached = cache.get(userId);
    if (cached) return cached;
    const row = control.get<{ permissions_json: string; revision: number }>(
      'SELECT permissions_json,revision FROM account_permissions WHERE user_id=?',
      userId,
    );
    let permissions: string[] = [];
    if (row) {
      // A corrupt row grants nothing.
      try { permissions = normalize(JSON.parse(row.permissions_json)); }
      catch { permissions = []; }
    }
    const stored = { userId, permissions, revision: row?.revision ?? 0 };
    cache.set(userId, stored);
    return stored;
  };
  return {
    /** Trusted host lookup for request contexts. Never takes request input. */
    forUser,
    /** True for the instance owner (who holds every permission) or a grant. */
    has(userId: string, permission: string): boolean {
      return isInstanceOwner(userId) || forUser(userId).permissions.includes(permission);
    },
    /** The account itself or the instance owner. Anyone else: not-found. */
    get(token: string, userId: string): StoredPermissions {
      const actor = sessions.require(token);
      if (actor.userId !== userId && !isInstanceOwner(actor.userId)) throw controlError('not-found', 'Account not found');
      requireUser(userId);
      return forUser(userId);
    },
    /** Instance owner only, elevated. */
    set(token: string, userId: string, raw: unknown, expectedRevision: number): StoredPermissions {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw controlError('invalid-input', 'Expected revision is required');
      }
      const permissions = normalize(raw);
      return control.transaction(() => {
        const actor = sessions.require(token, true);
        if (!isInstanceOwner(actor.userId)) throw controlError('forbidden', 'Instance owner access required');
        requireUser(userId);
        // The instance owner already holds every permission.
        if (isInstanceOwner(userId)) throw controlError('invalid-input', 'Instance owners already have every permission');
        cache.delete(userId);
        const current = forUser(userId);
        if (current.revision !== expectedRevision) throw controlError('conflict', 'Permissions changed; refresh before saving');
        control.run(
          `INSERT INTO account_permissions(user_id,permissions_json,revision,updated_by,updated_at_ms) VALUES(?,?,1,?,?)
           ON CONFLICT(user_id) DO UPDATE SET permissions_json=excluded.permissions_json,
             revision=account_permissions.revision+1,updated_by=excluded.updated_by,updated_at_ms=excluded.updated_at_ms`,
          userId, JSON.stringify(permissions), actor.userId, now(),
        );
        cache.delete(userId);
        control.bumpEpoch();
        control.audit(actor.userId, 'identity.permissions-updated', userId);
        return forUser(userId);
      });
    },
  };
}
export type PermissionsService = ReturnType<typeof createPermissions>;
