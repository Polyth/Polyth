import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acknowledgeDraftRevision, adoptServerDraft, loadScopedDraftRecord,
  recordLocalDraftEdit, trackOutboundDraftWrite,
} from "../src/draftRecord.ts";
import { setClientReliabilityContext, setClientReliabilityProject, clientPersistenceScope } from "../src/reliabilityContext.ts";
import { setActiveBrowserAccount } from "../src/accountStorage.ts";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

function withDraftStorage(run: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new MemoryStorage() });
  try {
    setClientReliabilityContext({ connectionScope: "draft-reconciliation", spaceId: "default" });
    setClientReliabilityProject("p");
    setActiveBrowserAccount("usr_draft-reconciliation");
    run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

test("an in-flight own projection does not conflict with a newer local edit", () => withDraftStorage(() => {
  adoptServerDraft("s", "", 4);
  const sent = recordLocalDraftEdit("s", "first");
  const settle = trackOutboundDraftWrite("s", "first", clientPersistenceScope({ sessionId: "s" }));
  recordLocalDraftEdit("s", "first and more");

  const echoed = adoptServerDraft("s", "first", 5);
  assert.equal(echoed.text, "first and more");
  assert.equal(echoed.dirty, true);
  assert.equal(echoed.serverUpdatedAt, 5);
  assert.equal(echoed.conflict, undefined);

  settle(true);
  acknowledgeDraftRevision("s", sent.revision, 5);
  assert.equal(loadScopedDraftRecord("s").dirty, true);
  const remote = adoptServerDraft("s", "other client", 6);
  assert.equal(remote.text, "first and more");
  assert.deepEqual(remote.conflict, { text: "other client", serverUpdatedAt: 6 });
}));

test("an uncertain own write remains recognizable when its projection arrives late", () => withDraftStorage(() => {
  adoptServerDraft("s", "", 10);
  recordLocalDraftEdit("s", "sent before disconnect");
  const settle = trackOutboundDraftWrite("s", "sent before disconnect", clientPersistenceScope({ sessionId: "s" }));
  recordLocalDraftEdit("s", "continued locally");
  settle(false);

  const echoed = adoptServerDraft("s", "sent before disconnect", 11);
  assert.equal(echoed.text, "continued locally");
  assert.equal(echoed.conflict, undefined);
  assert.equal(echoed.serverUpdatedAt, 11);
}));
