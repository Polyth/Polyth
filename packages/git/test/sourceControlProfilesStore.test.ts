import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceContext } from "@polyth/contracts";
import { SSH_KEY_PASSPHRASE_MESSAGE, applySshKey, createSourceControlProfilesStore, getSshKey, listSshKeys, testSshKey, validateIdentityFile } from "../src/sourceControlProfilesStore.ts";

test("profiles store, ssh key validation, sshCommand and key listing", async () => {
  const root = mkdtempSync(join(tmpdir(), "scp-"));
  try {
    const home = join(root, "home"), ssh = join(home, ".ssh"), outside = join(root, "outside");
    mkdirSync(ssh, { recursive: true }); writeFileSync(outside, "k");
    writeFileSync(join(ssh, "id_a"), "k"); writeFileSync(join(ssh, "id_a.pub"), "ssh-ed25519 AAAA me@host\n");
    writeFileSync(join(ssh, "lonely"), "k"); symlinkSync(outside, join(ssh, "esc"));
    const key = join(ssh, "id_a");
    assert.equal(validateIdentityFile(key, home), key);
    for (const bad of [`${key}.pub`, "-x", join(ssh, "..", "..", "outside"), join(ssh, "esc"), "rel", join(ssh, "a b"), join(ssh, "nope")]) {
      assert.throws(() => validateIdentityFile(bad, home), (e: { code?: string }) => e.code === "invalid-input", bad);
    }
    assert.deepEqual(listSshKeys(home), [{ path: key, name: "id_a", comment: "me@host" }]);

    const store = createSourceControlProfilesStore((space) => ({ root, path: (p) => join(root, space.spaceId, p), packageDir: (id) => {
      const d = join(root, space.spaceId, id); mkdirSync(d, { recursive: true }); return d;
    } }), home);
    const a = { spaceId: "a" } as SpaceContext, b = { spaceId: "b" } as SpaceContext;
    assert.equal(store.read(a).revision, 0);
    const state = { profiles: [{ id: "p", label: "P", provider: "github", authentication: { mode: "ssh-key", identityFile: key } }], globalDefaultProfileId: "p", repositoryProfileIds: { proj: "p", x: "ghost" } };
    const saved = store.save(a, state, 0);
    assert.equal(saved.revision, 1);
    assert.deepEqual(saved.state.repositoryProfileIds, { proj: "p" });
    assert.equal(store.read(b).state.profiles.length, 0);
    rmSync(key);
    assert.equal(store.read(a).state.profiles[0]!.authentication.identityFile, key, "a deleted key keeps the state readable");
    writeFileSync(key, "k");
    assert.throws(() => store.save(a, state, 0), (e: { code?: string }) => e.code === "conflict");
    assert.throws(() => store.save(a, { profiles: [{ id: "p", label: "P", authentication: { mode: "ssh-key", identityFile: outside } }] }, 1), /inside ~\/\.ssh/);

    const repo = join(root, "repo"); mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    await applySshKey(repo, key, home);
    assert.equal(await getSshKey(repo), key);
    await applySshKey(repo, undefined, home);
    assert.equal(await getSshKey(repo), key);
    await applySshKey(repo, null, home);
    assert.equal(await getSshKey(repo), null);
    execFileSync("git", ["-C", repo, "config", "core.sshCommand", "ssh -i /mine"]);
    await applySshKey(repo, null, home);
    assert.equal(execFileSync("git", ["-C", repo, "config", "core.sshCommand"], { encoding: "utf8" }).trim(), "ssh -i /mine");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ssh key test ignores ~/.ssh/config identities and explains passphrase-protected keys", async () => {
  const root = mkdtempSync(join(tmpdir(), "scp-ssh-"));
  const path = process.env.PATH;
  try {
    const home = join(root, "home"), ssh = join(home, ".ssh"), bin = join(root, "bin"), argsLog = join(root, "args");
    mkdirSync(ssh, { recursive: true }); mkdirSync(bin);
    const key = join(ssh, "id_a"); writeFileSync(key, "k"); writeFileSync(`${key}.pub`, "ssh-ed25519 AAAA me@host\n");
    const fake = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
    process.env.PATH = `${bin}:${path}`;

    fake("ssh", `echo "$@" > ${argsLog}; echo "Hi bob! You've successfully authenticated" >&2; exit 1`);
    assert.deepEqual(await testSshKey(key, "github.com", home), { ok: true, account: "bob", message: "Hi bob! You've successfully authenticated" });
    assert.match(readFileSync(argsLog, "utf8"), /-F \/dev\/null .*-i \S+id_a git@github\.com/, "user ssh config cannot add fallback identities");

    fake("ssh", `echo "git@github.com: Permission denied (publickey)." >&2; exit 255`);
    fake("ssh-keygen", `echo "Load key: incorrect passphrase supplied to decrypt private key" >&2; exit 0`);
    assert.deepEqual(await testSshKey(key, "github.com", home), { ok: false, message: SSH_KEY_PASSPHRASE_MESSAGE });
    fake("ssh-keygen", "echo ssh-ed25519 AAAA; exit 0");
    assert.deepEqual(await testSshKey(key, "github.com", home), { ok: false, message: "git@github.com: Permission denied (publickey)." });
  } finally { process.env.PATH = path; rmSync(root, { recursive: true, force: true }); }
});
