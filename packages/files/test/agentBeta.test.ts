import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteHost } from "@polyth/contracts";
import { createFileService } from "../src/index.ts";
import { createRemoteFileService } from "../src/remote.ts";

const withBeta = async (fn: () => Promise<void>): Promise<void> => {
  const before = process.env.POLYTH_AGENT_BETA;
  process.env.POLYTH_AGENT_BETA = "1";
  try { await fn(); }
  finally {
    if (before === undefined) delete process.env.POLYTH_AGENT_BETA;
    else process.env.POLYTH_AGENT_BETA = before;
  }
};

test("agent beta FileService keeps reads and rejects every write surface", async () => {
  const root = await mkdtemp(join(tmpdir(), "polyth-beta-files-"));
  try {
    await writeFile(join(root, "a.txt"), "hello\n");
    await withBeta(async () => {
      const files = createFileService();
      assert.equal((await files.read(root, "a.txt")).content, "hello\n");
      await assert.rejects(() => files.write(root, "a.txt", "changed"), /read-only/);
      await assert.rejects(() => files.writeBytes(root, "b.bin", new Uint8Array([1])), /read-only/);
      await assert.rejects(() => files.mkdir(root, "dir"), /read-only/);
      await assert.rejects(() => files.rename(root, "a.txt", "b.txt"), /read-only/);
      await assert.rejects(() => files.remove(root, "a.txt"), /read-only/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent beta blocks remote FileService writes before SSH execution", async () => {
  let calls = 0;
  const host = {
    exec: async () => { calls++; return { code: 0, stdout: "", stderr: "" }; },
  } as unknown as RemoteHost;
  await withBeta(async () => {
    const files = createRemoteFileService(host);
    await assert.rejects(() => files.writeBytes("/repo", "a.txt", new Uint8Array([1])), /read-only/);
    await assert.rejects(() => files.mkdir("/repo", "dir"), /read-only/);
    assert.equal(calls, 0);
  });
});
