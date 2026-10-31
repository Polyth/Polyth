// Pi's own packages (`pi install|remove|update|list`), read and managed in
// Pi's native user/project settings.
//
// Project trust: without an explicit `--approve`/`--no-approve`, a Pi package
// command in a project with trust-requiring resources loads that project's
// extensions to ask them about trust — repository code run by a list. Polyth
// therefore resolves trust from Pi's own saved decision (`trust.json`, then
// `defaultProjectTrust`) and always passes the explicit flag. It never grants
// trust itself: an untrusted project hides its project packages and refuses
// project-scoped changes until the user trusts it in Pi.
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { HarnessContext, MutationOutcome } from "@polyth/contracts";
import type {
  HarnessNativePluginManager,
  NativePluginAction,
  NativePluginComponentDto,
  NativePluginDto,
  NativePluginListDto,
  NativePluginScope,
  NativePluginSourceKind,
  NativePluginSupportDto,
} from "@polyth/contracts/capability-installations";
import { nativePluginRefError, readNativePluginCli, runNativePluginCli } from "@polyth/harness-runtime/native-plugins";

export interface PiNativePluginsOptions {
  harnessId: string;
  /** The executable and its environment, including an account's `PI_CODING_AGENT_DIR`. */
  resolveBinary(): Promise<{ command: string; env: NodeJS.ProcessEnv }>;
}

const ACTIONS: NativePluginAction[] = ["install", "uninstall", "update"];
const INSTALL_SCOPES: NativePluginScope[] = ["user", "project"];
const LIST_SOURCE = "pi list";
/** Polyth's project id for a context that names no project. */
const NO_PROJECT = "__default__";
const MAX_PLUGINS = 200;
const MAX_NAMES = 50;
const MAX_MANIFEST_BYTES = 256 * 1024;
/** Pi's `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES` (pi-coding-agent 0.85). */
const TRUST_REQUIRING = ["settings.json", "extensions", "skills", "prompts", "themes", "SYSTEM.md", "APPEND_SYSTEM.md"];

const support = (context: HarnessContext): NativePluginSupportDto => ({
  actions: context.remote ? [] : [...ACTIONS],
  installScopes: context.remote ? [] : [...INSTALL_SCOPES],
  installHint: "npm:package, git:github.com/user/repo or ./local/path",
  applies: "next-session",
  marketplaces: false,
});

const expandHome = (path: string, home: string): string =>
  path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;

const homeOf = (env: NodeJS.ProcessEnv): string => env.HOME?.trim() || homedir();

/** Pi's `getAgentDir()` for the child environment. */
export const piAgentDir = (env: NodeJS.ProcessEnv): string => {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  return resolve(configured ? expandHome(configured, homeOf(env)) : join(homeOf(env), ".pi", "agent"));
};

const canonical = async (path: string): Promise<string> => realpath(resolve(path)).catch(() => resolve(path));

const readJsonObject = async (file: string): Promise<Record<string, unknown> | undefined> => {
  const info = await lstat(file).catch(() => undefined);
  if (!info?.isFile() || info.size > MAX_MANIFEST_BYTES) return undefined;
  try {
    const parsed = JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, "")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
};

/** Pi's own trust decision for `cwd`, without running any project code. */
export async function piProjectTrusted(input: { agentDir: string; cwd: string; home: string }): Promise<boolean> {
  const store = await readJsonObject(join(input.agentDir, "trust.json"));
  let current = await canonical(input.cwd);
  if (store) {
    for (let dir = current; ; dir = dirname(dir)) {
      const decision = store[dir];
      if (decision === true || decision === false) return decision;
      if (dirname(dir) === dir) break;
    }
  }
  const settings = await readJsonObject(join(input.agentDir, "settings.json"));
  if (settings?.defaultProjectTrust === "always") return true;
  if (settings?.defaultProjectTrust === "never") return false;
  // Pi trusts a project that has nothing trust-requiring.
  if (TRUST_REQUIRING.some((entry) => existsSync(join(current, ".pi", entry)))) return false;
  const userSkills = join(await canonical(input.home), ".agents", "skills");
  for (;;) {
    const skills = join(current, ".agents", "skills");
    if (skills !== userSkills && existsSync(skills)) return false;
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

const stripAnsi = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");

export interface PiListedPackage {
  source: string;
  scope: "user" | "project";
  filtered: boolean;
  installedPath?: string;
}

/** Parses `pi list`: a `User packages:` / `Project packages:` header, each
 * source indented two spaces (` (filtered)` suffix allowed) and its installed
 * path indented four. */
export function parsePiList(stdout: string): PiListedPackage[] {
  const packages: PiListedPackage[] = [];
  let scope: "user" | "project" | undefined;
  for (const raw of stripAnsi(stdout).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (/^User packages:$/.test(line)) { scope = "user"; continue; }
    if (/^Project packages:$/.test(line)) { scope = "project"; continue; }
    if (!scope) continue;
    const path = line.match(/^ {4}(\S.*)$/);
    if (path) {
      const last = packages.at(-1);
      if (last && last.installedPath === undefined) last.installedPath = path[1]!;
      continue;
    }
    const source = line.match(/^ {2}(\S.*?)( \(filtered\))?$/);
    if (source && packages.length < MAX_PLUGINS) {
      packages.push({ source: source[1]!, scope, filtered: Boolean(source[2]) });
    }
  }
  return packages;
}

const sourceKind = (source: string): NativePluginSourceKind => {
  if (source.startsWith("npm:")) return "npm";
  if (/^(?:git:|https?:\/\/|ssh:\/\/|git@)/i.test(source)) return "git";
  return "local";
};

const npmNameVersion = (spec: string): { name: string; version?: string } => {
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  if (at <= 0) return { name: spec };
  const version = spec.slice(at + 1);
  return version ? { name: spec.slice(0, at), version } : { name: spec.slice(0, at) };
};

const contained = (root: string, candidate: string): boolean => {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
};

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Bounded read of one installed package: its `package.json` `pi` manifest,
 * else Pi's conventional `extensions/`, `skills/` and `prompts/` folders. */
const readComponents = async (installedPath: string): Promise<{ components: NativePluginComponentDto[]; version?: string }> => {
  const root = await realpath(installedPath).catch(() => undefined);
  if (!root) return { components: [] };
  const manifestFile = join(root, "package.json");
  const manifestReal = await realpath(manifestFile).catch(() => undefined);
  const manifest = manifestReal && contained(root, manifestReal) ? await readJsonObject(manifestReal) : undefined;
  const version = typeof manifest?.version === "string" ? manifest.version : undefined;
  const declared = manifest?.pi && typeof manifest.pi === "object" && !Array.isArray(manifest.pi)
    ? manifest.pi as Record<string, unknown>
    : undefined;
  const entries = async (folder: string): Promise<string[]> => {
    if (declared) return stringList(declared[folder]).map((entry) => basename(entry));
    const dir = join(root, folder);
    const info = await lstat(dir).catch(() => undefined);
    if (!info?.isDirectory()) return [];
    return (await readdir(dir).catch(() => [] as string[])).filter((name) => !name.startsWith(".")).slice(0, MAX_PLUGINS);
  };
  const [extensions, skills, prompts] = await Promise.all([entries("extensions"), entries("skills"), entries("prompts")]);
  const component = (
    kind: NativePluginComponentDto["kind"],
    names: string[],
    effect: NativePluginComponentDto["effect"],
    reason?: string,
  ): NativePluginComponentDto[] => names.length
    ? [{ kind, count: names.length, names: names.slice(0, MAX_NAMES), effect, ...(reason ? { reason } : {}) }]
    : [];
  return {
    ...(version ? { version } : {}),
    components: [
      // Polyth starts Pi with its own `--extension` and never `--no-extensions`,
      // so discovered package extensions load; blocking UI requests are
      // answered as cancelled by the RPC client (backend-pi rpc.ts).
      ...component("native-code", extensions, "active", "Interactive extension dialogs are cancelled by Polyth"),
      // Polyth never passes `--no-skills`.
      ...component("skill", skills, "active"),
      ...component("command", prompts, "unknown", "Prompt templates are not verified through Polyth's composer"),
    ],
  };
};

const outcomeMessage = (stdout: string): string | undefined => {
  const lines = stripAnsi(stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const last = lines.at(-1);
  return last ? last.slice(0, 500) : undefined;
};

const refused = (code: string, message: string): MutationOutcome<{ pendingRestart: boolean; message?: string }> =>
  ({ kind: "rejected", code, message });

export function createPiNativePlugins(options: PiNativePluginsOptions): HarnessNativePluginManager {
  const { harnessId } = options;
  const trustFlag = async (env: NodeJS.ProcessEnv, cwd: string): Promise<{ trusted: boolean; flag: string }> => {
    const trusted = await piProjectTrusted({ agentDir: piAgentDir(env), cwd, home: homeOf(env) });
    return { trusted, flag: trusted ? "--approve" : "--no-approve" };
  };
  return {
    support,
    async list(context, listOptions): Promise<NativePluginListDto> {
      if (context.remote) {
        return { harnessId, support: support(context), plugins: [], warnings: ["Pi packages are only read on this host."], checkedAt: Date.now() };
      }
      const { command, env } = await options.resolveBinary();
      const trust = await trustFlag(env, context.cwd);
      const { stdout } = await readNativePluginCli({
        command,
        args: ["list", trust.flag],
        env: { ...env, PI_OFFLINE: "1", NO_COLOR: "1" },
        cwd: context.cwd,
        ...(listOptions?.signal ? { signal: listOptions.signal } : {}),
      });
      const plugins: NativePluginDto[] = await Promise.all(parsePiList(stdout).map(async (item) => {
        const kind = sourceKind(item.source);
        const npm = kind === "npm" ? npmNameVersion(item.source.slice(4)) : undefined;
        const read = item.installedPath ? await readComponents(item.installedPath) : undefined;
        const version = npm?.version ?? read?.version;
        const name = npm?.name ?? (basename(item.source.replace(/[/\\]+$/, "").replace(/\.git$/, "")) || item.source);
        const note = [
          ...(item.filtered ? ["Some of this package's resources are turned off in `pi config`."] : []),
          ...(item.installedPath ? [] : ["Listed in settings but not installed on this host."]),
        ].join(" ");
        return {
          harnessId,
          id: item.source,
          name,
          ...(version ? { version } : {}),
          source: { kind, ref: item.source },
          scope: item.scope,
          ...(item.scope === "project" ? { projectPath: context.cwd } : {}),
          enabled: true,
          ...(read?.components.length ? { components: read.components } : {}),
          evidence: { stage: "discovered", source: LIST_SOURCE },
          ...(note ? { note } : {}),
        };
      }));
      return {
        harnessId,
        support: support(context),
        plugins,
        ...(trust.trusted ? {} : {
          warnings: ["Pi does not trust this project, so its project packages are hidden. Trust the project in Pi to manage them."],
        }),
        checkedAt: Date.now(),
      };
    },
    async mutate(context, input, mutation) {
      if (context.remote) return refused("unsupported", "Pi packages are only managed on this host.");
      if (!ACTIONS.includes(input.action)) return refused("unsupported", `Pi packages cannot be ${input.action}d.`);
      const scope = input.scope ?? "user";
      if (scope !== "user" && scope !== "project") return refused("invalid-input", "Pi packages live in user or project settings.");
      const ref = typeof input.plugin === "string" ? input.plugin : "";
      const invalid = nativePluginRefError(ref);
      if (invalid) return refused("invalid-input", invalid);
      // Pi resolves a relative local path against its cwd. Without a project
      // that cwd is only a placeholder, so the path would point somewhere else.
      if (context.projectId === NO_PROJECT && sourceKind(ref) === "local" && !isAbsolute(ref)) {
        return refused("invalid-input", "Choose a project to use a relative path, or give an absolute path.");
      }
      // Nothing has started yet, so a missing binary is a refusal.
      const prepared = await options.resolveBinary()
        .then(async (binary) => ({ ...binary, trust: await trustFlag(binary.env, context.cwd) }))
        .catch((error: { code?: unknown; message?: unknown }) => refused(
          typeof error?.code === "string" && error.code ? error.code : "not-installed",
          typeof error?.message === "string" && error.message ? error.message : "Pi is not available."));
      if ("kind" in prepared) return prepared;
      const { command, env, trust } = prepared;
      if (scope === "project" && input.action !== "update" && !trust.trusted) {
        return refused("project-untrusted", "Pi does not trust this project. Trust it in Pi before changing its project packages.");
      }
      const local = scope === "project" && input.action !== "update" ? ["-l"] : [];
      // `pi update <source>` would self-update for `pi`/`self`; `--extension`
      // always names one package.
      const args = input.action === "install" ? ["install", ref, ...local, trust.flag]
        : input.action === "uninstall" ? ["remove", ref, ...local, trust.flag]
        : ["update", "--extension", ref, trust.flag];
      const outcome = await runNativePluginCli({
        command,
        args,
        env: { ...env, NO_COLOR: "1" },
        cwd: context.cwd,
        operationId: mutation.operationId,
        ...(mutation.signal ? { signal: mutation.signal } : {}),
      });
      if (outcome.kind !== "confirmed") return outcome;
      const message = outcomeMessage(outcome.value.stdout);
      return { kind: "confirmed", value: { pendingRestart: false, ...(message ? { message } : {}) } };
    },
  };
}
