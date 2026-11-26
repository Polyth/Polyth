// The palette lists the signed-in person's own prompts only, also inside a
// shared chat and in a Space-wide read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@polyth/session";

import { after } from "node:test";
import { rmSync } from "node:fs";

const tempDirs: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(prefix);
  tempDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("another person's prompts never come back, per chat or Space-wide", async () => {
  const store = createStore(join(tempDir(join(tmpdir(), "polyth-ph-priv-")), "s.db"));
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
