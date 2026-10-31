import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { AttachmentRef } from "@polyth/contracts";
import { AGY_ATTACHMENT_MAX_BYTES, AGY_ATTACHMENT_MAX_COUNT, stageAgyAttachments, stagedFileName } from "../src/attachments.ts";

const temp = async (t: TestContext, prefix: string) => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

test("staged names are path-safe and carry the canonical extension for their MIME", () => {
  assert.equal(stagedFileName(1, "Screen Shot 2026.PNG", "image/png"), "1-Screen-Shot-2026.png");
  assert.equal(stagedFileName(2, "photo.jpeg", "image/jpeg"), "2-photo.jpg");
  assert.equal(stagedFileName(3, "../../etc/passwd", "audio/x-wav"), "3-etc-passwd.wav");
  assert.equal(stagedFileName(4, "diagram.svg", "image/svg+xml"), "4-diagram.svg", "an unknown MIME keeps a plain extension");
  assert.equal(stagedFileName(5, "...", "application/pdf"), "5-attachment.pdf");
});

test("a secondary repository attachment resolves against its checkout, never the primary cwd", async (t) => {
  const root = await temp(t, "polyth-agy-stage-");
  const primary = await temp(t, "polyth-agy-primary-");
  const secondary = await temp(t, "polyth-agy-secondary-");
  await writeFile(join(secondary, "logo.png"), "png");
  const ref: AttachmentRef = { id: "a", name: "logo.png", mime: "image/png", size: 3, path: "logo.png", repositoryId: "docs" };
  const workspace = { projectId: "p", sessionId: "s", repositories: [{ repositoryId: "docs", alias: "docs", path: secondary, state: "ready" as const }] };
  const staged = await stageAgyAttachments({ root, turnId: "turn-a", cwd: primary, text: "Look", attachments: [ref], workspace });
  assert.equal(staged.ok, true);
  if (staged.ok) assert.equal(staged.staged.paths.length, 1);
  const missing = await stageAgyAttachments({ root, turnId: "turn-b", cwd: primary, text: "Look",
    attachments: [ref], workspace: { ...workspace, repositories: [{ ...workspace.repositories[0]!, state: "missing" as const }] } });
  assert.deepEqual(missing, { ok: false, code: "invalid-attachment", message: "logo.png could not be read for Antigravity." });
});

test("size and count limits refuse the message before anything is copied", async (t) => {
  const root = await temp(t, "polyth-agy-stage-");
  const cwd = await temp(t, "polyth-agy-cwd-");
  await writeFile(join(cwd, "huge.wav"), "");
  await truncate(join(cwd, "huge.wav"), AGY_ATTACHMENT_MAX_BYTES + 1);
  const huge = await stageAgyAttachments({ root, turnId: "turn-a", cwd, text: "", attachments: [
    { id: "h", name: "huge.wav", mime: "audio/wav", size: AGY_ATTACHMENT_MAX_BYTES + 1, path: "huge.wav" },
  ] });
  assert.equal(huge.ok, false);
  assert.deepEqual(await readdir(join(root, "attachments")), [], "a refused turn leaves no partial copy");
  const links = Array.from({ length: AGY_ATTACHMENT_MAX_COUNT + 1 }, (_, index): AttachmentRef => ({
    id: `u${index}`, name: `link ${index}`, mime: "text/uri-list", size: 1, kind: "url", url: `https://example.com/${index}`,
  }));
  const many = await stageAgyAttachments({ root, turnId: "turn-b", cwd, text: "", attachments: links });
  assert.equal(many.ok, false);
});

test("only the newest turn directories are retained", async (t) => {
  const root = await temp(t, "polyth-agy-stage-");
  const cwd = await temp(t, "polyth-agy-cwd-");
  await mkdir(join(cwd, "_inbox"));
  await writeFile(join(cwd, "_inbox", "a.png"), "png");
  for (let turn = 0; turn < 26; turn++) {
    const staged = await stageAgyAttachments({ root, turnId: `turn-${turn}`, cwd, text: "", attachments: [
      { id: "a", name: "a.png", mime: "image/png", size: 3, path: "_inbox/a.png" },
    ] });
    assert.equal(staged.ok, true);
  }
  assert.equal((await readdir(join(root, "attachments"))).length, 24);
});

test("text with no attachments passes through untouched", async (t) => {
  const root = await temp(t, "polyth-agy-stage-");
  assert.deepEqual(await stageAgyAttachments({ root, turnId: "turn-a", cwd: root, text: "Plain" }), {
    ok: true, text: "Plain", staged: { manifest: "", steps: [], paths: [], urls: [] },
  });
});
