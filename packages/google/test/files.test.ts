import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readWorkspaceFile, safeFileName, saveDownload } from "../src/files.ts";

const project = () => mkdtempSync(join(tmpdir(), "google-files-"));

test("downloads land under .polyth/downloads/google with a fresh, sanitized name", async () => {
  const cwd = project();
  const first = await saveDownload(cwd, "../../etc/passwd", new TextEncoder().encode("one"));
  const second = await saveDownload(cwd, "../../etc/passwd", new TextEncoder().encode("two"));
  assert.match(first.path, /^\.polyth\/downloads\/google\/[0-9a-f]{8}-_\.\._etc_passwd$/);
  assert.notEqual(first.path, second.path);
  assert.equal(readFileSync(join(cwd, first.path), "utf8"), "one");
  assert.equal(safeFileName("\u0000.hidden:name?.pdf"), "_.hidden_name_.pdf");
  assert.equal(safeFileName(""), "download");
});

test("a symlinked download directory cannot redirect writes outside the project", async () => {
  const cwd = project();
  const outside = project();
  mkdirSync(join(cwd, ".polyth"));
  symlinkSync(outside, join(cwd, ".polyth", "downloads"));
  await assert.rejects(saveDownload(cwd, "x.txt", new Uint8Array([1])), { code: "permission-denied" });
});

test("only regular files inside the project can be uploaded or attached", async () => {
  const cwd = project();
  const outside = project();
  writeFileSync(join(cwd, "report.pdf"), "pdf");
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(join(outside, "secret.txt"), join(cwd, "link.txt"));
  mkdirSync(join(cwd, "folder"));

  const file = await readWorkspaceFile(cwd, "report.pdf", 1024);
  assert.equal(file.name, "report.pdf");
  assert.equal(file.mimeType, "application/pdf");
  await assert.rejects(readWorkspaceFile(cwd, "../" + outside.split("/").pop() + "/secret.txt", 1024), (error: { code?: string }) => error.code === "permission-denied" || error.code === "not-found");
  await assert.rejects(readWorkspaceFile(cwd, join(outside, "secret.txt"), 1024), { code: "permission-denied" });
  await assert.rejects(readWorkspaceFile(cwd, "link.txt", 1024), { code: "permission-denied" });
  await assert.rejects(readWorkspaceFile(cwd, "folder", 1024), { code: "invalid-request" });
  await assert.rejects(readWorkspaceFile(cwd, "missing.txt", 1024), { code: "not-found" });
  await assert.rejects(readWorkspaceFile(cwd, "report.pdf", 2), { code: "too-large" });
});

test("credential and repository-internal files are never uploaded or attached", async () => {
  const cwd = project();
  for (const dir of [".git", ".ssh", "config"]) mkdirSync(join(cwd, dir));
  for (const file of [".env", ".env.production", ".npmrc", "server.key", ".git/config", ".ssh/id_ed25519", "config/app.json", "..notes.txt"]) {
    writeFileSync(join(cwd, file), "x");
  }
  for (const file of [".env", ".env.production", ".npmrc", "server.key", ".git/config", ".ssh/id_ed25519"]) {
    await assert.rejects(readWorkspaceFile(cwd, file, 1024), { code: "permission-denied" }, file);
  }
  assert.equal((await readWorkspaceFile(cwd, "config/app.json", 1024)).name, "app.json");
  assert.equal((await readWorkspaceFile(cwd, "..notes.txt", 1024)).name, "..notes.txt");
  // A downloaded attachment can be forwarded again.
  const saved = await saveDownload(cwd, "invoice.pdf", new Uint8Array([1]));
  assert.equal((await readWorkspaceFile(cwd, saved.path, 1024)).mimeType, "application/pdf");
  assert.equal(readFileSync(join(cwd, ".polyth/downloads/google/.gitignore"), "utf8"), "*\n");
});
