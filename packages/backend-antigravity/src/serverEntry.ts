import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type {
  HarnessContext, HarnessProvider, HarnessRegistry, HarnessReleaseSource, ModelDescriptor, AgentRuntime, RuntimeCommandDescriptor,
  SmallModelCompletionRequest,
} from "@polyth/contracts";
import { releaseHarnessProcessExecution } from "@polyth/harness-runtime";
import { discoverHarnessExecutable, harnessExecutableChildEnv } from "@polyth/harness-runtime/executable-discovery";
import { vendorScriptInstallCommand } from "@polyth/harness-runtime/installers";
import { createHarnessProcessAuthority } from "@polyth/harness-runtime/process-authority";
import { createHarnessAccountFamily, harnessCommandLine, linkAccountOverlay, type HarnessAccountStatus, type ResolvedHarnessAccount } from "@polyth/harness-runtime/accounts";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { readAgySkills } from "./commands.ts";
import { createAntigravityPermissionBridge } from "./permissions.ts";
import { createAntigravityNativePlugins } from "./nativePlugins.ts";
import { createAntigravityProvisioner } from "./provisioner.ts";
import { ANTIGRAVITY_CAPABILITIES, agyError, parseAgyModels } from "./protocol.ts";
import { createAntigravityRuntime } from "./runtime.ts";
import { createAntigravityTitleReader } from "./title.ts";
import { createAntigravitySmallModelRunner } from "./smallModel.ts";
import { ANTIGRAVITY_WORKER_SOURCE } from "./workerSource.ts";

const exec = promisify(execFile);
/** The official per-user installers (antigravity.google/docs/cli/install):
 *  `~/.local/bin/agy` on macOS/Linux, `%LOCALAPPDATA%\agy\bin\agy.exe` on
 *  Windows, both SHA-512 checked against the release manifest. */
export const ANTIGRAVITY_INSTALLER = {
  posix: "https://antigravity.google/cli/install.sh",
  windowsPowerShell: "https://antigravity.google/cli/install.ps1",
} as const;
const AGY_INSTALL = vendorScriptInstallCommand(ANTIGRAVITY_INSTALLER, process.platform);
/** The release manifest those installers read (`{"version": "1.4.7", "url":
 *  …, "sha512": …}`, no authentication), for this machine's build. Other
 *  operating systems and CPUs fall back to the Linux x64 record. */
export const antigravityReleaseSource = (
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): HarnessReleaseSource => ({
  kind: "page",
  url: `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${
    platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : "linux"}_${arch === "arm64" ? "arm64" : "amd64"}.json`,
  pattern: "\"version\"\\s*:\\s*\"([0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\"",
});
/** Last resolved executable, for the synchronous sign-in command. */
let knownAgyCommand: string | undefined;
const resolveAgyBinary = async () => {
  const report = await discoverHarnessExecutable(process.env.POLYTH_ANTIGRAVITY_BIN?.trim() || "agy");
  if (!report.hit) throw agyError("not-installed", "Antigravity CLI was not found; install agy on the Polyth server");
  const command = report.hit.executablePath;
  knownAgyCommand = report.hit.launcherPath ?? command;
  return { command, env: await harnessExecutableChildEnv(command) };
};
/** An extra account's private home: its own `.gemini`, the rest linked back. */
const accountEnv = (account?: ResolvedHarnessAccount): Record<string, string> =>
  account ? { HOME: account.dir, ...(process.platform === "win32" ? { USERPROFILE: account.dir } : {}) } : {};
const metadata = async (binary: { command: string; env: NodeJS.ProcessEnv }, arg: "--version" | "models", cwd: string) =>
  (await exec(binary.command, [arg], { cwd, env: binary.env, timeout: 10_000, maxBuffer: 256 * 1024,
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(binary.command), windowsHide: true,
  })).stdout;

/** `agy models` is a free local report: it lists the catalog only when the
 *  home's Google login is valid and never runs a model turn. */
const antigravityAccountStatus = async (account?: ResolvedHarnessAccount): Promise<HarnessAccountStatus> => {
  const binary = await resolveAgyBinary();
  const output = await exec(binary.command, ["models"], {
    env: { ...binary.env, ...accountEnv(account) },
    timeout: 60_000,
    maxBuffer: 256 * 1024,
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(binary.command),
    windowsHide: true,
  }).then(({ stdout, stderr }) => ({ text: `${stdout}\n${stderr}`, ok: true }), (error: { stdout?: string; stderr?: string }) =>
    ({ text: `${error.stdout ?? ""}\n${error.stderr ?? ""}`, ok: false }));
  if (/sign in/i.test(output.text)) return { loggedIn: false };
  return output.ok && parseAgyModels(output.text).length ? { loggedIn: true } : { loggedIn: "unknown" };
};

/** A cached model catalog for one Space/project/workspace/binary scope. */
type CatalogEntry = { expires: number; promise: Promise<ModelDescriptor[]> };

/** How long one catalog fetch keeps proving sign-in to the cheap probe. This
 * mirrors the registry's own detail-trust window: the "Signed in" label and the
 * catalog beside it are the same observation, so they expire together instead
 * of the label reverting to "Not verified" while the catalog stays on screen.
 * A failed or forced detail recheck clears the proof immediately; until such a
 * recheck observes a later sign-out, the bounded cached evidence is necessarily
 * stale rather than a live authentication guarantee. */
const SIGNED_IN_TTL_MS = 5 * 60_000;

const writeGenerated = async (file: string, content: string): Promise<void> => {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
    throw agyError("invalid-path", "Antigravity generated runtime directory is unsafe");
  const existing = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw agyError("invalid-path", "Antigravity generated worker path is unsafe");
  const current = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (current !== content) {
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, content, { mode: 0o600 });
    await rename(temp, file);
  }
  await Promise.all([chmod(directory, 0o700), chmod(file, 0o600)]);
};

export function createAntigravityPackage(
  host: ServerPackageHost,
  options: { now?: () => number } = {},
) {
  const now = options.now ?? Date.now;
  const runtimes = new Set<AgentRuntime>();
  const realUserHome = (env: NodeJS.ProcessEnv): string => {
    const configured = env.HOME?.trim() || (process.platform === "win32" ? env.USERPROFILE?.trim() : undefined);
    return configured || homedir();
  };
  /** One Antigravity harness. The default reads the user's own `~/.gemini`;
   *  an extra account runs with its private home (`account.dir`), whose own
   *  `.gemini` holds that login and its native conversations while every other
   *  entry links back to the real home. */
  const createProvider = (account?: ResolvedHarnessAccount): HarnessProvider => {
    const harnessId = account ? account.harnessId : "antigravity";
    const resolveBinary = async () => {
      const binary = await resolveAgyBinary();
      return account ? { ...binary, env: { ...binary.env, ...accountEnv(account) } } : binary;
    };
    /** The home whose `.gemini` this harness signs in with. */
    const geminiHome = (env: NodeJS.ProcessEnv) => account ? account.dir : realUserHome(env);
    const catalog = new Map<string, CatalogEntry>();
    const discoveryEpoch = new Map<string, number>();
    const signInUntil = new Map<string, { until: number }>();
    const scopeKey = (context: HarnessContext) => JSON.stringify([context.spaceId, context.projectId, context.cwd]);
    const runtimeKey = (context: HarnessContext) => createHash("sha256")
      .update(JSON.stringify([context.spaceId, context.projectId, context.cwd, context.sessionId, ...(account ? [harnessId] : [])]))
      .digest("hex");
    const stateFile = (context: HarnessContext) => {
      if (!context.space || context.space.spaceId !== context.spaceId || context.remote || !context.sessionId)
        throw agyError("unsupported", "A validated local Space and canonical session are required");
      return host.spaceStorage(context.space).path(`runtime/${harnessId}/${runtimeKey(context)}.json`);
    };
    const generatedPaths = (context: HarnessContext) => {
      if (!context.space) throw agyError("unsupported", "A validated local Space is required");
      const root = host.spaceStorage(context.space).packageDir(host.pluginId);
      const runtime = join(root, "runtime", runtimeKey(context));
      return {
        worker: join(root, "generated", "antigravity-worker.mjs"),
        permissionRoot: join(runtime, "permission-workspace"),
        homeRoot: join(runtime, "agy-home"),
      };
    };
    const trimDiscoveryScopes = () => {
      // Bound tenant-sensitive metadata and keep its epoch/proof lifecycle tied
      // to the same catalog entry. An in-flight eviction can finish, but it can
      // no longer publish auth evidence because its entry is no longer current.
      while (catalog.size > 64) {
        const oldest = catalog.keys().next().value as string | undefined;
        if (!oldest) break;
        catalog.delete(oldest);
        discoveryEpoch.delete(oldest);
        // A refresh can still be pending while the proof belongs to its older
        // successful entry. Evict the whole scope, including that older proof.
        signInUntil.delete(oldest);
      }
      // Forced invalidations retain a generation fence until a replacement fetch
      // claims the scope. Bound scopes that were invalidated but never re-read;
      // never evict an epoch that still has a current catalog entry.
      for (const key of discoveryEpoch.keys()) {
        if (discoveryEpoch.size <= 64) break;
        if (!catalog.has(key)) discoveryEpoch.delete(key);
      }
    };
    const models = async (context: HarnessContext): Promise<ModelDescriptor[]> => {
      if (context.remote) throw agyError("unsupported", "Antigravity runs on the local Polyth server only");
      const binary = await resolveBinary();
      const key = JSON.stringify([scopeKey(context), binary.command]);
      const prior = catalog.get(key);
      if (prior && prior.expires > now()) return prior.promise;
      const epoch = discoveryEpoch.get(key) ?? 0;
      discoveryEpoch.set(key, epoch);
      const entry: CatalogEntry = { expires: now() + 30_000, promise: metadata(binary, "models", context.cwd).then((output) => {
        const rows = parseAgyModels(output, harnessId);
        if (!rows.length) throw agyError("discovery-unavailable", "Antigravity did not report a usable model catalog; run agy models on the server");
        // A usable catalog is the CLI's own answer to "who am I", and it is the
        // only non-billing probe that can fail on credentials: `agy --version`
        // answers identically with an empty home, while `agy models` refuses to
        // list anything until the account is signed in. Recording that here is
        // what lets a cheap probe report real readiness instead of "unknown".
        if (catalog.get(key) === entry && discoveryEpoch.get(key) === epoch) {
          signInUntil.set(key, { until: now() + SIGNED_IN_TTL_MS });
        }
        return rows;
      }) };
      catalog.set(key, entry);
      trimDiscoveryScopes();
      entry.promise.catch(() => {
        if (catalog.get(key) === entry) {
          catalog.delete(key);
          if (discoveryEpoch.get(key) === epoch) discoveryEpoch.delete(key);
          // A failed current recheck revokes the bounded account fact, including
          // proof left by an older successful catalog entry. An older failure
          // cannot erase a newer current entry or its successful re-proof.
          signInUntil.delete(key);
        }
      });
      return entry.promise;
    };
    /** Sign-in proven by a catalog this process already fetched for the same
     * Space, project, workspace and binary. Kept apart from the catalog entry so
     * a routine model-list refresh cannot silently drop the account fact, and
     * never inferred across scopes. */
    const cachedSignIn = (context: HarnessContext, command: string): boolean => {
      const proof = signInUntil.get(JSON.stringify([scopeKey(context), command]));
      return proof !== undefined && proof.until > now();
    };
    // Workspace and user skills are the native slash commands. The report is
    // scoped like the model catalog; a failed report is retried, never faked.
    const skillCatalog = new Map<string, { expires: number; promise: Promise<RuntimeCommandDescriptor[]> }>();
    const skills = async (context: HarnessContext): Promise<RuntimeCommandDescriptor[]> => {
      if (context.remote) return [];
      const binary = await resolveBinary();
      const key = JSON.stringify([scopeKey(context), binary.command]);
      const prior = skillCatalog.get(key);
      if (prior && prior.expires > now()) return prior.promise;
      const entry = { expires: now() + 5 * 60_000, promise: readAgySkills({ command: binary.command, cwd: context.cwd, env: binary.env, harnessId }) };
      skillCatalog.set(key, entry);
      if (skillCatalog.size > 64) skillCatalog.delete(skillCatalog.keys().next().value!);
      entry.promise.catch(() => { if (skillCatalog.get(key) === entry) skillCatalog.delete(key); });
      return entry.promise;
    };
    return {
      descriptor: {
        id: harnessId, name: "Antigravity", integration: "Google · Gemini / stream-json",
        priority: 30, autoSelect: false,
        setupUrl: "https://antigravity.google/docs/cli/install/", signInCommand: "agy",
        ...(AGY_INSTALL ? { installCommand: AGY_INSTALL } : {}),
        updateCommand: ["agy", "update"],
        releaseSource: antigravityReleaseSource(),
      },
      staticFeatures: ANTIGRAVITY_CAPABILITIES,
      async probe(context) {
        if (context.remote) return { harnessId, installed: false, authenticated: "unknown", healthy: false, message: "Local execution only" };
        try {
          const binary = await resolveBinary();
          try {
            const version = (await metadata(binary, "--version", context.cwd)).trim().slice(0, 256);
            // The version probe is deliberately cheap and cannot see credentials,
            // so it reports sign-in only while this scope's catalog still proves
            // it. Otherwise the honest answer stays "unknown" until the catalog
            // is fetched, rather than a guessed "ready".
            const signedIn = cachedSignIn(context, binary.command);
            return { harnessId, installed: true, authenticated: signedIn ? true : "unknown", healthy: true, version,
              ...(signedIn ? { state: "ready" as const } : {}),
              message: signedIn
                ? "Signed in to the server's Google account; model, effort and agent are fixed at session launch."
                : "Uses the server's native Google sign-in. Run agy interactively once; sign-in is confirmed by the model catalog, and model, effort and agent are fixed at session launch." };
          } catch { return { harnessId, installed: true, authenticated: "unknown", healthy: false, message: "Antigravity CLI did not answer the version probe" }; }
        } catch { return { harnessId, installed: false, authenticated: "unknown", healthy: false, message: "Install Antigravity CLI (agy) on the Polyth server" }; }
      },
      async discover(context) {
        // The catalog is only returned after a non-empty parse, and the CLI
        // refuses to list models without a signed-in account, so a resolved
        // catalog is positive authentication evidence. A failed catalog still
        // propagates, and the registry turns the CLI's own sign-in wording into
        // the "Sign in required" state.
        const rows = await models(context);
        return { state: "ready", authenticated: true, capabilities: ANTIGRAVITY_CAPABILITIES,
          catalog: { models: rows, agents: [] },
          message: "Sign-in is confirmed by the CLI's own model catalog. The headless CLI launches with its own permission bypass because it cannot answer an approval prompt; Polyth's bridge still decides every gated tool through the session's permission policy and blocks the known native delegation tools." };
      },
      invalidateDiscovery(context) {
        const scope = scopeKey(context);
        const keys = new Set([...catalog.keys(), ...discoveryEpoch.keys(), ...signInUntil.keys()]);
        for (const key of keys) {
          if (JSON.parse(key)[0] !== scope) continue;
          // Fence an older in-flight catalog before dropping the current entry;
          // its eventual success must not resurrect proof after a forced recheck.
          discoveryEpoch.set(key, (discoveryEpoch.get(key) ?? 0) + 1);
          catalog.delete(key);
          signInUntil.delete(key);
        }
        for (const key of skillCatalog.keys()) if (JSON.parse(key)[0] === scope) skillCatalog.delete(key);
        trimDiscoveryScopes();
      },
      async createRuntime(context) {
        const file = stateFile(context);
        const binary = await resolveBinary();
        const paths = generatedPaths(context);
        await writeGenerated(paths.worker, ANTIGRAVITY_WORKER_SOURCE);
        const authority = await createHarnessProcessAuthority(file);
        // The native CLI reads its Gemini config (including MCP servers) from
        // `$HOME`; a private home keeps one canonical session's bridge isolated
        // while the real app data stays shared for auth and conversation resume.
        const launchEnv: NodeJS.ProcessEnv = {
          ...binary.env,
          HOME: paths.homeRoot,
          ...(process.platform === "win32" ? { USERPROFILE: paths.homeRoot } : {}),
        };
        const runtime = createAntigravityRuntime({
          context,
          authority,
          command: binary.command,
          workerPath: paths.worker,
          env: launchEnv,
          models: () => models(context),
          commands: () => skills(context),
          harnessId,
          titleReader: createAntigravityTitleReader(
            join(geminiHome(binary.env), ".gemini", "antigravity-cli", "annotations"),
          ),
          // Headless Antigravity auto-denies every tool that needs an approval
          // interaction it cannot prompt for, and a PreToolUse `allow` is never
          // converted into a grant, so without this flag the CLI cannot use a
          // single gated tool and the session stalls until Polyth's tool
          // watchdog aborts it. The flag is not an approval: the bridge sends
          // every gated tool to the session's canonical permission policy and
          // fails closed, so it remains the enforcement point.
          nativePermissionBypass: async () => true,
          mcpSchemaRoot: join(paths.homeRoot, ".gemini", "antigravity-cli", "mcp"),
          permissionBridge: (handle) => createAntigravityPermissionBridge({
            root: paths.permissionRoot,
            homeRoot: paths.homeRoot,
            // An account's binary env points HOME at its own home; links still
            // come from the real one.
            realHome: realUserHome(account ? process.env : binary.env),
            ...(account ? { geminiHome: account.dir } : {}),
            handle,
          }),
        });
        const dispose = runtime.dispose.bind(runtime);
        runtime.dispose = async () => { await dispose(); runtimes.delete(runtime); };
        runtimes.add(runtime);
        // Stateless utility inference (commit messages, auditors) uses agy's
        // single-prompt print mode, not a native conversation.
        const smallModel = createAntigravitySmallModelRunner({
          command: binary.command,
          cwd: context.cwd,
          env: binary.env,
        });
        runtime.completeSmallModel = (request: SmallModelCompletionRequest) => smallModel.complete(request);
        return runtime;
      },
      async releaseExecution(context, binding, operationId) {
        let file: string;
        try { file = stateFile(context); } catch { return { kind: "rejected", code: "unsupported", message: "A validated local Space and session are required" }; }
        if (binding.canonicalSessionId !== context.sessionId || binding.location.directory !== context.cwd)
          return { kind: "rejected", code: "invalid-session", message: "Antigravity binding belongs to another session or workspace" };
        return releaseHarnessProcessExecution(file, binding, operationId);
      },
      provisioner: createAntigravityProvisioner(harnessId),
      plugins: createAntigravityNativePlugins({ harnessId, resolveBinary }),
    };
  };
  const accounts = createHarnessAccountFamily({
    family: "antigravity",
    label: "Antigravity",
    packageId: "backend-antigravity",
    storageDir: host.storageDir,
    deployment: host.deployment,
    registry: () => host.services.require(serverServiceKey<HarnessRegistry>("harnesses")),
    // Each enable builds fresh providers, so every catalog and sign-in proof
    // of a disabled package is dropped with them.
    createProvider,
    status: antigravityAccountStatus,
    // `agy` without arguments runs its own interactive Google sign-in.
    signInCommand: (account) => harnessCommandLine([knownAgyCommand ?? "agy"], accountEnv(account)),
    prepare: (account) => linkAccountOverlay({ root: account.dir, real: realUserHome(process.env), own: [".gemini"] }),
    // Usage reads the account's own `<dir>/.gemini/antigravity-cli` login.
    limitsFamily: "antigravity",
  });
  return {
    remoteAccess: localOnlyRemoteAccess(["backend-antigravity"]),
    routes: accounts.routes,
    onEnable: accounts.onEnable,
    async onDisable() {
      await accounts.onDisable();
      const outcomes = await Promise.allSettled([...runtimes].map((runtime) => runtime.dispose()));
      const failures = outcomes.filter((item): item is PromiseRejectedResult => item.status === "rejected");
      if (failures.length) {
        // Package lifecycle keeps the descriptor enabled when onDisable fails.
        // Restore the providers so that retry remains possible and the UI never
        // claims an enabled package whose harness silently disappeared.
        await accounts.onEnable();
        throw new AggregateError(failures.map((item) => item.reason), "Some Antigravity process trees could not be released");
      }
    },
  };
}

export default function registerPackage(host: ServerPackageHost) {
  return createAntigravityPackage(host);
}
