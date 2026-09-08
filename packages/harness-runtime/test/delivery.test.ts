import assert from "node:assert/strict";
import { test } from "node:test";
import type { AttachmentRef, RuntimeCapabilities } from "@polyth/contracts";
import { effectiveAttachmentSupport } from "@polyth/contracts";
import {
  composeProjectedPrompt,
  planAttachmentDelivery,
  projectAttachmentText,
  TEXT_PROJECTION_MAX_BYTES,
} from "../src/delivery.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const caps = (modalities: RuntimeCapabilities["attachments"] extends { modalities: infer M } | undefined ? M : never): RuntimeCapabilities => ({
  streaming: true, permissions: true, questions: false, compaction: false, subagents: false,
  attachments: { modalities },
});

const ref = (over: Partial<AttachmentRef>): AttachmentRef => ({
  id: "a", name: "a.ts", mime: "text/plain", size: 1, ...over,
});

test("a natively supported modality is handed to the adapter unchanged", () => {
  const plan = planAttachmentDelivery({
    ref: ref({ kind: "image", mime: "image/png", path: "shot.png" }),
    support: { image: "native" },
    harnessName: "Codex",
  });
  assert.deepEqual(plan, { kind: "native", modality: "image" });
});

test("an emulated file becomes a server-side text projection, not an adapter problem", () => {
  const plan = planAttachmentDelivery({
    ref: ref({ kind: "file", path: "src/a.ts" }),
    support: { file: "emulated" },
    harnessName: "Codex",
  });
  assert.deepEqual(plan, { kind: "text-projection", modality: "file" });
});

test("an emulated non-file modality stays a pass-through the harness emulates itself", () => {
  const plan = planAttachmentDelivery({
    ref: ref({ kind: "url", mime: "text/uri-list", url: "https://example.com/x" }),
    support: { url: "emulated" },
    harnessName: "OpenCode",
  });
  assert.deepEqual(plan, { kind: "harness-emulated", modality: "url" });
});

test("an unsupported modality is refused with the engine's name, not adapter prose", () => {
  const plan = planAttachmentDelivery({
    ref: ref({ mime: "application/pdf", path: "spec.pdf" }),
    support: { image: "native" },
    harnessName: "Codex",
  });
  assert.equal(plan.kind, "unsupported");
  assert.equal(plan.kind === "unsupported" && plan.code, "unsupported");
  assert.equal(
    plan.kind === "unsupported" ? plan.reason : "",
    "PDF attachments are not supported by the Codex engine.",
  );
});

test("unknown support never forwards a binary modality as native", () => {
  const plan = planAttachmentDelivery({
    ref: ref({ mime: "application/pdf", path: "spec.pdf" }),
    support: {},
    harnessName: "Legacy",
    supportDeclared: false,
  });
  assert.equal(plan.kind, "unsupported");
});

test("legacy unknown support keeps only guarded text projection compatibility", () => {
  const plan = planAttachmentDelivery({
    ref: ref({ kind: "file", mime: "text/plain", path: "notes.txt" }),
    support: {},
    harnessName: "Legacy",
    supportDeclared: false,
  });
  assert.deepEqual(plan, { kind: "text-projection", modality: "file" });
});

test("browser context with no usable capture is merged into the prompt, never refused", () => {
  const plan = planAttachmentDelivery({
    ref: ref({ kind: "browser-context", mime: "application/json", browserContext: {} as never }),
    support: {},
    harnessName: "Codex",
  });
  assert.deepEqual(plan, { kind: "prompt-merged" });
});

test("remote projects without materialization cannot deliver a file, and say so", () => {
  const harness = caps({ file: "emulated", image: "native" });
  const local = effectiveAttachmentSupport(harness, undefined, false, false);
  assert.equal(local.file, "emulated");
  const remoteNoCopy = effectiveAttachmentSupport(harness, undefined, true, false);
  assert.equal(remoteNoCopy.file, undefined);
  const remoteWithCopy = effectiveAttachmentSupport(harness, undefined, true, true);
  assert.equal(remoteWithCopy.file, "emulated");
  const plan = planAttachmentDelivery({
    ref: ref({ kind: "file", path: "src/a.ts" }),
    support: remoteNoCopy,
    harnessName: "Codex",
  });
  assert.equal(plan.kind, "unsupported");
});

test("a text file projects as one delimited, fenced section", () => {
  const projection = projectAttachmentText({ path: "src/a.ts", bytes: bytes("export const a = 1;\n") });
  assert.equal(projection.ok, true);
  assert.equal(
    projection.ok && projection.section,
    "Attached file: src/a.ts\n```\nexport const a = 1;\n```",
  );
});

test("a file whose own backticks would close the fence gets a longer fence", () => {
  const projection = projectAttachmentText({ path: "README.md", bytes: bytes("```js\nx\n```\n") });
  assert.ok(projection.ok && projection.section.includes("\n````\n"));
});

test("a binary file is refused rather than smuggled in as mojibake", () => {
  const projection = projectAttachmentText({ path: "logo.png", bytes: new Uint8Array([0x89, 0x50, 0x00, 0x01]) });
  assert.equal(projection.ok, false);
  assert.equal(projection.ok === false && projection.code, "invalid-attachment");
  assert.match(projection.ok === false ? projection.reason : "", /binary/);
});

test("non-UTF-8 bytes are refused with that reason", () => {
  const projection = projectAttachmentText({ path: "latin.txt", bytes: new Uint8Array([0x41, 0xff, 0xfe, 0x42]) });
  assert.equal(projection.ok, false);
  assert.match(projection.ok === false ? projection.reason : "", /not UTF-8/);
});

test("truncation is deterministic, cut on a UTF-8 boundary, and states the dropped bytes", () => {
  // "é" is two bytes, so the limit lands mid-sequence on every repetition.
  const source = "é".repeat(40);
  const first = projectAttachmentText({ path: "a.txt", bytes: bytes(source), maxBytes: 9 });
  const second = projectAttachmentText({ path: "a.txt", bytes: bytes(source), maxBytes: 9 });
  assert.equal(first.ok, true);
  assert.deepEqual(first, second);
  assert.equal(first.ok && first.truncatedBytes, 72);
  assert.ok(first.ok && first.section.includes("[truncated 72 bytes]"));
  assert.doesNotMatch(first.ok ? first.section : "", /\ufffd/);
});

test("a range attachment projects only the requested lines", () => {
  const projection = projectAttachmentText({
    path: "src/a.ts",
    range: [2, 3],
    bytes: bytes("one\ntwo\nthree\nfour\n"),
  });
  assert.equal(
    projection.ok && projection.section,
    "Attached file: src/a.ts (lines 2-3)\n```\ntwo\nthree\n```",
  );
  assert.equal(projection.ok && projection.truncatedBytes, 0);
});

test("a range after the 64 KiB prefix remains reachable", () => {
  const prefix = Array.from({ length: 20_000 }, (_, index) => `line-${index + 1}`).join("\n");
  const projection = projectAttachmentText({
    path: "late.txt",
    range: [19_999, 20_000],
    bytes: bytes(`${prefix}\n`),
  });
  assert.equal(
    projection.ok && projection.section,
    "Attached file: late.txt (lines 19999-20000)\n```\nline-19999\nline-20000\n```",
  );
});

test("projected sections follow the user's text in order", () => {
  assert.equal(composeProjectedPrompt("look", ["A", "B"]), "look\n\nA\n\nB");
  assert.equal(composeProjectedPrompt("   ", ["A"]), "A");
  assert.equal(composeProjectedPrompt("look", []), "look");
});

test("the projection ceiling is a stated, bounded number", () => {
  assert.equal(TEXT_PROJECTION_MAX_BYTES, 64 * 1024);
});
