// Attachments have no size limit: a big file uploads in pieces, and the desktop
// app on the server's own computer attaches a file where it sits.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProjectService, RequestIngress, RouteRequest, SessionService } from "@polyth/contracts";
import { createFileService, MAX_RAW_BYTES, uploadStagingPath } from "../src/index.ts";
import { createAttachmentSourceService, FILES_REMOTE_ACCESS, workspaceRoutes } from "../src/serverEntry.ts";

const withDirs = async (run: (dirs: { root: string; other: string }) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(path.join(tmpdir(), "polyth-upload-root-"));
  const other = await mkdtemp(path.join(tmpdir(), "polyth-upload-other-"));
  try {
    await run({ root, other });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
};

const code = (expected: string) => (error: { code?: string }) => error.code === expected;

test("pieces gather out of sight and the last one puts the whole file in place", async () => {
  await withDirs(async ({ root }) => {
    const files = createFileService();
    const bytes = Buffer.from("0123456789abcdef");
    const piece = (offset: number, end: number) => ({ offset, total: bytes.length, data: bytes.subarray(offset, end) });

    assert.deepEqual(await files.writeBytesPart(root, "_inbox/big.bin", piece(0, 6)), { size: 6, done: false });
    await assert.rejects(stat(path.join(root, "_inbox/big.bin")), { code: "ENOENT" }, "no half file at its own name");
    assert.equal(uploadStagingPath("_inbox/big.bin"), "_inbox/.big.bin.polyth-upload");
    // The same piece again (its reply was lost) is accepted without appending.
    assert.deepEqual(await files.writeBytesPart(root, "_inbox/big.bin", piece(0, 6)), { size: 6, done: false });
    assert.deepEqual(await files.writeBytesPart(root, "_inbox/big.bin", piece(6, 12)), { size: 12, done: false });
    assert.deepEqual(await files.writeBytesPart(root, "_inbox/big.bin", piece(6, 12)), { size: 12, done: false });
    // A piece that skips ahead says how much the server has.
    await assert.rejects(
      files.writeBytesPart(root, "_inbox/big.bin", { offset: 14, total: bytes.length, data: bytes.subarray(14) }),
      (error: { code?: string; size?: number }) => error.code === "conflict" && error.size === 12,
    );
    assert.deepEqual(await files.writeBytesPart(root, "_inbox/big.bin", piece(12, 16)), { size: 16, done: true });
    assert.equal(await readFile(path.join(root, "_inbox/big.bin"), "utf8"), "0123456789abcdef");
    await assert.rejects(stat(path.join(root, uploadStagingPath("_inbox/big.bin"))), { code: "ENOENT" });
    // The last piece's reply was lost: sending it again reports the finished file.
    assert.deepEqual(await files.writeBytesPart(root, "_inbox/big.bin", piece(12, 16)), { size: 16, done: true });
    // A different last piece is not mistaken for the stored one.
    await assert.rejects(
      files.writeBytesPart(root, "_inbox/big.bin", { offset: 12, total: 16, data: Buffer.from("zzzz") }),
      code("conflict"),
    );
  });
});

test("a link planted at the staging name never carries a piece out of the project", async () => {
  await withDirs(async ({ root, other }) => {
    const files = createFileService();
    await writeFile(path.join(other, "victim.txt"), "ORIGINAL");
    await mkdir(path.join(root, "_inbox"));
    await symlink(path.join(other, "victim.txt"), path.join(root, uploadStagingPath("_inbox/x.bin")));
    for (const offset of [0, 8]) {
      await assert.rejects(files.writeBytesPart(root, "_inbox/x.bin", { offset, total: 16, data: Buffer.alloc(8, 1) }));
    }
    assert.equal(await readFile(path.join(other, "victim.txt"), "utf8"), "ORIGINAL");
    await assert.rejects(files.writeBytesPart(root, "../escape.bin", { offset: 0, total: 1, data: Buffer.from("x") }));
  });
});

test("a staged attachment bigger than the in-memory cap is copied into a worktree", async () => {
  await withDirs(async ({ root, other }) => {
    const files = createFileService();
    const rel = "_inbox/0000-huge.bin";
    await mkdir(path.join(root, "_inbox"));
    await writeFile(path.join(root, rel), "");
    await truncate(path.join(root, rel), MAX_RAW_BYTES + 1);
    const service = createAttachmentSourceService(async () => files);
    assert.deepEqual(
      await service.materialize({ projectId: "p1", projectRoot: root, execRoot: other, rel }),
      { kind: "file", size: MAX_RAW_BYTES + 1 },
    );
    assert.equal((await stat(path.join(other, rel))).size, MAX_RAW_BYTES + 1);
  });
});

test("a file on the server's own disk is placed in _inbox without being sent", async () => {
  await withDirs(async ({ root, other }) => {
    const data = path.join(other, "data");
    await mkdir(data);
    const files = createFileService({ sealedRoots: () => [data] });
    const source = path.join(other, "Downloads", "archive.zip");
    await mkdir(path.dirname(source));
    await writeFile(source, "zip bytes");
    const { size, mtimeMs } = await stat(source);

    assert.deepEqual(await files.placeLocalFile!(root, "_inbox/1-archive.zip", source, { size, mtimeMs }), { size });
    assert.equal(await readFile(path.join(root, "_inbox/1-archive.zip"), "utf8"), "zip bytes");
    assert.equal(await readFile(source, "utf8"), "zip bytes", "the original stays where it was");

    await assert.rejects(files.placeLocalFile!(root, "_inbox/1-archive.zip", source, { size }), code("conflict"), "never overwrites");
    await assert.rejects(files.placeLocalFile!(root, "_inbox/2.zip", source, { size: size + 1 }), code("conflict"), "a different file");
    await assert.rejects(files.placeLocalFile!(root, "_inbox/3.zip", source, { size, mtimeMs: mtimeMs - 60_000 }), code("conflict"));
    await assert.rejects(files.placeLocalFile!(root, "_inbox/4.zip", "Downloads/archive.zip", { size }), code("invalid-input"));
    await assert.rejects(files.placeLocalFile!(root, "_inbox/5.zip", path.dirname(source), { size: 0 }), code("invalid-input"));
    await assert.rejects(files.placeLocalFile!(root, "_inbox/6.zip", path.join(other, "missing.zip"), { size: 0 }), code("not-found"));
    // The server's own data (everyone's private chats) is never placed.
    await writeFile(path.join(data, "sessions.db"), "private");
    const sealedLink = path.join(other, "innocent.db");
    await symlink(path.join(data, "sessions.db"), sealedLink);
    for (const sealed of [path.join(data, "sessions.db"), sealedLink]) {
      await assert.rejects(files.placeLocalFile!(root, "_inbox/7.db", sealed, { size: 7 }), code("not-found"));
    }
    await assert.rejects(stat(path.join(root, "_inbox/7.db")), { code: "ENOENT" });
  });
});

test("upload routes: pieces from anyone with files.write, a path only from the owner on this computer", async () => {
  await withDirs(async ({ root, other }) => {
    const projects = {
      get: async (id: string) => id === "p1" ? { id, path: root, name: "repo" } : undefined,
    } as unknown as ProjectService;
    const route = workspaceRoutes({ projects, sessions: {} as SessionService, files: createFileService() });
    const call = async (
      routePath: string,
      body: Record<string, unknown>,
      who: { ingress?: RequestIngress; instanceOwner?: boolean } = {},
    ) => {
      let payload: unknown;
      await route({
        path: routePath,
        method: "POST",
        url: new URL(`https://polyth.test${routePath}`),
        ingress: who.ingress ?? { kind: "public-http", listenerId: "l", loopback: true, secure: false },
        principal: { kind: "ui-session", sessionId: "u", rememberedDeviceId: "d" },
        space: { spaceId: "s1", role: "owner", instanceOwner: who.instanceOwner ?? true },
        body: async () => body,
        json: (_code: number, value: unknown) => { payload = value; },
      } as unknown as RouteRequest);
      return payload;
    };

    const bytes = Buffer.from("piece-one|piece-two");
    const part = (offset: number, end: number) => ({
      projectId: "p1", path: "_inbox/9-two.txt", offset, total: bytes.length, base64: bytes.subarray(offset, end).toString("base64"),
    });
    assert.deepEqual(await call("/api/files/upload-part", part(0, 10)), { ok: true, size: 10, done: false });
    assert.deepEqual(await call("/api/files/upload-part", part(10, bytes.length)), { ok: true, size: bytes.length, done: true });
    assert.equal(await readFile(path.join(root, "_inbox/9-two.txt"), "utf8"), "piece-one|piece-two");
    await assert.rejects(call("/api/files/upload-part", { ...part(0, 10), offset: -1 }), code("invalid-input"));
    await assert.rejects(call("/api/files/upload-part", { ...part(0, 10), total: 4 }), code("invalid-input"));

    const source = path.join(other, "movie.mp4");
    await writeFile(source, "frames");
    const local = { projectId: "p1", path: "_inbox/10-movie.mp4", source, size: 6 };
    const refused: Array<{ ingress?: RequestIngress; instanceOwner?: boolean }> = [
      { instanceOwner: false },
      { ingress: { kind: "polyth-link", connectionId: "c", transport: "relay" } },
      { ingress: { kind: "public-http", listenerId: "l", loopback: false, secure: true } },
      { ingress: { kind: "public-http", listenerId: "l", loopback: true, secure: false, proxied: true } },
    ];
    for (const who of refused) {
      await assert.rejects(call("/api/files/upload-local", local, who), code("forbidden"));
    }
    await assert.rejects(call("/api/files/upload-local", { ...local, path: "movie.mp4" }), code("invalid-input"));
    await assert.rejects(stat(path.join(root, "_inbox/10-movie.mp4")), { code: "ENOENT" });
    assert.deepEqual(await call("/api/files/upload-local", local), { ok: true, size: 6 });
    assert.equal(await readFile(path.join(root, "_inbox/10-movie.mp4"), "utf8"), "frames");
  });
});

test("a paired device may upload pieces but never name a path on the server", () => {
  const rule = (routePath: string) => FILES_REMOTE_ACCESS.http.find((entry) => entry.path === routePath);
  assert.deepEqual(
    (({ methods, capability, mutation }) => ({ methods, capability, mutation }))(rule("/api/files/upload-part")!),
    { methods: ["POST"], capability: "files.write", mutation: true },
  );
  assert.equal(rule("/api/files/upload-local"), undefined);
});
