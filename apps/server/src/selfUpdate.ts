// How a packaged server installs its own new releases for automatic updates
// (packages/server/src/serverAutoUpdate.ts decides when). npm installs replace
// the `polyth` package in the same node_modules; Homebrew installs run
// `brew upgrade polyth` with the Homebrew the formula lives in. Neither
// restarts anything: the server exits afterwards and its service starts the
// new release, so a driver exists only when such a service runs this process.
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { SelfUpdateResult, ServerSelfUpdater } from "@polyth/server";
import { channelOf, type InstallKind } from "@polyth/cli/update";
import { PACKAGE_NAME } from "./layout.ts";

const INSTALL_TIMEOUT_MS = 20 * 60_000;
const QUERY_TIMEOUT_MS = 2 * 60_000;
const OUTPUT_LIMIT = 4 * 1024 * 1024;

/** The service names `polyth service install` and `brew services` give it. */
const SYSTEMD_UNITS = new Set(["polyth.service", "homebrew.polyth.service"]);
const LAUNCHD_LABELS = new Set(["app.polyth.server", "homebrew.mxcl.polyth"]);

/**
 * The service that restarts this process when it exits unsuccessfully, or
 * null. `INVOCATION_ID` alone is not enough: a shell in a terminal that
 * systemd runs as a user service inherits it, so the process's own cgroup
 * must be one of Polyth's units. `POLYTH_SUPERVISED=1` vouches for any other
 * supervisor that restarts on a non-zero exit.
 */
export function restartingService(input: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** /proc/self/cgroup, on Linux. */
  cgroup?: string;
}): string | null {
  if (input.env.POLYTH_SUPERVISED?.trim() === "1") return "POLYTH_SUPERVISED";
  if (input.platform === "linux" && input.env.INVOCATION_ID && input.cgroup) {
    for (const line of input.cgroup.split("\n")) {
      const unit = line.trim().split("/").at(-1);
      if (unit && SYSTEMD_UNITS.has(unit)) return unit;
    }
  }
  if (input.platform === "darwin") {
    const label = input.env.XPC_SERVICE_NAME?.trim();
    if (label && LAUNCHD_LABELS.has(label)) return label;
  }
  return null;
}

/** `<prefix>/Cellar/polyth/<version>/libexec` → `<prefix>`. */
export function homebrewPrefix(root: string): string | null {
  const marker = `${sep}Cellar${sep}${PACKAGE_NAME}${sep}`;
  const at = root.indexOf(marker);
  return at > 0 ? root.slice(0, at) : null;
}

/** `npm install` arguments that replace this install with `version`. */
export function npmInstallArgs(kind: { global: boolean; prefix: string }, version: string): string[] {
  return ["install", ...(kind.global ? ["--global"] : ["--prefix", kind.prefix]), `${PACKAGE_NAME}@${version}`, "--no-audit", "--no-fund"];
}

/** `npm view` spec of the newest release in a version's channel. */
export const npmChannelSpec = (current: string): string =>
  `${PACKAGE_NAME}@${channelOf(current) === "nightly" ? "nightly" : "latest"}`;

interface Ran { ok: boolean; stdout: string; stderr: string }

function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeoutMs: number }): Promise<Ran> {
  return new Promise((resolveRun) => {
    execFile(command, args, { env: options.env ?? process.env, timeout: options.timeoutMs, maxBuffer: OUTPUT_LIMIT, encoding: "utf8" },
      (error, stdout, stderr) => resolveRun({ ok: !error, stdout: String(stdout), stderr: String(stderr || (error && !stderr ? error.message : "")) }));
  });
}

const lastLines = (text: string, count = 8): string => text.trim().split("\n").slice(-count).join("\n");

function buildVersion(root: string): string | null {
  try {
    const version = (JSON.parse(readFileSync(join(root, "BUILD.json"), "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

const writable = (path: string): boolean => {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/** The new tree starts: its own `polyth --version` answers with `version`. */
async function startsAs(command: string, args: string[], version: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const ran = await run(command, [...args, "--version"], { env, timeoutMs: QUERY_TIMEOUT_MS });
  if (!ran.ok) return `the new release does not start: ${lastLines(ran.stderr)}`;
  const answered = ran.stdout.trim().split("\n").at(-1)?.trim();
  return answered === version ? null : `the new release reports ${answered || "nothing"}, not ${version}`;
}

/** npm and node from the Node that runs this server: a service's PATH may
 *  hold neither, and npm's own shebang needs `node` on it. */
function npmEnvironment(): { npm: string; env: NodeJS.ProcessEnv } {
  const bin = dirname(process.execPath);
  const local = join(bin, process.platform === "win32" ? "npm.cmd" : "npm");
  const path = [bin, process.env.PATH].filter(Boolean).join(process.platform === "win32" ? ";" : ":");
  return { npm: existsSync(local) ? local : "npm", env: { ...process.env, PATH: path } };
}

function npmUpdater(root: string, service: string | null): ServerSelfUpdater {
  const { npm, env } = npmEnvironment();
  const nodeModules = dirname(root);
  let kind: Promise<{ global: boolean; prefix: string }> | undefined;
  const install = () => kind ??= run(npm, ["root", "--global"], { env, timeoutMs: QUERY_TIMEOUT_MS })
    .then((answer) => ({ global: answer.ok && answer.stdout.trim() === nodeModules, prefix: dirname(nodeModules) }));
  const unavailable = !service
    ? "No service restarts this server: install one with `polyth service install`."
    : !writable(nodeModules)
      ? `This server's account cannot write ${nodeModules}; update it with \`polyth update\` as an account that can.`
      : null;
  const reinstall = async (version: string): Promise<Ran> =>
    run(npm, npmInstallArgs(await install(), version), { env, timeoutMs: INSTALL_TIMEOUT_MS });
  return {
    kind: "npm",
    unavailable,
    async newest(current) {
      const spec = npmChannelSpec(current);
      const view = await run(npm, ["view", spec, "version"], { env, timeoutMs: QUERY_TIMEOUT_MS });
      if (!view.ok) throw new Error(`npm view ${spec}: ${lastLines(view.stderr, 2)}`);
      return view.stdout.trim().split("\n").at(-1)?.replace(/^.*'(.+)'$/, "$1").trim() || null;
    },
    async apply(version, current): Promise<SelfUpdateResult> {
      const installed = await reinstall(version);
      if (!installed.ok) return { ok: false, installed: buildVersion(root), message: `npm install ${PACKAGE_NAME}@${version} failed: ${lastLines(installed.stderr)}` };
      const now = buildVersion(root);
      const broken = now === version ? await startsAs(process.execPath, [join(root, "bin", "polyth.mjs")], version, env) : `npm installed ${now ?? "nothing readable"}, not ${version}`;
      if (!broken) return { ok: true, installed: now, message: `Installed ${version}.` };
      // The running server keeps its loaded code; the files go back so the
      // next restart starts what runs now.
      const back = await reinstall(current);
      return {
        ok: false,
        installed: buildVersion(root),
        message: back.ok ? `${broken}; ${current} was put back.` : `${broken}; putting ${current} back failed too: ${lastLines(back.stderr, 3)}`,
      };
    },
  };
}

/** The newest stable release on GitHub: the tap publishes stable releases only. */
async function newestStable(): Promise<string | null> {
  const repository = process.env.POLYTH_UPDATE_REPOSITORY?.trim() || "Polyth/Polyth";
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "polyth-server" },
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub releases/latest: HTTP ${response.status}`);
  const tag = (await response.json() as { tag_name?: unknown }).tag_name;
  return typeof tag === "string" ? tag.replace(/^v/, "") : null;
}

function homebrewUpdater(root: string, service: string | null): ServerSelfUpdater {
  const prefix = homebrewPrefix(root);
  const brew = prefix ? join(prefix, "bin", "brew") : "brew";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [prefix && join(prefix, "bin"), process.env.PATH].filter(Boolean).join(":"),
    // The running server's keg stays until it has restarted into the new one.
    HOMEBREW_NO_INSTALL_CLEANUP: "1",
    HOMEBREW_NO_ENV_HINTS: "1",
  };
  const unavailable = !service
    ? "No service restarts this server: start it with `brew services start polyth`."
    : !prefix || !existsSync(brew)
      ? "The Homebrew this formula belongs to was not found."
      : process.getuid?.() === 0
        ? "Homebrew does not run as root; run the service as the account that owns Homebrew."
        : null;
  const opt = prefix ? join(prefix, "opt", PACKAGE_NAME) : "";
  return {
    kind: "homebrew",
    unavailable,
    newest: () => newestStable(),
    async apply(version): Promise<SelfUpdateResult> {
      // Reads the tap's newest formula; a failure here still leaves the
      // upgrade the formula Homebrew already knows.
      await run(brew, ["update", "--quiet"], { env, timeoutMs: INSTALL_TIMEOUT_MS });
      const upgraded = await run(brew, ["upgrade", PACKAGE_NAME], { env, timeoutMs: INSTALL_TIMEOUT_MS });
      const now = buildVersion(join(opt, "libexec"));
      if (!upgraded.ok) return { ok: false, installed: now, message: `brew upgrade ${PACKAGE_NAME} failed: ${lastLines(upgraded.stderr)}` };
      if (now !== version) {
        return { ok: false, installed: now, notYet: true, message: `Homebrew does not offer ${version} yet (it has ${now ?? "nothing readable"}).` };
      }
      const broken = await startsAs(join(opt, "bin", PACKAGE_NAME), [], version, env);
      return broken
        ? { ok: false, installed: now, message: `${broken}; the service will start it at its next restart, so put the previous release back first.` }
        : { ok: true, installed: now, message: `Installed ${version}.` };
    },
  };
}

/** This install's driver, or why it has none. */
export function selfUpdater(kind: InstallKind): { updater?: ServerSelfUpdater; unavailable?: string } {
  const service = restartingService({
    env: process.env,
    platform: process.platform,
    ...(process.platform === "linux" ? { cgroup: readCgroup() } : {}),
  });
  switch (kind.kind) {
    case "npm": return { updater: npmUpdater(kind.root, service) };
    case "homebrew": return { updater: homebrewUpdater(kind.root, service) };
    case "archive": return { unavailable: "A release-archive install updates with `polyth update`." };
    case "docker": return { unavailable: "A container updates by pulling a newer image." };
    default: return { unavailable: "Automatic updates are for npm and Homebrew installs." };
  }
}

function readCgroup(): string {
  try {
    return readFileSync("/proc/self/cgroup", "utf8");
  } catch {
    return "";
  }
}
