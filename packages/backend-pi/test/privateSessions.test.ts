import assert from "node:assert/strict";
import test from "node:test";
import { createPiRuntime } from "../src/runtime.ts";
import type { PiRpc, PiRpcState } from "../src/rpc.ts";

const context = { spaceId: "s", projectId: "p", cwd: "/tmp", sessionId: "canonical" };

/** Pi under `--no-session` (live `get_state`): an in-memory id, no file. */
const fakeNoSessionPi = () => {
  const calls: Array<Record<string, unknown>> = [];
  const receipts: Record<string, string> = {};
  let state: PiRpcState = { sessionId: "initial", isStreaming: false };
  const rpc: PiRpc = {
    authorityId: "pi-authority",
    generation: 1,
    receipts,
    releasedAuthorities: [],
    async request<T>(command: Record<string, unknown> & { type: string }): Promise<T> {
      calls.push(command);
      if (command.type === "new_session") {
        state = { ...state, sessionId: "memory-1" };
        return { cancelled: false } as T;
      }
      if (command.type === "get_state") return { ...state } as T;
      if (command.type === "switch_session") throw new Error("no session file to switch to");
      return undefined as T;
    },
    async receipt(operationId: string, id: string) { receipts[operationId] = id; },
    onEvent: () => ({ dispose() {} }),
    onClose: () => ({ dispose() {} }),
    close: async () => {},
  } as unknown as PiRpc;
  return { rpc, calls };
};

test("a private Pi session is identified by its in-memory id and reconciles without a file", async () => {
  const pi = fakeNoSessionPi();
  const runtime = createPiRuntime({ ...context, privateSession: true }, pi.rpc);
  const created = await runtime.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
  assert.equal(created.kind, "confirmed");
  assert.equal(created.kind === "confirmed" ? created.value.backendSessionId : undefined, "memory-1");
  assert.equal(await runtime.ensureSession({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp", backendSessionId: "memory-1" }), "memory-1");
  const snapshot = await runtime.reconcile!({ canonicalSessionId: "canonical", backendSessionId: "memory-1", authorityId: "pi-authority", generation: 1, continuity: "generation-only", location: { directory: "/tmp" } });
  assert.equal(snapshot.state.value, "idle");
});

test("a private Pi session is never switched to from another process", async () => {
  const pi = fakeNoSessionPi();
  const runtime = createPiRuntime({ ...context, privateSession: true }, pi.rpc);
  await assert.rejects(
    runtime.ensureSession({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp", backendSessionId: "memory-old" }),
    { code: "unknown-session" },
  );
  assert.equal(pi.calls.some((call) => call.type === "switch_session"), false);
});

test("an ordinary Pi session still requires a persistent session file", async () => {
  const pi = fakeNoSessionPi();
  const runtime = createPiRuntime(context, pi.rpc);
  const created = await runtime.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
  assert.equal(created.kind, "rejected");
});
