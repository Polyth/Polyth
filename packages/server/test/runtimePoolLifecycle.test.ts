import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  acquireDataDirectoryLease,
  createRuntimeAdmissionBarrier,
  createRuntimeProtocolForwarder,
} from "../src/index.ts";
import { createOpenCodePendingService } from "../src/opencodePending.ts";
import { settleAllOrThrow } from "../src/settle.ts";

test("canonical data directory lease fails closed for a second writer", async () => {
  const parent = mkdtempSync(join(tmpdir(), "polyth-writer-lease-"));
  const dataDir = join(parent, "data");
  const first = await acquireDataDirectoryLease(dataDir);
  try {
    await assert.rejects(
      () => acquireDataDirectoryLease(dataDir),
      (error: Error & { code?: string }) =>
        error.code === "data-directory-locked"
        && /already owns data directory/.test(error.message),
    );
  } finally {
    await first.release();
  }

  const afterRelease = await acquireDataDirectoryLease(dataDir);
  await afterRelease.release();
});

test("stable runtime facade forwards protocol identity across replacements", async () => {
  let current = {
    protocol: async () => "v2" as const,
  } as never;
  const protocol = createRuntimeProtocolForwarder(() => current);

  assert.equal(await protocol(), "v2");
  current = {
    lifecycle: { protocol: async () => "legacy" as const },
  } as never;
  assert.equal(await protocol(), "legacy");

  current = {} as never;
  await assert.rejects(
    () => protocol(),
    (error: Error & { code?: string }) => error.code === "unsupported",
  );
});

test("busy runtime defers config apply and keeps the restart batch pending", async () => {
  let safe = false;
  let applied = 0;
  let restarted = 0;
  const pending = createOpenCodePendingService({
    canRestart: async () => safe
      ? { safe: true }
      : { safe: false, reason: "session session-1 is working" },
    restart: async () => {
      restarted += 1;
      return 1;
    },
  });
  pending.stage({
    id: "mcp",
    kind: "mcp",
    label: "MCP servers",
    apply: async () => {
      applied += 1;
    },
  });

  await assert.rejects(
    () => pending.applyAndRestart(),
    (error: Error & { code?: string }) => error.code === "restart-deferred",
  );
  assert.equal(applied, 0);
  assert.equal(restarted, 0);
  assert.equal(pending.list().count, 1);

  safe = true;
  assert.deepEqual(await pending.applyAndRestart(), { applied: 1, restarted: 1 });
  assert.equal(applied, 1);
  assert.equal(restarted, 1);
  assert.equal(pending.list().count, 0);
});

test("config safety check fences a racing admission through write and restart", async () => {
  const barrier = createRuntimeAdmissionBarrier();
  let releaseSafety!: () => void;
  let safetyStarted!: () => void;
  const safetyEntered = new Promise<void>((resolve) => {
    safetyStarted = resolve;
  });
  const safetyRelease = new Promise<void>((resolve) => {
    releaseSafety = resolve;
  });
  const order: string[] = [];
  const pending = createOpenCodePendingService({
    withAdmissionBarrier: (action) => barrier.run(action),
    canRestart: async () => {
      order.push("safety");
      safetyStarted();
      await safetyRelease;
      return { safe: true };
    },
    restart: async () => {
      order.push("restart");
      return 1;
    },
  });
  pending.stage({
    id: "mcp",
    kind: "mcp",
    label: "MCP servers",
    apply: async () => {
      order.push("write");
    },
  });

  const applying = pending.applyAndRestart();
  await safetyEntered;
  assert.equal(barrier.fenced(), true);
  await assert.rejects(
    () => barrier.admit(async () => {
      order.push("admission");
    }),
    (error: Error & { code?: string }) => error.code === "restart-deferred",
  );
  releaseSafety();

  assert.deepEqual(await applying, { applied: 1, restarted: 1 });
  assert.deepEqual(order, ["safety", "write", "restart"]);
  assert.equal(barrier.fenced(), false);
});

test("failed restart batch waits for every owned replacement to settle", async () => {
  let releaseSlow!: () => void;
  let slowSettled = false;
  let failureReturned = false;
  const slow = new Promise<void>((resolve) => {
    releaseSlow = () => {
      slowSettled = true;
      resolve();
    };
  });
  const failure = Object.assign(new Error("second owned restart failed"), {
    code: "restart-deferred",
  });
  const pending = createOpenCodePendingService({
    restart: async () => {
      await settleAllOrThrow([
        slow,
        Promise.reject(failure),
      ]);
      return 2;
    },
  });
  pending.stage({
    id: "mcp",
    kind: "mcp",
    label: "MCP servers",
    apply: async () => {},
  });
  const applying = pending.applyAndRestart().catch((error) => {
    failureReturned = true;
    throw error;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    failureReturned,
    false,
    "the replacement interlock must not unwind around a still-running restart",
  );
  assert.equal(pending.list().count, 1);
  releaseSlow();
  await assert.rejects(applying, (error: Error) => error === failure);
  assert.equal(slowSettled, true);
  assert.equal(failureReturned, true);
  assert.equal(pending.list().count, 1, "failed replacement proof must keep the batch pending");
});

test("unproven generation drift fails closed and keeps the captured restart batch pending", async () => {
  let generation = 1;
  let applied = false;
  let destructiveRestarts = 0;
  const pending = createOpenCodePendingService({
    captureRestartState: async () => {
      assert.equal(applied, false, "restart intent must be captured before config writes");
      return generation;
    },
    restart: async (captured) => {
      if (generation !== captured) {
        throw Object.assign(
          new Error("generation changed without loaded-config proof"),
          { code: "restart-deferred" },
        );
      }
      destructiveRestarts += 1;
      return 1;
    },
  });
  pending.stage({
    id: "provider-visibility",
    kind: "provider-visibility",
    label: "Provider visibility",
    apply: async () => {
      applied = true;
      // This models an implementation that failed to establish the lifecycle
      // replacement interlock before applying the batch.
      generation += 1;
    },
  });

  await assert.rejects(
    () => pending.applyAndRestart(),
    (error: Error & { code?: string }) => error.code === "restart-deferred",
  );
  assert.equal(generation, 2);
  assert.equal(destructiveRestarts, 0);
  assert.equal(pending.list().count, 1);
});
