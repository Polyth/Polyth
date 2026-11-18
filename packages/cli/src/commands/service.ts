import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { bool, str, UsageError } from "../args.ts";
import type { Command } from "../context.ts";
import { style } from "../output.ts";
import { bundleBuild, serverBundleRoot, serverDataDir } from "../target.ts";

// `polyth service`: run a packaged server (npm package or release archive)
// under systemd or launchd. The unit starts `<node> <bundle>/bin/polyth.mjs
// server start`, which becomes the server and handles the stop signal itself.

export type ServiceScope = "user" | "system";

export const LAUNCHD_LABEL = "app.polyth.server";
export const SYSTEMD_UNIT = "polyth.service";

export interface ServiceOptions {
  node: string;
  bundle: string;
  dataDir: string;
  scope: ServiceScope;
  runAs?: string | undefined;
  host?: string | undefined;
  port?: number | undefined;
  envFile?: string | undefined;
  /** launchd only: where stdout/stderr go. */
  logDir?: string | undefined;
}

export interface ServicePaths {
  file: string;
  logDir?: string;
}

export function servicePaths(os: NodeJS.Platform, scope: ServiceScope, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): ServicePaths {
  if (os === "darwin") {
    return scope === "system"
      ? { file: `/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`, logDir: "/Library/Logs/Polyth Server" }
      : { file: join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`), logDir: join(home, "Library", "Logs", "Polyth Server") };
  }
  if (os === "linux") {
    return scope === "system"
      ? { file: `/etc/systemd/system/${SYSTEMD_UNIT}` }
      : { file: join(env.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user", SYSTEMD_UNIT) };
  }
  throw new UsageError(os === "win32" ? "polyth service is not supported on Windows yet" : `polyth service does not support ${os}`);
}

/** One systemd word: backslash and double quote escaped, % doubled (specifiers),
 *  and, for ExecStart, $ doubled (variable expansion). Quoted only when needed. */
export function systemdQuote(value: string, exec = false): string {
  let text = value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/%/g, "%%");
  if (exec) text = text.replace(/\$/g, "$$$$");
  return /[\s"\\';]/.test(value) || value === "" ? `"${text}"` : text;
}

/** A value that cannot be written into a unit or plist line as is. */
function assertPrintable(name: string, value: string | undefined): void {
  if (value !== undefined && /[\x00-\x1f\x7f]/.test(value)) throw new UsageError(`${name} contains a control character`);
}

export function systemdUnit(o: ServiceOptions): string {
  for (const [name, value] of [["node path", o.node], ["bundle path", o.bundle], ["data directory", o.dataDir], ["--env-file", o.envFile]] as const) assertPrintable(name, value);
  const env = [`POLYTH_DATA_DIR=${o.dataDir}`];
  if (o.host) env.push(`HOST=${o.host}`);
  if (o.port !== undefined) env.push(`PORT=${o.port}`);
  const lines = [
    "[Unit]",
    "Description=Polyth server",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    ...(o.scope === "system" && o.runAs ? [`User=${o.runAs}`] : []),
    `ExecStart=${[o.node, join(o.bundle, "bin", "polyth.mjs"), "server", "start"].map((part) => systemdQuote(part, true)).join(" ")}`,
    ...env.map((assignment) => `Environment=${systemdQuote(assignment)}`),
    // EnvironmentFile= takes the rest of the line as one path: specifiers are
    // expanded, quotes are not removed.
    ...(o.envFile ? [`EnvironmentFile=-${o.envFile.replace(/%/g, "%%")}`] : []),
    "Restart=on-failure",
    "RestartSec=3",
    "KillMode=mixed",
    "TimeoutStopSec=60",
    "LimitNOFILE=65536",
    "",
    "[Install]",
    `WantedBy=${o.scope === "system" ? "multi-user.target" : "default.target"}`,
    "",
  ];
  return lines.join("\n");
}

export function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function launchdPlist(o: ServiceOptions): string {
  const s = (value: string) => `<string>${xmlEscape(value)}</string>`;
  const logDir = o.logDir ?? servicePaths("darwin", o.scope).logDir!;
  const env: Array<[string, string]> = [["POLYTH_DATA_DIR", o.dataDir]];
  if (o.host) env.push(["HOST", o.host]);
  if (o.port !== undefined) env.push(["PORT", String(o.port)]);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  ${s(LAUNCHD_LABEL)}`,
    ...(o.scope === "system" && o.runAs ? [`  <key>UserName</key>`, `  ${s(o.runAs)}`] : []),
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...[o.node, join(o.bundle, "bin", "polyth.mjs"), "server", "start"].map((part) => `    ${s(part)}`),
    `  </array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    ...env.flatMap(([key, value]) => [`    <key>${xmlEscape(key)}</key>`, `    ${s(value)}`]),
    `  </dict>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <dict>`,
    `    <key>SuccessfulExit</key>`,
    `    <false/>`,
    `  </dict>`,
    `  <key>StandardOutPath</key>`,
    `  ${s(join(logDir, "server.log"))}`,
    `  <key>StandardErrorPath</key>`,
    `  ${s(join(logDir, "server.err.log"))}`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

/** A system service needs root to write and an account to run as; the server
 *  never runs as root by default. */
export function assertSystemScope(scope: ServiceScope, runAs: string | undefined, uid: number | undefined, needRoot = true): void {
  if (scope !== "system") return;
  if (!runAs) throw new UsageError("--system needs --run-as <user>, the account the server runs as (never root by default)");
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*\$?$/.test(runAs)) throw new UsageError("--run-as is not a valid account name");
  if (needRoot && uid !== 0) throw new UsageError("--system writes a system service and needs root (run with sudo)");
}

export type CommandLine = string[];

const ctl = (os: NodeJS.Platform, scope: ServiceScope, ...args: string[]): CommandLine =>
  os === "darwin" ? ["launchctl", ...args] : ["systemctl", ...(scope === "user" ? ["--user"] : []), ...args];

const launchdDomain = (scope: ServiceScope, uid: number): string => (scope === "system" ? "system" : `gui/${uid}`);

export function installCommands(os: NodeJS.Platform, scope: ServiceScope, file: string, uid: number, start: boolean): CommandLine[] {
  if (os === "darwin") return start ? [["launchctl", "bootstrap", launchdDomain(scope, uid), file]] : [];
  // `restart` starts a stopped unit and makes a replaced one (--force) take effect.
  return [ctl(os, scope, "daemon-reload"), ...(start ? [ctl(os, scope, "enable", SYSTEMD_UNIT), ctl(os, scope, "restart", SYSTEMD_UNIT)] : [])];
}

export function uninstallCommands(os: NodeJS.Platform, scope: ServiceScope, uid: number): CommandLine[] {
  if (os === "darwin") return [["launchctl", "bootout", `${launchdDomain(scope, uid)}/${LAUNCHD_LABEL}`]];
  return [ctl(os, scope, "disable", "--now", SYSTEMD_UNIT)];
}

export function statusCommand(os: NodeJS.Platform, scope: ServiceScope, uid: number): CommandLine {
  return os === "darwin" ? ["launchctl", "print", `${launchdDomain(scope, uid)}/${LAUNCHD_LABEL}`] : ctl(os, scope, "is-active", SYSTEMD_UNIT);
}

interface Ran { code: number; stdout: string; stderr: string }
function run(line: CommandLine): Ran {
  const result = spawnSync(line[0]!, line.slice(1), { encoding: "utf8" });
  if (result.error) return { code: 127, stdout: "", stderr: result.error.message };
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const show = (line: CommandLine): string => line.map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part))).join(" ");

/** Home directory of another account (a system service's --run-as). */
export function accountHome(os: NodeJS.Platform, user: string): string | undefined {
  const ran = os === "darwin"
    ? spawnSync("dscl", [".", "-read", `/Users/${user}`, "NFSHomeDirectory"], { encoding: "utf8" })
    : spawnSync("getent", ["passwd", user], { encoding: "utf8" });
  if (ran.error || ran.status !== 0) return undefined;
  const home = os === "darwin" ? /NFSHomeDirectory:\s*(\S.*)$/m.exec(ran.stdout)?.[1] : ran.stdout.trim().split(":")[5];
  return home?.trim() || undefined;
}

/** The data directory the service runs with: --data-dir, POLYTH_DATA_DIR, else
 *  the packaged default of the account it runs as. Never target discovery,
 *  which may land on a ./data socket or a saved Desktop target; the default is
 *  the one discovery uses for this install, so `polyth update` run by that
 *  account reaches the server it restarts. */
export function serviceDataDir(os: NodeJS.Platform, scope: ServiceScope, explicit: string | undefined, runAsHome?: string): string {
  if (explicit) return resolve(explicit);
  if (scope === "system") return serverDataDir({}, os, runAsHome!);
  return serverDataDir(process.env, os);
}

export const service: Command = {
  name: "service",
  summary: "Run this packaged server under systemd or launchd",
  usage: [
    "polyth service install [--system --run-as USER] [--host HOST] [--port PORT] [--env-file FILE] [--no-start] [--force] [--dry-run]",
    "polyth service uninstall [--system] [--dry-run]",
    "polyth service status [--system]",
  ].join("\n       "),
  details: "For a packaged install (npm package or release archive). User scope by default: a systemd --user unit or a LaunchAgent.\n--system writes a system service and needs root and --run-as USER. --env-file (systemd only) names a file of KEY=value lines such as POLYTH_PUBLIC_ORIGIN.\nThe service keeps the data directory of --data-dir or POLYTH_DATA_DIR, else the packaged default of the account it runs as.",
  flags: [
    { name: "system", description: "System service instead of a user service (needs root and --run-as)" },
    { name: "run-as", value: true, description: "Account the system service runs as" },
    { name: "host", value: true, description: "Listen address (HOST)" },
    { name: "port", value: true, description: "HTTP port (PORT)" },
    { name: "env-file", value: true, description: "systemd EnvironmentFile (optional file)" },
    { name: "force", description: "Overwrite an existing unit or plist" },
    { name: "no-start", description: "Write the file but do not enable or start it" },
    { name: "dry-run", description: "Print what would be written and run, change nothing" },
  ],
  async run(ctx, args) {
    const os = platform();
    if (os === "win32") throw new UsageError("polyth service is not supported on Windows yet");
    const bundle = serverBundleRoot();
    if (!bundle) throw new UsageError("polyth service manages a packaged server install (npm package or release archive); a checkout uses `npm run polyth:restart` or its own unit");
    const [action = "status", extra] = args.positionals;
    if (extra !== undefined || !["install", "uninstall", "status"].includes(action)) throw new UsageError(`unknown action "${action}"`);
    const o = ctx.o;
    const scope: ServiceScope = bool(args, "system") ? "system" : "user";
    const dryRun = bool(args, "dry-run");
    const uid = process.getuid?.() ?? -1;
    const runAs = str(args, "run-as");
    if (scope === "user" && runAs) throw new UsageError("--run-as applies to --system only");
    assertSystemScope(scope, runAs, uid, action !== "status" && !dryRun);
    const paths = servicePaths(os, scope);
    const label = os === "darwin" ? "launchd" : "systemd";

    if (action === "status") {
      const ran = run(statusCommand(os, scope, uid));
      const exists = existsSync(paths.file);
      const summary = os === "darwin" ? (ran.code === 0 ? "loaded" : "not loaded") : ran.stdout.trim() || (ran.stderr.trim() || "unknown");
      if (o.json) { o.data({ manager: label, scope, file: paths.file, exists, state: summary, loaded: ran.code === 0 }); return 0; }
      o.out(`${style.bold(o.color, "Service")}  ${label} (${scope})`);
      o.out(`${style.bold(o.color, "File")}     ${paths.file} ${exists ? "" : style.dim(o.color, "(not installed)")}`.trimEnd());
      o.out(`${style.bold(o.color, "State")}    ${summary}`);
      return ran.code === 0 ? 0 : 3;
    }

    if (action === "uninstall") {
      const commands = uninstallCommands(os, scope, uid);
      const exists = existsSync(paths.file);
      if (dryRun) {
        for (const line of commands) o.out(show(line));
        o.out(`rm ${show([paths.file])}`);
        if (os === "linux") o.out(show(ctl(os, scope, "daemon-reload")));
        return 0;
      }
      if (!exists) o.err(`No service file at ${paths.file}; nothing to remove.`);
      let failed: { line: CommandLine; ran: Ran } | undefined;
      if (exists) {
        for (const line of commands) {
          const ran = run(line);
          if (ran.code !== 0) { failed = { line, ran }; o.err(ran.stderr.trim() || `${show(line)} failed`); }
        }
        rmSync(paths.file, { force: true });
        if (os === "linux") run(ctl(os, scope, "daemon-reload"));
        o.err(`${style.green(o.color, "✓")} removed ${paths.file}`);
      }
      if (failed) { o.err(`The file is gone but \`${show(failed.line)}\` failed; the service may still be loaded until reboot or a manual stop.`); return failed.ran.code || 1; }
      return 0;
    }

    // install
    const portText = str(args, "port");
    const port = portText === undefined ? undefined : Number(portText);
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new UsageError("--port must be an integer from 1 to 65535");
    const host = str(args, "host");
    if (host !== undefined && !/^[^\s\x00-\x1f"'\\%$]+$/.test(host)) throw new UsageError("--host is not a valid address");
    const envFileRaw = str(args, "env-file");
    if (envFileRaw && os !== "linux") throw new UsageError("--env-file is supported with systemd only; launchd takes EnvironmentVariables");
    const explicitDir = typeof ctx.globals["data-dir"] === "string" ? ctx.globals["data-dir"] : process.env.POLYTH_DATA_DIR?.trim() || undefined;
    const runAsHome = scope === "system" && !explicitDir ? accountHome(os, runAs!) : undefined;
    if (scope === "system" && !explicitDir && !runAsHome) throw new UsageError(`no account named "${runAs}" (or it has no home directory); create it or pass --data-dir`);
    const opts: ServiceOptions = {
      node: process.execPath,
      bundle,
      dataDir: serviceDataDir(os, scope, explicitDir, runAsHome),
      scope,
      runAs,
      host,
      port,
      envFile: envFileRaw ? resolve(envFileRaw) : undefined,
      logDir: paths.logDir,
    };
    const content = os === "darwin" ? launchdPlist(opts) : systemdUnit(opts);
    const start = !bool(args, "no-start");
    const replacing = existsSync(paths.file);
    if (replacing && !bool(args, "force")) throw new UsageError(`${paths.file} already exists; use --force to replace it`);
    // launchd refuses to bootstrap a label that is still loaded.
    const unload = os === "darwin" && replacing && start ? uninstallCommands(os, scope, uid)[0] : undefined;
    const commands = installCommands(os, scope, paths.file, uid, start);
    if (dryRun) {
      o.out(`# ${paths.file}`);
      o.out(content.trimEnd());
      o.out("");
      if (unload) o.out(show(unload));
      for (const line of commands) o.out(show(line));
      return 0;
    }
    const build = bundleBuild();
    mkdirSync(dirname(paths.file), { recursive: true });
    if (paths.logDir && !existsSync(paths.logDir)) {
      mkdirSync(paths.logDir, { recursive: true });
      // The daemon writes its logs as the account it runs as.
      if (scope === "system" && runAs) run(["chown", runAs, paths.logDir]);
    }
    writeFileSync(paths.file, content, { mode: 0o644 });
    chmodSync(paths.file, 0o644);
    o.err(`${style.green(o.color, "✓")} wrote ${paths.file}${build ? ` (Polyth ${build.version})` : ""}`);
    o.err(`  data directory ${opts.dataDir}`);
    if (unload) run(unload);
    for (const line of commands) {
      const ran = run(line);
      if (ran.code !== 0) {
        o.err(ran.stderr.trim() || `${show(line)} failed`);
        o.err(`The file is written but \`${show(line)}\` failed; fix the cause and run it yourself${os === "linux" ? ", or `polyth service install --force` again" : ""}.`);
        return ran.code || 1;
      }
    }
    if (start) o.err(`${style.green(o.color, "✓")} started; \`polyth service status\` shows the state`);
    else o.err(`Not started. ${os === "linux" ? `Run: ${show(ctl(os, scope, "enable", "--now", SYSTEMD_UNIT))}` : `Run: ${show(["launchctl", "bootstrap", launchdDomain(scope, uid), paths.file])}`}`);
    if (os === "linux" && scope === "user") o.err(`To keep it running without a login session: loginctl enable-linger $USER`);
    return 0;
  },
};
