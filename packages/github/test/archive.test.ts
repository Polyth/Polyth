import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGithubArchiveDownloader, type ArchiveExec } from "../src/archive.ts";

const source = "https://github.com/example-org/polyth-homeassistant";
const maxBytes = 32 * 1024 * 1024;
const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff]);
const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
const sshAuthenticated = () => Object.assign(new Error("SSH exits 1"), {
  code: 1, stderr: "Hi example! You've successfully authenticated, but GitHub does not provide shell access.",
});

test("GitHub archives use the existing CLI account before checking SSH", async () => {
  const calls: string[] = [];
  const download = createGithubArchiveDownloader({ exec: async (bin, args, opts) => {
    calls.push(bin);
    assert.deepEqual(args, ["api", "--hostname", "github.com", "--method", "GET", "repos/example-org/polyth-homeassistant/zipball/HEAD"]);
    assert.equal(opts.maxBytes, maxBytes);
    assert.equal(opts.timeoutMs, 60_000);
    return zip;
  } });
  assert.deepEqual(await download(source, maxBytes), zip);
  assert.deepEqual(calls, ["gh"]);
});

for (const ghFailure of [missing(), Object.assign(new Error("unsigned in"), { stderr: "To get started, run gh auth login." })]) {
  test(`SSH keys are used when gh is ${"code" in ghFailure ? "missing" : "unsigned in"}`, async () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    let staging = "";
    const exec: ArchiveExec = async (bin, args, opts) => {
      calls.push({ bin, args });
      if (bin === "gh") throw ghFailure;
      if (bin === "ssh" && args[0] === "-G") return Buffer.from("identityagent /fixture/agent\n");
      if (bin === "ssh-add") return Buffer.from("256 public-key-fingerprint (ED25519)\n");
      if (bin === "ssh") {
        assert.deepEqual(args, ["-T", "-oBatchMode=yes", "-oStrictHostKeyChecking=yes", "-oConnectTimeout=10", "git@github.com"]);
        throw sshAuthenticated();
      }
      assert.equal(bin, "git");
      assert.equal(opts.diskLimit?.bytes, maxBytes * 4);
      staging = opts.cwd!;
      assert.equal(existsSync(staging), true);
      assert.ok(args.includes("protocol.allow=never"));
      assert.ok(args.includes("protocol.ssh.allow=always"));
      assert.ok(args.some(arg => arg.startsWith("core.hooksPath=")));
      if (args.includes("fetch")) {
        assert.deepEqual(args.slice(args.indexOf("fetch")), ["fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", "--", "ssh://git@github.com/example-org/polyth-homeassistant.git", "HEAD"]);
      }
      if (args.includes("archive")) {
        assert.equal(opts.maxBytes, maxBytes);
        assert.deepEqual(args.slice(args.indexOf("archive")), ["archive", "--format=zip", "FETCH_HEAD"]);
        return zip;
      }
      return Buffer.alloc(0);
    };
    assert.deepEqual(await createGithubArchiveDownloader({ exec })(source, maxBytes), zip);
    assert.deepEqual(calls.map(call => call.bin), ["gh", "ssh", "ssh-add", "ssh", "git", "git", "git"]);
    assert.equal(existsSync(staging), false);
  });
}

test("only missing gh authentication and missing SSH credentials permit anonymous download", async () => {
  for (const sshFailure of [missing(), Object.assign(new Error("no key"), { code: 2 })]) {
    const calls: string[] = [];
    const download = createGithubArchiveDownloader({ exec: async (bin, args) => {
      calls.push(bin);
      if (bin === "gh") throw missing();
      if (bin === "ssh" && commandCode(sshFailure) !== "ENOENT" && args[0] === "-G") return Buffer.from("identityagent /fixture/agent\n");
      throw sshFailure;
    } });
    assert.equal(await download(source, maxBytes), null);
    assert.deepEqual(calls, commandCode(sshFailure) === "ENOENT" ? ["gh", "ssh"] : ["gh", "ssh", "ssh-add"]);
  }
});

test("authenticated denial and transport failures are reported without anonymous fallback", async () => {
  for (const [code, stderr, expected] of [
    [1, "HTTP 404: Not Found", /account\/key.*permissions/],
    [1, "HTTP 403: Forbidden", /denied access/],
    [1, "error connecting to api.github.com", /connection/],
    ["ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "untrusted response", /size limit/],
  ] as const) {
    const calls: string[] = [];
    const download = createGithubArchiveDownloader({ exec: async bin => {
      calls.push(bin);
      throw Object.assign(new Error("untrusted error text"), { code, stderr });
    } });
    await assert.rejects(() => download(source, maxBytes), expected);
    assert.deepEqual(calls, ["gh"]);
  }
});

test("SSH host verification failure cannot downgrade to anonymous download", async () => {
  const download = createGithubArchiveDownloader({ exec: async (bin, args) => {
    if (bin === "gh") throw missing();
    if (bin === "ssh" && args[0] === "-G") return Buffer.from("identityagent /fixture/agent\n");
    if (bin === "ssh-add") return Buffer.from("public-key-fingerprint\n");
    throw Object.assign(new Error("ssh failed"), { code: 255, stderr: "Host key verification failed." });
  } });
  await assert.rejects(() => download(source, maxBytes), /host verification failed/);
});

test("SSH fetch failures remove temporary data and preserve sanitized diagnostics", async () => {
  let staging = "";
  const download = createGithubArchiveDownloader({ exec: async (bin, args, opts) => {
    if (bin === "gh") throw missing();
    if (bin === "ssh" && args[0] === "-G") return Buffer.from("identityagent /fixture/agent\n");
    if (bin === "ssh-add") return Buffer.from("public-key-fingerprint\n");
    if (bin === "ssh") throw sshAuthenticated();
    staging = opts.cwd!;
    if (args.includes("fetch")) throw Object.assign(new Error("private details"), { stderr: "ERROR: Repository not found." });
    return Buffer.alloc(0);
  } });
  await assert.rejects(() => download(source, maxBytes), /SSH cannot access/);
  assert.equal(existsSync(staging), false);
});

function commandCode(error: Error): string | number | undefined {
  return (error as Error & { code?: string | number }).code;
}

test("no configured key and disabled agent skip SSH network access before public fallback", async () => {
  const calls: string[] = [];
  const download = createGithubArchiveDownloader({ exec: async (bin, args) => {
    calls.push(bin);
    if (bin === "gh") throw missing();
    assert.deepEqual(args, ["-G", "-oBatchMode=yes", "-oStrictHostKeyChecking=yes", "-oConnectTimeout=10", "git@github.com"]);
    return Buffer.from("identityfile /fixture/no-such-key\nidentityagent none\n");
  } });
  assert.equal(await download(source, maxBytes), null);
  assert.deepEqual(calls, ["gh", "ssh"]);
});

test("authentication never reaches arbitrary archives or other forges", async () => {
  const download = createGithubArchiveDownloader({ exec: async () => { throw new Error("must not execute"); } });
  for (const value of ["https://gitlab.com/acme/private", "https://example.com/a.zip", "https://codeload.github.com/acme/repo/zip/HEAD", "https://user:pass@github.com/acme/repo"]) {
    assert.equal(await download(value, maxBytes), null, value);
  }
  await assert.rejects(() => download("https://github.com/acme/repo/tree/-unsafe", maxBytes), /Invalid.*ref/);
});

test("the complete selected branch is encoded as one API ref", async () => {
  const download = createGithubArchiveDownloader({ exec: async (_bin, args) => {
    assert.equal(args.at(-1), "repos/acme/repo/zipball/feature%2Fprivate");
    return zip;
  } });
  assert.deepEqual(await download("https://github.com/acme/repo/tree/feature/private", maxBytes), zip);
});

test("SSH acquisition produces a real ZIP through bare Git fetch and cleans its staging", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-ssh-archive-fixture-"));
  const previousPath = process.env.PATH;
  // Executables also resolve from well-known directories outside PATH, so a
  // developer's signed-in gh would answer first: give it no login.
  const ghEnv = ["GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"] as const;
  const previousGh = Object.fromEntries(ghEnv.map((name) => [name, process.env[name]]));
  for (const name of ghEnv) delete process.env[name];
  process.env.GH_CONFIG_DIR = join(root, "gh-config");
  try {
    const bin = join(root, "bin");
    const repo = join(root, "source");
    const hooks = join(root, "hooks");
    const key = join(root, "identity-fixture");
    mkdirSync(bin); mkdirSync(repo); mkdirSync(hooks);
    writeFileSync(key, "metadata-only SSH test fixture");
    writeFileSync(join(repo, "fixture.txt"), "Selected repository contents\n");
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const git = (args: string[]) => execFileSync("git", ["-c", `core.hooksPath=${hooks}`, ...args], { cwd: repo, env, stdio: "pipe", timeout: 10_000 });
    const gitBin = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    git(["init", "--quiet", `--template=${hooks}`]);
    git(["add", "fixture.txt"]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "Fixture"]);
    symlinkSync(gitBin, join(bin, "git"));
    writeFileSync(join(bin, "ssh"), `#!${process.execPath}\n` + [
      "import { spawnSync } from 'node:child_process';",
      "const args = process.argv.slice(2);",
      `if (args.includes('-G')) { console.log('identityfile ' + ${JSON.stringify(key)}); process.exit(0); }`,
      "if (args.includes('-T')) { console.error(\"Hi fixture! You've successfully authenticated, but GitHub does not provide shell access.\"); process.exit(1); }",
      "if (!args.some(arg => arg.startsWith('git-upload-pack '))) process.exit(2);",
      `const child = spawnSync(${JSON.stringify(gitBin)}, ['upload-pack', ${JSON.stringify(repo)}], { stdio: 'inherit' });`,
      "process.exit(child.status ?? 1);",
    ].join("\n"), { mode: 0o700 });
    // Only Git/SSH are available: gh is truly absent. The SSH fixture serves
    // local Git objects, so no real key or external provider is involved.
    process.env.PATH = bin;
    const result = await createGithubArchiveDownloader()(source, maxBytes);
    assert.ok(result);
    assert.deepEqual(result.subarray(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    assert.ok(result.length > 100);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    for (const name of ghEnv) {
      if (previousGh[name] === undefined) delete process.env[name]; else process.env[name] = previousGh[name];
    }
    rmSync(root, { recursive: true, force: true });
  }
});
