import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { HarnessContext, HarnessProvider, HarnessRegistry, ModelDescriptor, AgentRuntime } from "@polyth/contracts";
import { releaseProcessExecution } from "@polyth/harness-runtime";
import { discoverHarnessExecutable, harnessExecutableChildEnv } from "@polyth/harness-runtime/executable-discovery";
import { createHarnessProcessAuthority } from "@polyth/harness-runtime/process-authority";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { createAntigravityPermissionBridge } from "./permissions.ts";
import { ANTIGRAVITY_CAPABILITIES, agyError, parseAgyModels } from "./protocol.ts";
import { createAntigravityRuntime } from "./runtime.ts";
import { ANTIGRAVITY_WORKER_SOURCE } from "./workerSource.ts";

const exec = promisify(execFile);
const resolveBinary = async () => {
  const report = await discoverHarnessExecutable(process.env.POLYTH_ANTIGRAVITY_BIN?.trim() || "agy");
  if (!report.hit) throw agyError("not-installed", "Antigravity CLI was not found; install agy on the Polyth server");
  const command = report.hit.executablePath;
  return { command, env: await harnessExecutableChildEnv(command) };
};
const metadata = async (binary: Awaited<ReturnType<typeof resolveBinary>>, arg: "--version" | "models", cwd: string) =>
  (await exec(binary.command, [arg], { cwd, env: binary.env, timeout: 10_000, maxBuffer: 256 * 1024,
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(binary.command), windowsHide: true,
  })).stdout;

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

export default function registerPackage(host: ServerPackageHost) {
  const runtimes = new Set<AgentRuntime>();
  const catalog = new Map<string, { expires: number; promise: Promise<ModelDescriptor[]> }>();
  const scopeKey = (context: HarnessContext) => JSON.stringify([context.spaceId, context.projectId, context.cwd]);
  const runtimeKey = (context: HarnessContext) => createHash("sha256")
    .update(JSON.stringify([context.spaceId, context.projectId, context.cwd, context.sessionId]))
    .digest("hex");
  const stateFile = (context: HarnessContext) => {
    if (!context.space || context.space.spaceId !== context.spaceId || context.remote || !context.sessionId)
      throw agyError("unsupported", "A validated local Space and canonical session are required");
    return host.spaceStorage(context.space).path(`runtime/antigravity/${runtimeKey(context)}.json`);
  };
  const generatedPaths = (context: HarnessContext) => {
    if (!context.space) throw agyError("unsupported", "A validated local Space is required");
    const root = host.spaceStorage(context.space).packageDir(host.pluginId);
    return {
      worker: join(root, "generated", "antigravity-worker.mjs"),
      permissionRoot: join(root, "runtime", runtimeKey(context), "permission-workspace"),
    };
  };
  const models = async (context: HarnessContext): Promise<ModelDescriptor[]> => {
    if (context.remote) throw agyError("unsupported", "Antigravity runs on the local Polyth server only");
    const binary = await resolveBinary();
    const key = JSON.stringify([scopeKey(context), binary.command]);
    const prior = catalog.get(key);
    if (prior && prior.expires > Date.now()) return prior.promise;
    const entry = { expires: Date.now() + 30_000, promise: metadata(binary, "models", context.cwd).then((output) => {
      const rows = parseAgyModels(output);
      if (!rows.length) throw agyError("discovery-unavailable", "Antigravity did not report a usable model catalog; run agy models on the server");
      return rows;
    }) };
    catalog.set(key, entry);
    // Bound distinct Space/project entries and discard failed discovery, never
    // invent a fallback catalog or reuse a different account's cached models.
    if (catalog.size > 64) catalog.delete(catalog.keys().next().value!);
    entry.promise.catch(() => { if (catalog.get(key) === entry) catalog.delete(key); });
    return entry.promise;
  };
  const provider: HarnessProvider = {
    descriptor: {
      id: "antigravity", name: "Antigravity", integration: "Google · Gemini / stream-json",
      priority: 60, autoSelect: false,
      setupUrl: "https://antigravity.google/docs/cli/install/", signInCommand: "agy",
    },
    staticFeatures: ANTIGRAVITY_CAPABILITIES,
    async probe(context) {
      if (context.remote) return { harnessId: "antigravity", installed: false, authenticated: "unknown", healthy: false, message: "Local execution only" };
      try {
        const binary = await resolveBinary();
        try {
          const version = (await metadata(binary, "--version", context.cwd)).trim().slice(0, 256);
          return { harnessId: "antigravity", installed: true, authenticated: "unknown", healthy: true, version,
            message: "Uses the server's native Google sign-in. Run agy interactively once; model, effort and agent are fixed at session launch." };
        } catch { return { harnessId: "antigravity", installed: true, authenticated: "unknown", healthy: false, message: "Antigravity CLI did not answer the version probe" }; }
      } catch { return { harnessId: "antigravity", installed: false, authenticated: "unknown", healthy: false, message: "Install Antigravity CLI (agy) on the Polyth server" }; }
    },
    async discover(context) {
      return { state: "unknown", authenticated: "unknown", capabilities: ANTIGRAVITY_CAPABILITIES,
        catalog: { models: await models(context), agents: [] },
        message: "Native CLI authentication is verified on session initialization; Polyth gates non-edit tools unless Auto-Approve is enabled." };
    },
    invalidateDiscovery(context) {
      for (const key of catalog.keys()) if (JSON.parse(key)[0] === scopeKey(context)) catalog.delete(key);
    },
    async createRuntime(context) {
      const file = stateFile(context);
      const binary = await resolveBinary();
      const paths = generatedPaths(context);
      await writeGenerated(paths.worker, ANTIGRAVITY_WORKER_SOURCE);
      const authority = await createHarnessProcessAuthority(file);
      const runtime = createAntigravityRuntime({
        context,
        authority,
        ...binary,
        workerPath: paths.worker,
        models: () => models(context),
        autoApprove: async () => {
          if (!context.sessionId) return false;
          try {
            const sessions = host.forSpace(context.space!).sessions;
            return (await sessions.autoAcceptGet?.(context.sessionId))?.effective ?? false;
          } catch {
            return false;
          }
        },
        permissionBridge: (handle) => createAntigravityPermissionBridge({
          root: paths.permissionRoot,
          handle,
        }),
      });
      const dispose = runtime.dispose.bind(runtime);
      runtime.dispose = async () => { await dispose(); runtimes.delete(runtime); };
      runtimes.add(runtime);
      return runtime;
    },
    async releaseExecution(context, binding, operationId) {
      let file: string;
      try { file = stateFile(context); } catch { return { kind: "rejected", code: "unsupported", message: "A validated local Space and session are required" }; }
      if (binding.canonicalSessionId !== context.sessionId || binding.location.directory !== context.cwd)
        return { kind: "rejected", code: "invalid-session", message: "Antigravity binding belongs to another session or workspace" };
      if (process.platform !== "linux") return { kind: "rejected", code: "unsupported", message: "Crash-safe cross-harness switching requires Linux; native Antigravity sessions remain available" };
      return releaseProcessExecution(file, binding, operationId);
    },
  };
  let registration: ReturnType<HarnessRegistry["register"]> | undefined;
  return {
    remoteAccess: localOnlyRemoteAccess(["backend-antigravity"]),
    onEnable() { registration ??= host.services.require(serverServiceKey<HarnessRegistry>("harnesses")).register(provider); },
    async onDisable() {
      registration?.dispose(); registration = undefined; catalog.clear();
      const outcomes = await Promise.allSettled([...runtimes].map((runtime) => runtime.dispose()));
      const failures = outcomes.filter((item): item is PromiseRejectedResult => item.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map((item) => item.reason), "Some Antigravity process trees could not be released");
    },
  };
}
