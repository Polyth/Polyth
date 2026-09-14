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
import type { CommandCodeRpc, CommandCodeWorkerEvent } from "../src/rpc.ts";

const context = (cwd: string) => ({ spaceId: "space", projectId: "project", sessionId: "session", cwd });

const fakeRpc = (requestImpl: CommandCodeRpc["request"]) => {
  const events = new Set<(event: CommandCodeWorkerEvent) => void>();
  const closes = new Set<() => void>();
  const rpc: CommandCodeRpc = {
    authorityId: "authority",
    generation: 7,
    receipts: {},
    releasedAuthorities: [],
    request: requestImpl,
    async receipt() {},
    onEvent(callback) { events.add(callback); return { dispose: () => events.delete(callback) }; },
    onClose(callback) { closes.add(callback); return { dispose: () => closes.delete(callback) }; },
    async close() { for (const callback of closes) callback(); },
  };
  return {
    rpc,
    emit(event: CommandCodeWorkerEvent) { for (const callback of events) callback(event); },
  };
};

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
      toolCapabilityIds: [],
    }, "commandcode", { desiredRevision: "rev-1", capabilityIds: ["instruction", "skill"] });
    const fake = fakeRpc(async <T>(command: Record<string, unknown> & { type: string }) => {
      requests.push(command);
      return { nativeSessionId: "native" } as T;
    });
    const sync = createCommandCodeCapabilitySync(ctx, fake.rpc);

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

test("native Polyth tool evidence is bound to the exact admitted capability id and revision", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-commandcode-tool-sync-"));
  const receipts: Array<{ outcome: string; capabilityIds: string[]; stage?: string }> = [];
  const disposeReceipt = setCapabilityReceiptSink((receipt) => receipts.push({
    outcome: receipt.outcome,
    capabilityIds: receipt.capabilityIds,
    stage: receipt.evidence?.stage,
  }));
  try {
    const ctx = context(dir);
    const toolBridge = {
      url: "http://127.0.0.1:9999/internal/agent-tools",
      token: "opaque-token",
    };
    commandCodeOverlays.set(ctx, {
      promptCapabilityIds: [],
      skillCapabilityIds: [],
      toolModFile: join(dir, "tools.ts"),
      toolCapabilityIds: ["example.tool"],
      toolBridge,
    }, "commandcode", { desiredRevision: "tools-rev", capabilityIds: ["example.tool"] });
    const requests: Array<Record<string, unknown>> = [];
    const fake = fakeRpc(async <T>(command: Record<string, unknown> & { type: string }) => {
      requests.push(command);
      return { nativeSessionId: "native" } as T;
    });
    const sync = createCommandCodeCapabilitySync(ctx, fake.rpc);
    const subscription = sync.onEvent(() => undefined);

    await sync.request({ type: "start_turn", operationId: "tool-turn", bindingPath: join(dir, "binding.json") });
    assert.equal(requests[0]?.toolModPath, join(dir, "tools.ts"));
    assert.deepEqual(requests[0]?.toolBridge, toolBridge);
    assert.deepEqual(receipts[0], {
      outcome: "unverifiable",
      capabilityIds: ["example.tool"],
      stage: "staged",
    });

    fake.emit({
      type: "polyth-tool-invoked",
      operationId: "tool-turn",
      capabilityId: "example.tool",
      toolName: "spoofed-name-is-irrelevant",
    });
    assert.deepEqual(receipts[1], {
      outcome: "applied",
      capabilityIds: ["example.tool"],
      stage: "invocable",
    });
    fake.emit({ type: "polyth-tool-invoked", operationId: "tool-turn", capabilityId: "other.tool", toolName: "review_project" });
    fake.emit({ type: "polyth-tool-invoked", operationId: "different-turn", capabilityId: "example.tool", toolName: "review_project" });
    assert.equal(receipts.length, 2);
    fake.emit({ type: "turn-exit", operationId: "tool-turn", code: 0, signal: null, stderr: "" });
    fake.emit({ type: "polyth-tool-invoked", operationId: "tool-turn", capabilityId: "example.tool", toolName: "review_project" });
    assert.equal(receipts.length, 2);
    subscription.dispose();
  } finally {
    disposeReceipt();
    commandCodeOverlays.release(context(dir));
    await rm(dir, { recursive: true, force: true });
  }
});

test("native Polyth tool Mod errors fail the exact admitted tool revision", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-commandcode-tool-error-"));
  const receipts: Array<{ outcome: string; capabilityIds: string[]; reason?: string }> = [];
  const disposeReceipt = setCapabilityReceiptSink((receipt) => receipts.push({
    outcome: receipt.outcome,
    capabilityIds: receipt.capabilityIds,
    reason: receipt.reason,
  }));
  try {
    const ctx = context(dir);
    commandCodeOverlays.set(ctx, {
      promptCapabilityIds: [],
      skillCapabilityIds: [],
      toolModFile: join(dir, "polyth-tools.ts"),
      toolCapabilityIds: ["example.tool"],
      toolBridge: {
        url: "http://127.0.0.1:9999/internal/agent-tools",
        token: "opaque-token",
      },
    }, "commandcode", { desiredRevision: "collision-rev", capabilityIds: ["example.tool"] });
    const fake = fakeRpc(async <T>() => ({ nativeSessionId: "native" }) as T);
    const sync = createCommandCodeCapabilitySync(ctx, fake.rpc);
    const subscription = sync.onEvent(() => undefined);

    await sync.request({ type: "start_turn", operationId: "collision-turn", bindingPath: join(dir, "binding.json") });
    assert.equal(receipts[0]?.outcome, "unverifiable");
    fake.emit({
      type: "commandcode-record",
      operationId: "collision-turn",
      record: {
        type: "event",
        event: { type: "mod_error", modId: "mod:polyth-tools", hook: "addTool", error: "tool already exists" },
      },
    });
    assert.equal(receipts[1]?.outcome, "failed");
    assert.deepEqual(receipts[1]?.capabilityIds, ["example.tool"]);
    assert.match(receipts[1]?.reason ?? "", /tool Mod/);

    fake.emit({ type: "polyth-tool-invoked", operationId: "collision-turn", capabilityId: "example.tool", toolName: "read_file" });
    assert.equal(receipts.length, 2, "failed native Mod registration cannot later be promoted by stray tool evidence");
    subscription.dispose();
  } finally {
    disposeReceipt();
    commandCodeOverlays.release(context(dir));
    await rm(dir, { recursive: true, force: true });
  }
});

test("early native Polyth tool Mod failure is not downgraded by later admission settlement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-commandcode-tool-early-error-"));
  const receipts: Array<{ outcome: string; capabilityIds: string[] }> = [];
  const disposeReceipt = setCapabilityReceiptSink((receipt) => receipts.push({
    outcome: receipt.outcome,
    capabilityIds: receipt.capabilityIds,
  }));
  try {
    const ctx = context(dir);
    commandCodeOverlays.set(ctx, {
      promptCapabilityIds: [],
      skillCapabilityIds: [],
      toolModFile: join(dir, "polyth-tools.ts"),
      toolCapabilityIds: ["example.tool"],
      toolBridge: {
        url: "http://127.0.0.1:9999/internal/agent-tools",
        token: "opaque-token",
      },
    }, "commandcode", { desiredRevision: "early-collision-rev", capabilityIds: ["example.tool"] });

    let fake!: ReturnType<typeof fakeRpc>;
    fake = fakeRpc(async <T>() => {
      fake.emit({
        type: "commandcode-record",
        operationId: "early-collision-turn",
        record: {
          type: "event",
          event: { type: "mod_error", modId: "mod:polyth-tools", hook: "addTool", error: "tool already exists" },
        },
      });
      return { nativeSessionId: "native" } as T;
    });
    const sync = createCommandCodeCapabilitySync(ctx, fake.rpc);
    const subscription = sync.onEvent(() => undefined);

    await sync.request({
      type: "start_turn",
      operationId: "early-collision-turn",
      bindingPath: join(dir, "binding.json"),
    });
    assert.deepEqual(receipts, [{ outcome: "failed", capabilityIds: ["example.tool"] }]);
    fake.emit({ type: "polyth-tool-invoked", operationId: "early-collision-turn", capabilityId: "example.tool", toolName: "read_file" });
    assert.equal(receipts.length, 1);
    subscription.dispose();
  } finally {
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
      toolCapabilityIds: [],
    }, "commandcode", { desiredRevision: "rev-2", capabilityIds: ["instruction"] });
    await writeFile(binding, JSON.stringify({ acceptedMutations: [] }));
    const fake = fakeRpc(async () => {
      throw Object.assign(new Error("workspace trust required"), { code: "runtime-rejected" });
    });
    const sync = createCommandCodeCapabilitySync(ctx, fake.rpc);

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
