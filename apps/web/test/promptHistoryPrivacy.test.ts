// The palette lists the signed-in person's own prompts only, also inside a
// shared chat and in a Space-wide read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@polyth/session";

test("another person's prompts never come back, per chat or Space-wide", async () => {
  const store = createStore(join(mkdtempSync(join(tmpdir(), "polyth-ph-priv-")), "s.db"));
  try {
    await store.upsertProjection({ id: "shared", projectId: "p", spaceId: "sp", title: "shared", status: "idle", createdAt: 1, updatedAt: 1 });
    await store.append("shared", "user/message", { text: "Ann private idea", author: { userId: "usr_ann" } });
    await store.append("shared", "user/message", { text: "Bea question", author: { userId: "usr_bea" } });
    const texts = async (personId: string, sessionId?: string) =>
      (await store.listPromptHistory({ spaceId: "sp", limit: 20, personId, ...(sessionId ? { sessionId } : {}) }))
        .map((e) => e.text);
    assert.deepEqual(await texts("usr_ann", "shared"), ["Ann private idea"]);
    assert.deepEqual(await texts("usr_bea", "shared"), ["Bea question"]);
    assert.deepEqual(await texts("usr_ann"), ["Ann private idea"]);
    assert.deepEqual(await texts("usr_cy", "shared"), []);
  } finally { await store.close(); }
});
