import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, installed } from './fixtures.ts';

test('bound-channel revalidation never extends idle lifetime and observes revocation', async t => {
  const f = fixture(t, { idleMs: 1000, absoluteMs: 5000 }), { owner, input } = await installed(f);
  assert.equal(f.identity.sessions.resolveId(owner.session.id, owner.userId)?.userId, owner.userId);
  assert.equal(f.identity.sessions.resolveId(owner.session.id, 'usr_wrong'), null);
  const before = f.control.get<{ last_seen_at_ms: number }>('SELECT last_seen_at_ms FROM auth_sessions WHERE id=?', owner.session.id)!.last_seen_at_ms;
  f.advance(750);
  assert.ok(f.identity.sessions.resolveId(owner.session.id, owner.userId));
  assert.equal(f.control.get<{ last_seen_at_ms: number }>('SELECT last_seen_at_ms FROM auth_sessions WHERE id=?', owner.session.id)!.last_seen_at_ms, before);
  f.advance(250);
  assert.equal(f.identity.sessions.resolveId(owner.session.id, owner.userId), null);

  const fresh = await f.identity.credentials.login({ login: input.login, password: input.password });
  assert.ok(f.identity.sessions.resolveId(fresh.session.id, owner.userId));
  f.identity.sessions.revoke(fresh.token, fresh.session.id, 1);
  assert.equal(f.identity.sessions.resolveId(fresh.session.id, owner.userId), null);
});
