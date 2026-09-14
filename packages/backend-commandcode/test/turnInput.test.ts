import assert from "node:assert/strict";
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

test("Command Code project attachment path never leaks or escapes the execution root", () => {
  const cwd = "/workspace/repo";
  assert.equal(commandCodeProjectPath(cwd, {
    id: "a", name: "a.ts", mime: "text/typescript", size: 10, kind: "file", path: "src/a.ts",
  }), "src/a.ts");
  assert.equal(commandCodeProjectPath(cwd, {
    id: "b", name: "secret", mime: "text/plain", size: 10, kind: "file", path: "../secret",
  }), undefined);
  assert.equal(commandCodeProjectPath(cwd, {
    id: "c", name: "absolute", mime: "text/plain", size: 10, kind: "file", path: "/etc/passwd",
  }), undefined);
});

test("Command Code turns project files and PDFs into provider-only native read_file instructions", () => {
  const prepared = prepareCommandCodeTurnInput("/workspace/repo", request({
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
  assert.match(prepared.request.text, /read_file tool on project file "src\/a\.ts"/);
  assert.match(prepared.request.text, /project document "docs\/spec\.pdf"/);
  assert.match(prepared.request.text, /lines 10-30/);
  assert.doesNotMatch(prepared.request.text, /\/workspace\/repo/);
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

test("Command Code advertises only the attachment modalities that the adapter really transports", () => {
  const base: RuntimeCapabilities = {
    streaming: true,
    permissions: false,
    questions: true,
    compaction: false,
    subagents: true,
    attachments: { modalities: { image: "unsupported", file: "unsupported", pdf: "unsupported", url: "unsupported", audio: "unsupported" } },
  };
  const capabilities = commandCodeInputCapabilities(base);
  assert.equal(capabilities.attachments?.modalities.file, "native");
  assert.equal(capabilities.attachments?.modalities.pdf, "native");
  assert.equal(capabilities.attachments?.modalities.image, "unsupported");
  assert.equal(capabilities.attachments?.modalities.url, "unsupported");
  assert.equal(capabilities.attachments?.modalities.audio, "unsupported");
});
