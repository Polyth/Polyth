import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { HarnessContext } from "@polyth/contracts";
import { claudePluginMutationArgs, createClaudeNativePlugins } from "../src/nativePlugins.ts";
import { createClaudeProvider } from "../src/serverEntry.ts";

const write = (path: string, content: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
};

/** A stand-in `claude` that records argv/env and answers the plugin subcommands. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, configDir: process.env.CLAUDE_CONFIG_DIR ?? null }) + "\\n");
const key = args.join(" ");
if (key === "plugin list --json") { process.stdout.write(fs.readFileSync(process.env.FAKE_LIST, "utf8")); process.exit(0); }
if (key === "plugin marketplace list --json") {
  if (process.env.FAKE_MARKETPLACE_FAIL) { process.stderr.write("boom"); process.exit(1); }
  process.stdout.write(JSON.stringify([{ name: "mk", source: "github", repo: "owner/mk", installLocation: "/x" }])); process.exit(0);
}
const ref = args[2] ?? "";
if (ref.startsWith("cmd@")) { process.stderr.write("\\u001b[31mThis plugin installs by running a marketplace-declared command; pass -y to accept it (required when stdin or stdout is not a TTY)\\u001b[0m"); process.exit(1); }
if (ref.startsWith("missing@")) { process.stderr.write("Plugin missing not found in marketplace"); process.exit(2); }
if (ref.startsWith("slow@")) { setTimeout(() => process.exit(0), 30000); return; }
process.stdout.write("ok"); process.exit(0);
`;

const setup = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "polyth-claude-plugins-")));
    const configDir = join(root, "config");
    const bin = join(root, "claude");
    write(bin, FAKE_CLAUDE);
    chmodSync(bin, 0o755);
    const log = join(root, "log.jsonl");
    write(log, "");
    // A plugin with every component kind.
    const demo = join(configDir, "plugins", "cache", "mk", "demo", "1.0.0");
    write(join(demo, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo", hooks: "./hooks/custom.json" }));
    write(join(demo, "skills", "alpha", "SKILL.md"), "---\nname: alpha\n---\n");
    write(join(demo, "skills", "beta", "SKILL.md"), "---\nname: beta\n---\n");
    mkdirSync(join(demo, "skills", "no-skill-file"), { recursive: true });
    write(join(demo, "commands", "ship.md"), "# ship");
    write(join(demo, "commands", "notes.toml"), "ignored");
    write(join(demo, "agents", "reviewer.md"), "# reviewer");
    write(join(demo, "hooks", "custom.json"), JSON.stringify({ hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x" }, { type: "command", command: "y" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "z" }] }],
    } }));
    write(join(demo, ".mcp.json"), JSON.stringify({ mcpServers: { figma: { type: "http", url: "https://example.invalid/mcp" } } }));
    // A skill directory that symlinks outside the plugin is not read.
    const outside = join(root, "outside");
    write(join(outside, "SKILL.md"), "---\nname: escaped\n---\n");
    symlinkSync(outside, join(demo, "skills", "escaped"));
    // A plugin whose install path lies outside the account's config dir.
    const foreign = join(root, "foreign-plugin");
    write(join(foreign, "skills", "x", "SKILL.md"), "x");
    const list = join(root, "list.json");
    write(list, JSON.stringify([
        { id: "demo@mk", version: "1.0.0", scope: "user", enabled: true, installPath: demo },
        { id: "other@mk", version: "2.0.0", scope: "project", enabled: false, installPath: foreign, projectPath: "/projects/elsewhere" },
        { id: "here@mk", scope: "local", enabled: true, projectPath: "/projects/a" },
        { id: "design@synced", version: "1.2.0", scope: "synced", enabled: true },
        { id: "mine@skills-dir", scope: "user", enabled: true },
        { id: "odd@mk", scope: "galaxy", enabled: true },
        { scope: "user" },
    ]));
    return { root, configDir, bin, log, list };
};

const context = (cwd = "/projects/a"): HarnessContext => ({ spaceId: "space-a", projectId: "project-a", cwd });
const calls = (log: string) => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { args: string[]; configDir: string | null });

const managerFor = (fixture: ReturnType<typeof setup>, extraEnv: NodeJS.ProcessEnv = {}) => createClaudeNativePlugins({
    harnessId: "claude",
    resolveBinary: async () => ({
        command: fixture.bin,
        env: { ...process.env, FAKE_LOG: fixture.log, FAKE_LIST: fixture.list, CLAUDE_CONFIG_DIR: fixture.configDir, ...extraEnv },
    }),
});

test("lists Claude plugins with components, effects and native scope", async (t) => {
    const fixture = setup();
    t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
    const cwd = mkdtempSync(join(tmpdir(), "polyth-claude-cwd-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const result = await managerFor(fixture).list({ ...context(), cwd });

    assert.deepEqual(calls(fixture.log).map((call) => call.args).sort(), [
        ["plugin", "list", "--json"],
        ["plugin", "marketplace", "list", "--json"],
    ]);
    assert.equal(result.harnessId, "claude");
    assert.deepEqual(result.support, { actions: ["install", "uninstall", "enable", "disable", "update"], installScopes: ["user", "project", "local"], installHint: "plugin@marketplace", applies: "next-session", marketplaces: true });
    assert.deepEqual(result.marketplaces, [{ name: "mk", source: "github", ref: "owner/mk" }]);
    assert.deepEqual(result.plugins.map((plugin) => plugin.id), ["demo@mk", "other@mk", "here@mk", "design@synced", "mine@skills-dir"]);
    assert.deepEqual(result.warnings, ["Skipped odd@mk: unrecognized scope"]);

    const demo = result.plugins[0]!;
    assert.equal(demo.name, "demo");
    assert.equal(demo.version, "1.0.0");
    assert.equal(demo.scope, "user");
    assert.equal(demo.enabled, true);
    assert.deepEqual(demo.source, { kind: "marketplace", ref: "mk" });
    assert.deepEqual(demo.evidence, { stage: "discovered", source: "claude plugin list --json" });
    assert.equal(demo.readOnly, undefined);
    const byKind = Object.fromEntries((demo.components ?? []).map((component) => [component.kind, component]));
    assert.deepEqual(Object.keys(byKind).sort(), ["agent", "command", "hook", "mcp-server", "skill"]);
    assert.equal(byKind.skill!.count, 2);
    assert.deepEqual(byKind.skill!.names, ["alpha", "beta"]);
    assert.equal(byKind.skill!.effect, "hidden-by-polyth");
    assert.equal(byKind.agent!.effect, "hidden-by-polyth");
    assert.deepEqual(byKind.command!.names, ["ship"]);
    assert.equal(byKind.command!.effect, "unknown");
    assert.equal(byKind.hook!.count, 3);
    assert.deepEqual(byKind.hook!.names, ["PreToolUse", "SessionStart"]);
    assert.equal(byKind.hook!.effect, "active");
    assert.deepEqual(byKind["mcp-server"]!.names, ["figma"]);
    assert.equal(byKind["mcp-server"]!.effect, "active");
    assert.ok(!JSON.stringify(demo).includes("example.invalid"), "MCP server configuration never leaves the adapter");

    const other = result.plugins[1]!;
    assert.equal(other.components, undefined, "an install path outside the account config dir is not read");
    assert.equal(other.readOnly, true);
    assert.match(other.note ?? "", /another project/);
    assert.equal(other.enabled, false);

    const synced = result.plugins[3]!;
    assert.equal(synced.scope, "synced");
    assert.equal(synced.readOnly, true);
    assert.deepEqual(synced.source, { kind: "unknown" });
    assert.deepEqual(result.plugins[4]!.source, { kind: "local" });
});

test("a project plugin for the current project stays manageable", async (t) => {
    const fixture = setup();
    t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "polyth-claude-cwd-")));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    write(fixture.list, JSON.stringify([{ id: "here@mk", scope: "local", enabled: true, projectPath: cwd }]));
    const result = await managerFor(fixture).list({ ...context(), cwd });
    assert.equal(result.plugins[0]!.readOnly, undefined);
    assert.equal(result.plugins[0]!.projectPath, cwd);
});

test("an unreadable marketplace list is a warning, not a failed listing", async (t) => {
    const fixture = setup();
    t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
    const result = await managerFor(fixture, { FAKE_MARKETPLACE_FAIL: "1" }).list({ ...context(), cwd: fixture.root });
    assert.equal(result.marketplaces, undefined);
    assert.ok(result.warnings?.includes("Claude Code marketplaces could not be read"));
    assert.equal(result.plugins.length, 5);
});

test("managed plugins are read-only and their enable/disable/uninstall is refused without a process", async (t) => {
    const fixture = setup();
    t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
    write(fixture.list, JSON.stringify([{ id: "policy@corp", version: "3.0.0", scope: "managed", enabled: true }]));
    const manager = managerFor(fixture);
    const ctx = { ...context(), cwd: fixture.root };
    const [managed] = (await manager.list(ctx)).plugins;
    assert.equal(managed!.scope, "managed");
    assert.equal(managed!.readOnly, true);
    assert.match(managed!.note ?? "", /administrator/);
    const before = calls(fixture.log).length;
    for (const action of ["enable", "disable", "uninstall", "install"] as const) {
        const outcome = await manager.mutate!(ctx, { action, plugin: "policy@corp", scope: "managed" }, { operationId: `op-${action}` });
        assert.equal(outcome.kind, "rejected");
        assert.equal((outcome as { code: string }).code, "unsupported", action);
    }
    assert.equal(calls(fixture.log).length, before, "a refused managed mutation never starts a process");
    // `claude plugin update --scope managed` is a real command, so it still runs.
    assert.equal((await manager.mutate!(ctx, { action: "update", plugin: "policy@corp", scope: "managed" }, { operationId: "op-update" })).kind, "confirmed");
    assert.deepEqual(calls(fixture.log).at(-1)!.args, ["plugin", "update", "policy@corp", "--scope", "managed"]);
});

test("remote projects are listed read-only without running the CLI", async (t) => {
    const fixture = setup();
    t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
    const manager = managerFor(fixture);
    const remote: HarnessContext = { ...context(), remote: true };
    const result = await manager.list(remote);
    assert.deepEqual(result.plugins, []);
    assert.deepEqual(result.support.actions, []);
    assert.deepEqual(calls(fixture.log), []);
    assert.equal((await manager.mutate!(remote, { action: "enable", plugin: "demo@mk" }, { operationId: "op" })).kind, "rejected");
});

test("mutation argv is exact, scoped, and never accepts a command on the user's behalf", () => {
    assert.deepEqual(claudePluginMutationArgs({ action: "install", plugin: "demo@mk" }), { args: ["plugin", "install", "demo@mk", "--scope", "user"] });
    assert.deepEqual(claudePluginMutationArgs({ action: "install", plugin: "demo@mk", scope: "project" }), { args: ["plugin", "install", "demo@mk", "--scope", "project"] });
    assert.deepEqual(claudePluginMutationArgs({ action: "enable", plugin: "demo@mk" }), { args: ["plugin", "enable", "demo@mk"] });
    assert.deepEqual(claudePluginMutationArgs({ action: "disable", plugin: "demo@mk", scope: "local" }), { args: ["plugin", "disable", "demo@mk", "--scope", "local"] });
    assert.deepEqual(claudePluginMutationArgs({ action: "uninstall", plugin: "demo@mk" }), { args: ["plugin", "uninstall", "demo@mk"] });
    assert.deepEqual(claudePluginMutationArgs({ action: "update", plugin: "demo@mk", scope: "managed" }), { args: ["plugin", "update", "demo@mk", "--scope", "managed"] });
    assert.equal((claudePluginMutationArgs({ action: "install", plugin: "demo@mk", scope: "synced" }) as { code: string }).code, "invalid-input");
    for (const action of ["enable", "disable", "uninstall"] as const) {
        assert.equal((claudePluginMutationArgs({ action, plugin: "demo@mk", scope: "managed" }) as { code: string }).code, "unsupported");
    }
    assert.equal((claudePluginMutationArgs({ action: "install", plugin: "-y" }) as { code: string }).code, "invalid-input");
    assert.equal((claudePluginMutationArgs({ action: "install", plugin: "a b" }) as { code: string }).code, "invalid-input");
    assert.equal((claudePluginMutationArgs({ action: "configure" as never, plugin: "demo@mk" }) as { code: string }).code, "unsupported");
    for (const action of ["install", "uninstall", "enable", "disable", "update"] as const) {
        const planned = claudePluginMutationArgs({ action, plugin: "demo@mk" }) as { args: string[] };
        assert.ok(!planned.args.some((arg) => arg === "-y" || arg === "--yes" || arg === "--accept-command" || arg === "--prune"));
    }
});

test("mutation outcomes: confirmed, refused, confirmation-required, missing CLI and unknown", async (t) => {
    const fixture = setup();
    t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
    const manager = managerFor(fixture);
    const ctx = { ...context(), cwd: fixture.root };

    assert.deepEqual(await manager.mutate!(ctx, { action: "install", plugin: "demo@mk", scope: "project" }, { operationId: "op-1" }),
        { kind: "confirmed", value: { pendingRestart: false, message: "Applies to new Claude Code sessions" } });
    assert.deepEqual(calls(fixture.log).at(-1), { args: ["plugin", "install", "demo@mk", "--scope", "project"], configDir: fixture.configDir });

    const missing = await manager.mutate!(ctx, { action: "uninstall", plugin: "missing@mk" }, { operationId: "op-2" });
    assert.deepEqual(missing, { kind: "rejected", code: "native-command-failed", message: "Plugin missing not found in marketplace" });

    const command = await manager.mutate!(ctx, { action: "install", plugin: "cmd@mk" }, { operationId: "op-3" });
    assert.equal(command.kind, "rejected");
    assert.equal((command as { code: string }).code, "confirmation-required");
    assert.ok(!(command as { message: string }).message.includes("\u001b"), "terminal escapes are stripped");

    const invalid = await manager.mutate!(ctx, { action: "install", plugin: "--accept-command=abc" }, { operationId: "op-4" });
    assert.equal((invalid as { code: string }).code, "invalid-input");
    assert.equal(calls(fixture.log).length, 3, "an invalid reference never reaches a process");

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const slow = await manager.mutate!(ctx, { action: "update", plugin: "slow@mk" }, { operationId: "op-5", signal: controller.signal });
    assert.equal(slow.kind, "unknown");
    assert.equal((slow as { operationId: string }).operationId, "op-5");

    const absent = createClaudeNativePlugins({ harnessId: "claude", resolveBinary: async () => { throw Object.assign(new Error("Claude Code CLI was not found"), { code: "not-installed" }); } });
    assert.deepEqual(await absent.mutate!(ctx, { action: "enable", plugin: "demo@mk" }, { operationId: "op-6" }),
        { kind: "rejected", code: "not-installed", message: "Claude Code CLI was not found" });
});

test("the provider wires plugins through the account's CLAUDE_CONFIG_DIR", async (t) => {
    const fixture = setup();
    t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
    const accountDir = join(fixture.root, "account-work");
    mkdirSync(accountDir, { recursive: true });
    const saved = { bin: process.env.POLYTH_CLAUDE_BIN, log: process.env.FAKE_LOG, list: process.env.FAKE_LIST };
    process.env.POLYTH_CLAUDE_BIN = fixture.bin;
    process.env.FAKE_LOG = fixture.log;
    process.env.FAKE_LIST = fixture.list;
    t.after(() => {
        for (const [key, value] of [["POLYTH_CLAUDE_BIN", saved.bin], ["FAKE_LOG", saved.log], ["FAKE_LIST", saved.list]] as const) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    const host = { pluginId: "backend-claude" } as unknown as Parameters<typeof createClaudeProvider>[0];
    const provider = createClaudeProvider(host, { id: "work", harnessId: "claude-work", name: "Work", dir: accountDir });
    assert.ok(provider.plugins, "Claude exposes a native plugin manager");
    const result = await provider.plugins.list({ ...context(), cwd: fixture.root });
    assert.equal(result.harnessId, "claude-work");
    assert.ok(result.plugins.every((plugin) => plugin.harnessId === "claude-work"));
    // The account dir holds no plugins, so nothing from the default fixture is read.
    assert.ok(result.plugins.every((plugin) => plugin.components === undefined));
    assert.ok(calls(fixture.log).every((call) => call.configDir === accountDir));
    await provider.plugins.mutate!({ ...context(), cwd: fixture.root }, { action: "disable", plugin: "demo@mk" }, { operationId: "op" });
    assert.deepEqual(calls(fixture.log).at(-1), { args: ["plugin", "disable", "demo@mk"], configDir: accountDir });
});
