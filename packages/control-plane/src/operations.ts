// Internal domain API: the caller supplies a server-resolved actor, never body.userId.
// Receipts deliberately store only a narrow nonsecret mutation summary.
import { controlError, digest, type ControlPlane } from './index.ts';

export interface MutationReceipt { resourceId: string; revision: number; state: string }
export interface Operation {
  actorId: string;
  operationId: string;
  action: string;
  resourceId: string;
  request: unknown;
}

function canonical(value: unknown, depth = 0): string {
  if (depth > 32) throw controlError('invalid-input', 'Request is too deeply nested');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (Array.from({ length: value.length }, (_, i) => i).some(i => !Object.hasOwn(value, i))) throw controlError('invalid-input', 'Sparse arrays are not JSON data');
    return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']';
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key], depth + 1)).join(',') + '}';
  }
  throw controlError('invalid-input', 'Operation request must be finite JSON data');
}

function receipt(value: unknown): MutationReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw controlError('invalid-input', 'Invalid operation receipt');
  const row = value as MutationReceipt;
  if (Object.keys(row).some(key => !['resourceId', 'revision', 'state'].includes(key))
    || typeof row.resourceId !== 'string' || row.resourceId.length > 200
    || !Number.isSafeInteger(row.revision) || row.revision < 1
    || typeof row.state !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(row.state)) {
    throw controlError('invalid-input', 'Receipts may contain only resourceId, revision and a state code');
  }
  return { resourceId: row.resourceId, revision: row.revision, state: row.state };
}

/** Domain mutation + audit + outbox + replay receipt share the outer commit. */
export function executeOnce(control: ControlPlane, op: Operation, authorize: () => void, mutate: () => MutationReceipt): { replayed: boolean; receipt: MutationReceipt } {
  for (const value of [op.actorId, op.operationId, op.action, op.resourceId]) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(value)) throw controlError('invalid-input', 'Invalid operation identity');
  }
  const serialized = canonical({ action: op.action, resourceId: op.resourceId, request: op.request });
  if (Buffer.byteLength(serialized) > 65_536) throw controlError('invalid-input', 'Operation request is too large');
  const hash = digest(serialized);
  return control.transaction(() => {
    // Cached receipts are not cached permissions: authorize even a replay,
    // inside the same transaction as the read and possible mutation.
    if (authorize.constructor.name === 'AsyncFunction') throw controlError('invalid-input', 'Authorization must be synchronous');
    const authorized: unknown = authorize();
    if (authorized !== undefined) throw controlError('invalid-input', 'Authorization must return void');
    const prior = control.get<{ request_digest: string; response_json: string }>(
      'SELECT request_digest,response_json FROM operation_receipts WHERE actor_id=? AND operation_id=?', op.actorId, op.operationId,
    );
    if (prior) {
      if (prior.request_digest !== hash) throw controlError('conflict', 'Operation key was already used for another request');
      return { replayed: true, receipt: receipt(JSON.parse(prior.response_json)) };
    }
    // A runtime promise cannot escape as a successful mutation or continue a
    // known async callback after rollback. Synchronous callbacks are required.
    if (mutate.constructor.name === 'AsyncFunction') throw controlError('invalid-input', 'Mutation must be synchronous');
    const result = receipt(mutate());
    if (result.resourceId !== op.resourceId) throw controlError('invalid-input', 'Receipt resource does not match the operation');
    control.audit(op.actorId, op.action, op.resourceId);
    control.run('INSERT INTO operation_receipts VALUES(?,?,?,?,?)', op.actorId, op.operationId, hash, JSON.stringify(result), Date.now());
    return { replayed: false, receipt: result };
  });
}
