import assert from "node:assert/strict";
import test from "node:test";
import { fixture, installed } from "./fixtures.ts";

test("operator break-glass reset requires installation confirmation, revokes sessions, and audits", async t => {
  const f = fixture(t);
  const { owner, input } = await installed(f);
  const another = await f.identity.credentials.login({ login: input.login, password: input.password });
  const installationId = f.control.installation().id;

  await assert.rejects(
    f.identity.credentials.operatorResetPassword({
      userId: owner.userId,
      password: "replacement operator passphrase",
      installationId: "00000000-0000-0000-0000-000000000000",
      reason: "Owner lost every interactive credential.",
    }),
    { code: "forbidden" },
  );
  await assert.rejects(
    f.identity.credentials.operatorResetPassword({
      userId: owner.userId,
      password: "replacement operator passphrase",
      installationId,
      reason: "too short",
    }),
    { code: "invalid-input" },
  );

  await f.identity.credentials.operatorResetPassword({
    userId: owner.userId,
    password: "replacement operator passphrase",
    installationId,
    reason: "Owner lost every interactive credential.",
  });

  assert.equal(f.identity.sessions.resolve(owner.token), null);
  assert.equal(f.identity.sessions.resolve(another.token), null);
  await assert.rejects(
    f.identity.credentials.login({ login: input.login, password: input.password }),
    { code: "invalid-credentials" },
  );
  assert.ok(await f.identity.credentials.login({
    login: input.login,
    password: "replacement operator passphrase",
  }));
  const audit = f.control.all<{ actor_id: string; action: string; resource_id: string | null }>(
    "SELECT actor_id,action,resource_id FROM audit_events WHERE action='auth.break-glass-password-reset'",
  );
  assert.deepEqual(audit, [{
    actor_id: "operator:break-glass",
    action: "auth.break-glass-password-reset",
    resource_id: owner.userId,
  }]);
});

test("operator break-glass refuses managed, inactive, and unknown identities", async t => {
  const f = fixture(t);
  const { owner } = await installed(f);
  const installationId = f.control.installation().id;
  const reset = (userId: string) => f.identity.credentials.operatorResetPassword({
    userId,
    password: "replacement operator passphrase",
    installationId,
    reason: "Operator recovery test for inaccessible account.",
  });

  await assert.rejects(reset("usr_missing"), { code: "not-found" });
  f.control.transaction(() => f.control.run("UPDATE users SET managed=1 WHERE id=?", owner.userId));
  await assert.rejects(reset(owner.userId), { code: "not-found" });
  f.control.transaction(() => {
    f.control.run("UPDATE users SET managed=0 WHERE id=?", owner.userId);
    f.control.run("UPDATE principals SET status='suspended' WHERE id=?", owner.userId);
  });
  await assert.rejects(reset(owner.userId), { code: "not-found" });
});
