import { controlError, type ControlPlane } from '@polyth/control-plane';
import type { SessionService } from './sessions.ts';

/** Account guardrails as stored. The shape is owned by `@polyth/contracts`
 *  (`AccountGuardrails`); identity persists it opaquely through the host's
 *  normalizer so this package stays contract-free. */
export interface StoredGuardrails {
  userId: string;
  guardrails: unknown | null;
  /** 0 before the first write. */
  revision: number;
}
/** Validates untrusted input into canonical guardrails; throws `invalid-input`. */
export type GuardrailsNormalizer = (raw: unknown) => unknown;

/** What a corrupt stored row degrades to: everything closed, never open. */
const FAIL_CLOSED = Object.freeze({ grants: [], models: [], approvals: 'none' });

export function createGuardrails(
  control: ControlPlane,
  sessions: SessionService,
  now: () => number,
  normalize: GuardrailsNormalizer,
) {
  const isInstanceOwner = (userId: string): boolean => !!control.get(
    "SELECT 1 FROM instance_roles WHERE user_id=? AND role='owner'",
    userId,
  );
  const forUser = (userId: string): StoredGuardrails => {
    const row = control.get<{ guardrails_json: string | null; revision: number }>(
      'SELECT guardrails_json,revision FROM account_guardrails WHERE user_id=?',
      userId,
    );
    if (!row) return { userId, guardrails: null, revision: 0 };
    if (row.guardrails_json === null) return { userId, guardrails: null, revision: row.revision };
    let guardrails: unknown;
    try { guardrails = normalize(JSON.parse(row.guardrails_json)); }
    catch { guardrails = FAIL_CLOSED; }
    return { userId, guardrails, revision: row.revision };
  };
  return {
    /** Trusted host lookup for request enforcement. Never takes request input. */
    forUser,
    /** The account itself or the instance owner. Anyone else: not-found. */
    get(token: string, userId: string): StoredGuardrails {
      const actor = sessions.require(token);
      if (actor.userId !== userId && !isInstanceOwner(actor.userId)) throw controlError('not-found', 'Account not found');
      if (!control.get("SELECT 1 FROM users u JOIN principals p ON p.id=u.id WHERE u.id=? AND p.kind='user'", userId)) {
        throw controlError('not-found', 'Account not found');
      }
      return forUser(userId);
    },
    /** Instance owner only, elevated. `raw === null` removes the guardrails. */
    set(token: string, userId: string, raw: unknown, expectedRevision: number): StoredGuardrails {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw controlError('invalid-input', 'Expected revision is required');
      }
      const guardrails = raw === null ? null : normalize(raw);
      return control.transaction(() => {
        const actor = sessions.require(token, true);
        if (!isInstanceOwner(actor.userId)) throw controlError('forbidden', 'Instance owner access required');
        if (!control.get("SELECT 1 FROM users u JOIN principals p ON p.id=u.id WHERE u.id=? AND p.kind='user'", userId)) {
          throw controlError('not-found', 'Account not found');
        }
        // An instance owner is the authority guardrails answer to; guarding
        // one would let the owner lock themselves out of administration.
        if (isInstanceOwner(userId)) throw controlError('invalid-input', 'Instance owners cannot be guarded');
        const current = forUser(userId);
        if (current.revision !== expectedRevision) throw controlError('conflict', 'Guardrails changed; refresh before saving');
        const json = guardrails === null ? null : JSON.stringify(guardrails);
        control.run(
          `INSERT INTO account_guardrails(user_id,guardrails_json,revision,updated_by,updated_at_ms) VALUES(?,?,1,?,?)
           ON CONFLICT(user_id) DO UPDATE SET guardrails_json=excluded.guardrails_json,
             revision=account_guardrails.revision+1,updated_by=excluded.updated_by,updated_at_ms=excluded.updated_at_ms`,
          userId, json, actor.userId, now(),
        );
        control.bumpEpoch();
        control.audit(actor.userId, guardrails === null ? 'identity.guardrails-removed' : 'identity.guardrails-updated', userId);
        return forUser(userId);
      });
    },
  };
}
export type GuardrailsService = ReturnType<typeof createGuardrails>;
