import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { SessionProjection } from "@polyth/contracts";

test("500 summary projections publish once, retain off-page sessions and do not fetch details", async () => {
  const dom = new Window({ url: "http://localhost:3000/" });
  Object.assign(globalThis, { window: dom, document: dom.document, localStorage: dom.localStorage, location: dom.location });
  Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
  let requests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { requests++; throw new Error("unselected summaries must not request details"); };
  const store = await import("../src/store.ts");
  const { handleProjectionBatch } = await import("../src/init.ts");
  const row = (id: string): SessionProjection => ({ id, projectId: "p", title: "chat", status: "idle", createdAt: 1, updatedAt: 1, summary: true });
  store.upsertSessions([row("off-page")]);
  let publications = 0;
  const off = store.subscribeStore(() => { publications++; });
  try {
    handleProjectionBatch(Array.from({ length: 500 }, (_, i) => row(`s${i}`)));
    assert.equal(publications, 1);
    assert.equal(store.getState().sessions.length, 501);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(requests, 0);
    store.upsertSession({ ...row("s0"), summary: undefined, pinned: { position: 0 }, folderId: "old-folder", autoAccept: true, draft: "keep draft" });
    handleProjectionBatch([{ ...row("s0"), autoAccept: false, updatedAt: 2 }]);
    const updated = store.getState().sessions.find((p) => p.id === "s0")!;
    assert.equal(updated.pinned, undefined, "a complete summary clears a removed pin");
    assert.equal(updated.folderId, undefined);
    assert.equal(updated.autoAccept, false, "cached approval preferences cannot override fresh effective settings");
    assert.equal(updated.draft, "keep draft", "unsent detail fields are cached, not erased");
    assert.equal(updated.summary, true, "cached details must be revalidated on open");
  } finally { off(); globalThis.fetch = originalFetch; await dom.happyDOM.close(); }
});
