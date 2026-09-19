import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGalleryMessage,
  describeAnnotation,
  galleryFolderLabel,
  galleryPathCrumbs,
  imageExtension,
  imageMimeOf,
  isImagePath,
  normalizeDragRect,
  normalizeGalleryPath,
  parentGalleryPath,
  parseAnnotations,
  type GalleryAnnotation,
} from "../src/shared.ts";

test("image paths classify by extension case-insensitively", () => {
  assert.equal(imageExtension("a/b/Frame_01.PNG"), "png");
  assert.equal(imageMimeOf("a/b/Frame_01.PNG"), "image/png");
  assert.equal(isImagePath("outputs/frame.webp"), true);
  assert.equal(isImagePath("src/main.ts"), false);
  assert.equal(isImagePath("no-extension"), false);
  assert.equal(isImagePath(".gitignore"), false);
});

test("normalizeGalleryPath rejects escape attempts and keeps folders relative", () => {
  assert.equal(normalizeGalleryPath(""), "");
  assert.equal(normalizeGalleryPath("."), "");
  assert.equal(normalizeGalleryPath("outputs/raw"), "outputs/raw");
  assert.equal(normalizeGalleryPath("/etc/passwd"), null);
  assert.equal(normalizeGalleryPath("../secrets"), null);
  assert.equal(normalizeGalleryPath("a/../b"), null);
  assert.equal(normalizeGalleryPath("a\\b"), null);
  assert.equal(normalizeGalleryPath("C:/Windows"), null);
});

test("parent and label walk a project-relative folder", () => {
  assert.equal(parentGalleryPath("outputs/raw"), "outputs");
  assert.equal(parentGalleryPath("outputs"), "");
  assert.equal(parentGalleryPath(""), null);
  assert.equal(galleryFolderLabel("outputs/raw"), "raw");
  assert.equal(galleryFolderLabel(""), "Project root");
  assert.deepEqual(galleryPathCrumbs("a/b/c"), [
    { label: "a", path: "a" },
    { label: "b", path: "a/b" },
    { label: "c", path: "a/b/c" },
  ]);
  assert.deepEqual(galleryPathCrumbs(""), []);
});

test("normalizeDragRect orders drag corners and clamps to the image box", () => {
  assert.deepEqual(normalizeDragRect({ x0: 0.8, y0: 0.9, x1: 0.2, y1: 0.3 }), {
    x: 0.2,
    y: 0.3,
    w: 0.6000000000000001,
    h: 0.6000000000000001,
  });
  assert.deepEqual(normalizeDragRect({ x0: -1, y0: -1, x1: 2, y1: 2 }), { x: 0, y: 0, w: 1, h: 1 });
});

test("parseAnnotations keeps valid notes and drops malformed entries", () => {
  const parsed = parseAnnotations([
    { id: "note-1", kind: "point", x: 0.5, y: 0.25, comment: "hand" },
    { id: "note-2", kind: "rect", x: 0.1, y: 0.1, w: 0.2, h: 0.2, comment: 42 },
    { id: "bad id!", kind: "point", x: 0.5, y: 0.5 },
    { id: "note-3", kind: "circle", x: 0.5, y: 0.5 },
    { id: "note-4", kind: "point", x: "nope", y: 0.5 },
    "not an object",
  ]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.id, "note-1");
  assert.equal(parsed[1]?.comment, "");
  assert.equal(parsed[1]?.w, 0.2);
});

test("describeAnnotation is human-readable normalized geometry", () => {
  const point: GalleryAnnotation = { id: "p", kind: "point", x: 0.5, y: 0.25, w: 0, h: 0, comment: "" };
  const rect: GalleryAnnotation = { id: "r", kind: "rect", x: 0.1, y: 0.2, w: 0.3, h: 0.4, comment: "" };
  assert.equal(describeAnnotation(point), "point at 50.0% × 25.0%");
  assert.equal(describeAnnotation(rect), "zone x 10.0%–40.0%, y 20.0%–60.0%");
});

test("buildGalleryMessage names images, paths, and notes", () => {
  const message = buildGalleryMessage({
    folder: "outputs/raw",
    instruction: "Fix the hands.",
    images: [
      {
        path: "outputs/raw/a.png",
        name: "a.png",
        annotations: [{ id: "n1", kind: "rect", x: 0.1, y: 0.2, w: 0.2, h: 0.2, comment: "six fingers" }],
      },
      { path: "outputs/raw/b.png", name: "b.png", annotations: [] },
    ],
  });
  assert.match(message, /outputs\/raw/);
  assert.match(message, /Fix the hands\./);
  assert.match(message, /a\.png \(`outputs\/raw\/a\.png`\)/);
  assert.match(message, /six fingers/);
  assert.match(message, /2\. b\.png/);
  assert.match(message, /\(no notes\)/);
});

test("buildGalleryMessage falls back to a default label for the project root", () => {
  const message = buildGalleryMessage({ folder: "", instruction: "", images: [
    { path: "x.png", name: "x.png", annotations: [{ id: "n", kind: "point", x: 0.5, y: 0.5, w: 0, h: 0, comment: "" }] },
  ] });
  assert.match(message, /project root/);
  assert.doesNotMatch(message, /undefined/);
});
