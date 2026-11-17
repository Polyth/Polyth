import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError } from "../src/args.ts";
import { main } from "../src/main.ts";
import {
  assertSystemScope, installCommands, launchdPlist, serviceDataDir, servicePaths, systemdQuote, systemdUnit, uninstallCommands,
} from "../src/commands/service.ts";
import { serverDataDir } from "../src/target.ts";

const base = { node: "/usr/bin/node", bundle: "/opt/my polyth%1", dataDir: "/var/lib/polyth", scope: "user" as const };

test("systemdQuote escapes backslash, quote and %, quotes only when needed", () => {
  assert.equal(systemdQuote("/usr/bin/node"), "/usr/bin/node");
  assert.equal(systemdQuote("a b"), "\"a b\"");
  assert.equal(systemdQuote("say \"hi\"\\"), "\"say \\\"hi\\\"\\\\\"");
  assert.equal(systemdQuote("100%"), "100%%");
  assert.equal(systemdQuote("$HOME", true), "$$HOME");
});

test("systemd unit: ExecStart quoting, environment, scope-specific keys", () => {
  const user = systemdUnit(base);
  assert.match(user, /^ExecStart=\/usr\/bin\/node "\/opt\/my polyth%%1\/bin\/polyth\.mjs" server start$/m);
  assert.match(user, /^Environment=POLYTH_DATA_DIR=\/var\/lib\/polyth$/m);
  assert.doesNotMatch(user, /^User=/m);
  assert.doesNotMatch(user, /HOST=|PORT=|EnvironmentFile/);
  assert.match(user, /^WantedBy=default\.target$/m);
  assert.match(user, /^KillMode=mixed$/m);
  assert.doesNotMatch(user, /POLYTH_SERVER_BUNDLE/);

  const system = systemdUnit({ ...base, scope: "system", runAs: "polyth", host: "0.0.0.0", port: 4401, envFile: "/etc/polyth env" , dataDir: "/data/my dir" });
  assert.match(system, /^User=polyth$/m);
  assert.match(system, /^WantedBy=multi-user\.target$/m);
  assert.match(system, /^Environment="POLYTH_DATA_DIR=\/data\/my dir"$/m);
  assert.match(system, /^Environment=HOST=0\.0\.0\.0$/m);
  assert.match(system, /^Environment=PORT=4401$/m);
  // EnvironmentFile= takes the rest of the line as the path; quotes would stay in it.
  assert.match(system, /^EnvironmentFile=-\/etc\/polyth env$/m);
  assert.match(systemdUnit({ ...base, envFile: "/etc/100%.env" }), /^EnvironmentFile=-\/etc\/100%%\.env$/m);
  assert.throws(() => systemdUnit({ ...base, dataDir: "/data\nExecStartPre=/bin/evil" }), /control character/);
});

test("launchd plist escapes XML in every value", () => {
  const plist = launchdPlist({ ...base, bundle: "/opt/a&b<c>\"d", scope: "system", runAs: "polyth", port: 80, logDir: "/Library/Logs/Polyth Server" });
  assert.match(plist, /<string>\/opt\/a&amp;b&lt;c&gt;&quot;d\/bin\/polyth\.mjs<\/string>/);
  assert.match(plist, /<key>UserName<\/key>\s*<string>polyth<\/string>/);
  assert.match(plist, /<key>PORT<\/key>\s*<string>80<\/string>/);
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(plist, /<string>\/Library\/Logs\/Polyth Server\/server\.log<\/string>/);
  assert.doesNotMatch(launchdPlist(base), /UserName/);
});

test("servicePaths per os and scope", () => {
  assert.equal(servicePaths("linux", "user", { XDG_CONFIG_HOME: "/x/cfg" }, "/home/u").file, "/x/cfg/systemd/user/polyth.service");
  assert.equal(servicePaths("linux", "user", {}, "/home/u").file, "/home/u/.config/systemd/user/polyth.service");
  assert.equal(servicePaths("linux", "system", {}, "/home/u").file, "/etc/systemd/system/polyth.service");
  assert.deepEqual(servicePaths("darwin", "user", {}, "/Users/u"), {
    file: "/Users/u/Library/LaunchAgents/app.polyth.server.plist", logDir: "/Users/u/Library/Logs/Polyth Server",
  });
  assert.deepEqual(servicePaths("darwin", "system", {}, "/Users/u"), {
    file: "/Library/LaunchDaemons/app.polyth.server.plist", logDir: "/Library/Logs/Polyth Server",
  });
  assert.throws(() => servicePaths("win32", "user", {}, "C:\\u"), UsageError);
});

test("command lists", () => {
  assert.deepEqual(installCommands("linux", "user", "f", 1000, true), [
    ["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "polyth.service"], ["systemctl", "--user", "restart", "polyth.service"],
  ]);
  assert.deepEqual(installCommands("linux", "system", "f", 0, false), [["systemctl", "daemon-reload"]]);
  assert.deepEqual(installCommands("darwin", "user", "/p", 501, true), [["launchctl", "bootstrap", "gui/501", "/p"]]);
  assert.deepEqual(installCommands("darwin", "system", "/p", 0, true), [["launchctl", "bootstrap", "system", "/p"]]);
  assert.deepEqual(uninstallCommands("darwin", "user", 501), [["launchctl", "bootout", "gui/501/app.polyth.server"]]);
});

test("service data directory: explicit, else the packaged default of the account it runs as", () => {
  assert.equal(serviceDataDir("linux", "system", "/srv/polyth"), "/srv/polyth");
  assert.equal(serviceDataDir("linux", "system", undefined, "/home/polyth"), "/home/polyth/.local/share/polyth-server/data");
  assert.equal(serviceDataDir("darwin", "system", undefined, "/Users/polyth"), "/Users/polyth/Library/Application Support/Polyth Server/data");
  // A user service keeps the directory discovery picks for this install, so `polyth update` reaches it.
  assert.equal(serviceDataDir("linux", "user", undefined), serverDataDir(process.env, "linux"));
});

test("--system needs --run-as and root", () => {
  assert.throws(() => assertSystemScope("system", undefined, 0), /--run-as/);
  assert.throws(() => assertSystemScope("system", "polyth", 1000), /root/);
  assert.throws(() => assertSystemScope("system", "bad name", 0), /account name/);
  assert.doesNotThrow(() => assertSystemScope("system", "polyth", 0));
  assert.doesNotThrow(() => assertSystemScope("user", undefined, 1000));
});

async function capture(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "", err = "";
  const o = process.stdout.write, e = process.stderr.write;
  process.stdout.write = ((c: string | Uint8Array) => { out += String(c); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err += String(c); return true; }) as typeof process.stderr.write;
  try { return { code: await main(argv), out, err }; } finally { process.stdout.write = o; process.stderr.write = e; }
}

test("service refuses outside a packaged install", { skip: process.platform === "win32" }, async () => {
  const saved = process.env.POLYTH_SERVER_BUNDLE;
  delete process.env.POLYTH_SERVER_BUNDLE;
  try {
    const result = await capture(["service", "install", "--dry-run"]);
    assert.equal(result.code, 2);
    assert.match(result.err, /packaged server install/);
  } finally { if (saved !== undefined) process.env.POLYTH_SERVER_BUNDLE = saved; }
});

test("service install --dry-run prints the unit and changes nothing", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-service-"));
  const data = join(dir, "data");
  writeFileSync(join(dir, "BUILD.json"), JSON.stringify({ version: "1.2.3", commit: "x", target: "linux-x64" }));
  const saved = { bundle: process.env.POLYTH_SERVER_BUNDLE, data: process.env.POLYTH_DATA_DIR, xdg: process.env.XDG_CONFIG_HOME };
  process.env.POLYTH_SERVER_BUNDLE = dir;
  process.env.POLYTH_DATA_DIR = data;
  process.env.XDG_CONFIG_HOME = join(dir, "cfg");
  try {
    const result = await capture(["service", "install", "--dry-run", "--port", "4500"]);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /\[Service\]/);
    assert.ok(result.out.includes(`POLYTH_DATA_DIR=${data}`));
    assert.match(result.out, /PORT=4500/);
    assert.ok(result.out.includes(join(dir, "bin", "polyth.mjs")));
    assert.doesNotMatch(result.out, /POLYTH_SERVER_BUNDLE/);
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(join(dir, "cfg")), false);
    const system = await capture(["service", "install", "--dry-run", "--system"]);
    assert.equal(system.code, 2);
    assert.match(system.err, /--run-as/);
    const explicit = await capture(["--data-dir", join(dir, "other"), "service", "install", "--dry-run"]);
    assert.equal(explicit.code, 0, explicit.err);
    assert.ok(explicit.out.includes(`POLYTH_DATA_DIR=${join(dir, "other")}`));
    delete process.env.POLYTH_DATA_DIR;
    const missing = await capture(["service", "install", "--dry-run", "--system", "--run-as", "polyth-no-such-account"]);
    assert.equal(missing.code, 2);
    assert.match(missing.err, /no account named/);
  } finally {
    for (const [key, value] of [["POLYTH_SERVER_BUNDLE", saved.bundle], ["POLYTH_DATA_DIR", saved.data], ["XDG_CONFIG_HOME", saved.xdg]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
