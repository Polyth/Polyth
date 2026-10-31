import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstalledPluginDto } from "@polyth/contracts";
import { createPluginRegistry } from "../src/managedRegistry.ts";
import { forkCloneAttempts, forkVersion } from "../src/forkSources.ts";
import { LOCAL_SOURCE_TICK_MS, runAutoUpdates, runLocalSourceUpdates, startAutoUpdater } from "../src/autoUpdate.ts";
import { writeSpaceEnabled } from "../src/spaceEnabled.ts";
import { createContext } from "@polyth/kernel";
import { testSpaceStorage } from "./helpers.ts";

const SOURCE = "https://github.com/acme/forked-package";
const ID = "com-example-forked";
const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", [...IDENTITY, ...args], { cwd: dir, encoding: "utf8" }).trim();
}

function writeManifest(dir: string, version: string, description = "Fork fixture."): void {
  writeFileSync(join(dir, "polyth-package.json"), JSON.stringify({
    manifestVersion: 2, id: ID, version,
    display: { name: "Forked package", description },
    runtime: { kind: "sandboxed" },
    contributes: { commands: [{ id: "hello", name: "hello", description: "Say hello" }] },
  }, null, 2));
}

function upstreamRepo(root: string): string {
  const dir = join(root, "upstream");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeManifest(dir, "1.0.0");
  writeFileSync(join(dir, "notes.txt"), "upstream\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

function commitUpstream(dir: string, version: string, extra?: [string, string]): void {
  writeManifest(dir, version);
  if (extra) writeFileSync(join(dir, extra[0]), extra[1]);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `release ${version}`);
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "polyth-fork-update-"));
  const upstream = upstreamRepo(root);
  const registry = createPluginRegistry({
    dir: join(root, "installed"),
    forkCloneAttempts: (_input, dest) => [{ command: "git", args: ["clone", "-q", "--no-tags", "--", upstream, dest] }],
  });
  const forkPath = join(root, "installed", ID, "fork");
  const activeDir = (dto: InstalledPluginDto) => join(root, "installed", ID, "versions", dto.version);
  return {
    root, upstream, registry, forkPath, activeDir,
    async cleanup() {
      await registry.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a fork install keeps the clone, tracks upstream and versions each commit", async () => {
  const ctx = setup();
  try {
    const installed = await ctx.registry.install(SOURCE, { fork: { strategy: "rebase" }, autoUpdate: true });
    const head = git(ctx.forkPath, "rev-parse", "HEAD");
    assert.equal(installed.version, forkVersion("1.0.0", head));
    assert.match(installed.version, /^1\.0\.0\+g[0-9a-f]{12}$/);
    assert.deepEqual(installed.fork, { strategy: "rebase", ref: "HEAD" });
    assert.equal(installed.autoUpdate, true);
    assert.equal(installed.updatable, true);
    assert.equal(git(ctx.forkPath, "remote"), "upstream");
    assert.equal(git(ctx.forkPath, "branch", "--show-current"), "polyth-local");
    assert.equal(existsSync(join(ctx.activeDir(installed), ".git")), false, "published tree excludes git metadata");
    assert.deepEqual(readdirSync(join(ctx.root, "installed", ".staging")), []);

    const unchanged = await ctx.registry.checkUpdate(ID);
    assert.equal(unchanged.updateCheck?.available, false);
    const noop = await ctx.registry.update(ID);
    assert.equal(noop.version, installed.version);
  } finally {
    await ctx.cleanup();
  }
});

test("rebase replays local fork commits on top of upstream", async () => {
  const ctx = setup();
  try {
    const installed = await ctx.registry.install(SOURCE, { fork: { strategy: "rebase" } });
    writeFileSync(join(ctx.forkPath, "local.txt"), "mine\n");
    git(ctx.forkPath, "add", "-A");
    git(ctx.forkPath, "commit", "-q", "-m", "local change");
    commitUpstream(ctx.upstream, "1.1.0");

    const checked = await ctx.registry.checkUpdate(ID);
    assert.equal(checked.updateCheck?.available, true);
    assert.equal(checked.updateCheck?.behind, 1);
    assert.equal(checked.version, installed.version, "a check never changes the active version");

    const updated = await ctx.registry.update(ID);
    assert.match(updated.version, /^1\.1\.0\+g/);
    assert.equal(updated.previousVersion, installed.version);
    assert.equal(updated.updateCheck?.available, false);
    assert.equal(git(ctx.forkPath, "rev-list", "--merges", "--count", "HEAD"), "0", "rebase keeps history linear");
    assert.equal(readFileSync(join(ctx.activeDir(updated), "local.txt"), "utf8"), "mine\n");
  } finally {
    await ctx.cleanup();
  }
});

test("merge integrates upstream with a merge commit once the strategy is switched", async () => {
  const ctx = setup();
  try {
    await ctx.registry.install(SOURCE, { fork: { strategy: "rebase" } });
    const configured = await ctx.registry.configure(ID, { forkStrategy: "merge" });
    assert.equal(configured.fork?.strategy, "merge");
    writeFileSync(join(ctx.forkPath, "local.txt"), "mine\n");
    git(ctx.forkPath, "add", "-A");
    git(ctx.forkPath, "commit", "-q", "-m", "local change");
    commitUpstream(ctx.upstream, "1.2.0");

    const updated = await ctx.registry.update(ID);
    assert.match(updated.version, /^1\.2\.0\+g/);
    assert.equal(git(ctx.forkPath, "rev-list", "--merges", "--count", "HEAD"), "1");
    assert.equal(readFileSync(join(ctx.activeDir(updated), "local.txt"), "utf8"), "mine\n");
  } finally {
    await ctx.cleanup();
  }
});

for (const strategy of ["rebase", "merge"] as const) {
  test(`a ${strategy} conflict aborts and keeps the active version`, async () => {
    const ctx = setup();
    try {
      const installed = await ctx.registry.install(SOURCE, { fork: { strategy } });
      writeFileSync(join(ctx.forkPath, "notes.txt"), "local edit\n");
      git(ctx.forkPath, "commit", "-q", "-am", "local edit");
      const localHead = git(ctx.forkPath, "rev-parse", "HEAD");
      commitUpstream(ctx.upstream, "1.1.0", ["notes.txt", "upstream edit\n"]);

      await assert.rejects(() => ctx.registry.update(ID), /conflict/);
      const after = ctx.registry.detail(ID);
      assert.equal(after.version, installed.version);
      assert.match(after.updateCheck?.error ?? "", /conflict/);
      assert.equal(git(ctx.forkPath, "status", "--porcelain"), "", "the aborted integration leaves a clean fork");
      assert.equal(git(ctx.forkPath, "rev-parse", "HEAD"), localHead);
    } finally {
      await ctx.cleanup();
    }
  });
}

test("an uncommitted fork edit blocks the update instead of being discarded", async () => {
  const ctx = setup();
  try {
    await ctx.registry.install(SOURCE, { fork: { strategy: "rebase" } });
    writeFileSync(join(ctx.forkPath, "notes.txt"), "unsaved\n");
    commitUpstream(ctx.upstream, "1.1.0");
    await assert.rejects(() => ctx.registry.update(ID), /uncommitted changes/);
    assert.equal(readFileSync(join(ctx.forkPath, "notes.txt"), "utf8"), "unsaved\n");
  } finally {
    await ctx.cleanup();
  }
});

test("fork installs reject non-repository sources and trusted-local runtimes", async () => {
  const ctx = setup();
  try {
    await assert.rejects(
      () => ctx.registry.install("https://cdn.example.com/package.zip", { fork: { strategy: "merge" } }),
      /repository link can be installed as a fork/,
    );
    writeFileSync(join(ctx.upstream, "server.ts"), "export default () => ({});\n");
    writeFileSync(join(ctx.upstream, "polyth-package.json"), JSON.stringify({
      manifestVersion: 2, id: ID, version: "1.0.0",
      display: { name: "Native", description: "Trusted runtime." },
      runtime: { kind: "trusted-local", server: "server.ts" },
    }));
    git(ctx.upstream, "add", "-A");
    git(ctx.upstream, "commit", "-q", "-m", "trusted");
    await assert.rejects(() => ctx.registry.install(SOURCE, { fork: { strategy: "rebase" } }), /trusted local source/);
    assert.equal(ctx.registry.has(ID), false);
    assert.deepEqual(readdirSync(join(ctx.root, "installed", ".staging")), []);
  } finally {
    await ctx.cleanup();
  }
});

test("checking a refetchable source compares manifest versions without staging", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-check-update-"));
  const trusted = join(root, "trusted");
  const pkg = join(trusted, "pkg");
  mkdirSync(pkg, { recursive: true });
  writeManifest(pkg, "1.0.0");
  const registry = createPluginRegistry({ dir: join(root, "installed"), trustedDir: trusted });
  try {
    const installed = await registry.install("file:pkg");
    assert.equal(installed.autoUpdate, undefined);
    assert.equal((await registry.checkUpdate(ID)).updateCheck?.available, false);
    writeManifest(pkg, "1.1.0");
    const checked = await registry.checkUpdate(ID);
    assert.deepEqual(
      { available: checked.updateCheck?.available, version: checked.updateCheck?.version },
      { available: true, version: "1.1.0" },
    );
    assert.equal(checked.version, "1.0.0");
    assert.deepEqual(checked.versions, ["1.0.0"]);
    assert.equal((await registry.configure(ID, { autoUpdate: true })).autoUpdate, true);
    assert.equal((await registry.configure(ID, { autoUpdate: false })).autoUpdate, undefined);
    await assert.rejects(() => registry.configure(ID, { forkStrategy: "merge" }), /only a forked package/);
  } finally {
    await registry.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("updating a local source that still holds the active version is a no-op", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-same-version-"));
  const trusted = join(root, "trusted");
  const pkg = join(trusted, "pkg");
  mkdirSync(pkg, { recursive: true });
  writeManifest(pkg, "1.0.0");
  const registry = createPluginRegistry({ dir: join(root, "installed"), trustedDir: trusted });
  try {
    await registry.install("file:pkg");
    writeFileSync(join(pkg, "notes.txt"), "edited without a version bump\n");
    const updated = await registry.update(ID);
    assert.equal(updated.version, "1.0.0");
    assert.equal(updated.updateCheck?.available, false);
    assert.equal(updated.updateCheck?.error, undefined);
  } finally {
    await registry.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the auto-updater only applies due, opted-in packages with a found update", async () => {
  const now = 10_000_000;
  const base = { permissions: { requested: [], effective: [] }, updatable: true } as unknown as InstalledPluginDto;
  const list = [
    { ...base, id: "due", autoUpdate: true, updateCheck: { checkedAt: 0, available: false } },
    { ...base, id: "fresh", autoUpdate: true, updateCheck: { checkedAt: now - 1, available: false } },
    { ...base, id: "off" },
    { ...base, id: "upload", autoUpdate: true, updatable: false },
    { ...base, id: "staged", autoUpdate: true, update: { version: "2.0.0" } },
    { ...base, id: "current", autoUpdate: true },
    { ...base, id: "broken", autoUpdate: true },
  ] as InstalledPluginDto[];
  const checked: string[] = [];
  const applied: string[] = [];
  const updated = await runAutoUpdates({
    now: () => now,
    intervalMs: 1000,
    registry: {
      list: () => list,
      checkUpdate: async (id) => {
        checked.push(id);
        if (id === "broken") throw new Error("offline");
        return { ...base, id, updateCheck: { checkedAt: now, available: id === "due" } };
      },
      update: async () => { throw new Error("apply goes through the host wrapper"); },
    },
    apply: async (id) => { applied.push(id); },
  });
  assert.deepEqual(checked, ["due", "current", "broken"]);
  assert.deepEqual(applied, ["due"]);
  assert.deepEqual(updated, ["due"]);
});

/** Swap a fresh tree into place, the way the repository sync job does. */
function swapIn(trusted: string, name: string, version: string): void {
  const fresh = join(trusted, `.${name}.new`);
  const old = join(trusted, `.${name}.old`);
  mkdirSync(fresh);
  writeManifest(fresh, version);
  renameSync(join(trusted, name), old);
  renameSync(fresh, join(trusted, name));
  rmSync(old, { recursive: true, force: true });
}

test("a local source is applied as soon as its manifest changes, and only then", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-local-auto-"));
  const trusted = join(root, "trusted");
  const pkg = join(trusted, "pkg");
  mkdirSync(pkg, { recursive: true });
  writeManifest(pkg, "1.0.0");
  const open = () => createPluginRegistry({ dir: join(root, "installed"), trustedDir: trusted });
  let registry = open();
  const checked: string[] = [];
  const pass = () => runLocalSourceUpdates({
    registry: {
      changedLocalSources: () => registry.changedLocalSources(),
      checkUpdate: (id) => {
        checked.push(id);
        return registry.checkUpdate(id);
      },
    },
    apply: (id) => registry.update(id),
  });
  try {
    await registry.install("file:pkg");
    assert.deepEqual(registry.changedLocalSources(), [], "auto-update off: not watched");
    await registry.configure(ID, { autoUpdate: true });
    assert.deepEqual(registry.changedLocalSources(), [ID], "never checked against this source yet");
    assert.deepEqual(await pass(), []);
    assert.deepEqual(checked, [ID]);
    assert.equal(Object.hasOwn(registry.detail(ID).updateCheck ?? {}, "sourceFingerprint"), false, "the stamp stays on the host");

    writeFileSync(join(pkg, "notes.txt"), "not a release\n");
    assert.deepEqual(await pass(), []);
    swapIn(trusted, "pkg", "1.0.0");
    assert.deepEqual(await pass(), []);
    assert.deepEqual(checked, [ID], "other edits and a swap of identical content are not checked");

    renameSync(pkg, join(trusted, ".pkg.moving"));
    assert.deepEqual(registry.changedLocalSources(), [], "a source that is mid-swap is skipped");
    renameSync(join(trusted, ".pkg.moving"), pkg);
    swapIn(trusted, "pkg", "1.1.0");
    assert.deepEqual(await pass(), [ID]);
    assert.equal(registry.detail(ID).version, "1.1.0");
    assert.deepEqual(await pass(), [], "an applied release is not checked again");

    await registry.rollback(ID, "1.0.0");
    await registry.dispose();
    registry = open();
    assert.deepEqual(await pass(), [], "a rollback holds across a restart while the source is unchanged");
    assert.equal(registry.detail(ID).version, "1.0.0");

    const held = await registry.checkUpdate(ID);
    assert.equal(held.updateCheck?.available, true);
    assert.deepEqual(registry.changedLocalSources(), [], "a manual check does not undo the rollback");

    writeManifest(pkg, "1.2.0", "Edited in place.");
    const found = await registry.checkUpdate(ID);
    assert.equal(found.updateCheck?.version, "1.2.0");
    assert.deepEqual(registry.changedLocalSources(), [ID], "a release found by a manual check is still applied");
    assert.deepEqual(await pass(), [ID]);
    assert.equal(registry.detail(ID).version, "1.2.0");
    assert.deepEqual(checked, [ID, ID, ID]);
  } finally {
    await registry.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a package.json manifest bumped in place is picked up by the local-source pass", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-local-pkgjson-"));
  const trusted = join(root, "trusted");
  const pkg = join(trusted, "pkg");
  mkdirSync(pkg, { recursive: true });
  const write = (version: string) => writeFileSync(join(pkg, "package.json"), JSON.stringify({
    name: "forked-package", version, description: "package.json fixture",
    polyth: {
      manifestVersion: 2, id: ID,
      runtime: { kind: "sandboxed" },
      contributes: { commands: [{ id: "hello", name: "hello", description: "Say hello" }] },
    },
  }, null, 2));
  write("1.0.0");
  const registry = createPluginRegistry({ dir: join(root, "installed"), trustedDir: trusted });
  const options = { registry, apply: (id: string) => registry.update(id) };
  try {
    await registry.install("file:pkg", { autoUpdate: true });
    await runLocalSourceUpdates(options);
    assert.deepEqual(registry.changedLocalSources(), []);
    write("1.10.0");
    assert.deepEqual(await runLocalSourceUpdates(options), [ID]);
    assert.equal(registry.detail(ID).version, "1.10.0");
  } finally {
    await registry.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a local candidate awaiting review is not replaced by the local-source pass", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-local-review-"));
  const trusted = join(root, "trusted");
  const pkg = join(trusted, "pkg");
  mkdirSync(pkg, { recursive: true });
  writeManifest(pkg, "1.0.0");
  const storage = testSpaceStorage(join(root, "space"));
  const registry = createPluginRegistry({
    dir: join(root, "installed"),
    trustedDir: trusted,
    packageSpaces: () => [{ spaceId: "spc_a", storage }],
  });
  const release = (version: string) => {
    const manifest = JSON.parse(readFileSync(join(pkg, "polyth-package.json"), "utf8"));
    writeFileSync(join(pkg, "polyth-package.json"), JSON.stringify({
      ...manifest, version, capabilities: [{ name: "clipboard.write" }],
    }, null, 2));
  };
  try {
    await registry.install("file:pkg", { autoUpdate: true });
    writeSpaceEnabled(storage, ID, true);
    release("1.1.0");
    const options = { registry, apply: (id: string) => registry.update(id) };
    assert.deepEqual(await runLocalSourceUpdates(options), [ID]);
    const staged = registry.detail(ID, storage);
    assert.equal(staged.version, "1.0.0", "new access waits for review");
    assert.equal(staged.update?.version, "1.1.0");
    release("1.2.0");
    assert.deepEqual(registry.changedLocalSources(), [], "the owner's review comes first");
    assert.deepEqual(await runLocalSourceUpdates(options), []);
    assert.equal(registry.detail(ID, storage).update?.version, "1.1.0", "the reviewed candidate is not replaced");
    assert.equal((await registry.checkUpdate(ID, { storage })).updateCheck?.version, "1.2.0");
    const granted = await registry.grant(ID, ["clipboard.write"], storage);
    assert.equal(granted.version, "1.1.0");
    assert.deepEqual(await runLocalSourceUpdates(options), [ID], "the newer release follows once the review is done");
    assert.equal(registry.detail(ID, storage).version, "1.2.0");
  } finally {
    await registry.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a local release that failed to activate is replaced by the next one", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-local-boom-"));
  const trusted = join(root, "trusted");
  const pkg = join(trusted, "boom");
  const BOOM = "com-example-boom";
  mkdirSync(pkg, { recursive: true });
  const release = (version: string, server: string) => {
    writeFileSync(join(pkg, "polyth-plugin.json"), JSON.stringify({
      id: BOOM, name: "Boom", version, trust: "privileged", entries: { server: "server.mjs" },
    }));
    writeFileSync(join(pkg, "server.mjs"), server);
  };
  const healthy = (version: string) => `export default (host) => ({
    manifest: { id: host.pluginId, version: "${version}", trust: "privileged" },
    setup() {},
  });\n`;
  release("1.0.0", healthy("1.0.0"));
  const kernel = createContext("test-root");
  const storage = testSpaceStorage(join(root, "space"));
  const registry = createPluginRegistry({
    dir: join(root, "installed"),
    trustedDir: trusted,
    root: kernel,
    routes: { add: () => ({ dispose() {} }) },
    packageSpaces: () => [{ spaceId: "spc_boom", storage }],
  });
  const options = { registry, apply: (id: string) => registry.update(id) };
  try {
    await registry.install("file:boom", { autoUpdate: true });
    await registry.enable(BOOM, storage);
    release("1.1.0", `throw new Error("cannot start");\n`);
    assert.deepEqual(await runLocalSourceUpdates(options), []);
    const failed = registry.detail(BOOM, storage);
    assert.equal(failed.version, "1.0.0");
    assert.equal(failed.update?.version, "1.1.0");
    assert.match(failed.updateCheck?.error ?? "", /cannot start/);
    assert.deepEqual(registry.changedLocalSources(), [], "the failed release is not retried in a loop");
    release("1.1.1", healthy("1.1.1"));
    assert.deepEqual(await runLocalSourceUpdates(options), [BOOM]);
    const fixed = registry.detail(BOOM, storage);
    assert.equal(fixed.version, "1.1.1");
    assert.equal(fixed.update, undefined);
  } finally {
    await registry.dispose();
    await kernel.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the local-source pass checks each changed source and keeps going past a failure", async () => {
  const base = { permissions: { requested: [], effective: [] }, updatable: true } as unknown as InstalledPluginDto;
  const checked: string[] = [];
  const applied: string[] = [];
  const updated = await runLocalSourceUpdates({
    registry: {
      changedLocalSources: () => ["broken", "current", "newer"],
      checkUpdate: async (id) => {
        checked.push(id);
        if (id === "broken") throw new Error("broken manifest");
        return { ...base, id, updateCheck: { checkedAt: 0, available: id === "newer" } };
      },
    },
    apply: async (id) => { applied.push(id); },
  });
  assert.deepEqual(checked, ["broken", "current", "newer"]);
  assert.deepEqual(applied, ["newer"]);
  assert.deepEqual(updated, ["newer"]);
});

test("the auto-updater driver looks at local sources between full passes until disposed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const base = { permissions: { requested: [], effective: [] }, updatable: true } as unknown as InstalledPluginDto;
  let changed = ["local"];
  const checked: string[] = [];
  const updater = startAutoUpdater({
    registry: {
      list: () => [],
      changedLocalSources: () => changed,
      checkUpdate: async (id) => {
        checked.push(id);
        changed = []; // the registry records the stamp the check saw
        return { ...base, id, updateCheck: { checkedAt: 0, available: false } };
      },
      update: async () => { throw new Error("apply goes through the host wrapper"); },
    },
    apply: async () => {},
  });
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((done) => setImmediate(done));
  };
  try {
    t.mock.timers.tick(LOCAL_SOURCE_TICK_MS);
    await settle();
    assert.deepEqual(checked, [], "nothing runs before the first pass");
    t.mock.timers.tick(2 * 60 * 1000 - LOCAL_SOURCE_TICK_MS);
    await settle();
    assert.deepEqual(checked, ["local"]);
    t.mock.timers.tick(LOCAL_SOURCE_TICK_MS);
    await settle();
    assert.deepEqual(checked, ["local"], "an unchanged source is not checked");
    changed = ["local"];
    t.mock.timers.tick(LOCAL_SOURCE_TICK_MS);
    await settle();
    assert.deepEqual(checked, ["local", "local"]);
    updater.dispose();
    changed = ["local"];
    t.mock.timers.tick(LOCAL_SOURCE_TICK_MS * 4);
    await settle();
    assert.deepEqual(checked, ["local", "local"]);
  } finally {
    updater.dispose();
  }
});

test("an uploaded archive cannot opt into automatic updates", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-upload-auto-"));
  const pkg = join(root, "pkg");
  mkdirSync(pkg, { recursive: true });
  writeManifest(pkg, "1.0.0");
  const { packDirectory } = await import("@polyth/package-sdk/manifest");
  const registry = createPluginRegistry({ dir: join(root, "installed") });
  try {
    const installed = await registry.installArchive(await packDirectory(pkg), "pkg.zip");
    assert.equal(installed.updatable, false);
    await assert.rejects(() => registry.configure(ID, { autoUpdate: true }), /cannot update automatically/);
    await assert.rejects(() => registry.checkUpdate(ID), /uploaded archive/);
  } finally {
    await registry.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fork clone arguments refuse option-shaped refs and paths", () => {
  const attempts = forkCloneAttempts({ host: "github.com", path: "owner/repo", ref: "feature/x" }, "/tmp/fork");
  assert.deepEqual(attempts.at(-1)?.args, ["clone", "--no-tags", "--branch", "feature/x", "--", "git@github.com:owner/repo.git", "/tmp/fork"]);
  for (const input of [
    { host: "github.com", path: "owner/repo", ref: "--upload-pack=touch /tmp/pwned" },
    { host: "github.com", path: "-x/repo", ref: "HEAD" },
    { host: "codeberg.org", path: "owner/repo", ref: "main\nmore" },
  ]) {
    assert.throws(() => forkCloneAttempts(input, "/tmp/fork"), { code: "invalid-input" });
  }
});
