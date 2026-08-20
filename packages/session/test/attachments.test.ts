// F2: attachments survive the durable queue and model-history derivation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AttachmentRef, SessionEvent } from "@polyth/contracts";
import { createStore, deriveMessages } from "../src/index.ts";

const tmpStore = () => createStore(join(mkdtempSync(join(tmpdir(), "polyth-att-")), "s.db"));

const refs: AttachmentRef[] = [
  { id: "a1", name: "notes.md", mime: "text/plain", size: 12, kind: "file", path: "docs/notes.md", url: "/api/files/raw?projectId=p1&path=docs%2Fnotes.md" },
  { id: "a2", name: "pic.png", mime: "image/png", size: 512, kind: "image", path: "img/pic.png" },
  { id: "a3", name: "index.ts (10-20)", mime: "text/plain", size: 40, kind: "range", path: "src/index.ts", range: [10, 20] },
  { id: "a4", name: "PR #7", mime: "text/uri-list", size: 0, kind: "url", url: "https://github.com/o/r/pull/7" },
];

test("queue round-trip preserves attachments; text-only rows stay clean", async () => {
  const store = tmpStore();
  const withAtt = await store.enqueue("s1", "look at these", "queue", refs);
  await store.enqueue("s1", "plain", "queue");

  assert.deepEqual(withAtt.attachments, refs);
  const listed = await store.queueList("s1");
  assert.equal(listed.length, 2);
  assert.deepEqual(listed[0]?.attachments, refs);
  assert.equal(listed[1]?.attachments, undefined);

  const head = await store.queueShift("s1");
  assert.deepEqual(head?.attachments, refs);
  const next = await store.queueShift("s1");
  assert.equal(next?.attachments, undefined);
  await store.close();
});

test("deriveMessages emits file parts on the user message", () => {
  const ev = (seq: number, type: string, data: object): SessionEvent => ({
    id: `e${seq}`, sessionId: "s1", seq, time: seq, type, data: data as SessionEvent["data"], v: 1,
  });
  const msgs = deriveMessages([
    ev(1, "user/message", { text: "review these", attachments: refs }),
    ev(2, "assistant/message", { partId: "p1", text: "ok" }),
  ]);
  assert.equal(msgs.length, 2);
  const user = msgs[0]!;
  assert.equal(user.role, "user");
  assert.deepEqual(user.parts[0], { type: "text", text: "review these" });
  const files = user.parts.filter((p) => p.type === "file");
  assert.equal(files.length, 4);
  assert.deepEqual(files[2], {
    type: "file", name: "index.ts (10-20)", mime: "text/plain", path: "src/index.ts", range: [10, 20],
  });
  assert.deepEqual(files[3], {
    type: "file", name: "PR #7", mime: "text/uri-list", url: "https://github.com/o/r/pull/7",
  });
});

test("malformed attachment rows are skipped, never thrown", () => {
  const ev: SessionEvent = {
    id: "e1", sessionId: "s1", seq: 1, time: 1, type: "user/message",
    data: { text: "hi", attachments: [{ nope: true }, "junk", { name: "ok.txt", mime: "text/plain" }] } as unknown as SessionEvent["data"],
    v: 1,
  };
  const msgs = deriveMessages([ev]);
  const files = msgs[0]!.parts.filter((p) => p.type === "file");
  assert.equal(files.length, 1);
  assert.equal((files[0] as { name: string }).name, "ok.txt");
});

test("attachments survive fork copy (copyTo) and re-derivation", async () => {
  const store = tmpStore();
  await store.append("src", "user/message", { text: "with file", attachments: refs as unknown as Array<Record<string, never>> });
  await store.append("src", "assistant/message", { partId: "p1", text: "done" });
  await store.copyTo("src", "dst");
  const msgs = deriveMessages(await store.events("dst"));
  const files = msgs[0]!.parts.filter((p) => p.type === "file");
  assert.equal(files.length, 4);
  assert.equal((files[0] as { path?: string }).path, "docs/notes.md");
  await store.close();
});
