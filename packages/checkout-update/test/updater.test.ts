import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutRoot, createCheckoutUpdater, type BuildStep } from "../src/index.ts";
import { runsFrom } from "../src/serverEntry.ts";

const ID = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", [...ID, ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();

function write(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** A bare origin, the deployment checkout on `devel`, and a developer clone. */
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "polyth-checkout-update-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const origin = join(dir, "origin.git");
  const dev = join(dir, "dev");
  const deploy = join(dir, "deploy");
  git(dir, "init", "--quiet", "--bare", "--initial-branch=devel", origin);
  git(dir, "clone", "--quiet", origin, dev);
  git(dev, "checkout", "--quiet", "-B", "devel");
  write(dev, "packages/server/src/index.ts", "export {};\n");
  write(dev, "packages/server/package.json", "{}\n");
  write(dev, "README.md", "one\n");
  git(dev, "add", "-A");
  git(dev, "commit", "--quiet", "-m", "first");
  git(dev, "push", "--quiet", "origin", "devel");
  git(dir, "clone", "--quiet", "--branch", "devel", origin, deploy);
  const push = (path: string, text: string, message = `change ${path}`): string => {
    write(dev, path, text);
    git(dev, "add", "-A");
    git(dev, "commit", "--quiet", "-m", message);
    git(dev, "push", "--quiet", "origin", "devel");
    return git(dev, "rev-parse", "HEAD");
  };
  const built: Array<{ rustChanged: boolean; head: string }> = [];
  let failBuild = false;
  const updater = createCheckoutUpdater({
    root: deploy,
    buildSteps: ({ rustChanged }): BuildStep[] => {
      built.push({ rustChanged, head: git(deploy, "rev-parse", "HEAD") });
      return [{
        label: "fixture build",
        command: process.execPath,
        args: ["-e", failBuild ? "console.error('boom: dist missing'); process.exit(1)" : "process.exit(0)"],
        timeoutMs: 30_000,
      }];
    },
  });
  return {
    deploy,
    dev,
    push,
    updater,
    built,
    failNextBuilds: (value: boolean) => { failBuild = value; },
    head: () => git(deploy, "rev-parse", "HEAD"),
  };
}

test("an up-to-date checkout offers nothing newer", async () => {
  const r = rig();
  const current = await r.updater.current!();
  assert.equal(current, r.head().slice(0, 12));
  const newest = await r.updater.newest(current);
  assert.equal(newest, current);
  assert.equal(r.updater.isNewer!(newest!, current), false);
  assert.equal(r.updater.unavailable, null);
  assert.equal(r.updater.source!(), "origin/devel");
});

test("a pushed commit fast-forwards the checkout and rebuilds it", async () => {
  const r = rig();
  const current = await r.updater.current!();
  const pushed = r.push("README.md", "two\n");
  const newest = await r.updater.newest(current);
  assert.equal(newest, pushed.slice(0, 12));
  assert.equal(r.updater.isNewer!(newest!, current), true);
  assert.equal(r.head().slice(0, 12), current, "a check never moves the checkout");
  const result = await r.updater.apply(newest!, current);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.installed, newest);
  assert.equal(r.head(), pushed);
  assert.deepEqual(r.built, [{ rustChanged: false, head: pushed }]);
  assert.equal(await r.updater.current!(), newest);
});

test("Rust source changes are passed to the build", async () => {
  const r = rig();
  const current = await r.updater.current!();
  r.push("crates/polyth-link-host/src/main.rs", "fn main() {}\n");
  const result = await r.updater.apply((await r.updater.newest(current))!, current);
  assert.equal(result.ok, true, result.message);
  assert.equal(r.built[0]?.rustChanged, true);
});

test("local changes to tracked files hold the update and are never discarded", async () => {
  const r = rig();
  const current = await r.updater.current!();
  r.push("README.md", "two\n");
  writeFileSync(join(r.deploy, "README.md"), "edited on the server\n");
  await assert.rejects(r.updater.newest(current), /local changes \(README\.md\)/);
  const pushed = git(r.dev, "rev-parse", "HEAD").slice(0, 12);
  const result = await r.updater.apply(pushed, current);
  assert.equal(result.ok, false);
  assert.match(result.message, /local changes/);
  assert.equal(r.head().slice(0, 12), current);
  assert.deepEqual(r.built, []);
  // Untracked build output does not count.
  git(r.deploy, "checkout", "--", "README.md");
  write(r.deploy, "apps/web/dist/index.html", "<html></html>\n");
  assert.equal(await r.updater.newest(current), pushed);
});

test("a checkout with commits of its own is never moved", async () => {
  const r = rig();
  write(r.deploy, "LOCAL.md", "mine\n");
  git(r.deploy, "add", "-A");
  git(r.deploy, "commit", "--quiet", "-m", "local only");
  const current = await r.updater.current!();
  r.push("README.md", "two\n");
  await assert.rejects(r.updater.newest(current), /fast-forward/);
  const result = await r.updater.apply(git(r.dev, "rev-parse", "HEAD").slice(0, 12), current);
  assert.equal(result.ok, false);
  assert.equal(r.head().slice(0, 12), current);
});

test("a failed build puts the previous commit and its build back", async () => {
  const r = rig();
  const before = r.head();
  const current = await r.updater.current!();
  r.push("README.md", "two\n");
  const newest = (await r.updater.newest(current))!;
  r.failNextBuilds(true);
  const result = await r.updater.apply(newest, current);
  assert.equal(result.ok, false);
  assert.match(result.message, /fixture build failed: boom: dist missing/);
  assert.match(result.message, /was put back, but rebuilding it failed too/);
  assert.equal(result.installed, current);
  assert.equal(r.head(), before);
  assert.deepEqual(r.built.map((one) => one.head), [git(r.dev, "rev-parse", "HEAD"), before]);
  assert.equal(git(r.deploy, "status", "--porcelain", "--untracked-files=no"), "");
});

test("a detached or untracked branch says how to follow one", async () => {
  const r = rig();
  git(r.deploy, "checkout", "--quiet", "--detach");
  await assert.rejects(r.updater.newest(await r.updater.current!()), /detached HEAD/);
  git(r.deploy, "checkout", "--quiet", "-b", "local-only");
  await assert.rejects(r.updater.newest(await r.updater.current!()), /follows no remote branch/);
});

test("a stale check or an unknown target installs nothing", async () => {
  const r = rig();
  const current = await r.updater.current!();
  const moved = await r.updater.apply("0123456789ab", "ffffffffffff");
  assert.equal(moved.ok, false);
  assert.match(moved.message, /moved/);
  const unknown = await r.updater.apply("0123456789ab", current);
  assert.equal(unknown.ok, false);
  assert.match(unknown.message, /not a commit/);
  assert.deepEqual(r.built, []);
});

test("only a writable Polyth checkout can update itself", () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-checkout-update-plain-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const updater = createCheckoutUpdater({ root: dir });
  assert.match(updater.unavailable ?? "", /does not run from a git checkout/);
  mkdirSync(join(dir, ".git"));
  assert.match(createCheckoutUpdater({ root: dir }).unavailable ?? "", /not a Polyth source checkout/);
});

test("the package finds its checkout and the server's own script in it", () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-checkout-update-root-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const here = join(dir, "packages", "checkout-update", "src");
  mkdirSync(here, { recursive: true });
  write(dir, "packages/server/package.json", "{}\n");
  write(dir, "packages/server/src/index.ts", "export {};\n");
  assert.equal(checkoutRoot(here), null, "no .git: a packaged build");
  mkdirSync(join(dir, ".git"));
  assert.equal(checkoutRoot(here), join(here, "..", "..", ".."));
  assert.equal(runsFrom(dir, join(dir, "packages", "server", "src", "index.ts")), true);
  assert.equal(runsFrom(dir, join(tmpdir(), "elsewhere", "index.ts")), false);
  assert.equal(runsFrom(dir, undefined), false);
  const link = join(tmpdir(), `polyth-checkout-update-link-${process.pid}`);
  symlinkSync(dir, link);
  after(() => rmSync(link, { force: true }));
  assert.equal(runsFrom(dir, join(link, "packages", "server", "src", "index.ts")), true, "a symlinked path is the same checkout");
});
