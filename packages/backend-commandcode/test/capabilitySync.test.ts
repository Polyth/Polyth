import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  setCapabilityLaunchSink,
  setCapabilityReceiptSink,
} from "@polyth/harness-runtime";
import { createCommandCodeCapabilitySync } from "../src/capabilitySync.ts";
import { commandCodeOverlays } from "../src/provisioner.ts";
import type { CommandCodeRpc } from "../src/rpc.ts";

const context = (cwd: string) => ({ spaceId: "space", projectId: "project", sessionId: "session", cwd });

const fakeRpc = (requestImpl: CommandCodeRpc["request"]): CommandCodeRpc => ({
  authorityId: "authority",
  generation: 7,
  receipts: {},
  releasedAuthorities: [],
  request: requestImpl,
  async receipt() {},
  onEvent() { return { dispose() {} }; },
  onClose() { return { dispose() {} }; },
  async close() {},
});

test("capability wrapper projects transient Mod and skills on every native turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-commandcode-cap-sync-"));
  const binding = join(dir, "binding.json");
  const requests: Array<Record<string, unknown>> = [];
  const receipts: Array<{ outcome: string; capabilityIds: string[] }> = [];
  const launches: Array<{ outcome: string; desiredRevision: string }> = [];
  const disposeReceipt = setCapabilityReceiptSink((receipt) => receipts.push({ outcome: receipt.outcome, capabilityIds: receipt.capabilityIds }));
  const disposeLaunch = setCapabilityLaunchSink((event) => launches.push({ outcome: event.outcome, desiredRevision: event.desiredRevision }));
  try {
    const ctx = context(dir);
    commandCodeOverlays.set(ctx, {
      promptModFile: join(dir, "capability.ts"),
      promptCapabilityIds: ["instruction"],
      skillRoot: join(dir, "skills"),
      skillCapabilityIds: ["skill"],
    }, "commandcode", { desiredRevision: "rev-1", capabilityIds: ["instruction", "skill"] });
    const sync = createCommandCodeCapabilitySync(ctx, fakeRpc(async <T>(command: Record<string, unknown> & { type: string }) => {
      requests.push(command);
      return { nativeSessionId: "native" } as T;
    }));

    for (const operationId of ["turn-1", "turn-2"]) {
      await sync.request({ type: "start_turn", operationId, bindingPath: binding });
    }

    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.capabilityModPath, join(dir, "capability.ts"));
      assert.deepEqual(request.skillRoots, [join(dir, "skills")]);
    }
    assert.deepEqual(launches, [
      { outcome: "captured", desiredRevision: "rev-1" },
      { outcome: "captured", desiredRevision: "rev-1" },
    ]);
    assert.equal(receipts.length, 4);
    assert.ok(receipts.every((receipt) => receipt.outcome === "unverifiable"));
    assert.ok(commandCodeOverlays.peek(ctx, "commandcode"));
  } finally {
    disposeLaunch();
    disposeReceipt();
    commandCodeOverlays.release(context(dir));
    await rm(dir, { recursive: true, force: true });
  }
});

test("proven pre-admission rejection releases launch capture but keeps projection retryable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-commandcode-cap-reject-"));
  const binding = join(dir, "binding.json");
  const launches: Array<{ outcome: string; desiredRevision: string }> = [];
  const disposeLaunch = setCapabilityLaunchSink((event) => launches.push({ outcome: event.outcome, desiredRevision: event.desiredRevision }));
  try {
    const ctx = context(dir);
    commandCodeOverlays.set(ctx, {
      promptModFile: join(dir, "capability.ts"),
      promptCapabilityIds: ["instruction"],
      skillCapabilityIds: [],
    }, "commandcode", { desiredRevision: "rev-2", capabilityIds: ["instruction"] });
    await writeFile(binding, JSON.stringify({ acceptedMutations: [] }));
    const sync = createCommandCodeCapabilitySync(ctx, fakeRpc(async () => {
      throw Object.assign(new Error("workspace trust required"), { code: "runtime-rejected" });
    }));

    await assert.rejects(
      sync.request({ type: "start_turn", operationId: "turn-rejected", bindingPath: binding }),
      (error: unknown) => (error as { code?: string }).code === "runtime-rejected",
    );
    assert.deepEqual(launches, [
      { outcome: "captured", desiredRevision: "rev-2" },
      { outcome: "failed", desiredRevision: "rev-2" },
    ]);
    assert.ok(commandCodeOverlays.peek(ctx, "commandcode"));
  } finally {
    disposeLaunch();
    commandCodeOverlays.release(context(dir));
    await rm(dir, { recursive: true, force: true });
  }
});
