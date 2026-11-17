import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { bool, str, UsageError } from "../args.ts";
import { PolythError } from "../client.ts";
import type { Command, Context } from "../context.ts";
import { style } from "../output.ts";
import { bundleBuild, repoRoot, serverBundleRoot } from "../target.ts";
import {
  acquireUpdateLock,
  type Channel,
  channelOf,
  compareVersions,
  installKind,
  type InstallKind,
  managedElsewhere,
  parseReleases,
  pickRelease,
  readBuild,
  rollbackInstall,
  SERVER_SUMS_NAME,
  serverArchiveName,
  stageArchive,
  swapInstall,
} from "../update.ts";

/** The service names `polyth service install` writes. */
const SYSTEMD_UNIT = "polyth.service";
const LAUNCHD_LABEL = "app.polyth.server";
const HEALTH_TIMEOUT_MS = 10 * 60_000;
const USER_AGENT = "polyth-cli";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npm = (args: string[]) => spawnSync(npmCommand, args, { encoding: "utf8", shell: process.platform === "win32" });

function detectInstall(): InstallKind {
  const bundle = serverBundleRoot();
  const npmRoot = bundle ? npm(["root", "--global"]) : undefined;
  return installKind({
    ...(bundle ? { bundle } : {}),
    ...(repoRoot() ? { checkout: repoRoot()! } : {}),
    docker: existsSync("/.dockerenv"),
    ...(npmRoot?.status === 0 ? { npmGlobalRoot: npmRoot.stdout.trim() } : {}),
  });
}

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/vnd.github+json" }, redirect: "follow" });
  if (!response.ok) throw new Error(`${new URL(url).host}${new URL(url).pathname}: HTTP ${response.status}`);
  return response;
}

/** The release repository, as the server's download section names it. */
const repository = () => process.env.POLYTH_UPDATE_REPOSITORY?.trim() || "Polyth/Polyth";

async function newestVersion(kind: InstallKind, channel: Channel, wanted: string | undefined) {
  if (kind.kind === "npm") {
    const spec = `polyth@${wanted ?? (channel === "stable" ? "latest" : channel)}`;
    const view = npm(["view", spec, "version"]);
    if (view.status !== 0) throw new Error(`npm has no ${spec}: ${view.stderr.trim().split("\n")[0]}`);
    return { version: view.stdout.trim().split("\n").at(-1)!.replace(/^.*'(.+)'$/, "$1") };
  }
  // A mirror answering in GitHub's shape (air-gapped hosts) may stand in for GitHub.
  const url = process.env.POLYTH_UPDATE_RELEASES_URL?.trim() || `https://api.github.com/repos/${repository()}/releases?per_page=50`;
  const releases = parseReleases(await (await fetchOk(url)).json());
  const release = pickRelease(releases, channel, wanted);
  if (!release) throw new Error(wanted ? `release ${wanted} not found in ${repository()}` : `no ${channel} release in ${repository()}`);
  return { version: release.version, release };
}

/** The install itself for an archive; beside the package for npm, which replaces its directory. */
const lockDir = (kind: { kind: "archive" | "npm"; root: string }) => kind.kind === "archive" ? kind.root : dirname(kind.root);

interface Service { describe: string; restart: () => { ok: boolean; detail: string } }

/** The service that runs this install's server: one `polyth service install`
 *  wrote, whose command names this install (a `polyth.service` running another
 *  install, such as a checkout, is never restarted). */
export function serviceRunsInstall(command: string, root: string): boolean {
  return command.includes(`${root}/bin/polyth.mjs`) || command.includes(`${root}\\bin\\polyth.mjs`);
}

function runningService(root: string): Service | null {
  const superuser = process.getuid?.() === 0;
  if (process.platform === "linux") {
    for (const user of [true, false]) {
      const scope = user ? ["--user"] : [];
      const active = spawnSync("systemctl", [...scope, "is-active", SYSTEMD_UNIT], { encoding: "utf8" });
      if (active.status !== 0) continue;
      const command = spawnSync("systemctl", [...scope, "show", "--property=ExecStart", "--value", SYSTEMD_UNIT], { encoding: "utf8" });
      if (!serviceRunsInstall(command.stdout, root)) continue;
      const describe = `systemctl ${[...scope, "restart", SYSTEMD_UNIT].join(" ")}`;
      if (!user && !superuser) return { describe, restart: () => ({ ok: false, detail: `run \`sudo ${describe}\`` }) };
      return { describe, restart: () => {
        const done = spawnSync("systemctl", [...scope, "restart", SYSTEMD_UNIT], { encoding: "utf8" });
        return { ok: done.status === 0, detail: done.stderr.trim() };
      } };
    }
  }
  if (process.platform === "darwin") {
    for (const domain of [`gui/${process.getuid?.() ?? 0}`, "system"]) {
      const service = `${domain}/${LAUNCHD_LABEL}`;
      const printed = spawnSync("launchctl", ["print", service], { encoding: "utf8" });
      if (printed.status !== 0 || !serviceRunsInstall(printed.stdout, root)) continue;
      const describe = `launchctl kickstart -k ${service}`;
      if (domain === "system" && !superuser) return { describe, restart: () => ({ ok: false, detail: `run \`sudo ${describe}\`` }) };
      return { describe, restart: () => {
        const done = spawnSync("launchctl", ["kickstart", "-k", service], { encoding: "utf8" });
        return { ok: done.status === 0, detail: done.stderr.trim() };
      } };
    }
  }
  return null;
}

async function serverVersion(ctx: Context): Promise<string | null> {
  try {
    return (await ctx.client().get<{ version: string }>("/api/health")).version;
  } catch (error) {
    if (error instanceof PolythError && error.code === "unreachable") return null;
    throw error;
  }
}

async function waitForVersion(ctx: Context, version: string, timeoutMs = HEALTH_TIMEOUT_MS): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    // A server migrating a large database copies it first; that start is slow.
    if (await serverVersion(ctx).catch(() => null) === version) return true;
    await new Promise((wait) => setTimeout(wait, 2_000));
  }
  return false;
}

export const update: Command = {
  name: "update",
  summary: "Update this machine's packaged Polyth server (npm package or release archive)",
  usage: [
    "polyth update                      # the newest release of this install's channel",
    "polyth update --check              # show what would change",
    "polyth update --channel nightly    # or stable",
    "polyth update --version 1.2.357",
    "polyth update --no-restart         # install only; restart the server yourself",
    "polyth update --rollback           # back to the release before the last update (archive)",
  ].join("\n       "),
  details: "Restarts the server through the systemd or launchd service `polyth service install` wrote and waits until it answers with the new version; if it does not, the previous release is put back. A server copies each database before migrating it (pre-migration/ in its data directory); a release older than a migrated database needs those copies restored.",
  flags: [
    { name: "check", description: "Print the current and newest version; change nothing" },
    { name: "channel", value: true, description: "stable or nightly (default: this install's)" },
    { name: "version", value: true, description: "Install exactly this release" },
    { name: "restart", description: "Restart the server afterwards (default; --no-restart)" },
    { name: "rollback", description: "Put back the release kept by the last update (archive installs)" },
  ],
  async run(ctx, args) {
    const o = ctx.o;
    const kind = detectInstall();
    const elsewhere = managedElsewhere(kind);
    if (elsewhere) throw new UsageError(elsewhere);
    if (kind.kind !== "archive" && kind.kind !== "npm") return 2;
    const current = bundleBuild()?.version ?? readBuild(kind.root).version;
    const restart = args.flags.restart !== false;
    const target = `${process.platform}-${process.arch}`;
    const dataDir = ctx.target().kind === "socket" ? (ctx.target() as { dataDir: string }).dataDir : undefined;

    if (bool(args, "rollback")) {
      if (kind.kind !== "archive") throw new UsageError("an npm install goes back with `npm install --global polyth@<version>`");
      const release = acquireUpdateLock(lockDir(kind));
      try {
        const restored = rollbackInstall(kind.root);
        o.out(`Polyth ${current} replaced by the kept ${restored}.`);
        return await finish(ctx, kind.root, restored, restart, null);
      } finally {
        release();
      }
    }

    const channelFlag = str(args, "channel");
    if (channelFlag && channelFlag !== "stable" && channelFlag !== "nightly") throw new UsageError("--channel is stable or nightly");
    const channel: Channel = (channelFlag as Channel | undefined) ?? channelOf(current);
    const wanted = str(args, "version");
    const newest = await newestVersion(kind, channel, wanted);
    const newer = compareVersions(newest.version, current) > 0;
    if (o.json && bool(args, "check")) {
      o.data({ install: kind.kind, root: kind.root, current, channel, available: newest.version, update: newer || (!!wanted && newest.version !== current) });
      return 0;
    }
    if (bool(args, "check")) {
      o.out(`${style.bold(o.color, "Installed")}  ${current} (${kind.kind}, ${channel})`);
      o.out(`${style.bold(o.color, "Available")}  ${newest.version}${newer ? "" : " — up to date"}`);
      return 0;
    }
    if (newest.version === current || (!wanted && !newer)) {
      o.out(`Polyth ${current} is up to date (${channel}).`);
      return 0;
    }

    const release = acquireUpdateLock(lockDir(kind));
    try {
      if (kind.kind === "archive") {
        const assets = newest.release!.assets;
        const name = serverArchiveName(newest.version, target);
        const archiveUrl = assets.get(name);
        const sumsUrl = assets.get(SERVER_SUMS_NAME);
        if (!archiveUrl || !sumsUrl) throw new Error(`release ${newest.version} has no server archive for ${target}`);
        o.err(`Downloading ${name}…`);
        const archive = new Uint8Array(await (await fetchOk(archiveUrl)).arrayBuffer());
        const sums = await (await fetchOk(sumsUrl)).text();
        const staged = stageArchive({ root: kind.root, version: newest.version, target, archive, sums });
        swapInstall(kind.root, staged);
      } else {
        const install = npm(["install", ...(kind.global ? ["--global"] : ["--prefix", kind.prefix]), `polyth@${newest.version}`, "--no-audit", "--no-fund"]);
        if (install.status !== 0) throw new Error(`npm install polyth@${newest.version} failed:\n${install.stderr.trim()}`);
      }
      o.out(`Polyth ${newest.version} installed (was ${current}).`);
      const rollback = () => {
        if (kind.kind === "archive") return rollbackInstall(kind.root);
        const back = npm(["install", ...(kind.global ? ["--global"] : ["--prefix", kind.prefix]), `polyth@${current}`, "--no-audit", "--no-fund"]);
        if (back.status !== 0) throw new Error(`npm install polyth@${current} failed: ${back.stderr.trim()}`);
        return current;
      };
      return await finish(ctx, kind.root, newest.version, restart, { previous: current, rollback, dataDir });
    } finally {
      release();
    }
  },
};

/** Restarts the server into `version` and confirms it answers; on failure puts the previous release back. */
async function finish(
  ctx: Context,
  root: string,
  version: string,
  restart: boolean,
  undo: { previous: string; rollback: () => string; dataDir: string | undefined } | null,
): Promise<number> {
  const o = ctx.o;
  const running = await serverVersion(ctx);
  const service = runningService(root);
  if (!restart || !service) {
    if (running === null) o.out("The server is not running; start it to use the new release.");
    else if (!restart) o.out(`The server still runs ${running}: restart it to switch to ${version}.`);
    else o.out(`The server still runs ${running}: restart it to switch to ${version} (no service from \`polyth service install\` runs this install).`);
    return 0;
  }
  o.err(`Restarting: ${service.describe}`);
  const restarted = service.restart();
  if (!restarted.ok) {
    o.out(`Could not restart the server (${restarted.detail}); restart it to switch to ${version}.`);
    return 1;
  }
  if (await waitForVersion(ctx, version)) {
    o.out(`The server runs ${version}.`);
    return 0;
  }
  if (!undo) {
    o.out(`The server did not come back with ${version}; check its log.`);
    return 1;
  }
  o.out(`The server did not come back with ${version}; putting ${undo.previous} back.`);
  undo.rollback();
  service.restart();
  if (await waitForVersion(ctx, undo.previous)) {
    o.out(`The server runs ${undo.previous} again.`);
    return 1;
  }
  const snapshots = undo.dataDir ? `${undo.dataDir}/pre-migration/*-before-${version}-*.sqlite` : "pre-migration/ in the data directory";
  o.out([
    `The server does not start with ${undo.previous} either. If ${version} migrated a database, ${undo.previous} cannot open it:`,
    `stop the server, copy each ${snapshots} over its database (control-plane/control.sqlite, sessions.db),`,
    "delete that database's -wal and -shm files, and start it again.",
  ].join("\n"));
  return 1;
}
