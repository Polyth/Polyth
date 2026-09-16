import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openControlPlane } from '../src/index.ts';
import { executeOnce as authorizedOperation, type MutationReceipt, type Operation } from '../src/operations.ts';
import { createOutbox } from '../src/outbox.ts';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'polyth-operations-'));
  const c = openControlPlane({ directory });
  t.after(() => { c.close(); rmSync(directory, { recursive: true, force: true }); });
  return { c, directory };
}
const op = { actorId: 'usr_a', operationId: 'request-1', action: 'user.created', resourceId: 'usr_b', request: { name: 'Example', managed: false } };
// These isolated storage tests use an explicit trusted test authorization.
const executeOnce = (c: ReturnType<typeof openControlPlane>, op: Operation, mutate: () => MutationReceipt) => authorizedOperation(c, op, () => {}, mutate);
const summary: MutationReceipt = { resourceId: 'usr_b', revision: 1, state: 'active' };

test('mutation, audit, outbox and receipt commit once across connections and reordered JSON', t => {
  const { c, directory } = fixture(t);
  const other = openControlPlane({ directory });
  t.after(() => other.close());
  let mutations = 0;
  const mutate = () => { mutations++; c.run("INSERT INTO principals(id,kind,status) VALUES('usr_b','user','active')"); return summary; };
  assert.equal(executeOnce(c, op, mutate).replayed, false);
  assert.equal(executeOnce(other, { ...op, request: { managed: false, name: 'Example' } }, mutate).replayed, true);
  assert.equal(mutations, 1);
  for (const table of ['principals', 'audit_events', 'outbox', 'operation_receipts']) assert.equal(c.all(`SELECT * FROM ${table}`).length, 1);
});

test('same key with changed payload, action or resource conflicts without new audit', t => {
  const { c } = fixture(t);
  executeOnce(c, op, () => summary);
  for (const patch of [{ request: { name: 'Other' } }, { action: 'user.deleted' }, { resourceId: 'usr_foreign' }]) {
    assert.throws(() => executeOnce(c, { ...op, ...patch }, () => { throw new Error('must not execute'); }), { code: 'conflict' });
  }
  assert.equal(c.all('SELECT * FROM audit_events').length, 1);
});

test('mutation failure rolls back domain changes and all evidence; retry can win', t => {
  const { c } = fixture(t);
  assert.throws(() => executeOnce(c, op, () => {
    c.run("INSERT INTO principals(id,kind,status) VALUES('usr_b','user','active')");
    throw new Error('fault-before-commit');
  }), /fault-before-commit/);
  for (const table of ['principals', 'audit_events', 'outbox', 'operation_receipts']) assert.equal(c.all(`SELECT * FROM ${table}`).length, 0);
  assert.equal(executeOnce(c, op, () => summary).replayed, false);
});

test('secret-bearing, mismatched and asynchronous receipts cannot commit', t => {
  const { c } = fixture(t);
  for (const invalid of [{ ...summary, token: 'never-persist-this' }, { ...summary, resourceId: 'foreign' }, { ...summary, revision: NaN }]) {
    assert.throws(() => executeOnce(c, op, () => { c.bumpEpoch(); return invalid; }), { code: 'invalid-input' });
  }
  let invoked = false;
  const asyncMutation = async () => { invoked = true; return summary; };
  assert.throws(() => executeOnce(c, op, asyncMutation as unknown as () => MutationReceipt), { code: 'invalid-input' });
  assert.equal(invoked, false);
  assert.equal(c.installation().authority_epoch, 1);
  assert.equal(c.all('SELECT * FROM operation_receipts').length, 0);
});

test('ordered outbox retries do not lose events or persist exception secrets', async t => {
  const { c } = fixture(t);
  let time = 1000;
  const outbox = createOutbox(c, { now: () => time });
  c.transaction(() => { c.audit('usr_a', 'access.revoked', 'spc_a'); c.audit('usr_a', 'access.changed', 'spc_b'); });
  const seen: number[] = [];
  assert.equal(await outbox.deliverNext(async e => { seen.push(e.id); throw new Error('provider-secret-must-not-persist'); }), 'retry');
  assert.equal(await outbox.deliverNext(async () => { assert.fail('backoff must stop delivery'); }), 'waiting');
  assert.equal(JSON.stringify(c.all('SELECT * FROM outbox')).includes('provider-secret'), false);
  time += 1000;
  assert.equal(await outbox.deliverNext(async e => { seen.push(e.id); }), 'delivered');
  assert.equal(await outbox.deliverNext(async e => { seen.push(e.id); }), 'delivered');
  assert.deepEqual(seen, [1, 1, 2]);
  assert.equal(await outbox.deliverNext(async () => {}), 'idle');
  assert.equal(outbox.status().pending, 0);
});

test('failure after delivery but before ack survives reopen and is logically deduplicated', async t => {
  const { c, directory } = fixture(t);
  let time = 1000;
  const outbox = createOutbox(c, { now: () => time, leaseMs: 100 });
  c.transaction(() => c.audit('usr_a', 'access.revoked', 'spc_a'));
  const applied = new Set<number>();
  let deliveries = 0;
  await assert.rejects(outbox.deliverNext(async e => { applied.add(e.id); deliveries++; c.close(); }), { code: 'unavailable' });
  const reopened = openControlPlane({ directory }); t.after(() => reopened.close());
  const resumed = createOutbox(reopened, { now: () => time, leaseMs: 100 });
  assert.equal(await resumed.deliverNext(async () => { assert.fail(); }), 'waiting');
  time += 100;
  assert.equal(await resumed.deliverNext(async e => { applied.add(e.id); deliveries++; }), 'delivered');
  assert.equal(deliveries, 2);
  assert.equal(applied.size, 1);
});

test('expired lease takeover fences a late acknowledgement', async t => {
  const { c, directory } = fixture(t);
  const other = openControlPlane({ directory }); t.after(() => other.close());
  let time = 0;
  c.transaction(() => c.audit('usr_a', 'access.revoked', 'spc_a'));
  const first = createOutbox(c, { now: () => time, leaseMs: 10 });
  const second = createOutbox(other, { now: () => time, leaseMs: 10 });
  let release!: () => void;
  const running = first.deliverNext(async () => new Promise<void>(resolve => { release = resolve; }));
  assert.equal(await second.deliverNext(async () => { assert.fail(); }), 'waiting');
  time = 11;
  assert.equal(await second.deliverNext(async () => {}), 'delivered');
  release();
  assert.equal(await running, 'lease-lost');
  assert.equal(first.status().pending, 0);
});

test('poison event is retained, blocks later events and requires an audited retry', async t => {
  const { c } = fixture(t);
  const outbox = createOutbox(c, { maxAttempts: 1 });
  c.transaction(() => { c.audit('usr_a', 'first'); c.audit('usr_a', 'second'); });
  assert.equal(await outbox.deliverNext(async () => { throw new Error('failed'); }), 'blocked');
  assert.equal(await outbox.deliverNext(async () => { assert.fail(); }), 'blocked');
  assert.equal(outbox.status().pending, 2);
  assert.equal(outbox.status().blocked, 1);
  assert.equal(outbox.retryBlocked(1, 'usr_operator'), true);
  assert.equal(c.get<{ action: string }>('SELECT action FROM audit_events ORDER BY seq DESC LIMIT 1')?.action, 'outbox.retry');
  assert.equal(await outbox.deliverNext(async e => { assert.equal(e.action, 'first'); }), 'delivered');
});

test('a replay still requires current authorization; sparse request arrays are rejected', t => {
  const { c } = fixture(t);
  executeOnce(c, op, () => summary);
  assert.throws(() => authorizedOperation(c, op, () => { throw Object.assign(new Error('revoked'), { code: 'forbidden' }); }, () => summary), { code: 'forbidden' });
  assert.equal(c.all('SELECT * FROM operation_receipts').length, 1);
  assert.throws(() => executeOnce(c, { ...op, request: new Array(2) }, () => summary), { code: 'invalid-input' });
});
