import assert from "node:assert/strict";
import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { npmCliInstallCommand } from "@polyth/harness-runtime/installers";
import type { ResolvedHarnessAccount } from "@polyth/harness-runtime/accounts";
import { accountChildEnv, COPILOT_ACP_ARGS, COPILOT_NATIVE_AGENT_TOOLS, createCopilotProfile, NPM_PACKAGE, parseCopilotVersion } from "../src/serverEntry.ts";
import { environmentSignIn, signInFromSessionNew } from "../src/signIn.ts";
import { createCopilotSmallModelRunner } from "../src/smallModel.ts";

const account = { id: "work", harnessId: "copilot-work", name: "Work", dir: "/data/accounts/work" } as unknown as ResolvedHarnessAccount;

test("Copilot installs on Linux, macOS and Windows from GitHub's npm package, with no prerequisites", () => {
  assert.equal(NPM_PACKAGE, "@github/copilot");
  for (const platform of ["linux", "darwin"] as const) {
    assert.match(npmCliInstallCommand(NPM_PACKAGE, platform), /^sh -c '[\s\S]*npm install -g --prefix "\$P" @github\/copilot'$/);
  }
  assert.match(npmCliInstallCommand(NPM_PACKAGE, "win32"), /^powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "[\s\S]*install -g '@github\/copilot'[\s\S]*"$/);
});

test("the descriptor offers this platform's installer, the POSIX one on SSH hosts, the CLI's updater and a device sign-in for hosts", () => {
  const { descriptor } = createCopilotProfile();
  assert.equal(descriptor.id, "copilot");
  assert.equal(descriptor.installCommand, npmCliInstallCommand(NPM_PACKAGE, process.platform));
  assert.deepEqual(descriptor.remoteHost, {
    binary: "copilot",
    installCommand: npmCliInstallCommand(NPM_PACKAGE),
    signInCommand: "copilot login --device-code",
  });
  assert.deepEqual(descriptor.updateCommand, ["copilot", "update"]);
  assert.deepEqual(descriptor.releaseSource, { kind: "npm", package: "@github/copilot" });
  assert.equal(descriptor.autoSelect, false);
});

test("the agent starts as an ACP stdio server without its own subagent tools or self-update", () => {
  assert.deepEqual(createCopilotProfile().args, COPILOT_ACP_ARGS);
  assert.deepEqual(COPILOT_ACP_ARGS.slice(0, 3), ["--acp", "--stdio", "--no-auto-update"]);
  assert.equal(COPILOT_ACP_ARGS[3], "--excluded-tools=task,read_agent,list_agents,write_agent,run_dynamic_workflow,dynamic_workflows_manage");
  // No path of this machine is in the arguments, so an SSH host runs the same ones.
  assert.equal(createCopilotProfile().remoteArgs, undefined);
  assert.ok(COPILOT_NATIVE_AGENT_TOOLS.includes("task"));
});

test("an added account runs in its own COPILOT_HOME and never on the server's token", () => {
  const base = { PATH: "/bin", COPILOT_GITHUB_TOKEN: "a", GH_TOKEN: "b", GITHUB_TOKEN: "c", COPILOT_HOME: "/root/.copilot" };
  assert.equal(accountChildEnv(base), base);
  assert.deepEqual(accountChildEnv(base, account), { PATH: "/bin", COPILOT_HOME: "/data/accounts/work" });
  const profile = createCopilotProfile(account);
  assert.equal(profile.descriptor.id, "copilot-work");
  assert.equal(profile.env?.COPILOT_HOME, "/data/accounts/work");
  assert.equal(profile.env?.GH_TOKEN, undefined);
  assert.equal(createCopilotProfile().env, undefined);
});

test("the version line proves the executable is GitHub's CLI", () => {
  assert.equal(parseCopilotVersion("GitHub Copilot CLI 1.0.109.\nRun 'copilot update' to check for updates.\n"), "1.0.109");
  assert.equal(parseCopilotVersion("GitHub Copilot CLI 1.1.0-beta.2"), "1.1.0-beta.2");
  // The build the GitHub Copilot app carries; the sentence's full stop is not part of it.
  assert.equal(parseCopilotVersion("GitHub Copilot CLI 1.0.106-8.\n"), "1.0.106-8");
  // AWS Copilot CLI answers `copilot --version` too.
  assert.equal(parseCopilotVersion("copilot version: v1.34.0"), undefined);
  assert.equal(parseCopilotVersion(""), undefined);
});

test("sign-in is read from the launch environment or from what session/new answers", () => {
  assert.deepEqual(environmentSignIn({ GH_TOKEN: "x" }), { loggedIn: true, plan: "Access token" });
  assert.deepEqual(environmentSignIn({ COPILOT_PROVIDER_BASE_URL: "http://localhost:11434/v1", GH_TOKEN: "x" }), { loggedIn: true, plan: "Own model provider" });
  assert.equal(environmentSignIn({ GH_TOKEN: "  " }), undefined);
  assert.deepEqual(signInFromSessionNew({ ok: true }), { loggedIn: true });
  // The exact refusal of a signed-out Copilot CLI 1.0.109.
  assert.deepEqual(signInFromSessionNew({ ok: false, rpcCode: -32000, message: "Authentication required" }), { loggedIn: false });
  // A crash or a timeout is not a sign-out.
  assert.deepEqual(signInFromSessionNew({ ok: false }), { loggedIn: "unknown" });
  assert.deepEqual(signInFromSessionNew({ ok: false, rpcCode: -32603, message: "Internal error" }), { loggedIn: "unknown" });
});

test("a signed-out probe never claims a sign-in; a remote context is refused", async () => {
  const probe = await createCopilotProfile().probe({ spaceId: "s", projectId: "p", cwd: "/tmp", remote: true });
  assert.deepEqual(probe, { harnessId: "copilot", installed: false, authenticated: "unknown", healthy: false, message: "Local execution only" });
});

test("utility completions pipe the prompt to a silent, tool-restricted run outside the project", async () => {
  const calls: Array<{ command: string; args: readonly string[]; cwd?: string; stdin: string }> = [];
  const spawnProcess = ((command: string, args: readonly string[], options: { cwd?: string }) => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let written = "";
    stdin.on("data", (chunk) => { written += String(chunk); });
    stdin.on("end", () => {
      calls.push({ command, args, ...(options.cwd ? { cwd: options.cwd } : {}), stdin: written });
      stdout.end("Fix the login redirect\n\n");
      stderr.end();
      setImmediate(() => { child.emit("exit", 0, null); child.emit("close", 0, null); });
    });
    Object.assign(child, { stdin, stdout, stderr, exitCode: null, signalCode: null, kill: () => true });
    return child;
  }) as unknown as typeof spawn;
  const runner = createCopilotSmallModelRunner({ command: "/opt/bin/copilot", excludedTools: COPILOT_NATIVE_AGENT_TOOLS, spawnProcess });
  const result = await runner.complete({ systemPrompt: "Write a commit subject.", prompt: "diff --git a/x b/x", cwd: "/work/project", model: { providerID: "copilot", modelID: "gpt-5-mini" } });
  assert.equal(result.text, "Fix the login redirect");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.command, "/opt/bin/copilot");
  assert.deepEqual(calls[0]!.args, [
    "-s", "--model", "gpt-5-mini", "--no-custom-instructions", "--disable-builtin-mcps", "--no-auto-update", "--no-color",
    "--excluded-tools=task,read_agent,list_agents,write_agent,run_dynamic_workflow,dynamic_workflows_manage",
  ]);
  assert.equal(calls[0]!.cwd, tmpdir());
  // The prompt travels on stdin, never in the argument list.
  assert.equal(calls[0]!.stdin, "Write a commit subject.\n\ndiff --git a/x b/x");
});

test("stdio MCP servers are handed to the launched process in an owner-only file, never on the command line", async () => {
  const { mkdtemp, readFile, rm, stat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { copilotMcpConfig, writeCopilotLaunchMcp } = await import("../src/launchMcp.ts");
  const dir = await mkdtemp(join(tmpdir(), "polyth-copilot-mcp-"));
  try {
    const file = join(dir, "runtime", "abc.mcp.json");
    const servers = [{ name: "polyth-agent-tools", command: "/usr/bin/node", args: ["/srv/tools.mjs"], env: [{ name: "POLYTH_TOKEN", value: "s3cr3t" }] }];
    const args = await writeCopilotLaunchMcp({ servers, file });
    assert.deepEqual(args, [`--additional-mcp-config=@${file}`]);
    assert.equal(args.join(" ").includes("s3cr3t"), false);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      mcpServers: { "polyth-agent-tools": { type: "stdio", command: "/usr/bin/node", args: ["/srv/tools.mjs"], env: { POLYTH_TOKEN: "s3cr3t" }, tools: ["*"] } },
    });
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    // A launch without stdio servers adds nothing and leaves no stale file.
    assert.deepEqual(await writeCopilotLaunchMcp({ servers: [], file }), []);
    await assert.rejects(stat(file), { code: "ENOENT" });
    assert.deepEqual(copilotMcpConfig([]), { mcpServers: {} });
    assert.equal(createCopilotProfile().launchStdioMcp, writeCopilotLaunchMcp);
    assert.equal(createCopilotProfile().toolNameFromTitle, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
