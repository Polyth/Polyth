import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import type { HarnessContext } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import { discoverServerPackages } from "@polyth/plugins";
import { createHarnessRegistry } from "@polyth/harness-runtime";
import {
  attachmentFacts, availabilityLabel, integrationLabel, projectionFacts, runtimeFacts,
} from "../../harness-runtime/widgets/presentation.ts";
import registerPackage, { createAntigravityPackage } from "../src/serverEntry.ts";

function fixture(now?: () => number) {
  const registry = createHarnessRegistry();
  let requests = 0;
  const host = { services: { require: () => { requests++; return registry; } } } as unknown as ServerPackageHost;
  const pkg = now ? createAntigravityPackage(host, { now }) : registerPackage(host);
  return { registry, pkg, get requests() { return requests; } };
}

/** A fake `agy` that answers `--version` always and `models` only when the
 * fixture is signed in, mirroring the real CLI: the version probe succeeds
 * with an empty home, while the catalog refuses to list anything. */
async function fakeCli(t: TestContext, options: { signedIn: boolean }): Promise<{ bin: string; cwd: string; setSignedIn(value: boolean): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "polyth-agy-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "agy");
  const signedInPath = join(dir, "signed-in");
  const models = "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n";
  if (options.signedIn) await writeFile(signedInPath, "");
  await writeFile(bin, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "1.2.11"; exit 0; fi
if [ "$1" = "models" ]; then
  if [ -f '${signedInPath}' ]; then printf '%s' '${models}'; exit 0; fi
  echo 'Error: Please sign in to view available models.' >&2
  exit 1
fi
exit 1
`, { mode: 0o700 });
  await chmod(bin, 0o700);
  return {
    bin,
    cwd: dir,
    async setSignedIn(value) {
      if (value) await writeFile(signedInPath, "");
      else await rm(signedInPath, { force: true });
    },
  };
}

const contextFor = (cwd: string, overrides: Partial<HarnessContext> = {}): HarnessContext => ({
  spaceId: "space-a", projectId: "project-a", cwd, ...overrides,
});

function useEnvironment(t: TestContext, name: string, value: string): void {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

async function waitForFile(path: string, t: TestContext): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const handle = await readFile(path);
      if (handle.length >= 0) return;
    } catch { /* not created yet */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  t.diagnostic(`timed out waiting for ${path}`);
  throw new Error("fake CLI did not reach the expected probe state");
}

async function deferredCatalogCli(t: TestContext): Promise<{
  bin: string;
  cwd: string;
  entered: string;
  pause(): Promise<void>;
  release(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "polyth-agy-deferred-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "agy");
  const entered = join(dir, "catalog-entered");
  const release = join(dir, "release");
  await writeFile(bin, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "1.2.11"; exit 0; fi
if [ "$1" = "models" ]; then
  : > "$PWD/catalog-entered"
  while [ ! -e '${release}' ]; do sleep 0.01; done
  echo 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)'
  exit 0
fi
exit 1
`, { mode: 0o700 });
  await chmod(bin, 0o700);
  return {
    bin,
    cwd: dir,
    entered,
    async pause() { await Promise.all([rm(release, { force: true }), rm(entered, { force: true })]); },
    async release() { await writeFile(release, ""); },
  };
}

test("package registration is lazy, idempotent and reversible without native CLI startup", async () => {
  const f = fixture();
  assert.equal(f.requests, 0);
  assert.equal(f.registry.get("antigravity"), undefined);
  f.pkg.onEnable(); f.pkg.onEnable();
  assert.equal(f.requests, 1);
  assert.equal(f.registry.get("antigravity")?.descriptor.autoSelect, false);
  await f.pkg.onDisable(); await f.pkg.onDisable();
  assert.equal(f.registry.get("antigravity"), undefined);
});

test("provider rejects remote execution and missing validated Space before accessing credentials", async () => {
  const f = fixture(); f.pkg.onEnable();
  try {
    const provider = f.registry.get("antigravity")!;
    const context = { spaceId: "space-a", projectId: "project-a", cwd: "/project", sessionId: "session-a" };
    assert.equal((await provider.probe({ ...context, remote: true })).installed, false);
    await assert.rejects(provider.createRuntime(context), { code: "unsupported" });
    await assert.rejects(provider.discover!({ ...context, remote: true }), { code: "unsupported" });
  } finally { await f.pkg.onDisable(); }
});

test("a signed-in catalog is reported as verified readiness instead of unknown", async (t) => {
  const { bin, cwd } = await fakeCli(t, { signedIn: true });
  useEnvironment(t, "POLYTH_ANTIGRAVITY_BIN", bin);
  const f = fixture(); f.pkg.onEnable();
  try {
    const provider = f.registry.get("antigravity")!;
    // The cheap version probe cannot see credentials, so it stays honest.
    const probe = await provider.probe(contextFor(cwd));
    assert.equal(probe.installed, true);
    assert.equal(probe.healthy, true);
    assert.equal(probe.authenticated, "unknown");
    assert.equal(probe.state, undefined);
    // The catalog is the CLI's own answer about the account, and it is only
    // returned after a non-empty parse, so it is positive evidence.
    const discovery = await provider.discover!(contextFor(cwd));
    assert.equal(discovery.state, "ready");
    assert.equal(discovery.authenticated, true);
    assert.equal(discovery.catalog?.models?.length, 1);
    // A refreshed cheap probe may now reuse that proof, but only for the same
    // Space, project, workspace and binary.
    const after = await provider.probe(contextFor(cwd));
    assert.equal(after.authenticated, true);
    assert.equal(after.state, "ready");
    assert.equal((await provider.probe(contextFor(cwd, { projectId: "project-b" }))).authenticated, "unknown");
    assert.equal((await provider.probe(contextFor(cwd, { spaceId: "space-b" }))).authenticated, "unknown");
  } finally { await f.pkg.onDisable(); }
});

test("an unsigned CLI surfaces the CLI's own sign-in requirement and never claims readiness", async (t) => {
  const { bin, cwd } = await fakeCli(t, { signedIn: false });
  useEnvironment(t, "POLYTH_ANTIGRAVITY_BIN", bin);
  const f = fixture(); f.pkg.onEnable();
  try {
    const provider = f.registry.get("antigravity")!;
    assert.equal((await provider.probe(contextFor(cwd))).authenticated, "unknown");
    await assert.rejects(provider.discover!(contextFor(cwd)), /sign in/i);
    // A failed catalog leaves no cached proof behind for the next cheap probe.
    assert.equal((await provider.probe(contextFor(cwd))).authenticated, "unknown");
    const [snapshot] = await f.registry.snapshots(contextFor(cwd), { harnessId: "antigravity", detail: true });
    assert.ok(snapshot, "the registered harness must produce a snapshot");
    assert.equal(snapshot.availability.state, "auth-required");
    assert.notEqual(snapshot.availability.state, "ready");
  } finally { await f.pkg.onDisable(); }
});

test("a proven account survives cheap probes but not an explicit re-check", async (t) => {
  // The catalog cache becomes refresh-eligible after 30 seconds while the
  // registry keeps showing the detailed metadata for minutes. The "Signed in"
  // label is the same observation as that catalog, so an explicit re-check must
  // prove the account again.
  const { bin, cwd } = await fakeCli(t, { signedIn: true });
  useEnvironment(t, "POLYTH_ANTIGRAVITY_BIN", bin);
  const f = fixture(); f.pkg.onEnable();
  try {
    const provider = f.registry.get("antigravity")!;
    const context = contextFor(cwd);
    await provider.discover!(context);
    assert.equal((await provider.probe(context)).authenticated, true);
    // The registry invalidates discovery on force, which must re-prove rather
    // than reuse the claim; discovery then re-establishes it.
    provider.invalidateDiscovery?.(context);
    assert.equal((await provider.probe(context)).authenticated, "unknown");
    await provider.discover!(context);
    assert.equal((await provider.probe(context)).authenticated, true);
    // Another scope never inherits the claim.
    assert.equal((await provider.probe(contextFor(cwd, { projectId: "project-b" }))).authenticated, "unknown");
  } finally { await f.pkg.onDisable(); }
});

test("cached account evidence expires with the documented trust window", async (t) => {
  const cli = await fakeCli(t, { signedIn: true });
  useEnvironment(t, "POLYTH_ANTIGRAVITY_BIN", cli.bin);
  let now = 1_000;
  const f = fixture(() => now); f.pkg.onEnable();
  try {
    const provider = f.registry.get("antigravity")!;
    const context = contextFor(cli.cwd);
    await provider.discover!(context);
    assert.equal((await provider.probe(context)).authenticated, true);
    now += 5 * 60_000 - 1;
    assert.equal((await provider.probe(context)).authenticated, true);
    now += 2;
    assert.equal((await provider.probe(context)).authenticated, "unknown");
  } finally { await f.pkg.onDisable(); }
});

test("a failed fresh catalog check revokes the proof produced by the prior check", async (t) => {
  const cli = await fakeCli(t, { signedIn: true });
  useEnvironment(t, "POLYTH_ANTIGRAVITY_BIN", cli.bin);
  const f = fixture(); f.pkg.onEnable();
  try {
    const provider = f.registry.get("antigravity")!;
    const context = contextFor(cli.cwd);
    await provider.discover!(context);
    assert.equal((await provider.probe(context)).authenticated, true);

    await cli.setSignedIn(false);
    provider.invalidateDiscovery?.(context);
    await assert.rejects(provider.discover!(context), /sign in/i);
    assert.equal((await provider.probe(context)).authenticated, "unknown");
  } finally { await f.pkg.onDisable(); }
});

test("an older in-flight catalog cannot restore proof after forced invalidation", async (t) => {
  const cli = await deferredCatalogCli(t);
  useEnvironment(t, "POLYTH_ANTIGRAVITY_BIN", cli.bin);
  const f = fixture(); f.pkg.onEnable();
  try {
    const provider = f.registry.get("antigravity")!;
    const context = contextFor(cli.cwd);
    const oldDiscovery = provider.discover!(context);
    await waitForFile(cli.entered, t);
    provider.invalidateDiscovery?.(context);
    await cli.release();
    assert.equal((await oldDiscovery).authenticated, true);
    assert.equal((await provider.probe(context)).authenticated, "unknown");
  } finally { await f.pkg.onDisable(); }
});

test("evicting a refreshing scope drops its older account proof", async (t) => {
  const cli = await deferredCatalogCli(t);
  useEnvironment(t, "POLYTH_ANTIGRAVITY_BIN", cli.bin);
  let now = 1_000;
  const f = fixture(() => now); f.pkg.onEnable();
  const provider = f.registry.get("antigravity")!;
  const first = contextFor(cli.cwd);
  const pending: Promise<unknown>[] = [];
  try {
    await cli.release();
    await provider.discover!(first);
    for (let i = 1; i < 64; i++) {
      await provider.discover!(contextFor(cli.cwd, { projectId: `project-${i}` }));
    }
    now += 31_000;
    await cli.pause();
    pending.push(provider.discover!(first));
    await waitForFile(cli.entered, t);
    assert.equal((await provider.probe(first)).authenticated, true);
    const otherCwd = join(cli.cwd, "other");
    await mkdir(otherCwd);
    pending.push(provider.discover!(contextFor(otherCwd)));
    await waitForFile(join(otherCwd, "catalog-entered"), t);
    assert.equal((await provider.probe(first)).authenticated, "unknown");
    await cli.release();
    await Promise.all(pending);
    assert.equal((await provider.probe(first)).authenticated, "unknown",
      "the evicted refresh cannot restore proof when it finishes");
  } finally {
    await cli.release();
    await Promise.allSettled(pending);
    await f.pkg.onDisable();
  }
});

test("the settings panel shows a decided value for every declared row, never an unverified one", async (t) => {
  // The harness settings page renders these three matrices straight from the
  // snapshot, and "Not verified" is what a user sees whenever a kind, feature or
  // modality has no declared support. Anything genuinely unsupported must say
  // so instead, so this walks the real snapshot rather than the declarations.
  const { bin, cwd } = await fakeCli(t, { signedIn: true });
  useEnvironment(t, "POLYTH_ANTIGRAVITY_BIN", bin);
  const f = fixture(); f.pkg.onEnable();
  try {
    const [snapshot] = await f.registry.snapshots(contextFor(cwd), { harnessId: "antigravity", detail: true });
    assert.ok(snapshot);
    const rows = [
      ...projectionFacts(snapshot),
      ...runtimeFacts(snapshot),
      ...attachmentFacts(snapshot),
    ];
    const unverified = rows.filter((row) => row.value === "Not verified").map((row) => row.label);
    assert.deepEqual(unverified, [], "every panel row must carry a decided support value");
    // Unsupported rows must reflect the shipped execution mode. Approval prompts
    // are supported: the bridge sends gated tools to Polyth even under the
    // native headless bypass.
    assert.deepEqual(rows.filter((row) => row.unsupported).map((row) => row.id).sort(),
      ["extension", "subagents", "fork", "compaction", "cost"].sort());
    assert.equal(availabilityLabel(snapshot), "Ready");
    assert.equal(integrationLabel(snapshot), "Session-scoped integration");
  } finally { await f.pkg.onDisable(); }
});

test("autonomous discovery includes the package and workspace lock records its exact dependencies", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const discovered = await discoverServerPackages(root);
  assert.ok(discovered.some((item) => item.packageName === "@polyth/backend-antigravity"));
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../../../package-lock.json", import.meta.url), "utf8"));
  assert.deepEqual(lock.packages["packages/backend-antigravity"].dependencies, manifest.dependencies);
  assert.equal(lock.packages["node_modules/@polyth/backend-antigravity"].resolved, "packages/backend-antigravity");
});
