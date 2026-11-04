import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeEndpoint } from "@polyth/contracts";
import {
  attachRuntimeLifecycle,
  createOpenCodeRuntimeFacade,
} from "../src/index.ts";
import type { RuntimeLifecycle } from "../src/runtime.ts";

const endpoint: RuntimeEndpoint = {
  authorityId: "stream-recovery-test",
  generation: 1,
  continuity: "verified",
  url: "http://fake.invalid",
  location: { directory: "/tmp" },
  control: { kind: "owned", instanceToken: "stream-recovery-test" },
  config: { kind: "read-only" },
  authentication: { kind: "none" },
};

const streamRejected = (): Error =>
  Object.assign(new Error("OpenCode event stream rejected (500)"), {
    code: "invalid-response",
    component: "harness-transport",
  });

const waitUntil = async (pred: () => boolean, ms = 4_000): Promise<void> => {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > ms) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

interface StreamRecoveryHarness {
  lifecycle: RuntimeLifecycle;
  attempts: () => number;
  restarts: () => number;
  logs: string[];
}

/** An owned runtime whose health keeps answering while `/event` rejects the
 *  first `failAttempts` connections — the state that used to reconnect forever. */
const createHarness = (options: {
  failAttempts: number;
}): StreamRecoveryHarness => {
  let attempts = 0;
  let restarts = 0;
  const logs: string[] = [];
  const lifecycle = {
    control: { kind: "owned" as const, instanceToken: "stream-recovery-test" },
    endpoint: async () => endpoint,
    protocol: async () => "legacy" as const,
    refresh: async () => endpoint,
    restart: async () => {
      restarts += 1;
      return endpoint;
    },
    withConfigRestart: async <T,>(
      action: (restart: () => Promise<RuntimeEndpoint>) => Promise<T>,
    ) => await action(async () => endpoint),
    streamEvents: async ({ signal }: { signal: AbortSignal }) => {
      attempts += 1;
      if (attempts <= options.failAttempts) throw streamRejected();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  } as unknown as RuntimeLifecycle;
  return { lifecycle, attempts: () => attempts, restarts: () => restarts, logs };
};

test("a persistently rejected event stream replaces the owned runtime instead of reconnecting forever", async () => {
  const harness = createHarness({ failAttempts: 2 });
  const facade = createOpenCodeRuntimeFacade({
    cwd: "/tmp",
    lifecycle: harness.lifecycle,
    streamRestartAfterFailures: 2,
    streamRestartCooldownMs: 60_000,
    log: (level, message) => harness.logs.push(`${level}:${message}`),
  });
  const runtime = attachRuntimeLifecycle(facade, harness.lifecycle);
  try {
    await waitUntil(() => harness.restarts() === 1);
    assert.ok(
      harness.logs.some((line) => line.includes("replacing the owned runtime")),
      "the replacement is reported, not silently swallowed",
    );
    // The replacement generation serves normally: no further restart.
    await waitUntil(() => harness.attempts() >= 3);
    assert.equal(harness.restarts(), 1, "a serving replacement is not replaced again");
  } finally {
    await runtime.dispose();
  }
});

test("the replacement cooldown keeps a runtime that stays broken from restarting again", async () => {
  const harness = createHarness({ failAttempts: 1_000 });
  const facade = createOpenCodeRuntimeFacade({
    cwd: "/tmp",
    lifecycle: harness.lifecycle,
    streamRestartAfterFailures: 1,
    streamRestartCooldownMs: 60_000,
  });
  const runtime = attachRuntimeLifecycle(facade, harness.lifecycle);
  try {
    await waitUntil(() => harness.restarts() === 1);
    await waitUntil(() => harness.attempts() >= 4, 10_000);
    assert.equal(harness.restarts(), 1, "later failures inside the cooldown do not restart again");
  } finally {
    await runtime.dispose();
  }
});
