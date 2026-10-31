import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFileService } from "../src/index.ts";
import { createRemoteFileService } from "../src/remote.ts";
import { createExternalReadStore, DEFAULT_EXTERNAL_READ_POLICY, normalizeExternalReadPolicy, type ExternalReadPolicy } from "../src/externalReads.ts";
import { externalReadsRoute } from "../src/serverEntry.ts";

const forbidden = (err: { code?: string }) => err.code === "forbidden";

async function withDirs(fn: (dirs: { root: string; allowed: string; other: string }) => Promise<void>): Promise<void> {
  const base = await mkdtemp(path.join(tmpdir(), "polyth-external-"));
  const dirs = { root: path.join(base, "project"), allowed: path.join(base, "allowed"), other: path.join(base, "other") };
  try {
    for (const dir of Object.values(dirs)) await mkdir(dir);
    await fn(dirs);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test("outside the project only the owner's folders and file types are readable", async () => {
  await withDirs(async ({ root, allowed, other }) => {
    const policy: ExternalReadPolicy = { folders: [allowed], extensions: ["png", "txt"] };
    const files = createFileService({ externalReads: () => policy });
    await writeFile(path.join(allowed, "shot.png"), Buffer.from([1, 2, 3]));
    await writeFile(path.join(allowed, "id_rsa"), "key");
    await writeFile(path.join(allowed, "notes.md"), "md");
    await writeFile(path.join(other, "shot.png"), Buffer.from([4]));
    await writeFile(path.join(other, "secret.key"), "key");

    assert.deepEqual([...(await files.readRaw(root, path.join(allowed, "shot.png"))).data], [1, 2, 3]);
    await assert.rejects(files.readRaw(root, path.join(allowed, "id_rsa")), forbidden, "no extension");
    await assert.rejects(files.read(root, path.join(allowed, "notes.md")), forbidden, "type not listed");
    await assert.rejects(files.stat(root, path.join(other, "shot.png")), forbidden, "folder not listed");
    // A refusal never reveals whether the file exists.
    await assert.rejects(files.stat(root, path.join(other, "missing.png")), forbidden);
    await assert.rejects(files.stat(root, "/etc/hostname"), forbidden);

    // A link inside an allowed folder is judged by what it points at.
    await symlink(path.join(other, "shot.png"), path.join(allowed, "away.png"));
    await symlink(path.join(other, "secret.key"), path.join(allowed, "disguised.txt"));
    await assert.rejects(files.readRaw(root, path.join(allowed, "away.png")), forbidden);
    await assert.rejects(files.readRaw(root, path.join(allowed, "disguised.txt")), forbidden);

    // Writes never leave the project, whatever the policy allows.
    await assert.rejects(files.write(root, path.join(allowed, "shot.png"), "x"), /escapes/i);
  });
});

test("an absolute path inside the project is an ordinary project path", async () => {
  await withDirs(async ({ root, other }) => {
    const files = createFileService({ externalReads: () => ({ folders: [], extensions: [] }) });
    await writeFile(path.join(root, ".env"), "LOCAL=1");
    assert.equal((await files.read(root, path.join(root, ".env"))).content, "LOCAL=1");
    // ...and stays jailed: a project symlink out of it is still refused.
    await writeFile(path.join(other, "secret.txt"), "nope");
    await symlink(other, path.join(root, "link"));
    await assert.rejects(files.read(root, path.join(root, "link", "secret.txt")), /escapes/i);
  });
});

test("the slashless tmp/ fallback cannot climb out of /tmp", async () => {
  await withDirs(async ({ root }) => {
    const files = createFileService({ externalReads: () => DEFAULT_EXTERNAL_READ_POLICY });
    await assert.rejects(files.read(root, "tmp/../../etc/hostname"), /escapes/i);
    await assert.rejects(files.read(root, "tmp/../etc/hostname"), /escapes/i);
  });
});

test("remote reads outside the root follow the same folders and types", async () => {
  await withDirs(async ({ root, allowed, other }) => {
    const ran: string[] = [];
    const host = {
      exec: async (command: string) => { ran.push(command); return { code: 1, stdout: "", stderr: "" }; },
    } as unknown as Parameters<typeof createRemoteFileService>[0];
    const fs = createRemoteFileService(host, () => ({ folders: [allowed], extensions: ["png"] }));
    await assert.rejects(fs.stat(root, path.join(other, "a.png")), forbidden);
    await assert.rejects(fs.stat(root, path.join(allowed, "a.key")), forbidden);
    await assert.rejects(fs.stat(root, "../../etc/passwd"), forbidden);
    assert.equal(ran.length, 0, "a refused path never reaches the remote shell");
    await assert.rejects(fs.stat(root, path.join(allowed, "a.png")), /cannot stat/);
    assert.equal(ran.length, 1);
  });
});

test("policy input is validated, never silently trimmed", () => {
  assert.deepEqual(
    normalizeExternalReadPolicy({ folders: [" /srv/shots/ ", "/srv/shots"], extensions: [".PNG", "png", "md"] }),
    { folders: ["/srv/shots"], extensions: ["png", "md"] },
  );
  assert.throws(() => normalizeExternalReadPolicy({ folders: ["relative/dir"], extensions: [] }), /absolute/);
  assert.throws(() => normalizeExternalReadPolicy({ folders: [], extensions: ["p n g"] }), /extension/);
  assert.throws(() => normalizeExternalReadPolicy({ folders: "/tmp", extensions: [] }), /lists/);
  assert.deepEqual(normalizeExternalReadPolicy({ folders: [], extensions: [] }), { folders: [], extensions: [] });
});

test("the store persists the owner's policy and falls back to defaults", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "polyth-external-store-"));
  try {
    assert.deepEqual(createExternalReadStore(dir).get(), DEFAULT_EXTERNAL_READ_POLICY);
    createExternalReadStore(dir).set({ folders: ["/srv/shots"], extensions: ["png"] });
    assert.deepEqual(createExternalReadStore(dir).get(), { folders: ["/srv/shots"], extensions: ["png"] });
    await writeFile(path.join(dir, "external-reads.json"), "{broken");
    assert.deepEqual(createExternalReadStore(dir).get(), DEFAULT_EXTERNAL_READ_POLICY);
    assert.match(await readFile(path.join(dir, "external-reads.json"), "utf8"), /broken/, "a bad file is left for the owner, not overwritten");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("only the instance owner may change the policy", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "polyth-external-route-"));
  try {
    const route = externalReadsRoute(createExternalReadStore(dir));
    const call = async (method: string, instanceOwner: boolean, body: unknown = {}) => {
      let status = 0;
      let payload: unknown;
      const handled = await route({
        path: "/api/files/external-reads",
        method,
        space: { spaceId: "s1", role: "owner", instanceOwner },
        principal: { kind: "ui-session" },
        body: async () => body,
        json: (code: number, value: unknown) => { status = code; payload = value; },
      } as unknown as Parameters<typeof route>[0]);
      return { handled, status, payload: payload as { editable?: boolean; folders?: string[] } };
    };
    const member = await call("GET", false);
    assert.equal(member.status, 200);
    assert.equal(member.payload.editable, false);
    // A Space owner who is not the instance owner is still refused.
    await assert.rejects(call("PUT", false, { folders: ["/"], extensions: ["key"] }), forbidden);
    assert.deepEqual(createExternalReadStore(dir).get(), DEFAULT_EXTERNAL_READ_POLICY);
    const owner = await call("PUT", true, { folders: ["/srv/shots"], extensions: ["png"] });
    assert.deepEqual(owner.payload.folders, ["/srv/shots"]);
    assert.equal(owner.payload.editable, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a write never follows a project symlink out of the project", async () => {
  await withDirs(async ({ root, other }) => {
    const files = createFileService();
    await writeFile(path.join(other, "victim.txt"), "ORIGINAL");
    await symlink(path.join(other, "victim.txt"), path.join(root, "readme.txt"));
    await assert.rejects(files.write(root, "readme.txt", "PWNED"), /escapes/i);
    assert.equal(await readFile(path.join(other, "victim.txt"), "utf8"), "ORIGINAL");
    // A dangling link would create the file outside.
    await symlink(path.join(other, "created.txt"), path.join(root, "dangling.txt"));
    await assert.rejects(files.writeBytes(root, "dangling.txt", Buffer.from("NEW")), /escapes/i);
    await assert.rejects(readFile(path.join(other, "created.txt")), { code: "ENOENT" });
    // Ordinary new files still write.
    await files.write(root, "dir/new.txt", "ok");
    assert.equal(await readFile(path.join(root, "dir", "new.txt"), "utf8"), "ok");
  });
});
