import test from "node:test";
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openControlPlane } from "@polyth/control-plane";
import type { OutboxEvent } from "@polyth/control-plane/outbox";
import {
  AUTHORITY_EVENT_CHANNEL,
  createAuthorityOutboxWorker,
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
