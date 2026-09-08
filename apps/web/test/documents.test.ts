import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });

import {
  anyUnflushedDirty,
  fileRef,
  installDocumentUnloadGuard,
  openDocument,
  resetDocumentsForTest,
} from "../src/resources/documents.ts";
import { registerResourceProvider } from "../src/resources/providers.ts";
import { setUiSettings } from "../src/uiPrefs.ts";

const scheme = `doc-test-${process.pid}`;
const files = new Map<string, { content: string; revision: string }>([
  ["a.ts", { content: " const a = 1;\n", revision: "r1" }],
]);

let writeImpl: (ref: { locator: string }, content: string) => Promise<{ revision: string }> = async (ref, content) => {
  const revision = `r${files.size + 1}`;
  files.set(ref.locator, { content, revision });
  return { revision };
};

registerResourceProvider({
  scheme,
  describe: (ref) => ({ label: ref.locator, kind: "text" }),
  read: async (ref) => {
    const got = files.get(ref.locator);
    if (!got) throw new Error("missing");
    return { ...got };
  },
  write: async (ref, content) => writeImpl(ref, content),
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
  handle.attachSource({ getText: () => live });
  live = " cons t a = 2;\n";
  handle.markUserEdit();
  const snap = handle.getSnapshot();
  assert.equal(snap.dirty, true);
  assert.equal(snap.saved, saved);
  assert.equal(handle.getBuffer(), live);
  handle.markUserEdit();
  assert.equal(handle.getSnapshot().saved, saved);
});

test("attachSource lease: same source re-attach is idempotent; different source rejected", async () => {
  resetDocumentsForTest();
  const handle = openDocument(ref("a.ts"));
  await handle.load();
  const sourceA = { getText: () => "a" };
  const sourceB = { getText: () => "b" };
  const releaseA = handle.attachSource(sourceA);
  assert.ok(releaseA);
  const releaseA2 = handle.attachSource(sourceA);
  assert.ok(releaseA2);
  assert.equal(handle.attachSource(sourceB), null);
  releaseA2?.();
  assert.equal(handle.getBuffer(), "a");
});

test("discard does not mutate attached source; authoritative reset is editor-bridge owned", async () => {
  resetDocumentsForTest();
  const handle = openDocument(ref("a.ts"));
  await handle.load();
  const saved = handle.getSnapshot().saved;
  let live = saved;
  handle.attachSource({ getText: () => live });
  live = "edited";
  handle.markUserEdit();
  const genBefore = handle.getSnapshot().authoritativeGeneration;
  handle.discard();
  assert.equal(handle.getSnapshot().dirty, false);
  assert.equal(handle.getSnapshot().authoritativeGeneration, genBefore + 1);
  assert.equal(live, "edited", "document layer does not push authoritative text into the source");
});

test("fileRef identity is scheme/project/session/path", () => {
  assert.equal(fileRef("p", null, "src/a.ts").scheme, "file");
  assert.equal(fileRef("p", "s1", "src/a.ts").sessionId, "s1");
});

test("reportUserEdit toggles dirty without extra notify when already dirty", async () => {
  resetDocumentsForTest();
  const handle = openDocument(ref("a.ts"));
  await handle.load();
  let notifies = 0;
  handle.subscribe(() => { notifies += 1; });
  handle.reportUserEdit(false);
  assert.equal(handle.getSnapshot().dirty, true);
  const afterDirty = notifies;
  handle.reportUserEdit(false);
  assert.equal(notifies, afterDirty, "second dirty edit does not notify again");
  handle.reportUserEdit(true);
  assert.equal(handle.getSnapshot().dirty, false);
});

test("save failure keeps dirty state", async () => {
  resetDocumentsForTest();
  writeImpl = async () => { throw new Error("disk full"); };
  const handle = openDocument(ref("a.ts"));
  await handle.load();
  handle.attachSource({ getText: () => "edited" });
  handle.markUserEdit();
  await handle.save();
  assert.equal(handle.getSnapshot().dirty, true);
  assert.match(handle.getSnapshot().error, /disk full/);
  writeImpl = async (r, content) => {
    const revision = `r${files.size + 1}`;
    files.set(r.locator, { content, revision });
    return { revision };
  };
});

test("409 conflict preserves buffer and marks live conflict", async () => {
  resetDocumentsForTest();
  writeImpl = async () => {
    const err = new Error("conflict") as Error & { status: number };
    err.status = 409;
    throw err;
  };
  const handle = openDocument(ref("a.ts"));
  await handle.load();
  const live = "my edit";
  handle.attachSource({ getText: () => live });
  handle.markUserEdit();
  await handle.save();
  assert.equal(handle.getBuffer(), live);
  assert.equal(handle.getSnapshot().dirty, true);
  assert.equal(handle.getSnapshot().live?.kind, "conflict");
  writeImpl = async (r, content) => {
    const revision = `r${files.size + 1}`;
    files.set(r.locator, { content, revision });
    return { revision };
  };
});

test("edit during save keeps later buffer dirty after save resolves", async () => {
  resetDocumentsForTest();
  let release!: () => void;
  writeImpl = async (r, content) => {
    await new Promise<void>((resolve) => { release = resolve; });
    const revision = `r${files.size + 1}`;
    files.set(r.locator, { content, revision });
    return { revision };
  };
  const handle = openDocument(ref("a.ts"));
  await handle.load();
  let live = "first";
  handle.attachSource({ getText: () => live });
  handle.markUserEdit();
  const saving = handle.save();
  live = "second";
  handle.markUserEdit();
  release();
  await saving;
  assert.equal(handle.getBuffer(), "second");
  assert.equal(handle.getSnapshot().dirty, true);
  assert.equal(handle.getSnapshot().saved, "first");
  writeImpl = async (r, content) => {
    const revision = `r${files.size + 1}`;
    files.set(r.locator, { content, revision });
    return { revision };
  };
});

test("beforeunload guard blocks only unflushed dirty with autosave off", async () => {
  resetDocumentsForTest();
  setUiSettings({ editorAutosave: false });
  installDocumentUnloadGuard();
  const handle = openDocument(ref("a.ts"));
  await handle.load();
  handle.attachSource({ getText: () => "edited" });
  handle.reportUserEdit(false);
  assert.equal(anyUnflushedDirty(), true);
  const BlockedEvt = (dom as unknown as { Event: typeof Event }).Event;
  const blocked = new BlockedEvt("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
  window.dispatchEvent(blocked);
  assert.equal(blocked.defaultPrevented, true);
  handle.reportUserEdit(true);
  assert.equal(anyUnflushedDirty(), false);
  const allowed = new BlockedEvt("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
  window.dispatchEvent(allowed);
  assert.equal(allowed.defaultPrevented, false);
});

function restoreWriteImpl(): void {
  writeImpl = async (r, content) => {
    const revision = `r${files.size + 1}`;
    files.set(r.locator, { content, revision });
    return { revision };
  };
}

test("saveInFlight serializes writes after undo-to-baseline during a held save", async () => {
  resetDocumentsForTest();
  setUiSettings({ editorAutosave: true });
  files.set("serial.ts", { content: "O", revision: "r1" });
  const payloads: string[] = [];
  let releaseFirst!: () => void;
  writeImpl = async (r, content) => {
    payloads.push(content);
    if (payloads.length === 1) {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
    }
    const revision = `r${payloads.length + 1}`;
    files.set(r.locator, { content, revision });
    return { revision };
  };
  const handle = openDocument(ref("serial.ts"));
  try {
    await handle.load();
    let live = "O";
    handle.attachSource({ getText: () => live });
    live = "A";
    handle.reportUserEdit(false);
    const saving = handle.save();
    assert.equal(payloads.length, 1);
    live = "O";
    handle.reportUserEdit(true);
    assert.equal(handle.getBuffer(), "O");
    assert.equal(payloads.length, 1);
    live = "C";
    handle.reportUserEdit(false);
    await new Promise((resolve) => setTimeout(resolve, 1600));
    assert.equal(payloads.length, 1, "autosave must not start a second provider write");
    assert.equal(handle.getBuffer(), "C");
    assert.equal(handle.getSnapshot().dirty, true);
    releaseFirst();
    await saving;
    assert.equal(handle.getSnapshot().saved, "A");
    assert.equal(handle.getBuffer(), "C");
    assert.equal(handle.getSnapshot().dirty, true);
    await handle.save();
    assert.equal(payloads.length, 2);
    assert.equal(payloads[1], "C");
    assert.equal(handle.getSnapshot().saved, "C");
    assert.equal(handle.getSnapshot().dirty, false);
  } finally {
    restoreWriteImpl();
    resetDocumentsForTest();
  }
});

test("explicit save during an in-flight write does not start a second provider.write", async () => {
  resetDocumentsForTest();
  files.set("manual.ts", { content: "O", revision: "r1" });
  const payloads: string[] = [];
  let releaseFirst!: () => void;
  writeImpl = async (r, content) => {
    payloads.push(content);
    if (payloads.length === 1) {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
    }
    const revision = `r${payloads.length + 1}`;
    files.set(r.locator, { content, revision });
    return { revision };
  };
  const handle = openDocument(ref("manual.ts"));
  try {
    await handle.load();
    let live = "O";
    handle.attachSource({ getText: () => live });
    live = "A";
    handle.reportUserEdit(false);
    const saving = handle.save();
    live = "C";
    handle.reportUserEdit(false);
    await handle.save();
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0], "A");
    releaseFirst();
    await saving;
    assert.equal(handle.getSnapshot().saved, "A");
    assert.equal(handle.getBuffer(), "C");
    assert.equal(handle.getSnapshot().dirty, true);
  } finally {
    restoreWriteImpl();
    resetDocumentsForTest();
  }
});
