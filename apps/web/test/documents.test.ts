import test from "node:test";
import assert from "node:assert/strict";
import {
  fileRef,
  openDocument,
  resetDocumentsForTest,
} from "../src/resources/documents.ts";
import { registerResourceProvider } from "../src/resources/providers.ts";

const scheme = `doc-test-${process.pid}`;
const files = new Map<string, { content: string; revision: string }>([
  ["a.ts", { content: " cons t a = 1;\n", revision: "r1" }],
]);

registerResourceProvider({
  scheme,
  describe: (ref) => ({ label: ref.locator, kind: "text" }),
  read: async (ref) => {
    const got = files.get(ref.locator);
    if (!got) throw new Error("missing");
    return { ...got };
  },
  write: async (ref, content) => {
    const revision = `r${files.size + 1}`;
    files.set(ref.locator, { content, revision });
    return { revision };
  },
});

function ref(path: string) {
  return { scheme, locator: path, projectId: "p", sessionId: null };
}

test("document snapshot stays pull-based: keystrokes do not rewrite saved", async () => {
  resetDocumentsForTest();
  const handle = openDocument(ref("a.ts"));
  await handle.load();
  const saved = handle.getSnapshot().saved;
  let live = saved;
  handle.attachSource({
    getText: () => live,
    resetAuthoritative: (text) => { live = text; },
  });
  live = " cons t a = 2;\n";
  handle.markUserEdit();
  const snap = handle.getSnapshot();
  assert.equal(snap.dirty, true);
  assert.equal(snap.saved, saved);
  assert.equal(handle.getBuffer(), live);
  handle.markUserEdit();
  assert.equal(handle.getSnapshot().saved, saved);
});

test("discard restores authoritative text through the attached source", async () => {
  resetDocumentsForTest();
  const handle = openDocument(ref("a.ts"));
  await handle.load();
  const saved = handle.getSnapshot().saved;
  let live = saved;
  let resets = 0;
  handle.attachSource({
    getText: () => live,
    resetAuthoritative: (text) => { live = text; resets += 1; },
  });
  live = "edited";
  handle.markUserEdit();
  handle.discard();
  assert.equal(handle.getSnapshot().dirty, false);
  assert.equal(handle.getBuffer(), saved);
  assert.equal(live, saved);
  assert.equal(resets, 1);
});

test("fileRef identity is scheme/project/session/path", () => {
  assert.equal(fileRef("p", null, "src/a.ts").scheme, "file");
  assert.equal(fileRef("p", "s1", "src/a.ts").sessionId, "s1");
});
