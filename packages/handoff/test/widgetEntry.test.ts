// The handoff package hands its new-session provenance to the generic composer
// start-extension seam, falling back to the after-created seam on older hosts,
// so the shell never names the handoff package.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { HandoffResultImportedData } from "@polyth/contracts";
import type {
  ComposerSessionCreatedHook,
  ComposerSessionStartExtension,
  WebPackageHost,
} from "@polyth/web-sdk";
import { noteNewSessionHandoffPending, resetNewSessionHandoffPending } from "../src/newSessionProvenance.ts";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
});
register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const provenance: HandoffResultImportedData["provenance"] = {
  sourceKind: "chat-workspace",
  provider: "opencode",
  profileName: "default",
  bundleLabel: "Review",
};

const entry = (await import("../widgets/index.tsx")).default;

function fixture(opts: { startSeam?: boolean } = {}) {
  const hooks: ComposerSessionCreatedHook[] = [];
  const extensions: ComposerSessionStartExtension[] = [];
  const registrations: string[] = [];
  const composer: Record<string, unknown> = {
    registerSessionCreatedHook: (hook: ComposerSessionCreatedHook) => {
      hooks.push(hook);
      return () => { hooks.splice(hooks.indexOf(hook), 1); };
    },
  };
  if (opts.startSeam) {
    composer.registerSessionStartExtension = (extension: ComposerSessionStartExtension) => {
      extensions.push(extension);
      return () => { extensions.splice(extensions.indexOf(extension), 1); };
    };
  }
  const host = {
    reducers: { register: (eventType: string) => { registrations.push(`reducer:${eventType}`); return () => {}; } },
    slots: { register: (registration: { id: string }) => { registrations.push(`slot:${registration.id}`); return () => {}; } },
    composer,
  } as unknown as WebPackageHost;
  const dispose = entry(host)();
  return { dispose, hooks, extensions, registrations };
}

test("a host with the start seam registers one extension and no created hook", () => {
  const { dispose, extensions, hooks, registrations } = fixture({ startSeam: true });

  assert.equal(extensions.length, 1);
  assert.equal(extensions[0]!.id, "handoff.import");
  assert.equal(hooks.length, 0, "never both seams at once");
  assert.ok(registrations.includes("slot:handoff.provenance-chip"));

  resetNewSessionHandoffPending();
  noteNewSessionHandoffPending("project-1", provenance, "the prompt");
  const payload = extensions[0]!.collect({ projectId: "project-1", text: "the prompt" });
  assert.deepEqual(Object.keys(payload ?? {}).sort(), ["provenance", "textHash"]);
  assert.deepEqual((payload as { provenance: unknown }).provenance, provenance);
  assert.equal(typeof (payload as { textHash?: unknown }).textHash, "string");
  assert.equal(extensions[0]!.collect({ projectId: "project-1", text: "the prompt" }), undefined, "seconds are taken");

  dispose();
  assert.deepEqual(extensions, []);
});

test("the extension's legacy path posts the collected import against the new session", async () => {
  const { dispose, extensions } = fixture({ startSeam: true });
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
    resetNewSessionHandoffPending();
    noteNewSessionHandoffPending("project-1", provenance, "the prompt");
    const payload = extensions[0]!.collect({ projectId: "project-1", text: "the prompt" });
    await extensions[0]!.legacy!({ projectId: "project-1", sessionId: "session-1", text: "the prompt" }, payload!);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "/api/handoff/imports");
    assert.equal(calls[0]!.body.sessionId, "session-1");
    assert.deepEqual(calls[0]!.body.provenance, provenance);
    assert.equal(typeof calls[0]!.body.textHash, "string");
  } finally {
    resetNewSessionHandoffPending();
    Object.assign(globalThis, { fetch: originalFetch });
    dispose();
  }
});

test("an older host keeps the created hook and its flush, and disposes it", async () => {
  const { dispose, hooks, extensions } = fixture();
  assert.equal(extensions.length, 0);
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0]!.id, "handoff.new-session-import");

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
    resetNewSessionHandoffPending();
    noteNewSessionHandoffPending("project-1", provenance, "the prompt");
    await hooks[0]!.run({ projectId: "project-1", sessionId: "session-1", text: "the prompt" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "/api/handoff/imports");
    assert.equal(calls[0]!.body.sessionId, "session-1");
    assert.deepEqual(calls[0]!.body.provenance, provenance);
    assert.equal(typeof calls[0]!.body.textHash, "string");
    await hooks[0]!.run({ projectId: "project-1", sessionId: "session-1", text: "the prompt" });
    assert.equal(calls.length, 1, "nothing pending, nothing sent");
  } finally {
    resetNewSessionHandoffPending();
    Object.assign(globalThis, { fetch: originalFetch });
    dispose();
  }
  assert.deepEqual(hooks, []);
});
