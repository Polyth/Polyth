// A server package (a tracker card handed to an agent) stages fetched bytes as
// an ordinary `_inbox/*` upload at the project root, the place a composer
// upload lands, so the session's attachment preparation materializes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService, MAX_RAW_BYTES } from "../src/index.ts";
import { createAttachmentSourceService, inboxFileName } from "../src/serverEntry.ts";

test("stage writes a fresh _inbox upload at the project root and materialize finds it", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "polyth-stage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = createFileService();
  const roots: string[] = [];
  const service = createAttachmentSourceService(async () => files, async (projectId) => {
    roots.push(projectId);
    return root;
  });
  const bytes = new Uint8Array([1, 2, 3]);
  const first = await service.stage!({ projectId: "p1", name: "../Screen shot (1).png", bytes });
  const second = await service.stage!({ projectId: "p1", name: "../Screen shot (1).png", bytes });
  assert.match(first.path, /^_inbox\/[0-9a-f-]{36}-_Screen_shot_1_.png$/, "no directory part survives");
  assert.notEqual(first.path, second.path, "each staging gets its own name");
  assert.equal(first.size, 3);
  assert.deepEqual([...readFileSync(join(root, first.path))], [1, 2, 3]);
  assert.deepEqual(roots, ["p1", "p1"]);
  assert.deepEqual(
    await service.materialize({ projectId: "p1", projectRoot: root, execRoot: root, rel: first.path }),
    { kind: "file", size: 3 },
  );
  await assert.rejects(
    service.stage!({ projectId: "p1", name: "big.png", bytes: new Uint8Array(MAX_RAW_BYTES + 1) }),
    { code: "invalid-input" },
  );
});

test("stage exists only when the service knows project roots", () => {
  assert.equal(createAttachmentSourceService(async () => createFileService()).stage, undefined);
  assert.equal(inboxFileName("...hidden"), "hidden");
  assert.equal(inboxFileName("знімок.png"), "_.png");
  assert.equal(inboxFileName(""), "file");
});
