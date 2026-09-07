import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "@polyth/session";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "polyth-store-close-"));
}

function isClosedStoreError(err: unknown): boolean {
  const error = err as { code?: string; message?: string };
  return error.code === "unavailable" && /session store is closed/.test(error.message ?? "");
}

test("reads after close fail closed without touching sqlite", async () => {
  const dir = freshDir();
  const path = join(dir, "t.db");
  const store = createStore(path);
  try {
    await store.append("s1", "user/message", { text: "hi" });
    await store.close();
    await assert.rejects(async () => { await store.events("s1"); }, isClosedStoreError);
    await assert.rejects(async () => { await store.projections(); }, isClosedStoreError);
    await assert.rejects(async () => { await store.append("s1", "user/message", { text: "late" }); }, isClosedStoreError);
    await store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("in-flight service operation cannot touch sqlite after close", async () => {
  const dir = freshDir();
  const path = join(dir, "t.db");
  const store = createStore(path);
  try {
    await store.append("s1", "user/message", { text: "hi" });

    let release!: () => void;
    const hang = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    let backingTouched = false;

    // Service operation starts, hangs inside itself, then would read backing.
    const op = (async () => {
      entered = true;
      await hang;
      const rows = await store.events("s1");
      backingTouched = true;
      return rows;
    })();

    await Promise.resolve();
    assert.equal(entered, true, "operation must start before teardown");

    await store.close();
    release();

    await assert.rejects(op, isClosedStoreError);
    assert.equal(backingTouched, false);

    const reopened = createStore(path);
    try {
      const rows = await reopened.events("s1");
      assert.equal(rows.length, 1);
      assert.equal((rows[0]!.data as { text?: string }).text, "hi");
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
