import test from "node:test";
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openControlPlane } from "@polyth/control-plane";
import type { OutboxEvent } from "@polyth/control-plane/outbox";
import type { AuthPrincipal } from "@polyth/contracts";
import { PairedSocketRegistry } from "@polyth/plugins";
import {
  AUTHORITY_EVENT_CHANNEL,
  createAuthorityOutboxWorker,
  publishAuthorityEvent,
} from "../src/authorityOutbox.ts";

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "polyth-authority-outbox-"));
  const control = openControlPlane({ directory });
  t.after(() => {
    control.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return control;
}

async function eventually(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const event = (action: string, resourceId: string | null, actorId = "usr_owner"): OutboxEvent => ({
  installationId: "11111111-1111-1111-1111-111111111111",
  id: 1,
  auditSequence: 1,
  actorId,
  action,
  resourceId,
  occurredAt: 1,
  authorityEpoch: 1,
});
const ui = (sessionId: string, userId: string): AuthPrincipal => ({
  kind: "ui-session",
  sessionId,
  rememberedDeviceId: sessionId,
  userId,
} as AuthPrincipal & { userId: string });
const paired = (userId: string): AuthPrincipal => ({
  kind: "paired-device",
  deviceId: "dev_owner",
  deviceEndpointId: "endpoint",
  connectionId: "connection",
  transport: "direct",
  grants: [],
  grantRevision: 1,
  userId,
} as AuthPrincipal & { userId: string });

test("production worker drains durable authority events into diagnostics telemetry", async t => {
  const control = fixture(t);
  const observed: OutboxEvent[] = [];
  const telemetry = channel(AUTHORITY_EVENT_CHANNEL);
  const subscriber = (message: unknown): void => { observed.push(message as OutboxEvent); };
  telemetry.subscribe(subscriber);
  t.after(() => telemetry.unsubscribe(subscriber));

  control.transaction(() => {
    control.audit("system:test", "authority.test", "resource:test");
  });

  const worker = createAuthorityOutboxWorker(control, { pollMs: 5 });
  worker.start();
  t.after(() => worker.stop());

  await eventually(() => worker.status().pending === 0);
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.action, "authority.test");
  assert.equal(observed[0]?.resourceId, "resource:test");
  assert.equal(worker.status().lastDeliveredEventId, observed[0]?.id);
});

test("durable revocation events close the exact authority class they invalidate", async () => {
  const registry = new PairedSocketRegistry();
  const closed: string[] = [];
  const revoked = {}, sibling = {}, device = {};
  registry.bind(revoked, ui("ses_revoked", "usr_owner"), () => closed.push("revoked"));
  registry.bind(sibling, ui("ses_sibling", "usr_owner"), () => closed.push("sibling"));
  registry.bind(device, paired("usr_owner"), () => closed.push("device"));

  await publishAuthorityEvent(event("authority.unrelated", "usr_owner"));
  assert.deepEqual(closed, []);

  await publishAuthorityEvent(event("auth.session-revoked", "ses_revoked"));
  assert.deepEqual(closed, ["revoked"]);
  assert.equal(registry.size, 1, "paired-device bookkeeping is unchanged by a browser-session revoke");

  await publishAuthorityEvent(event("auth.password-changed", "usr_owner"));
  assert.deepEqual(closed.sort(), ["revoked", "sibling"]);
  assert.equal(registry.size, 1, "password/session authority is independent from pairing grants");

  // Account lifecycle revocation invalidates the user behind both auth classes.
  await publishAuthorityEvent(event("identity.suspended", "usr_owner", "usr_admin"));
  assert.deepEqual(closed.sort(), ["device", "revoked", "sibling"]);
  assert.equal(registry.size, 0);

  // At-least-once outbox replay is harmless after the first close removed the entries.
  await publishAuthorityEvent(event("identity.suspended", "usr_owner", "usr_admin"));
  assert.equal(closed.length, 3);
});

test("actor-scoped auth method removal invalidates that user's browser sessions only", async () => {
  const registry = new PairedSocketRegistry();
  const closed: string[] = [];
  const owner = {}, device = {}, other = {};
  registry.bind(owner, ui("ses_owner_method", "usr_owner_method"), () => closed.push("owner"));
  registry.bind(device, paired("usr_owner_method"), () => closed.push("device"));
  registry.bind(other, ui("ses_other_method", "usr_other_method"), () => closed.push("other"));

  await publishAuthorityEvent(event("auth.passkey-removed", "pky_credential", "usr_owner_method"));
  assert.deepEqual(closed, ["owner"]);
  assert.equal(registry.size, 1);
  registry.closeDevice("dev_owner");
  registry.unbind(other);
});

test("delivery failure is retried from durable state without losing order", async t => {
  const control = fixture(t);
  let now = 1;
  let attempts = 0;
  control.transaction(() => {
    control.audit("system:test", "authority.retry", "resource:retry");
  });

  const worker = createAuthorityOutboxWorker(control, {
    now: () => now,
    maxAttempts: 3,
    deliver: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient");
    },
  });

  assert.deepEqual(await worker.flush(), ["retry"]);
  assert.equal(worker.status().pending, 1);
  now = 1_001;
  const second = await worker.flush();
  assert.equal(second[0], "delivered");
  assert.equal(worker.status().pending, 0);
  assert.equal(attempts, 2);
});

test("poison delivery blocks visibly and never drops the durable event", async t => {
  const control = fixture(t);
  const logs: string[] = [];
  control.transaction(() => {
    control.audit("system:test", "authority.poison", "resource:poison");
  });

  const worker = createAuthorityOutboxWorker(control, {
    maxAttempts: 1,
    pollMs: 5,
    deliver: async () => { throw new Error("poison"); },
    log: (message) => logs.push(message),
  });
  worker.start();
  t.after(() => worker.stop());

  await eventually(() => worker.status().blocked === 1);
  assert.equal(worker.status().pending, 1);
  assert.equal(worker.status().lastResult, "blocked");
  assert.equal(logs.filter((message) => message.includes("operator retry required")).length, 1);
});
