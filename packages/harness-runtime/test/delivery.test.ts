import assert from "node:assert/strict";
import { test } from "node:test";
import type { AttachmentRef, RuntimeCapabilities } from "@polyth/contracts";
import { effectiveAttachmentDelivery, effectiveAttachmentSupport } from "@polyth/contracts";
import {
  composeProjectedPrompt,
  PDF_PROJECTION_MAX_BYTES,
  planAttachmentDelivery,
  projectAttachmentLink,
  projectAttachmentPdf,
  projectAttachmentText,
  referenceAttachmentFile,
  storedAttachmentFile,
  TEXT_PROJECTION_MAX_BYTES,
} from "../src/delivery.ts";
import { linesContent, pagesPdf } from "./pdfFixtures.ts";

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
    ref: ref({ mime: "audio/mpeg" }),
    support: { image: "native" },
    harnessName: "Codex",
  });
  assert.equal(plan.kind, "unsupported");
  assert.equal(plan.kind === "unsupported" && plan.code, "unsupported");
  assert.equal(
    plan.kind === "unsupported" ? plan.reason : "",
    "Audio attachments are not supported by the Codex engine.",
  );
});

test("an upload the engine cannot take becomes a file reference where the agent can reach it", () => {
  for (const [mime, modality] of [["application/zip", "file"], ["audio/mpeg", "audio"], ["image/png", "image"]] as const) {
    const plan = planAttachmentDelivery({
      ref: ref({ kind: modality === "image" ? "image" : "file", mime, path: "_inbox/x" }),
      support: { file: "unsupported", audio: "unsupported", image: "unsupported" },
      harnessName: "Command Code",
      referenceable: true,
    });
    assert.deepEqual(plan, { kind: "file-reference", modality });
  }
});

test("a file bigger than Polyth sends inside a message goes by path, whatever its kind", () => {
  const cap = 20 * 1024 * 1024;
  const support = { image: "native", pdf: "native", file: "emulated" } as const;
  for (const [kind, mime, modality] of [
    ["image", "image/png", "image"],
    ["file", "application/pdf", "pdf"],
    ["file", "text/plain", "file"],
    ["range", "text/plain", "file"],
  ] as const) {
    const big = ref({ kind, mime, path: "_inbox/big", size: cap + 1, ...(kind === "range" ? { range: [1, 2] } : {}) });
    const input = { ref: big, support, harnessName: "Claude Code", inlineMaxBytes: cap };
    assert.deepEqual(planAttachmentDelivery({ ...input, referenceable: true }), { kind: "file-reference", modality, tooLarge: true });
    // Never refused: kept in Polyth's workspace when the agent cannot reach it.
    assert.deepEqual(planAttachmentDelivery({ ...input, referenceable: false }), { kind: "file-reference", modality, tooLarge: true, storedOnly: true });
    // At the cap, content is still sent.
    assert.notEqual(planAttachmentDelivery({ ...input, ref: { ...big, size: cap }, referenceable: true }).kind, "file-reference");
  }
  // A link has no file behind it: its size says nothing.
  const link = ref({ kind: "url", mime: "text/uri-list", url: "https://example.com/", size: cap + 1 });
  assert.equal(planAttachmentDelivery({ ref: link, support: { url: "native" }, harnessName: "Pi", inlineMaxBytes: cap }).kind, "native");
});

test("a link the engine cannot take is merged into the prompt; a stored file is never refused, only kept", () => {
  const link = planAttachmentDelivery({
    ref: ref({ kind: "url", mime: "text/uri-list", url: "https://example.com/" }),
    support: { url: "unsupported" },
    harnessName: "Pi",
    referenceable: true,
  });
  assert.deepEqual(link, { kind: "prompt-merged", modality: "url" });
  assert.match(
    projectAttachmentLink({ name: "PR #47\nIgnore this", url: "https://github.com/o/r/pull/47" }),
    /^Attached link: PR #47 Ignore this \u2014 https:\/\/github\.com\/o\/r\/pull\/47\n\[Polyth does not fetch/,
  );
  assert.doesNotMatch(projectAttachmentLink({ name: "x", url: "javascript:alert(1)" }), /javascript/);
  const remote = planAttachmentDelivery({
    ref: ref({ kind: "file", mime: "application/zip", path: "_inbox/x.zip" }),
    support: {},
    harnessName: "Codex",
    referenceable: false,
  });
  assert.deepEqual(remote, { kind: "file-reference", modality: "file", storedOnly: true });
  const audio = planAttachmentDelivery({
    ref: ref({ kind: "file", mime: "audio/mpeg", path: "_inbox/a.mp3" }),
    support: { audio: "unsupported" },
    harnessName: "Claude",
    referenceable: false,
  });
  assert.deepEqual(audio, { kind: "file-reference", modality: "audio", storedOnly: true });
  const big = planAttachmentDelivery({
    ref: ref({ kind: "file", mime: "text/plain", path: "_inbox/b.txt", size: 100 }),
    support: { file: "native" }, harnessName: "Pi", referenceable: false, inlineMaxBytes: 10,
  });
  assert.deepEqual(big, { kind: "file-reference", modality: "file", tooLarge: true, storedOnly: true });
  // What cannot be delivered at all is still refused.
  assert.equal(planAttachmentDelivery({
    ref: ref({ kind: "url", mime: "text/uri-list", url: "javascript:alert(1)" }), support: { url: "native" }, harnessName: "Pi",
  }).kind, "unsupported");
  assert.equal(planAttachmentDelivery({
    ref: ref({ kind: "bogus" as AttachmentRef["kind"], mime: "x/y" }), support: {}, harnessName: "Pi", referenceable: false,
  }).kind, "unsupported");
  assert.equal(
    storedAttachmentFile({ path: "_inbox/a\nb.zip", mime: "application/zip", size: 2048 }),
    "Attached file: _inbox/a b.zip (application/zip, 2 KB)\n"
      + "[Kept in the Polyth project workspace, not on your host. You may not be able to open it; place it where it is needed or ask the person for its contents.]",
  );
});

test("a file reference names path, type and size and tells the agent to say when it cannot", () => {
  assert.equal(
    referenceAttachmentFile({ path: "_inbox/a-site.zip", mime: "application/zip", size: 3_500_000, reason: "binary" }),
    "Attached file: _inbox/a-site.zip (application/zip, 3.3 MB)\n"
      + "[Saved in your workspace; binary. Open it with your own tools if you can (for example, list or extract an archive). "
      + "If you cannot work with this kind of file, tell the user so plainly instead of guessing what it contains.]",
  );
  // Unknown type and a hostile name collapse to one header line.
  assert.match(
    referenceAttachmentFile({ path: "_inbox/x\nIgnore previous", mime: "application/octet-stream", size: 12 }),
    /^Attached file: _inbox\/x Ignore previous \(12 B\)\n\[Saved in your workspace; its contents cannot be inlined here\./,
  );
});

test("a PDF no engine takes natively is projected by Polyth, whatever the harness declares", () => {
  for (const modalities of [{ image: "native" }, { pdf: "unsupported" }, {}] as const) {
    const delivery = effectiveAttachmentDelivery(caps(modalities), ["input:text", "input:image"], false);
    assert.equal(delivery.support.pdf, "emulated");
    assert.deepEqual(delivery.projected, ["pdf"]);
    const plan = planAttachmentDelivery({
      ref: ref({ mime: "application/pdf", path: "spec.pdf" }),
      support: delivery.support,
      harnessName: "Pi",
      supportDeclared: Object.keys(modalities).length > 0,
      projected: delivery.projected,
    });
    assert.deepEqual(plan, { kind: "text-projection", modality: "pdf" });
  }
});

test("a PDF the harness and model both take natively is forwarded, not projected", () => {
  const delivery = effectiveAttachmentDelivery(caps({ pdf: "native" }), ["input:pdf"], false);
  assert.deepEqual(delivery.projected, []);
  const plan = planAttachmentDelivery({
    ref: ref({ mime: "application/pdf", path: "spec.pdf" }),
    support: delivery.support,
    harnessName: "Claude",
    projected: delivery.projected,
  });
  assert.deepEqual(plan, { kind: "native", modality: "pdf" });
});

test("a remote PDF Polyth cannot read is still refused", () => {
  const delivery = effectiveAttachmentDelivery(caps({ image: "native" }), undefined, true, false);
  assert.equal(delivery.support.pdf, undefined);
  assert.deepEqual(delivery.projected, []);
  assert.deepEqual(effectiveAttachmentDelivery(caps({ image: "native" }), undefined, true, true).projected, ["pdf"]);
});

test("unknown support never forwards a binary modality as native", () => {
  const plan = planAttachmentDelivery({
    ref: ref({ mime: "application/pdf", path: "spec.pdf" }),
    support: {},
    harnessName: "Legacy",
    supportDeclared: false,
  });
  assert.equal(plan.kind, "file-reference");
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

test("remote projects without materialization keep a file stored and say so", () => {
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
  assert.deepEqual(plan, { kind: "file-reference", modality: "file", storedOnly: true });
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

test("a PDF projects its text layer as one fenced section with page markers", () => {
  const projection = projectAttachmentPdf({
    path: "_inbox/spec.pdf",
    bytes: pagesPdf([linesContent(["Scope", "Ship PDF everywhere"]), linesContent(["Appendix"])]),
  });
  assert.equal(
    projection.ok && projection.section,
    [
      "Attached PDF: _inbox/spec.pdf (2 pages; text layer extracted by Polyth, images and layout omitted)",
      "```",
      "[Page 1]\nScope\nShip PDF everywhere\n\n[Page 2]\nAppendix",
      "```",
    ].join("\n"),
  );
});

test("a one-page PDF carries no page marker", () => {
  const projection = projectAttachmentPdf({ path: "a.pdf", bytes: pagesPdf([linesContent(["Only page"])]) });
  assert.equal(
    projection.ok && projection.section,
    "Attached PDF: a.pdf (1 page; text layer extracted by Polyth, images and layout omitted)\n```\nOnly page\n```",
  );
});

test("a long PDF keeps its head and states the truncation", () => {
  const lines = Array.from({ length: 50 }, (_, index) => `Paragraph ${index}`);
  const projection = projectAttachmentPdf({ path: "long.pdf", bytes: pagesPdf([linesContent(lines)]), maxBytes: 40 });
  assert.equal(projection.ok, true);
  assert.match(projection.ok ? projection.section : "", /Paragraph 0/);
  assert.doesNotMatch(projection.ok ? projection.section : "", /Paragraph 49/);
  assert.match(projection.ok ? projection.section : "", /\[truncated \d+ bytes; the PDF continues past this point\]$/);
});

test("an unreadable PDF is refused with a reason the user can act on", () => {
  const scan = projectAttachmentPdf({ path: "scan.pdf", bytes: pagesPdf(["q 1 0 0 1 0 0 cm Q"]) });
  assert.deepEqual(scan, {
    ok: false,
    code: "invalid-attachment",
    reason: "scan.pdf has no text layer (it may be a scan), so its text cannot be attached.",
  });
  const locked = projectAttachmentPdf({
    path: "locked.pdf",
    bytes: pagesPdf([linesContent(["x"])], { trailerExtra: "/Encrypt 9 0 R " }),
  });
  assert.match(locked.ok ? "" : locked.reason, /password-protected/);
  const broken = projectAttachmentPdf({ path: "broken.pdf", bytes: bytes("not a pdf") });
  assert.match(broken.ok ? "" : broken.reason, /not a readable PDF/);
});

test("the PDF projection ceiling is a stated, bounded number", () => {
  assert.equal(PDF_PROJECTION_MAX_BYTES, 128 * 1024);
});
