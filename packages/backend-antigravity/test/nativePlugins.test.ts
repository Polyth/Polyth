import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { HarnessContext } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import { createHarnessRegistry } from "@polyth/harness-runtime";
import { createAntigravityNativePlugins, parseAgyPluginList } from "../src/nativePlugins.ts";
import registerPackage from "../src/serverEntry.ts";

interface FakeCall { argv: string[]; cwd: string; env: Record<string, string | undefined> }
type FakeReply = { stdout?: string; stderr?: string; exit?: number; sleepMs?: number };

/** A fake `agy` that records argv/cwd/env and answers by `plugin <command>`. */
async function fakeAgy(t: TestContext, replies: Record<string, FakeReply>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "polyth-agy-plugins-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "agy");
  const log = join(dir, "calls.jsonl");
  const repliesFile = join(dir, "replies.json");
  await writeFile(repliesFile, JSON.stringify(replies));
  await writeFile(bin, `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, cwd: process.cwd(), env: { HOME: process.env.HOME, NO_COLOR: process.env.NO_COLOR } }) + "\\n");
const replies = JSON.parse(fs.readFileSync(${JSON.stringify(repliesFile)}, "utf8"));
const reply = (argv[0] === "plugin" ? replies[argv[1]] : replies[argv[0]]) ?? {};
setTimeout(() => {
  if (reply.stdout) process.stdout.write(reply.stdout);
  if (reply.stderr) process.stderr.write(reply.stderr);
  process.exit(reply.exit ?? 0);
}, reply.sleepMs ?? 0);
`, { mode: 0o700 });
  const calls = async (): Promise<FakeCall[]> =>
    (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as FakeCall);
  const setReplies = (next: Record<string, FakeReply>) => writeFile(repliesFile, JSON.stringify(next));
  return { dir, bin, calls, setReplies };
}

const contextFor = (cwd: string, overrides: Partial<HarnessContext> = {}): HarnessContext => ({
  spaceId: "space-a", projectId: "project-a", cwd, ...overrides,
});

test("parseAgyPluginList recognizes agy's empty marker and only strict plugin rows", () => {
  assert.deepEqual(parseAgyPluginList("No imported plugins.\n"), { empty: true, plugins: [], unrecognized: 0 });
  // No output is not proof of an empty list.
  assert.deepEqual(parseAgyPluginList(""), { empty: false, plugins: [], unrecognized: 0 });
  assert.deepEqual(parseAgyPluginList("Imported plugins:\n  - review@acme (enabled)\n  - lint disabled\n  * notes\n  2. guard: Enabled\n"), {
    empty: false,
    plugins: [
      { name: "review@acme", enabled: true },
      { name: "lint", enabled: false },
      { name: "notes", enabled: "unknown" },
      { name: "guard", enabled: true },
    ],
    unrecognized: 0,
  });
  // Prose, versions, paths and flags are never read as a plugin name.
  assert.deepEqual(parseAgyPluginList("Imported plugins:\n  review@acme\nRun agy plugin enable <name> to turn one on.\n  lint v1.2.0 (enabled)\n  --help\n  /tmp/x\n"), {
    empty: false,
    plugins: [{ name: "review@acme", enabled: "unknown" }],
    unrecognized: 4,
  });
});

test("an unrecognized line makes every listed plugin read-only and is reported", async (t) => {
  const agy = await fakeAgy(t, { list: { stdout: "Imported plugins:\n  review@acme\nLoaded 1 plugin from /home/u/.gemini\n" } });
  const manager = createAntigravityNativePlugins({
    harnessId: "antigravity",
    resolveBinary: async () => ({ command: agy.bin, env: { PATH: process.env.PATH, HOME: agy.dir } }),
  });
  const list = await manager.list(contextFor(agy.dir));
  assert.deepEqual(list.plugins.map((plugin) => [plugin.id, plugin.readOnly]), [["review@acme", true]]);
  assert.match(list.plugins[0]!.note ?? "", /could not be fully read/);
  assert.ok(list.warnings?.includes("Some lines of agy's plugin list were not recognized, so its plugins are shown read-only."));
  // Neither the prose word nor a listed name is uninstalled from a partly read list.
  for (const plugin of ["Loaded", "review@acme"]) {
    const outcome = await manager.mutate!(contextFor(agy.dir), { action: "uninstall", plugin }, { operationId: "op" });
    assert.equal(outcome.kind, "rejected");
    assert.equal((outcome as { code: string }).code, "unsupported");
  }
  assert.deepEqual((await agy.calls()).map((call) => call.argv), [["plugin", "list"], ["plugin", "list"], ["plugin", "list"]]);
});

test("list runs `agy plugin list` with the account home and marks parsed text as best-effort", async (t) => {
  const agy = await fakeAgy(t, { list: { stdout: "Imported plugins:\n  review@acme\n" } });
  const home = join(agy.dir, "account-home");
  const manager = createAntigravityNativePlugins({
    harnessId: "antigravity-work",
    resolveBinary: async () => ({ command: agy.bin, env: { PATH: process.env.PATH, HOME: home } }),
  });
  const list = await manager.list(contextFor(agy.dir));
  const [call] = await agy.calls();
  assert.deepEqual(call!.argv, ["plugin", "list"]);
  assert.equal(call!.env.HOME, home);
  assert.equal(call!.cwd, agy.dir);
  assert.deepEqual(list.support, {
    actions: ["install", "uninstall", "enable", "disable"], installScopes: ["user"],
    installHint: "plugin@marketplace or /path/to/plugin-directory", applies: "next-session", marketplaces: false,
  });
  assert.equal(list.plugins.length, 1);
  assert.equal(list.plugins[0]!.id, "review@acme");
  assert.equal(list.plugins[0]!.name, "review");
  assert.deepEqual(list.plugins[0]!.source, { kind: "marketplace", ref: "acme" });
  assert.equal(list.plugins[0]!.enabled, "unknown");
  assert.deepEqual(list.plugins[0]!.evidence, { stage: "discovered", source: "agy plugin list" });
  assert.match(list.warnings?.[0] ?? "", /no machine-readable plugin list/);
  assert.equal(list.warnings?.length, 1);
  assert.equal(list.plugins[0]!.readOnly, undefined);

  await agy.setReplies({ list: { stdout: "No imported plugins.\n" } });
  const empty = await manager.list(contextFor(agy.dir));
  assert.deepEqual(empty.plugins, []);
  assert.equal(empty.warnings, undefined);
});

test("mutations map to exact `agy plugin` argv and report confirmed/rejected/unknown truthfully", async (t) => {
  const agy = await fakeAgy(t, {
    list: { stdout: "Imported plugins:\n  review@acme\n" },
    install: { stdout: "Extracting plugin...\nInstalled plugin \"review\"\n" },
    enable: { stderr: "Error: plugin \"ghost\" not found or invalid\n", exit: 1 },
    disable: {},
    uninstall: { stdout: "Uninstalled plugin \"review@acme\"\n" },
  });
  const home = join(agy.dir, "home");
  const manager = createAntigravityNativePlugins({
    harnessId: "antigravity",
    resolveBinary: async () => ({ command: agy.bin, env: { PATH: process.env.PATH, HOME: home } }),
  });
  const context = contextFor(agy.dir);
  assert.deepEqual(await manager.mutate!(context, { action: "install", plugin: "review@acme", scope: "user" }, { operationId: "a" }),
    { kind: "confirmed", value: { pendingRestart: false, message: "Installed plugin \"review\"" } });
  assert.deepEqual(await manager.mutate!(context, { action: "enable", plugin: "ghost" }, { operationId: "b" }),
    { kind: "rejected", code: "native-command-failed", message: "Error: plugin \"ghost\" not found or invalid" });
  assert.deepEqual(await manager.mutate!(context, { action: "disable", plugin: "review@acme" }, { operationId: "c" }),
    { kind: "confirmed", value: { pendingRestart: false } });
  assert.equal((await manager.mutate!(context, { action: "uninstall", plugin: "review@acme" }, { operationId: "d" })).kind, "confirmed");

  const calls = await agy.calls();
  assert.deepEqual(calls.map((call) => call.argv), [
    ["plugin", "install", "review@acme"],
    ["plugin", "enable", "ghost"],
    ["plugin", "disable", "review@acme"],
    // uninstall pre-reads the list: agy reports success for a missing name.
    ["plugin", "list"],
    ["plugin", "uninstall", "review@acme"],
  ]);
  for (const call of calls) {
    assert.equal(call.env.HOME, home);
    assert.ok(!call.argv.includes("-y") && !call.argv.includes("--yes"));
  }
});

test("uninstall against agy's empty list is refused without touching its manifest", async (t) => {
  const agy = await fakeAgy(t, { list: { stdout: "No imported plugins.\n" }, uninstall: { stdout: "Uninstalled plugin \"x\"\n" } });
  const manager = createAntigravityNativePlugins({
    harnessId: "antigravity",
    resolveBinary: async () => ({ command: agy.bin, env: { PATH: process.env.PATH, HOME: agy.dir } }),
  });
  assert.deepEqual(await manager.mutate!(contextFor(agy.dir), { action: "uninstall", plugin: "x" }, { operationId: "op" }),
    { kind: "rejected", code: "not-found", message: "x is not installed in Antigravity." });
  assert.deepEqual((await agy.calls()).map((call) => call.argv), [["plugin", "list"]]);
});

test("uninstall of a name absent from a recognized non-empty list is refused without running uninstall", async (t) => {
  const agy = await fakeAgy(t, { list: { stdout: "Imported plugins:\n  - review@acme (enabled)\n" }, uninstall: { stdout: "Uninstalled plugin \"ghost\"\n" } });
  const manager = createAntigravityNativePlugins({
    harnessId: "antigravity",
    resolveBinary: async () => ({ command: agy.bin, env: { PATH: process.env.PATH, HOME: agy.dir } }),
  });
  assert.deepEqual(await manager.mutate!(contextFor(agy.dir), { action: "uninstall", plugin: "ghost" }, { operationId: "op" }),
    { kind: "rejected", code: "not-found", message: "ghost is not installed in Antigravity." });
  assert.deepEqual((await agy.calls()).map((call) => call.argv), [["plugin", "list"]]);
});

test("refusals before any command, remote targets, a missing binary and an interrupted command", async (t) => {
  const agy = await fakeAgy(t, { install: { sleepMs: 5_000 } });
  const env = { PATH: process.env.PATH, HOME: agy.dir };
  const manager = createAntigravityNativePlugins({ harnessId: "antigravity", resolveBinary: async () => ({ command: agy.bin, env }) });
  const context = contextFor(agy.dir);
  const code = async (input: Parameters<NonNullable<typeof manager.mutate>>[1], ctx = context) =>
    (await manager.mutate!(ctx, input, { operationId: "x" }) as { code?: string }).code;
  // `--help` as a name is exactly what made the real agy run an uninstall.
  assert.equal(await code({ action: "uninstall", plugin: "--help" }), "invalid-input");
  assert.equal(await code({ action: "update", plugin: "review" }), "unsupported");
  assert.equal(await code({ action: "install", plugin: "review", scope: "project" }), "invalid-input");
  assert.equal(await code({ action: "install", plugin: "review" }, contextFor(agy.dir, { remote: true })), "unsupported");
  assert.equal((await agy.calls()).length, 0);
  const remote = await manager.list(contextFor(agy.dir, { remote: true }));
  assert.deepEqual(remote.support.actions, []);
  assert.equal((await agy.calls()).length, 0);

  const missing = createAntigravityNativePlugins({ harnessId: "antigravity", resolveBinary: async () => ({ command: join(agy.dir, "nope"), env }) });
  assert.equal((await missing.mutate!(context, { action: "install", plugin: "review" }, { operationId: "x" }) as { code: string }).code, "not-installed");
  assert.equal((await missing.mutate!(context, { action: "uninstall", plugin: "review" }, { operationId: "x" }) as { code: string }).code, "not-installed");
  const lookupFails = createAntigravityNativePlugins({
    harnessId: "antigravity",
    resolveBinary: async () => { throw Object.assign(new Error("Antigravity CLI was not found"), { code: "not-installed" }); },
  });
  assert.deepEqual(await lookupFails.mutate!(context, { action: "enable", plugin: "review" }, { operationId: "x" }),
    { kind: "rejected", code: "not-installed", message: "Antigravity CLI was not found" });

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const interrupted = await manager.mutate!(context, { action: "install", plugin: "slow" }, { operationId: "op-slow", signal: controller.signal });
  assert.equal(interrupted.kind, "unknown");
  assert.equal((interrupted as { operationId: string }).operationId, "op-slow");
});

test("the registered Antigravity provider carries a native plugin manager", async (t) => {
  const agy = await fakeAgy(t, { list: { stdout: "No imported plugins.\n" } });
  const previous = process.env.POLYTH_ANTIGRAVITY_BIN;
  process.env.POLYTH_ANTIGRAVITY_BIN = agy.bin;
  t.after(() => { if (previous === undefined) delete process.env.POLYTH_ANTIGRAVITY_BIN; else process.env.POLYTH_ANTIGRAVITY_BIN = previous; });
  const registry = createHarnessRegistry();
  const pkg = registerPackage({ services: { require: () => registry } } as unknown as ServerPackageHost);
  pkg.onEnable();
  try {
    const provider = registry.get("antigravity");
    assert.ok(provider?.plugins);
    const list = await provider.plugins.list(contextFor(agy.dir));
    assert.equal(list.harnessId, "antigravity");
    assert.deepEqual((await agy.calls()).map((call) => call.argv), [["plugin", "list"]]);
  } finally { await pkg.onDisable(); }
});
