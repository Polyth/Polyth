import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deltaCost,
  deltaTokenUsage,
  composeTurnPrompt,
  effectiveAttachmentSupport,
  isPlaceholderTitle,
  titleFromPrompt,
  attachmentModality,
} from "../src/features.ts";
import { commandPrecedence, mergeCommandCatalog } from "@polyth/commands";
import type { RuntimeCapabilities, RuntimeCommandDescriptor } from "@polyth/contracts";

test("titleFromPrompt truncates long first lines", () => {
  assert.equal(titleFromPrompt("hello world"), "hello world");
  const long = "a".repeat(60);
  assert.equal(titleFromPrompt(long).length, 48);
  assert.ok(titleFromPrompt(long).endsWith("…"));
});

test("isPlaceholderTitle detects common placeholders", () => {
  assert.equal(isPlaceholderTitle("New session"), true);
  assert.equal(isPlaceholderTitle("New session - 2026-01-01T00:00:00Z"), true);
  assert.equal(isPlaceholderTitle("ses_abc"), true);
  assert.equal(isPlaceholderTitle("Real title"), false);
});

test("deltaTokenUsage floors at zero", () => {
  const prev = { input: 100, output: 50 };
  const curr = { input: 80, output: 60 };
  const delta = deltaTokenUsage(prev, curr);
  assert.equal(delta.input, 0);
  assert.equal(delta.output, 10);
});

test("deltaCost returns undefined for no increase", () => {
  assert.equal(deltaCost(1, 1), undefined);
  assert.equal(deltaCost(undefined, 0.5), 0.5);
});

test("mergeCommandCatalog keeps collisions as separate entries", () => {
  const polyth = [{ name: "compact", description: "", prompt: "x", scope: "builtin" as const }];
  const native: RuntimeCommandDescriptor[] = [{
    id: "native:claude:compact",
    name: "compact",
    owner: "native",
    harnessId: "claude",
    invocation: "raw-native-input",
  }];
  const merged = mergeCommandCatalog(polyth, native);
  assert.equal(merged.length, 2);
});

test("commandPrecedence prefers project over builtin over native", () => {
  const polyth = [
    { name: "go", description: "", prompt: "p", scope: "builtin" as const },
    { name: "go", description: "", prompt: "q", scope: "project" as const },
  ];
  const native: RuntimeCommandDescriptor[] = [{
    id: "native:x:go",
    name: "go",
    owner: "native",
    harnessId: "x",
    invocation: "raw-native-input",
  }];
  const picked = commandPrecedence("go", [...polyth, ...native]);
  assert.equal((picked as { prompt?: string }).prompt, "q");
});

test("effectiveAttachmentSupport intersects harness and model", () => {
  const harness: RuntimeCapabilities = {
    streaming: true,
    permissions: true,
    questions: false,
    compaction: false,
    subagents: false,
    attachments: { modalities: { image: "native", file: "native" } },
  };
  const support = effectiveAttachmentSupport(harness, ["input:image"], false);
  assert.equal(support.image, "native");
  assert.equal(support.file, "native");
});

test("effectiveAttachmentSupport distinguishes unknown from an explicit empty model catalog", () => {
  const harness: RuntimeCapabilities = {
    streaming: true,
    permissions: true,
    questions: false,
    compaction: false,
    subagents: false,
    attachments: { modalities: { image: "native", file: "emulated" } },
  };
  assert.deepEqual(
    effectiveAttachmentSupport(harness, undefined, false),
    { image: "native", file: "emulated" },
  );
  assert.deepEqual(effectiveAttachmentSupport(harness, [], false), { file: "emulated" });
});

test("effectiveAttachmentSupport keeps harness file delivery when the model only reports text/image", () => {
  const harness: RuntimeCapabilities = {
    streaming: true,
    permissions: true,
    questions: false,
    compaction: false,
    subagents: false,
    attachments: { modalities: { image: "native", file: "native", url: "emulated", pdf: "native" } },
  };
  const support = effectiveAttachmentSupport(
    harness,
    ["input:text", "input:image", "output:text", "toolcall"],
    false,
  );
  assert.equal(support.image, "native");
  assert.equal(support.file, "native");
  assert.equal(support.url, "emulated");
  assert.equal(support.pdf, undefined);
});

test("effectiveAttachmentSupport requires materialize for remote path delivery", () => {
  const harness: RuntimeCapabilities = {
    streaming: true,
    permissions: true,
    questions: false,
    compaction: false,
    subagents: false,
    attachments: { modalities: { file: "native" } },
  };
  assert.equal(effectiveAttachmentSupport(harness, ["input:file"], true, false).file, undefined);
  assert.equal(effectiveAttachmentSupport(harness, ["input:file"], true, true).file, "emulated");
});

test("composeTurnPrompt prepends browser context and collects absolute captures", () => {
  const composed = composeTurnPrompt("look", [{
    id: "bc",
    name: "page",
    mime: "application/vnd.polyth.browser-context+json",
    size: 0,
    kind: "browser-context",
    browserContext: {
      id: "bc",
      type: "page",
      browserSessionId: "b",
      projectId: "p",
      frameRevision: 1,
      url: "https://example.com",
      title: "Example",
      viewport: { width: 800, height: 600 },
      capturedAt: "2026-01-01T00:00:00.000Z",
      screenshot: { id: "shot", mime: "image/png", size: 4, localPath: "/tmp/shot.png" },
    },
  }]);
  assert.match(composed.text, /^look\n\n\[Browser context\]/);
  assert.match(composed.text, /URL: https:\/\/example.com/);
  assert.deepEqual(composed.images, [{ localPath: "/tmp/shot.png", mime: "image/png" }]);
});

test("effectiveAttachmentSupport follows selected model for image and pdf", () => {
  const harness: RuntimeCapabilities = {
    streaming: true,
    permissions: true,
    questions: false,
    compaction: false,
    subagents: false,
    attachments: { modalities: { image: "native", pdf: "native", audio: "native" } },
  };
  assert.equal(
    effectiveAttachmentSupport(harness, ["input:text", "output:text"], false).image,
    undefined,
  );
  assert.equal(
    effectiveAttachmentSupport(harness, ["input:text", "input:image", "output:text"], false).image,
    "native",
  );
  assert.equal(
    effectiveAttachmentSupport(harness, ["input:text", "input:pdf", "output:text"], false).pdf,
    "native",
  );
});

test("attachmentModality prefers mime/kind over a presentational file URL", () => {
  assert.equal(attachmentModality({
    id: "img",
    name: "shot.png",
    size: 1,
    kind: "image",
    mime: "image/png",
    path: "shot.png",
    url: "/api/files/raw?projectId=p&path=shot.png",
  }), "image");
  assert.equal(attachmentModality({
    id: "pdf",
    name: "doc.pdf",
    size: 1,
    kind: "file",
    mime: "application/pdf",
    path: "doc.pdf",
    url: "/api/files/raw?projectId=p&path=doc.pdf",
  }), "pdf");
  assert.equal(attachmentModality({
    id: "link",
    name: "a.png",
    size: 0,
    kind: "url",
    mime: "image/png",
    url: "https://example.com/a.png",
  }), "url");
});

test("ACP audio can remain supported when image and file are unsupported", () => {
  const harness: RuntimeCapabilities = {
    streaming: true,
    permissions: true,
    questions: false,
    compaction: false,
    subagents: false,
    attachments: { modalities: { image: "unsupported", file: "unsupported", audio: "native" } },
  };
  const support = effectiveAttachmentSupport(harness, ["input:audio", "output:text"], false);
  assert.equal(support.audio, "native");
  assert.equal(support.image, undefined);
});

test("commandPrecedence returns native only when no Polyth scope owns the name", () => {
  const native: RuntimeCommandDescriptor[] = [{
    id: "native:x:status",
    name: "status",
    owner: "native",
    harnessId: "x",
    invocation: "raw-native-input",
  }];
  assert.equal(commandPrecedence("status", native), native[0]);
  assert.equal(commandPrecedence("missing", []), undefined);
});
