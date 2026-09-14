import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CanonicalTurnRequest, RuntimeCapabilities } from "@polyth/contracts";
import {
  commandCodeInputCapabilities,
  commandCodeProjectPath,
  prepareCommandCodeTurnInput,
} from "../src/turnInput.ts";

const request = (overrides: Partial<CanonicalTurnRequest> = {}): CanonicalTurnRequest => ({
  sessionId: "canonical",
  text: "Review these inputs",
  ...overrides,
});

const workspace = (): string => {
  const root = mkdtempSync(join(tmpdir(), "polyth-commandcode-input-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export {};\n");
  writeFileSync(join(root, "src", "slice.ts"), "one\ntwo\nthree\n");
  writeFileSync(join(root, "docs", "spec.pdf"), "%PDF-fixture\n");
  return root;
};

test("Command Code project attachment path never leaks or escapes the execution root", () => {
  const cwd = workspace();
  assert.equal(commandCodeProjectPath(cwd, {
    id: "a", name: "a.ts", mime: "text/typescript", size: 10, kind: "file", path: "src/a.ts",
  }), "src/a.ts");
  assert.equal(commandCodeProjectPath(cwd, {
    id: "b", name: "secret", mime: "text/plain", size: 10, kind: "file", path: "../secret",
  }), undefined);
  assert.equal(commandCodeProjectPath(cwd, {
    id: "c", name: "absolute", mime: "text/plain", size: 10, kind: "file", path: join(cwd, "src", "a.ts"),
  }), undefined);
  assert.equal(commandCodeProjectPath(cwd, {
    id: "d", name: "missing", mime: "text/plain", size: 10, kind: "file", path: "src/missing.txt",
  }), undefined);
});

test("Command Code fences attachment symlink targets to the canonical workspace", {
  skip: process.platform === "win32" ? "symlink creation can require Windows developer privileges" : false,
}, () => {
  const cwd = workspace();
  const outside = mkdtempSync(join(tmpdir(), "polyth-commandcode-outside-"));
  const secret = join(outside, "secret.txt");
  writeFileSync(secret, "secret\n");
  symlinkSync(secret, join(cwd, "src", "escape.txt"));
  symlinkSync(join(cwd, "src", "a.ts"), join(cwd, "src", "inside-link.ts"));

  assert.equal(commandCodeProjectPath(cwd, {
    id: "escape", name: "escape.txt", mime: "text/plain", size: 7, kind: "file", path: "src/escape.txt",
  }), undefined);
  assert.equal(commandCodeProjectPath(cwd, {
    id: "inside", name: "inside-link.ts", mime: "text/typescript", size: 10, kind: "file", path: "src/inside-link.ts",
  }), "src/inside-link.ts");
});

test("Command Code turns project files and PDFs into provider-only read_file instructions", () => {
  const cwd = workspace();
  const prepared = prepareCommandCodeTurnInput(cwd, request({
    attachments: [
      { id: "a", name: "a.ts", mime: "text/typescript", size: 10, kind: "file", path: "src/a.ts" },
      { id: "b", name: "spec.pdf", mime: "application/pdf", size: 42, kind: "file", path: "docs/spec.pdf" },
      { id: "c", name: "slice.ts", mime: "text/typescript", size: 20, kind: "range", path: "src/slice.ts", range: [10, 30] },
    ],
  }));
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(prepared.request.attachments?.length, 0);
  assert.match(prepared.request.text, /Review these inputs/);
  assert.match(prepared.request.text, /Resolve project-relative path "src\/a\.ts" against the current workspace root/);
  assert.match(prepared.request.text, /resulting absolute in-workspace path to native read_file/);
  assert.match(prepared.request.text, /"docs\/spec\.pdf"/);
  assert.match(prepared.request.text, /document extraction/);
  assert.match(prepared.request.text, /"src\/slice\.ts"[\s\S]*offset=10 and limit=21/);
  assert.doesNotMatch(prepared.request.text, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Command Code refuses project-file delivery without a canonical relative path", () => {
  const prepared = prepareCommandCodeTurnInput("/workspace/repo", request({
    attachments: [
      { id: "upload", name: "upload.pdf", mime: "application/pdf", size: 100, kind: "file" },
    ],
  }));
  assert.deepEqual(prepared, {
    ok: false,
    code: "invalid-attachment",
    message: "upload.pdf must resolve to a project-relative path before Command Code can read it",
  });
});

test("Command Code does not claim browser screenshots or other unsupported attachment classes", () => {
  const prepared = prepareCommandCodeTurnInput("/workspace/repo", request({
    attachments: [
      { id: "shot", name: "shot.png", mime: "image/png", size: 100, kind: "image", path: "artifacts/shot.png" },
    ],
  }));
  assert.equal(prepared.ok, false);
  if (prepared.ok) return;
  assert.equal(prepared.code, "unsupported");
});

test("Command Code custom subagents cannot be silently treated as primary agents", () => {
  const prepared = prepareCommandCodeTurnInput("/workspace/repo", request({ agent: "explore" }));
  assert.deepEqual(prepared, {
    ok: false,
    code: "unsupported",
    message: "Command Code custom agents are delegated native subagents and cannot be selected as the primary turn agent",
  });
});

test("Command Code advertises project attachment transport as emulated, not native", () => {
  const base: RuntimeCapabilities = {
    streaming: true,
    permissions: false,
    questions: true,
    compaction: false,
    subagents: true,
    attachments: { modalities: { image: "unsupported", file: "unsupported", pdf: "unsupported", url: "unsupported", audio: "unsupported" } },
  };
  const capabilities = commandCodeInputCapabilities(base);
  assert.equal(capabilities.attachments?.modalities.file, "emulated");
  assert.equal(capabilities.attachments?.modalities.pdf, "emulated");
  assert.equal(capabilities.attachments?.modalities.image, "unsupported");
  assert.equal(capabilities.attachments?.modalities.url, "unsupported");
  assert.equal(capabilities.attachments?.modalities.audio, "unsupported");
});
