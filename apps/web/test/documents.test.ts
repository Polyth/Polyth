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
  deleteDocument,
  documentSessionCount,
  fileRef,
  installDocumentUnloadGuard,
  isDocumentDirty,
  openDocument,
  peekDocument,
  registerDocumentEditorBridge,
  removeDocument,
  renameDocument,
  resetDocumentsForTest,
} from "../src/resources/documents.ts";
import type { ResourceStat } from "@polyth/web-sdk";
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

let readImpl: (ref: { locator: string }) => Promise<{ content: string; revision: string }> = async (ref) => {
  const got = files.get(ref.locator);
  if (!got) throw new Error("missing");
  return { ...got };
};

let statImpl: ((ref: { locator: string }) => Promise<ResourceStat>) | null = null;

registerResourceProvider({
  scheme,
  describe: (ref) => ({ label: ref.locator, kind: "text" }),
  read: async (ref) => readImpl(ref),
  write: async (ref, content) => writeImpl(ref, content),
  rename: async (ref, to) => {
    const got = files.get(ref.locator);
    if (!got) throw new Error("missing");
    files.delete(ref.locator);
    files.set(to, { ...got });
    return { ...ref, locator: to };
  },
  remove: async (ref) => {
    if (!files.has(ref.locator)) throw new Error("missing");
    files.delete(ref.locator);
  },
  stat: async (ref) => {
    if (statImpl) return statImpl(ref);
    const got = files.get(ref.locator);
    return got ? { kind: "present" as const, revision: got.revision } : { kind: "missing" as const };
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

function holdFirstWrite(payloads: string[]): { release: () => void } {
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
  return { release: () => releaseFirst() };
}

test("rename waits for in-flight save; later dirty buffer survives on the new path", async () => {
  resetDocumentsForTest();
  setUiSettings({ editorAutosave: true });
  files.set("old.ts", { content: "O", revision: "r1" });
  const payloads: string[] = [];
  const held = holdFirstWrite(payloads);
  const handle = openDocument(ref("old.ts"));
  try {
    await handle.load();
    let live = "O";
    handle.attachSource({ getText: () => live });
    live = "A";
    handle.reportUserEdit(false);
    const saving = handle.save();
    live = "B";
    handle.reportUserEdit(false);
    let renamed = false;
    const renaming = renameDocument(ref("old.ts"), "new.ts").then(() => { renamed = true; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(renamed, false, "rename must not run while save is held");
    assert.equal(files.has("old.ts"), true);
    assert.equal(files.has("new.ts"), false);
    held.release();
    await saving;
    await renaming;
    assert.equal(files.has("old.ts"), false);
    assert.equal(files.get("new.ts")?.content, "A");
    assert.equal(handle.ref.locator, "new.ts");
    assert.equal(handle.getBuffer(), "B");
    assert.equal(handle.getSnapshot().dirty, true);
    assert.equal(peekDocument(ref("old.ts")), null);
    assert.ok(peekDocument(ref("new.ts")));
    await handle.save();
    assert.equal(files.get("new.ts")?.content, "B");
    assert.equal(files.has("old.ts"), false);
    assert.equal(handle.getSnapshot().dirty, false);
  } finally {
    restoreWriteImpl();
    resetDocumentsForTest();
  }
});

test("delete waits for in-flight save and does not resurrect the file", async () => {
  resetDocumentsForTest();
  setUiSettings({ editorAutosave: true });
  files.set("file.ts", { content: "O", revision: "r1" });
  const payloads: string[] = [];
  const held = holdFirstWrite(payloads);
  const handle = openDocument(ref("file.ts"));
  try {
    await handle.load();
    let live = "O";
    handle.attachSource({ getText: () => live });
    live = "A";
    handle.reportUserEdit(false);
    const saving = handle.save();
    let removed = false;
    const deleting = removeDocument(ref("file.ts")).then(() => { removed = true; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(removed, false);
    assert.equal(files.has("file.ts"), true);
    held.release();
    await saving;
    await deleting;
    assert.equal(files.has("file.ts"), false);
    assert.equal(peekDocument(ref("file.ts")), null);
    assert.equal(documentSessionCount(), 0);
    await new Promise((resolve) => setTimeout(resolve, 1600));
    assert.equal(files.has("file.ts"), false);
    assert.equal(payloads.length, 1);
  } finally {
    restoreWriteImpl();
    resetDocumentsForTest();
  }
});

test("reload waits for in-flight save then resets to the saved payload", async () => {
  resetDocumentsForTest();
  files.set("rel.ts", { content: "O", revision: "r1" });
  const payloads: string[] = [];
  const held = holdFirstWrite(payloads);
  const handle = openDocument(ref("rel.ts"));
  try {
    await handle.load();
    let live = "O";
    handle.attachSource({ getText: () => live });
    live = "A";
    handle.reportUserEdit(false);
    const saving = handle.save();
    live = "B";
    handle.reportUserEdit(false);
    let reloaded = false;
    const reloading = handle.reload().then(() => { reloaded = true; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(reloaded, false);
    assert.equal(handle.getBuffer(), "B");
    held.release();
    await saving;
    await reloading;
    assert.equal(handle.getSnapshot().saved, "A");
    assert.equal(handle.getSnapshot().dirty, false);
    assert.equal(files.get("rel.ts")?.content, "A");
  } finally {
    restoreWriteImpl();
    resetDocumentsForTest();
  }
});

test("discard waits for in-flight save then drops later edits against the new baseline", async () => {
  resetDocumentsForTest();
  files.set("dis.ts", { content: "O", revision: "r1" });
  const payloads: string[] = [];
  const held = holdFirstWrite(payloads);
  const handle = openDocument(ref("dis.ts"));
  try {
    await handle.load();
    let live = "O";
    handle.attachSource({ getText: () => live });
    live = "A";
    handle.reportUserEdit(false);
    const saving = handle.save();
    live = "B";
    handle.reportUserEdit(false);
    const discarding = handle.discard();
    assert.equal(discarding instanceof Promise, true);
    held.release();
    await saving;
    await discarding;
    assert.equal(files.get("dis.ts")?.content, "A");
    assert.equal(handle.getSnapshot().saved, "A");
    assert.equal(handle.getSnapshot().dirty, false);
  } finally {
    restoreWriteImpl();
    resetDocumentsForTest();
  }
});

test("failed save then rename still moves the existing file without pretending text was saved", async () => {
  resetDocumentsForTest();
  files.set("fail.ts", { content: "O", revision: "r1" });
  writeImpl = async () => {
    throw new Error("disk full");
  };
  const handle = openDocument(ref("fail.ts"));
  try {
    await handle.load();
    let live = "O";
    handle.attachSource({ getText: () => live });
    live = "A";
    handle.reportUserEdit(false);
    await handle.save();
    assert.equal(handle.getSnapshot().dirty, true);
    assert.equal(handle.getSnapshot().error, "disk full");
    assert.equal(files.get("fail.ts")?.content, "O");
    await renameDocument(ref("fail.ts"), "renamed.ts");
    assert.equal(files.has("fail.ts"), false);
    assert.equal(files.get("renamed.ts")?.content, "O");
    assert.equal(handle.ref.locator, "renamed.ts");
    assert.equal(handle.getBuffer(), "A");
    assert.equal(handle.getSnapshot().dirty, true);
  } finally {
    restoreWriteImpl();
    resetDocumentsForTest();
  }
});

test("isDocumentDirty includes an unresolved persistence operation", async () => {
  resetDocumentsForTest();
  files.set("guard.ts", { content: "O", revision: "r1" });
  const payloads: string[] = [];
  const held = holdFirstWrite(payloads);
  const handle = openDocument(ref("guard.ts"));
  try {
    await handle.load();
    let live = "O";
    handle.attachSource({ getText: () => live });
    live = "A";
    handle.reportUserEdit(false);
    const saving = handle.save();
    live = "O";
    handle.reportUserEdit(true);
    assert.equal(handle.getSnapshot().dirty, false);
    assert.equal(isDocumentDirty(ref("guard.ts")), true);
    held.release();
    await saving;
    assert.equal(handle.getSnapshot().saved, "A");
    assert.equal(handle.getBuffer(), "O");
    assert.equal(handle.getSnapshot().dirty, true);
    assert.equal(isDocumentDirty(ref("guard.ts")), true);
  } finally {
    restoreWriteImpl();
    resetDocumentsForTest();
  }
});

test("deleteDocument waits for in-flight save before dropping the session", async () => {
  resetDocumentsForTest();
  files.set("close.ts", { content: "O", revision: "r1" });
  const payloads: string[] = [];
  const held = holdFirstWrite(payloads);
  const handle = openDocument(ref("close.ts"));
  try {
    await handle.load();
    let live = "O";
    handle.attachSource({ getText: () => live });
    live = "A";
    handle.reportUserEdit(false);
    const saving = handle.save();
    let dropped = false;
    const dropping = Promise.resolve(deleteDocument(ref("close.ts"))).then(() => { dropped = true; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(dropped, false);
    assert.equal(documentSessionCount(), 1);
    held.release();
    await saving;
    await dropping;
    assert.equal(documentSessionCount(), 0);
    assert.equal(files.get("close.ts")?.content, "A");
  } finally {
    restoreWriteImpl();
    resetDocumentsForTest();
  }
});

function restoreReadImpl(): void {
  readImpl = async (ref) => {
    const got = files.get(ref.locator);
    if (!got) throw new Error("missing");
    return { ...got };
  };
}

function restoreStatImpl(): void {
  statImpl = null;
}

function holdFirstRead(): { started: Promise<void>; release: (result: { content: string; revision: string }) => void } {
  let release!: (result: { content: string; revision: string }) => void;
  let startedResolve!: () => void;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  let first = true;
  readImpl = async (ref) => {
    if (first) {
      first = false;
      startedResolve();
      return await new Promise<{ content: string; revision: string }>((resolve) => { release = resolve; });
    }
    const got = files.get(ref.locator);
    if (!got) throw new Error("missing");
    return { ...got };
  };
  return { started, release: (result) => release(result) };
}

function holdNthStat(
  n: number,
  result: { kind: "present"; revision?: string } | { kind: "missing" },
): { started: Promise<void>; release: () => void } {
  let release!: () => void;
  let startedResolve!: () => void;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  let calls = 0;
  const prev = statImpl;
  statImpl = async (ref) => {
    calls++;
    if (calls === n) {
      startedResolve();
      await new Promise<void>((resolve) => { release = resolve; });
      return result;
    }
    if (prev) return prev(ref);
    const got = files.get(ref.locator);
    return got ? { kind: "present" as const, revision: got.revision } : { kind: "missing" as const };
  };
  return { started, release: () => release() };
}

test("stale load after close/reopen does not publish into the new session", async () => {
  resetDocumentsForTest();
  files.set("race.ts", { content: "OLD", revision: "r-old" });
  let resets = 0;
  let resetText = "";
  const off = registerDocumentEditorBridge({
    onAuthoritativeReset(_ref, text) {
      resets += 1;
      resetText = text;
    },
    onSavedBaselineAdvanced() {},
    onDocumentDeleted() {},
    onDocumentMoved() {},
  });
  const held = holdFirstRead();
  const s1 = openDocument(ref("race.ts"));
  try {
    await held.started;
    deleteDocument(ref("race.ts"));
    assert.equal(documentSessionCount(), 0);
    files.set("race.ts", { content: "NEW", revision: "r-new" });
    const s2 = openDocument(ref("race.ts"));
    await s2.load();
    assert.equal(s2.getSnapshot().saved, "NEW");
    assert.equal(s2.getSnapshot().revision, "r-new");
    const gen = s2.getSnapshot().authoritativeGeneration;
    assert.equal(resets, 1);
    assert.equal(resetText, "NEW");
    let live = "NEW";
    s2.attachSource({ getText: () => live });
    live = "NEW+edit";
    s2.reportUserEdit(false);
    held.release({ content: "OLD", revision: "r-old" });
    await s1.load();
    assert.equal(documentSessionCount(), 1);
    assert.equal(peekDocument(ref("race.ts"))?.key, s2.key);
    assert.equal(s2.getSnapshot().saved, "NEW");
    assert.equal(s2.getBuffer(), "NEW+edit");
    assert.equal(s2.getSnapshot().dirty, true);
    assert.equal(s2.getSnapshot().revision, "r-new");
    assert.equal(s2.getSnapshot().authoritativeGeneration, gen);
    assert.equal(s2.getSnapshot().status, "ready");
    assert.equal(s2.getSnapshot().error, "");
    assert.equal(resets, 1);
    assert.equal(resetText, "NEW");
  } finally {
    off();
    restoreReadImpl();
    resetDocumentsForTest();
  }
});

test("stale load after identity move does not publish old-path content", async () => {
  resetDocumentsForTest();
  files.set("from.ts", { content: "ORIGIN", revision: "r1" });
  const held = holdFirstRead();
  const handle = openDocument(ref("from.ts"));
  try {
    await held.started;
    await renameDocument(ref("from.ts"), "to.ts");
    assert.equal(handle.ref.locator, "to.ts");
    await handle.load();
    assert.equal(handle.getSnapshot().saved, "ORIGIN");
    held.release({ content: "STALE-FROM", revision: "r-stale" });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(handle.getSnapshot().saved, "ORIGIN");
    assert.equal(handle.getSnapshot().revision, "r1");
    assert.equal(handle.ref.locator, "to.ts");
    assert.notEqual(handle.getSnapshot().saved, "STALE-FROM");
  } finally {
    restoreReadImpl();
    resetDocumentsForTest();
  }
});

test("stale check after rename does not mark the new path deleted", async () => {
  resetDocumentsForTest();
  files.set("old.ts", { content: "O", revision: "r1" });
  const handle = openDocument(ref("old.ts"));
  try {
    await handle.load();
    handle.attachSource({ getText: () => "O" });
    const held = holdNthStat(1, { kind: "missing" });
    const checking = handle.check();
    await held.started;
    await renameDocument(ref("old.ts"), "new.ts");
    assert.equal(handle.ref.locator, "new.ts");
    held.release();
    await checking;
    assert.equal(handle.ref.locator, "new.ts");
    assert.equal(files.has("new.ts"), true);
    assert.notEqual(handle.getSnapshot().live?.kind, "deleted");
    assert.notEqual(handle.getSnapshot().live?.kind, "external-change");
    assert.notEqual(handle.getSnapshot().live?.kind, "conflict");
    assert.equal(handle.getSnapshot().dirty, false);
  } finally {
    restoreStatImpl();
    resetDocumentsForTest();
  }
});

test("stale check after save does not invent external-change or block later saves", async () => {
  resetDocumentsForTest();
  setUiSettings({ editorAutosave: true });
  files.set("rev.ts", { content: "O", revision: "r1" });
  writeImpl = async (r, content) => {
    files.set(r.locator, { content, revision: "r2" });
    return { revision: "r2" };
  };
  const handle = openDocument(ref("rev.ts"));
  try {
    await handle.load();
    assert.equal(handle.getSnapshot().revision, "r1");
    let live = "O";
    handle.attachSource({ getText: () => live });
    const held = holdNthStat(1, { kind: "present", revision: "r1" });
    const checking = handle.check();
    await held.started;
    live = "A";
    handle.reportUserEdit(false);
    await handle.save();
    assert.equal(handle.getSnapshot().revision, "r2");
    assert.equal(handle.getSnapshot().dirty, false);
    held.release();
    await checking;
    assert.equal(handle.getSnapshot().revision, "r2");
    assert.notEqual(handle.getSnapshot().live?.kind, "external-change");
    assert.notEqual(handle.getSnapshot().live?.kind, "conflict");
    live = "B";
    handle.reportUserEdit(false);
    assert.equal(handle.getSnapshot().dirty, true);
    assert.notEqual(handle.autosaveDelay(true), null);
    writeImpl = async (r, content) => {
      files.set(r.locator, { content, revision: "r3" });
      return { revision: "r3" };
    };
    await handle.save();
    assert.equal(handle.getSnapshot().revision, "r3");
    assert.equal(handle.getSnapshot().dirty, false);
    assert.equal(files.get("rev.ts")?.content, "B");
  } finally {
    restoreWriteImpl();
    restoreStatImpl();
    resetDocumentsForTest();
  }
});

test("older check cannot overwrite a newer check", async () => {
  resetDocumentsForTest();
  files.set("order.ts", { content: "O", revision: "r1" });
  type StatResult = { kind: "present"; revision?: string } | { kind: "missing" };
  const startWaiters = new Map<number, () => void>();
  const held = new Map<number, (result: StatResult) => void>();
  let calls = 0;
  statImpl = async () => {
    const n = ++calls;
    startWaiters.get(n)?.();
    return await new Promise<StatResult>((resolve) => { held.set(n, resolve); });
  };
  const waitFor = (n: number) => new Promise<void>((resolve) => {
    if (calls >= n) { resolve(); return; }
    startWaiters.set(n, resolve);
  });
  const handle = openDocument(ref("order.ts"));
  try {
    await handle.load();
    const checking1 = handle.check();
    await waitFor(1);
    const checking2 = handle.check();
    await waitFor(2);
    held.get(2)!({ kind: "present", revision: "r1" });
    await checking2;
    assert.notEqual(handle.getSnapshot().live?.kind, "external-change");
    held.get(1)!({ kind: "present", revision: "STALE" });
    await checking1;
    assert.notEqual(handle.getSnapshot().live?.kind, "external-change");
    assert.notEqual(handle.getSnapshot().live?.kind, "conflict");
    assert.equal(handle.getSnapshot().revision, "r1");
  } finally {
    restoreStatImpl();
    resetDocumentsForTest();
  }
});

test("stale load after provider unload does not publish into the closed-provider session", async () => {
  resetDocumentsForTest();
  const unloadScheme = `doc-unload-${process.pid}`;
  let releaseRead!: (result: { content: string; revision: string }) => void;
  let started!: () => void;
  const startedP = new Promise<void>((resolve) => { started = resolve; });
  const unregister = registerResourceProvider({
    scheme: unloadScheme,
    describe: (ref) => ({ label: ref.locator, kind: "text" }),
    read: async () => {
      started();
      return await new Promise((resolve) => { releaseRead = resolve; });
    },
  });
  const unloadRef = { scheme: unloadScheme, locator: "gone.ts", projectId: "p", sessionId: null };
  try {
    const handle = openDocument(unloadRef);
    await startedP;
    const genBefore = handle.getSnapshot().authoritativeGeneration;
    unregister();
    releaseRead({ content: "STALE-UNLOAD", revision: "old" });
    await handle.load();
    assert.notEqual(handle.getSnapshot().saved, "STALE-UNLOAD");
    assert.equal(handle.getSnapshot().authoritativeGeneration, genBefore);
    assert.equal(handle.getSnapshot().status, "error");
  } finally {
    unregister();
    resetDocumentsForTest();
  }
});
