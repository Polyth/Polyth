import test from "node:test";
import assert from "node:assert/strict";
import {
  autosaveDelay,
  beginLiveFileSave,
  checkLiveFile,
  completeLiveFileSave,
  conflictLiveFile,
  dismissLiveFileNotice,
  editLiveFile,
  htmlPreviewDocument,
  initialPreviewVisible,
  loadedLiveFile,
  previewKindForPath,
  restoreLiveFileBuffer,
} from "../widgets/editor/liveFile.ts";
import { parseEditorPrefs } from "../../../apps/web/src/uiPrefs.ts";

test("live file: clean external replacement is reload-only; dirty replacement conflicts", () => {
  const clean = loadedLiveFile("rev-1");
  const replacement = checkLiveFile(clean, { kind: "present", revision: "rev-2" });
  assert.equal(replacement.kind, "external-change");
  assert.equal(replacement.dirty, false);
  assert.equal(replacement.diskRevision, "rev-2");

  const dirty = editLiveFile(clean);
  const conflict = checkLiveFile(dirty, { kind: "present", revision: "rev-2" });
  assert.equal(conflict.kind, "conflict");
  assert.equal(conflict.dirty, true);
  assert.equal(restoreLiveFileBuffer(conflict).kind, "external-change");
});

test("live file: autosave pauses for IME and unsafe revision states", () => {
  const dirty = editLiveFile(loadedLiveFile("rev-1"));
  const ready = { enabled: true, editing: true, composing: false, readOnly: false };
  assert.equal(autosaveDelay(dirty, ready), 1_500);
  assert.equal(autosaveDelay(dirty, { ...ready, composing: true }), null);
  assert.equal(autosaveDelay(dirty, { ...ready, editing: false }), null);
  assert.equal(autosaveDelay(conflictLiveFile(dirty, "rev-2"), ready), null);
  assert.equal(autosaveDelay(checkLiveFile(dirty, { kind: "deleted" }), ready), null);
});

test("live file: save transitions preserve edits made during an in-flight write", () => {
  const dirty = editLiveFile(loadedLiveFile("rev-1"));
  const saving = beginLiveFileSave(dirty);
  assert.equal(saving.kind, "saving");
  assert.deepEqual(completeLiveFileSave(saving, "rev-2"), {
    kind: "saved",
    baseRevision: "rev-2",
    dirty: false,
    noticeDismissed: false,
  });
  assert.equal(completeLiveFileSave(saving, "rev-2", true).kind, "dirty");
});

test("live file: deletion and check failures surface retryable, dismissible notices", () => {
  const dirty = editLiveFile(loadedLiveFile("rev-1"));
  const deleted = checkLiveFile(dirty, { kind: "deleted" });
  assert.equal(deleted.kind, "deleted");
  assert.equal(deleted.dirty, true);
  assert.equal(dismissLiveFileNotice(deleted).noticeDismissed, true);

  const failed = checkLiveFile(dirty, { kind: "failed", message: "offline" });
  assert.equal(failed.kind, "check-failed");
  assert.equal(failed.message, "offline");
  assert.equal(checkLiveFile(failed, { kind: "present", revision: "rev-1" }).kind, "dirty");
});

test("editor preview selection and HTML sandbox document are deterministic", () => {
  assert.equal(previewKindForPath("README.md"), "markdown");
  assert.equal(previewKindForPath("public/index.HTML"), "html");
  assert.equal(previewKindForPath("data.json"), "json");
  assert.equal(previewKindForPath("src/app.ts"), null);
  assert.equal(initialPreviewVisible("README.md", true), true);
  assert.equal(initialPreviewVisible("README.md", false), false);
  assert.equal(initialPreviewVisible("src/app.ts", true), false);
  // Finding 3: a per-kind choice wins over the global default; other kinds
  // and non-previewable paths are unaffected.
  assert.equal(initialPreviewVisible("README.md", true, { markdown: false }), false);
  assert.equal(initialPreviewVisible("README.md", false, { markdown: true }), true);
  assert.equal(initialPreviewVisible("data.json", true, { markdown: false }), true);
  assert.equal(initialPreviewVisible("src/app.ts", true, { markdown: true }), false);
  assert.deepEqual(parseEditorPrefs(null), { openInPreview: true, previewByKind: {} });
  assert.deepEqual(parseEditorPrefs('{"openInPreview":false}'), { openInPreview: false, previewByKind: {} });
  assert.deepEqual(
    parseEditorPrefs('{"previewByKind":{"markdown":false,"html":true,"bogus":true,"json":"nope"}}'),
    { openInPreview: true, previewByKind: { markdown: false, html: true } },
  );

  const html = htmlPreviewDocument("<script>globalThis.previewRan = true</script>", 'https://example.test/a"b/');
  assert.match(html, /<base href="https:\/\/example\.test\/a&quot;b\/">/);
  assert.match(html, /script-src 'unsafe-inline'/);
  assert.match(html, /<script>globalThis\.previewRan = true<\/script>/);
});
