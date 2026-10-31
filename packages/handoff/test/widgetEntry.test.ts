// The handoff package registers its new-session provenance flush through the
// generic composer "after new session created" seam, so the shell never names
// the handoff package.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { HandoffResultImportedData } from "@polyth/contracts";
import type { ComposerSessionCreatedHook, WebPackageHost } from "@polyth/web-sdk";
import { noteNewSessionHandoffPending, resetNewSessionHandoffPending } from "../src/newSessionProvenance.ts";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
});
register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const hooks: ComposerSessionCreatedHook[] = [];
const registrations: string[] = [];

const host = {
  reducers: { register: (eventType: string) => { registrations.push(`reducer:${eventType}`); return () => {}; } },
  slots: { register: (registration: { id: string }) => { registrations.push(`slot:${registration.id}`); return () => {}; } },
  composer: {
    registerSessionCreatedHook: (hook: ComposerSessionCreatedHook) => {
      hooks.push(hook);
      return () => { hooks.splice(hooks.indexOf(hook), 1); };
    },
  },
} as unknown as WebPackageHost;

const provenance: HandoffResultImportedData["provenance"] = {
  sourceKind: "chat-workspace",
  provider: "opencode",
  profileName: "default",
  bundleLabel: "Review",
};

const entry = (await import("../widgets/index.tsx")).default;
const dispose = entry(host)();

test("handoff registers its provenance flush as one composer session-created hook", () => {
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0]!.id, "handoff.new-session-import");
  assert.ok(registrations.includes("slot:handoff.provenance-chip"));
});

test("the hook posts the pending import against the created session", async () => {
  resetNewSessionHandoffPending();
  noteNewSessionHandoffPending("project-1", provenance, "the prompt");
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  Object.assign(globalThis, {
    fetch: async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  try {
    await hooks[0]!.run({ projectId: "project-1", sessionId: "session-1", text: "the prompt" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "/api/handoff/imports");
    assert.equal(calls[0]!.body.sessionId, "session-1");
    assert.deepEqual(calls[0]!.body.provenance, provenance);
    assert.equal(typeof calls[0]!.body.textHash, "string");
    // A second run has nothing pending and sends nothing.
    await hooks[0]!.run({ projectId: "project-1", sessionId: "session-1", text: "the prompt" });
    assert.equal(calls.length, 1);
  } finally {
    resetNewSessionHandoffPending();
    Object.assign(globalThis, { fetch: originalFetch });
  }
});

test("disposing the package removes the hook", () => {
  dispose();
  assert.deepEqual(hooks, []);
});
