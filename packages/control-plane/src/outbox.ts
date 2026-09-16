import { randomUUID } from 'node:crypto';
import { controlError, type ControlPlane } from './index.ts';

export interface OutboxEvent {
  installationId: string; id: number; auditSequence: number; actorId: string; action: string;
  resourceId: string | null; occurredAt: number; authorityEpoch: number;
}
interface Row {
  id: number; audit_seq: number; attempts: number; next_attempt_at_ms: number;
  lease_token: string | null; lease_expires_at_ms: number | null;
}
export type DeliveryResult = 'idle' | 'waiting' | 'delivered' | 'retry' | 'blocked' | 'lease-lost';

/** At-least-once delivery. Consumers MUST deduplicate by installation + event.id.
 * A crash after delivery but before acknowledgement can repeat delivery; it
 * cannot lose the durable event. A poison event stops this ordered stream.
 * No timers, hidden workers or network requests are started by construction. */
export function createOutbox(control: ControlPlane, opts: { now?: () => number; leaseMs?: number; maxAttempts?: number } = {}) {
  const now = opts.now ?? Date.now;
  const leaseMs = opts.leaseMs ?? 30_000;
  const maxAttempts = opts.maxAttempts ?? 10;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw controlError('invalid-input', 'Invalid outbox limits');
  }
  return {
    async deliverNext(deliver: (event: Readonly<OutboxEvent>) => Promise<void>): Promise<DeliveryResult> {
      const lease = randomUUID();
      const claimed = control.transaction((): Row | DeliveryResult => {
        const row = control.get<Row>('SELECT id,audit_seq,attempts,next_attempt_at_ms,lease_token,lease_expires_at_ms FROM outbox WHERE delivered_at_ms IS NULL ORDER BY id LIMIT 1');
        if (!row) return 'idle';
        if (row.lease_token && (row.lease_expires_at_ms ?? 0) > now()) return 'waiting';
        if (row.attempts >= maxAttempts) return 'blocked';
        if (row.next_attempt_at_ms > now()) return 'waiting';
        control.run('UPDATE outbox SET lease_token=?,lease_expires_at_ms=?,attempts=attempts+1 WHERE id=?', lease, now() + leaseMs, row.id);
        return row;
      });
      if (typeof claimed === 'string') return claimed;
      const event = control.get<OutboxEvent>(
        'SELECT (SELECT id FROM installation WHERE singleton=1) AS installationId,o.id, a.seq AS auditSequence,a.actor_id AS actorId,a.action,a.resource_id AS resourceId,a.occurred_at_ms AS occurredAt,a.authority_epoch AS authorityEpoch FROM outbox o JOIN audit_events a ON a.seq=o.audit_seq WHERE o.id=?', claimed.id,
      );
      try {
        if (!event) throw controlError('recovery-required', 'Outbox audit record is missing');
        await deliver(Object.freeze(event));
        return control.transaction(() => {
          const update = control.run('UPDATE outbox SET delivered_at_ms=?,lease_token=NULL,lease_expires_at_ms=NULL,last_error_code=NULL WHERE id=? AND lease_token=? AND delivered_at_ms IS NULL', now(), claimed.id, lease);
          return update.changes === 1 ? 'delivered' : 'lease-lost';
        });
      } catch {
        // Never persist arbitrary exception messages: providers may include secrets.
        return control.transaction(() => {
          const delay = Math.min(60_000, 1000 * 2 ** Math.min(claimed.attempts, 6));
          const update = control.run("UPDATE outbox SET lease_token=NULL,lease_expires_at_ms=NULL,next_attempt_at_ms=?,last_error_code='delivery-failed' WHERE id=? AND lease_token=? AND delivered_at_ms IS NULL", now() + delay, claimed.id, lease);
          if (update.changes !== 1) return 'lease-lost';
          return claimed.attempts + 1 >= maxAttempts ? 'blocked' : 'retry';
        });
      }
    },
    status() {
      return control.get<{ pending: number; blocked: number; oldestEventAt: number | null }>(
        'SELECT count(*) AS pending,coalesce(sum(o.attempts>=? AND (o.lease_token IS NULL OR o.lease_expires_at_ms<=?)),0) AS blocked,min(a.occurred_at_ms) AS oldestEventAt FROM outbox o JOIN audit_events a ON a.seq=o.audit_seq WHERE o.delivered_at_ms IS NULL', maxAttempts, now(),
      )!;
    },
    /** Trusted operator operation; the HTTP adapter must authorize the actor. */
    retryBlocked(id: number, actorId: string): boolean {
      if (!Number.isSafeInteger(id) || id < 1 || !actorId) throw controlError('invalid-input', 'Invalid outbox retry');
      return control.transaction(() => {
        const changed = control.run('UPDATE outbox SET attempts=0,next_attempt_at_ms=0,lease_token=NULL,lease_expires_at_ms=NULL WHERE id=? AND delivered_at_ms IS NULL AND attempts>=? AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms<=?)', id, maxAttempts, now());
        if (changed.changes !== 1) return false;
        control.audit(actorId, 'outbox.retry', String(id));
        return true;
      });
    },
  };
}
