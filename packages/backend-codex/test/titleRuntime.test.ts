import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRuntime, CanonicalTurnRequest } from "@polyth/contracts";
import type { RpcPeer } from "@polyth/harness-runtime";
import { withCodexTitleGeneration } from "../src/title.ts";

function fixture() {
  const calls: Array<{ method: string; params: any }> = [];
  const notifications = new Set<(method: string, params: any) => void>();
  const runtimeEvents = new Set<(sessionId: string, event: any) => void>();

  const rpc = {
    authorityId: "authority-a",
    generation: 1,
    releasedAuthorities: [],
    receipts: {},
    async request<T>(method: string, params: any): Promise<T> {
      calls.push({ method, params });
      if (method === "config/read") return { config: { additional: { mcp_servers: {} } } } as T;
      if (method === "thread/start") return { thread: { id: "metadata-thread" } } as T;
      if (method === "turn/start") {
        queueMicrotask(() => {
          for (const listener of notifications) listener("item/completed", {
            threadId: "metadata-thread",
            turnId: "metadata-turn",
            item: { type: "agentMessage", text: '{"title":"Fix mobile composer"}' },
          });
          for (const listener of notifications) listener("turn/completed", {
            threadId: "metadata-thread",
            turn: { id: "metadata-turn", status: "completed" },
          });
        });
        return { turn: { id: "metadata-turn" } } as T;
      }
      return {} as T;
    },
    notify() {},
    async receipt() {},
    onNotification(listener: (method: string, params: any) => void) { notifications.add(listener); },
    onRequest() {},
    onClose() {},
    async close() {},
  } as unknown as RpcPeer;

  const runtime = {
    harnessId: "codex",
    async capabilities() { return { title: "emulated" }; },
    async models() {
      return [{ providerID: "openai", modelID: "gpt-5.6-luna", name: "GPT-5.6 Luna", connected: true }];
    },
    async agents() { return []; },
    async createSessionOperation() {
      return { kind: "confirmed" as const, value: { backendSessionId: "primary-thread" }, receipt: "primary-thread" };
    },
    async startTurnOperation() { return { kind: "confirmed" as const, value: { admissionId: "primary-turn" } }; },
    async startTurn() {},
    async ensureSession() { return "primary-thread"; },
    async sessions() { return []; },
    onEvent(listener: (sessionId: string, event: any) => void) {
      runtimeEvents.add(listener);
      return { dispose: () => runtimeEvents.delete(listener) };
    },
    async stop() {},
    async dispose() {},
  } as unknown as AgentRuntime;

  return {
    calls,
    wrapped: withCodexTitleGeneration(
      { spaceId: "space-a", projectId: "project-a", cwd: "/project/a", sessionId: "session-a" },
      rpc,
      runtime,
    ),
  };
}

const turn = { text: "Please fix the mobile composer layout and queue behavior" } as CanonicalTurnRequest;

async function flushMetadataTurn() {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("placeholder Codex session gets a semantic native thread name", async () => {
  const { wrapped, calls } = fixture();
  await wrapped.createSessionOperation!({ title: "New session" } as any, "create-a");
  await wrapped.startTurnOperation!(turn, "turn-a");
  await flushMetadataTurn();

  const metadataStart = calls.find((call) => call.method === "thread/start");
  assert.equal(metadataStart?.params.ephemeral, true);
  assert.equal(metadataStart?.params.sandbox, "read-only");
  assert.equal(metadataStart?.params.model, "gpt-5.6-luna");

  const nameSet = calls.find((call) => call.method === "thread/name/set");
  assert.deepEqual(nameSet?.params, { threadId: "primary-thread", name: "Fix mobile composer" });
});

test("explicit Codex session title does not spend a metadata turn", async () => {
  const { wrapped, calls } = fixture();
  await wrapped.createSessionOperation!({ title: "Review auth flow" } as any, "create-a");
  await wrapped.startTurnOperation!(turn, "turn-a");
  await flushMetadataTurn();

  assert.equal(calls.some((call) => call.method === "thread/start"), false);
  assert.equal(calls.some((call) => call.method === "thread/name/set"), false);
});
