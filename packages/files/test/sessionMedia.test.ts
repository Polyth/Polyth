// Session-lifetime chat media preservation. A chat image is a project-relative
// path resolved against the session's current execution root; when an isolated
// session is merged/discarded its worktree is deleted, so a referenced file
// that only lived there must be carried into the destination checkout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@polyth/contracts";
import { createFileService } from "../src/index.ts";
import { createSessionMediaService } from "../src/serverEntry.ts";
import {
  mediaPathsInDataFile,
  MAX_SESSION_MEDIA_BYTES,
  preserveSessionMedia,
  referencedSessionMediaPaths,
} from "../src/sessionMedia.ts";

const event = (type: string, data: Record<string, unknown>, seq: number): SessionEvent => ({
  id: `e${seq}`,
  sessionId: "s1",
  seq,
  time: seq,
  type,
  data: data as SessionEvent["data"],
  v: 1,
});

test("referencedSessionMediaPaths reads ui block rows, options, markdown and attachments", () => {
  const text = [
    "Here is the result.",
    "```ui",
    "media SSH server page: before / after",
    "- .scratch/pi-remote-config/before.png | Before",
    "- .scratch/pi-remote-config/after.png | After",
    "```",
    "",
    "```ui",
    "cards Shops image=assets/logo.webp",
    "- https://example.com/a.jpg | Remote | stays | $1",
    "```",
    "",
    "![inline](./docs/diagram.png)",
  ].join("\n");
  const paths = referencedSessionMediaPaths([
    event("assistant/message", { partId: "p", text }, 1),
    event("user/message", { text: "look", attachments: [{ id: "a", name: "shot.png", mime: "image/png", size: 3, kind: "image", path: "_inbox/a-shot.png" }] }, 2),
    event("tool/result", { callId: "c", tool: "t", output: "ignore .scratch/not-referenced.png" }, 3),
  ]);
  // Order within one message follows the scan (markdown, then fences), so
  // assert the set and the de-duplication instead of a brittle global order.
  assert.deepEqual([...paths].sort(), [
    ".scratch/pi-remote-config/after.png",
    ".scratch/pi-remote-config/before.png",
    "_inbox/a-shot.png",
    "assets/logo.webp",
    "docs/diagram.png",
  ]);
  assert.equal(new Set(paths).size, paths.length);
  // The unreferenced tool output never contributes a path.
  assert.ok(!paths.includes(".scratch/not-referenced.png"));
});

test("referencedSessionMediaPaths keeps the from= data file a block renders", () => {
  const text = [
    "```ui",
    "cards Big · from=.scratch/data.json",
    "```",
    "```ui",
    "cards Chart from=", // unterminated option is not a path
    "```",
  ].join("\n");
  assert.deepEqual(
    referencedSessionMediaPaths([event("assistant/message", { partId: "p", text }, 1)]),
    [".scratch/data.json"],
  );
});

test("mediaPathsInDataFile reads bounded top-level image fields", () => {
  assert.deepEqual(mediaPathsInDataFile(JSON.stringify([
    { image: "img/a.png", title: "A" },
    { photo: "./img/b.webp" },
    { title: "no image" },
    "img/c.jpg",
    ["img/d.gif", "D"],
    { image: "https://host/e.png", title: "remote" },
  ]), "json"), ["img/a.png", "img/b.webp", "img/c.jpg", "img/d.gif"]);
  assert.deepEqual(mediaPathsInDataFile(JSON.stringify({ rows: [{ image: "img/a.png" }] }), "json"), ["img/a.png"]);
  assert.deepEqual(mediaPathsInDataFile(JSON.stringify({ image: "img/one.png" }), "json"), ["img/one.png"]);
  assert.deepEqual(mediaPathsInDataFile("{\"image\":\"img/a.png\"}\nnot json\n{\"image\":\"img/b.png\"}\n", "jsonl"), ["img/a.png", "img/b.png"]);
  assert.deepEqual(mediaPathsInDataFile("title,image\nA,img/a.png\nB,img/b.png\n", "csv"), ["img/a.png", "img/b.png"]);
  assert.deepEqual(mediaPathsInDataFile("image,title\nimg/a.png,A\n", "csv"), ["img/a.png"]);
  assert.deepEqual(mediaPathsInDataFile("", "json"), []);
});

test("referencedSessionMediaPaths rejects traversal, absolute, URL and non-image tokens", () => {
  const text = [
    "```ui",
    "- ../secret.png | escape",
    "- /etc/passwd | absolute",
    "- https://host/x.png | remote",
    "- src/app.ts | not media",
    "- a/../../b.png | traversal",
    "```",
    "![proto](javascript:alert(1))",
  ].join("\n");
  assert.deepEqual(referencedSessionMediaPaths([event("assistant/message", { partId: "p", text }, 1)]), []);
});

test("preserveSessionMedia copies only referenced files missing at the destination", async () => {
  const source = new Map<string, Uint8Array>([
    [".scratch/a.png", new Uint8Array([1, 2, 3])],
    [".scratch/b.png", new Uint8Array([4, 5, 6])],
  ]);
  const destination = new Map<string, Uint8Array>([
    [".scratch/b.png", new Uint8Array([9])],
  ]);
  const result = await preserveSessionMedia({
    paths: [".scratch/a.png", ".scratch/b.png", ".scratch/gone.png"],
    sourceRoot: "wt",
    destinationRoot: "root",
    exists: async (root, rel) => (root === "wt" ? source : destination).has(rel),
    read: async (root, rel) => (root === "wt" ? source : destination).get(rel) ?? null,
    write: async (root, rel, data) => {
      assert.equal(root, "root");
      destination.set(rel, data);
    },
  });
  assert.deepEqual(result.copied, [".scratch/a.png"]);
  assert.deepEqual(result.skipped, [".scratch/b.png"]);
  assert.deepEqual(result.missing, [".scratch/gone.png"]);
  // The destination's newer bytes are never overwritten.
  assert.deepEqual([...destination.get(".scratch/b.png")!], [9]);
  assert.deepEqual([...destination.get(".scratch/a.png")!], [1, 2, 3]);
});

test("preserveSessionMedia refuses traversal, oversized and unreadable files without throwing", async () => {
  const seen: string[] = [];
  const result = await preserveSessionMedia({
    paths: ["../escape.png", "big.png", "boom.png"],
    sourceRoot: "wt",
    destinationRoot: "root",
    exists: async (_root, rel) => rel !== "../escape.png" && rel !== "boom.png" && rel !== "big.png",
    read: async (_root, rel) => {
      if (rel === "boom.png") throw new Error("EIO");
      if (rel === "big.png") return new Uint8Array(MAX_SESSION_MEDIA_BYTES + 1);
      return new Uint8Array([1]);
    },
    write: async (_root, rel) => { seen.push(rel); },
  });
  assert.deepEqual(result.copied, []);
  assert.deepEqual(result.missing, ["../escape.png", "big.png", "boom.png"]);
  assert.deepEqual(seen, []);
});

test("preserveSessionMedia copies only the paths Git reports ignored", async () => {
  const copied: string[] = [];
  const result = await preserveSessionMedia({
    paths: ["docs/shot.png", ".scratch/shot.png"],
    sourceRoot: "wt",
    destinationRoot: "root",
    // Only the worktree holds the files; an existing destination is skipped.
    exists: async (root) => root === "wt",
    read: async () => new Uint8Array([1]),
    write: async (_root, rel) => { copied.push(rel); },
    ignored: async (paths) => paths.filter((rel) => rel.startsWith(".scratch/")),
  });
  assert.deepEqual(copied, [".scratch/shot.png"]);
  assert.deepEqual(result.copied, [".scratch/shot.png"]);
  assert.deepEqual(result.notIgnored, ["docs/shot.png"]);
});

test("createSessionMediaService carries history-referenced media between real checkouts", async () => {
  const base = mkdtempSync(join(tmpdir(), "polyth-session-media-"));
  try {
    const worktree = join(base, "worktree");
    const root = join(base, "project");
    mkdirSync(join(worktree, ".scratch"), { recursive: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(worktree, ".scratch", "after.png"), "png-bytes");
    // A second referenced file the destination already holds (a committed file):
    // it must be left untouched, never overwritten by the worktree copy.
    writeFileSync(join(worktree, ".scratch", "tracked.png"), "worktree-version");
    mkdirSync(join(root, ".scratch"), { recursive: true });
    writeFileSync(join(root, ".scratch", "tracked.png"), "root-version");

    const files = createFileService();
    const events: SessionEvent[] = [{
      id: "e1",
      sessionId: "s1",
      seq: 1,
      time: 1,
      type: "assistant/message",
      data: {
        partId: "p",
        text: [
          "```ui",
          "media Shots",
          "- .scratch/after.png | After",
          "- .scratch/tracked.png | Tracked",
          "```",
        ].join("\n"),
      } as SessionEvent["data"],
      v: 1,
    }];
    const service = createSessionMediaService(async () => files, async () => events);
    const result = await service.preserve({ sessionIds: ["s1"], projectId: "p", sourceRoot: worktree, destinationRoot: root });
    assert.deepEqual(result.copied, [".scratch/after.png"]);
    assert.deepEqual(result.skipped, [".scratch/tracked.png"]);
    assert.equal(readFileSync(join(root, ".scratch", "after.png"), "utf8"), "png-bytes");
    assert.equal(readFileSync(join(root, ".scratch", "tracked.png"), "utf8"), "root-version");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("createSessionMediaService expands from= rows and unions parent + child history", async () => {
  const base = mkdtempSync(join(tmpdir(), "polyth-session-media-from-"));
  try {
    const worktree = join(base, "worktree");
    const root = join(base, "project");
    mkdirSync(join(worktree, ".scratch", "img"), { recursive: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(worktree, ".scratch", "data.json"), JSON.stringify([
      { image: ".scratch/img/a.png", title: "A" },
      { image: ".scratch/img/b.png", title: "B" },
    ]));
    for (const name of ["a.png", "b.png", "child.png"]) {
      writeFileSync(join(worktree, ".scratch", "img", name), "png");
    }
    // Parent history: the block renders from the data file; child history: its
    // own screenshot. Both ran in this checkout and rebind to the destination.
    const parent: SessionEvent[] = [{
      id: "p1", sessionId: "parent", seq: 1, time: 1, type: "assistant/message",
      data: { partId: "p", text: "```ui\ncards Big · from=.scratch/data.json\n```" } as SessionEvent["data"],
      v: 1,
    }];
    const child: SessionEvent[] = [{
      id: "c1", sessionId: "child", seq: 1, time: 1, type: "assistant/message",
      data: { partId: "c", text: "```ui\nmedia Child\n- .scratch/img/child.png | Child\n```" } as SessionEvent["data"],
      v: 1,
    }];
    const files = createFileService();
    const service = createSessionMediaService(
      async () => files,
      async (sessionId) => sessionId === "parent" ? parent : child,
    );
    const result = await service.preserve({ sessionIds: ["parent", "child"], projectId: "p", sourceRoot: worktree, destinationRoot: root });
    assert.deepEqual(result.copied.slice().sort(), [
      ".scratch/data.json",
      ".scratch/img/a.png",
      ".scratch/img/b.png",
      ".scratch/img/child.png",
    ]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
