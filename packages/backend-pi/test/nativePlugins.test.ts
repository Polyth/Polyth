import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { HarnessContext } from "@polyth/contracts";
import type { ResolvedHarnessAccount } from "@polyth/harness-runtime/accounts";
import type { ServerPackageHost } from "@polyth/plugins";
import { createPiNativePlugins, parsePiList, piProjectTrusted } from "../src/nativePlugins.ts";
import { createPiProvider } from "../src/serverEntry.ts";

interface FakeCall { argv: string[]; cwd: string; env: Record<string, string | undefined> }
type FakeReply = { stdout?: string; stderr?: string; exit?: number; sleepMs?: number };

/** A fake `pi` that records argv/cwd/env and answers by subcommand. */
async function fakePi(t: TestContext, replies: Record<string, FakeReply>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "polyth-pi-plugins-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "pi");
  const log = join(dir, "calls.jsonl");
  await writeFile(join(dir, "replies.json"), JSON.stringify(replies));
  await writeFile(bin, `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
const pick = (...names) => Object.fromEntries(names.map((name) => [name, process.env[name]]));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, cwd: process.cwd(), env: pick("PI_CODING_AGENT_DIR", "PI_OFFLINE", "NO_COLOR", "HOME") }) + "\\n");
const replies = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, "replies.json"))}, "utf8"));
const reply = replies[argv[0]] ?? replies["*"] ?? {};
setTimeout(() => {
  if (reply.stdout) process.stdout.write(reply.stdout);
  if (reply.stderr) process.stderr.write(reply.stderr);
  process.exit(reply.exit ?? 0);
}, reply.sleepMs ?? 0);
`, { mode: 0o700 });
  const calls = async (): Promise<FakeCall[]> =>
    (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as FakeCall);
  return { dir, bin, calls };
}

/** An isolated Pi home + project. `trusted` writes Pi's own trust decision. */
async function layout(t: TestContext, options: { trusted?: boolean; trustRequiring?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "polyth-pi-layout-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  if (options.trustRequiring) {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "settings.json"), "{}");
  }
  if (options.trusted !== undefined) await writeFile(join(agentDir, "trust.json"), JSON.stringify({ [cwd]: options.trusted }));
  return { root, home, agentDir, cwd };
}

const contextFor = (cwd: string, overrides: Partial<HarnessContext> = {}): HarnessContext => ({
  spaceId: "space-a", projectId: "project-a", cwd, ...overrides,
});

const LIST_OUTPUT = (userPath: string) => `User packages:
  npm:pi-mcp-client@0.8.0
    ${userPath}
  git:github.com/acme/pi-tools (filtered)

Project packages:
  ./vendor/local-pi
    /srv/project/vendor/local-pi
`;

test("parsePiList reads the real `pi list` shape, including filtered and project rows", () => {
  const parsed = parsePiList(LIST_OUTPUT("/home/u/.pi/agent/npm/node_modules/pi-mcp-client"));
  assert.deepEqual(parsed, [
    { source: "npm:pi-mcp-client@0.8.0", scope: "user", filtered: false, installedPath: "/home/u/.pi/agent/npm/node_modules/pi-mcp-client" },
    { source: "git:github.com/acme/pi-tools", scope: "user", filtered: true },
    { source: "./vendor/local-pi", scope: "project", filtered: false, installedPath: "/srv/project/vendor/local-pi" },
  ]);
  assert.deepEqual(parsePiList("No packages installed.\n"), []);
  // chalk escapes do not break the headers.
  assert.equal(parsePiList("\u001b[1mUser packages:\u001b[22m\n  npm:a\n").length, 1);
});

test("Pi trust follows its own store, default and resource rules without running project code", async (t) => {
  const trusted = await layout(t, { trusted: true, trustRequiring: true });
  assert.equal(await piProjectTrusted({ agentDir: trusted.agentDir, cwd: trusted.cwd, home: trusted.home }), true);
  const denied = await layout(t, { trusted: false });
  assert.equal(await piProjectTrusted({ agentDir: denied.agentDir, cwd: denied.cwd, home: denied.home }), false);
  const unknown = await layout(t, { trustRequiring: true });
  assert.equal(await piProjectTrusted({ agentDir: unknown.agentDir, cwd: unknown.cwd, home: unknown.home }), false);
  await writeFile(join(unknown.agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
  assert.equal(await piProjectTrusted({ agentDir: unknown.agentDir, cwd: unknown.cwd, home: unknown.home }), true);
  // Nothing trust-requiring: Pi trusts it, so project packages stay manageable.
  const plain = await layout(t);
  assert.equal(await piProjectTrusted({ agentDir: plain.agentDir, cwd: plain.cwd, home: plain.home }), true);
  // An ancestor's saved decision applies to a nested project.
  const nested = await layout(t, { trustRequiring: true });
  await writeFile(join(nested.agentDir, "trust.json"), JSON.stringify({ [nested.root]: true }));
  assert.equal(await piProjectTrusted({ agentDir: nested.agentDir, cwd: nested.cwd, home: nested.home }), true);
});

test("list passes the account agent dir and explicit trust, and reports package components with effects", async (t) => {
  const paths = await layout(t, { trusted: true, trustRequiring: true });
  const pkg = join(paths.agentDir, "npm", "node_modules", "pi-mcp-client");
  await mkdir(join(pkg, "skills", "triage"), { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({
    name: "pi-mcp-client", version: "0.8.0", pi: { extensions: ["./dist/index.js"], skills: ["./skills/triage"], prompts: ["./prompts/fix.md"] },
  }));
  const pi = await fakePi(t, { list: { stdout: LIST_OUTPUT(pkg) } });
  const manager = createPiNativePlugins({
    harnessId: "pi-work",
    resolveBinary: async () => ({ command: pi.bin, env: { PATH: process.env.PATH, HOME: paths.home, PI_CODING_AGENT_DIR: paths.agentDir } }),
  });
  const list = await manager.list(contextFor(paths.cwd));
  const [call] = await pi.calls();
  assert.deepEqual(call!.argv, ["list", "--approve"]);
  assert.equal(call!.cwd, paths.cwd);
  assert.equal(call!.env.PI_CODING_AGENT_DIR, paths.agentDir);
  assert.equal(call!.env.PI_OFFLINE, "1");
  assert.equal(list.harnessId, "pi-work");
  assert.equal(list.warnings, undefined);
  assert.deepEqual(list.support, {
    actions: ["install", "uninstall", "update"], installScopes: ["user", "project"],
    installHint: "npm:package, git:github.com/user/repo or ./local/path", applies: "next-session", marketplaces: false,
  });
  const [mcp, git, local] = list.plugins;
  assert.equal(mcp!.id, "npm:pi-mcp-client@0.8.0");
  assert.equal(mcp!.name, "pi-mcp-client");
  assert.equal(mcp!.version, "0.8.0");
  assert.deepEqual(mcp!.source, { kind: "npm", ref: "npm:pi-mcp-client@0.8.0" });
  assert.equal(mcp!.scope, "user");
  assert.equal(mcp!.enabled, true);
  assert.deepEqual(mcp!.evidence, { stage: "discovered", source: "pi list" });
  assert.deepEqual(mcp!.components, [
    { kind: "native-code", count: 1, names: ["index.js"], effect: "active", reason: "Interactive extension dialogs are cancelled by Polyth" },
    { kind: "skill", count: 1, names: ["triage"], effect: "active" },
    { kind: "command", count: 1, names: ["fix.md"], effect: "unknown", reason: "Prompt templates are not verified through Polyth's composer" },
  ]);
  assert.equal(git!.source.kind, "git");
  assert.equal(git!.name, "pi-tools");
  assert.match(git!.note!, /turned off in `pi config`/);
  assert.match(git!.note!, /not installed/);
  assert.equal(local!.scope, "project");
  assert.equal(local!.projectPath, paths.cwd);
  assert.equal(local!.source.kind, "local");
});

test("an untrusted project lists with --no-approve, warns, and refuses project changes before running Pi", async (t) => {
  const paths = await layout(t, { trustRequiring: true });
  const pi = await fakePi(t, { list: { stdout: "No packages installed.\n" } });
  const manager = createPiNativePlugins({
    harnessId: "pi",
    resolveBinary: async () => ({ command: pi.bin, env: { PATH: process.env.PATH, HOME: paths.home, PI_CODING_AGENT_DIR: paths.agentDir } }),
  });
  const list = await manager.list(contextFor(paths.cwd));
  assert.deepEqual((await pi.calls()).map((call) => call.argv), [["list", "--no-approve"]]);
  assert.match(list.warnings?.[0] ?? "", /does not trust this project/);
  const outcome = await manager.mutate!(contextFor(paths.cwd), { action: "install", plugin: "npm:foo", scope: "project" }, { operationId: "op-1" });
  assert.deepEqual(outcome, { kind: "rejected", code: "project-untrusted", message: "Pi does not trust this project. Trust it in Pi before changing its project packages." });
  assert.equal((await pi.calls()).length, 1);
  // User scope is unaffected by project trust; the flag stays explicit.
  const user = await manager.mutate!(contextFor(paths.cwd), { action: "install", plugin: "npm:foo" }, { operationId: "op-2" });
  assert.equal(user.kind, "confirmed");
  assert.deepEqual((await pi.calls()).at(-1)!.argv, ["install", "npm:foo", "--no-approve"]);
});

test("mutations map to exact native argv without -y or a shell and report every outcome", async (t) => {
  const paths = await layout(t, { trusted: true, trustRequiring: true });
  const pi = await fakePi(t, {
    install: { stdout: "Installing npm:foo...\nInstalled npm:foo\n" },
    remove: { stderr: "No matching package found for npm:missing\n", exit: 1 },
    update: { stdout: "Updated npm:foo\n" },
  });
  const env = { PATH: process.env.PATH, HOME: paths.home, PI_CODING_AGENT_DIR: paths.agentDir };
  const manager = createPiNativePlugins({ harnessId: "pi", resolveBinary: async () => ({ command: pi.bin, env }) });
  const context = contextFor(paths.cwd);

  assert.deepEqual(await manager.mutate!(context, { action: "install", plugin: "npm:foo", scope: "user" }, { operationId: "op-a" }),
    { kind: "confirmed", value: { pendingRestart: false, message: "Installed npm:foo" } });
  assert.equal((await manager.mutate!(context, { action: "install", plugin: "./tools/pkg", scope: "project" }, { operationId: "op-b" })).kind, "confirmed");
  assert.deepEqual(await manager.mutate!(context, { action: "uninstall", plugin: "npm:missing", scope: "user" }, { operationId: "op-c" }),
    { kind: "rejected", code: "native-command-failed", message: "No matching package found for npm:missing" });
  assert.equal((await manager.mutate!(context, { action: "update", plugin: "npm:foo", scope: "project" }, { operationId: "op-d" })).kind, "confirmed");

  const calls = await pi.calls();
  assert.deepEqual(calls.map((call) => call.argv), [
    ["install", "npm:foo", "--approve"],
    ["install", "./tools/pkg", "-l", "--approve"],
    ["remove", "npm:missing", "--approve"],
    // `--extension` keeps a package named `pi`/`self` from self-updating Pi.
    ["update", "--extension", "npm:foo", "--approve"],
  ]);
  for (const call of calls) {
    assert.ok(!call.argv.includes("-y") && !call.argv.includes("--yes"));
    assert.equal(call.env.PI_CODING_AGENT_DIR, paths.agentDir);
    assert.equal(call.cwd, paths.cwd);
  }
});

test("invalid refs, unsupported actions, remote targets, a missing binary and an interrupted command", async (t) => {
  const paths = await layout(t, { trusted: true });
  const pi = await fakePi(t, { install: { sleepMs: 5_000 } });
  const env = { PATH: process.env.PATH, HOME: paths.home, PI_CODING_AGENT_DIR: paths.agentDir };
  const manager = createPiNativePlugins({ harnessId: "pi", resolveBinary: async () => ({ command: pi.bin, env }) });
  const context = contextFor(paths.cwd);

  assert.equal((await manager.mutate!(context, { action: "install", plugin: "-y" }, { operationId: "x" })).kind, "rejected");
  assert.deepEqual(await manager.mutate!(context, { action: "install", plugin: "npm:a b" }, { operationId: "x" }),
    { kind: "rejected", code: "invalid-input", message: "Plugin reference must not contain whitespace or control characters." });
  assert.equal((await manager.mutate!(context, { action: "enable", plugin: "npm:a" }, { operationId: "x" }) as { code: string }).code, "unsupported");
  assert.equal((await manager.mutate!(context, { action: "install", plugin: "npm:a", scope: "local" }, { operationId: "x" }) as { code: string }).code, "invalid-input");
  assert.equal((await manager.mutate!(contextFor(paths.cwd, { remote: true }), { action: "install", plugin: "npm:a" }, { operationId: "x" }) as { code: string }).code, "unsupported");
  assert.equal((await pi.calls()).length, 0);

  const remote = await manager.list(contextFor(paths.cwd, { remote: true }));
  assert.deepEqual(remote.support.actions, []);
  assert.deepEqual(remote.plugins, []);
  assert.equal((await pi.calls()).length, 0);

  const missing = createPiNativePlugins({ harnessId: "pi", resolveBinary: async () => ({ command: join(paths.root, "no-such-pi"), env }) });
  assert.equal((await missing.mutate!(context, { action: "install", plugin: "npm:a" }, { operationId: "x" }) as { code: string }).code, "not-installed");
  const lookupFails = createPiNativePlugins({
    harnessId: "pi",
    resolveBinary: async () => { throw Object.assign(new Error("Pi CLI was not found"), { code: "not-installed" }); },
  });
  assert.deepEqual(await lookupFails.mutate!(context, { action: "install", plugin: "npm:a" }, { operationId: "x" }),
    { kind: "rejected", code: "not-installed", message: "Pi CLI was not found" });

  // Aborted after the command started: completion is unknown, never retried.
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const interrupted = await manager.mutate!(context, { action: "install", plugin: "npm:slow" }, { operationId: "op-slow", signal: controller.signal });
  assert.equal(interrupted.kind, "unknown");
  assert.equal((interrupted as { operationId: string }).operationId, "op-slow");
  assert.equal((await pi.calls()).length, 1);
});

test("without a project, a relative local path is refused before Pi runs; absolute paths and packages still run", async (t) => {
  const paths = await layout(t, { trusted: true });
  const pi = await fakePi(t, { "*": { stdout: "Done\n" } });
  const env = { PATH: process.env.PATH, HOME: paths.home, PI_CODING_AGENT_DIR: paths.agentDir };
  const manager = createPiNativePlugins({ harnessId: "pi", resolveBinary: async () => ({ command: pi.bin, env }) });
  const noProject = contextFor(paths.home, { projectId: "__default__" });

  for (const plugin of ["./local/ext", "../ext", "ext", "~/ext"]) {
    for (const action of ["install", "uninstall", "update"] as const) {
      assert.deepEqual(await manager.mutate!(noProject, { action, plugin }, { operationId: "x" }),
        { kind: "rejected", code: "invalid-input", message: "Choose a project to use a relative path, or give an absolute path." }, `${action} ${plugin}`);
    }
  }
  assert.equal((await pi.calls()).length, 0, "no Pi process for a refused path");

  assert.equal((await manager.mutate!(noProject, { action: "install", plugin: join(paths.root, "ext") }, { operationId: "x" })).kind, "confirmed");
  assert.equal((await manager.mutate!(noProject, { action: "install", plugin: "npm:pkg" }, { operationId: "x" })).kind, "confirmed");
  // With an explicit project, Pi resolves the relative path in that project.
  assert.equal((await manager.mutate!(contextFor(paths.cwd), { action: "install", plugin: "./local/ext" }, { operationId: "x" })).kind, "confirmed");
  const calls = await pi.calls();
  assert.deepEqual(calls.map((call) => call.argv[1]), [join(paths.root, "ext"), "npm:pkg", "./local/ext"]);
  assert.equal(calls[2]!.cwd, paths.cwd);
});

test("each Pi account provider exposes its own manager bound to that account's agent dir", async (t) => {
  const paths = await layout(t, { trusted: true });
  const pi = await fakePi(t, { list: { stdout: "No packages installed.\n" } });
  const previous = process.env.POLYTH_PI_BIN;
  process.env.POLYTH_PI_BIN = pi.bin;
  t.after(() => { if (previous === undefined) delete process.env.POLYTH_PI_BIN; else process.env.POLYTH_PI_BIN = previous; });
  const account = { id: "work", harnessId: "pi-work", label: "Work", dir: paths.agentDir } as unknown as ResolvedHarnessAccount;
  const provider = createPiProvider({} as ServerPackageHost, account);
  assert.ok(provider.plugins);
  const list = await provider.plugins.list(contextFor(paths.cwd));
  assert.equal(list.harnessId, "pi-work");
  assert.equal((await pi.calls())[0]!.env.PI_CODING_AGENT_DIR, paths.agentDir);
});
