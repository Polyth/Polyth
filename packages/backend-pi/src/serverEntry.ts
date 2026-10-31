import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HarnessContext, HarnessProvider, HarnessRegistry, RuntimeSessionBinding, SmallModelCompletionRequest } from "@polyth/contracts";
import { agentBetaEnabled, captureCapabilityLaunch, provisioningTarget, releaseHarnessProcessExecution } from "@polyth/harness-runtime";
import { discoverHarnessExecutable, harnessExecutableChildEnv } from "@polyth/harness-runtime/executable-discovery";
import { npmCliInstallCommand } from "@polyth/harness-runtime/installers";
import { probeRemoteHarness, remoteHarnessConfigSource, remoteHarnessLaunch, resolveRemoteHarnessHost, type RemoteProcessHost } from "@polyth/harness-runtime/remote-host";
import { createHarnessAccountFamily, harnessCommandLine, type HarnessAccountStatus, type ResolvedHarnessAccount } from "@polyth/harness-runtime/accounts";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { createPiRpc } from "./rpc.ts";
import { createPiRuntime, PI_CAPABILITIES } from "./runtime.ts";
import { createPiTitleRunner, withPiTitleGeneration } from "./title.ts";
import { createPiSmallModelRunner } from "./smallModel.ts";
import { createPiCapabilitySync } from "./capabilitySync.ts";
import { createPiNativePlugins } from "./nativePlugins.ts";
import { createPiProvisioner, piOverlays } from "./provisioner.ts";
import { PI_BOOTSTRAP_SOURCE } from "./bootstrapSource.ts";
import { PI_WORKER_SOURCE } from "./workerSource.ts";
import { listPiSessions, readPiSession } from "./history.ts";
import { remotePiEnv } from "./remoteConfig.ts";

const exec = promisify(execFile);
const windowsShim = (command: string) => process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);

/** Last resolved executable, for the synchronous sign-in command. */
let knownPiCommand: string | undefined;
const resolvePiBinary = async () => {
  const report = await discoverHarnessExecutable(process.env.POLYTH_PI_BIN?.trim() || "pi");
  if (!report.hit) {
    throw Object.assign(new Error(`Pi CLI was not found (${report.searched.slice(0, 8).join(", ") || "no searchable locations"})`), {
      code: "not-installed",
    });
  }
  knownPiCommand = report.hit.launcherPath ?? report.hit.executablePath;
  return report.hit.executablePath;
};

/** `PI_CODING_AGENT_DIR` holds one login's `auth.json`, settings and sessions. */
const accountEnv = (account?: ResolvedHarnessAccount): Record<string, string> =>
  account ? { PI_CODING_AGENT_DIR: account.dir } : {};
const piEnv = async (command: string, account?: ResolvedHarnessAccount): Promise<NodeJS.ProcessEnv> =>
  ({ ...await harnessExecutableChildEnv(command), ...accountEnv(account) });

/** `pi --list-models` offline is a local catalog report; it runs no turn. */
const piAccountStatus = async (account?: ResolvedHarnessAccount): Promise<HarnessAccountStatus> => {
  const command = await resolvePiBinary();
  const { text, ok } = await exec(command, ["--list-models"], {
    timeout: 30_000,
    maxBuffer: 512 * 1024,
    env: { ...await piEnv(command, account), PI_OFFLINE: "1" },
    shell: windowsShim(command),
  }).then(({ stdout, stderr }) => ({ text: `${stdout}\n${stderr}`, ok: true }), (error: { stdout?: string; stderr?: string }) =>
    ({ text: `${error.stdout ?? ""}\n${error.stderr ?? ""}`, ok: false }));
  if (/no models available/i.test(text)) return { loggedIn: false };
  return ok && text.trim() ? { loggedIn: true } : { loggedIn: "unknown" };
};

const PI_REMOTE_BINARY = "pi";

const writeGenerated = async (file: string, content: string): Promise<void> => {
  const current = await readFile(file, "utf8").catch(() => undefined);
  if (current === content) return;
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, content, { mode: 0o600 });
  await rename(temp, file);
};

const connectPi = async (
  context: HarnessContext,
  options: {
    stateFile?: string;
    ephemeral?: boolean;
    workerPath?: string;
    bootstrapPath?: string;
    harnessId?: string;
    account?: ResolvedHarnessAccount;
    remote?: RemoteProcessHost;
    /** The connection allows this machine's Pi configuration on the host. */
    remoteLocalConfig?: boolean;
  } = {},
) => {
  const harnessId = options.harnessId ?? "pi";
  const args = [
    ...(agentBetaEnabled() ? ["--exclude-tools", "bash,powershell,edit,write"] : []),
    ...(options.ephemeral ? ["--no-session"] : []),
  ];
  if (options.remote) {
    // Pi on the host, plain RPC mode: the host's own configuration, or this
    // machine's when the connection allows it and the host has no models
    // (remoteConfig.ts). The local tool bridge worker is not projected there.
    const env = options.remoteLocalConfig ? await remotePiEnv(options.remote, { binary: PI_REMOTE_BINARY }) : {};
    const rpc = await createPiRpc({
      command: PI_REMOTE_BINARY,
      cwd: context.cwd,
      launch: remoteHarnessLaunch(options.remote, [PI_REMOTE_BINARY, "--mode", "rpc", ...args], { cwd: context.cwd, env }),
      stateFile: options.stateFile,
      stableAuthority: Boolean(options.stateFile),
    });
    return { rpc: createPiCapabilitySync(context, rpc, harnessId), command: PI_REMOTE_BINARY, env: {} as NodeJS.ProcessEnv };
  }
  const command = await resolvePiBinary();
  const env = await piEnv(command, options.account);
  const staged = piOverlays.peek(context, harnessId);
  const toolProjection = staged
    && options.workerPath
    && options.bootstrapPath
    && staged.value.extensionFile
    && staged.value.toolBridge
    ? staged
    : undefined;
  if (toolProjection) {
    captureCapabilityLaunch({
      target: provisioningTarget(context, harnessId),
      desiredRevision: toolProjection.desiredRevision,
    });
  }
  const rpc = await createPiRpc({
    command,
    cwd: context.cwd,
    env,
    args,
    ...(toolProjection ? {
      workerPath: options.workerPath,
      bootstrapPath: options.bootstrapPath,
      extensionPath: toolProjection.value.extensionFile!,
      toolBridge: toolProjection.value.toolBridge!,
    } : {}),
    stateFile: options.stateFile,
    stableAuthority: Boolean(options.stateFile),
  });
  return {
    rpc: createPiCapabilitySync(context, rpc, harnessId),
    command,
    env,
  };
};

export function createPiProvider(host: ServerPackageHost, account?: ResolvedHarnessAccount): HarnessProvider {
  const harnessId = account ? account.harnessId : "pi";
  const agentDir = account ? account.dir : undefined;
  const generatedPaths = (context: HarnessContext) => {
    if (!context.space) throw Object.assign(new Error("Local Space context required"), { code: "unsupported" });
    const root = join(host.spaceStorage(context.space).packageDir(host.pluginId), "generated");
    return { worker: join(root, "pi-worker.mjs"), bootstrap: join(root, "pi-bootstrap.mjs") };
  };
  const stateFile = (context: HarnessContext) => {
    const key = createHash("sha256")
      .update(JSON.stringify([context.projectId, context.cwd, context.sessionId ?? "catalog"]))
      .digest("hex");
    return host.spaceStorage(context.space!).path(`runtime/${harnessId}/${key}.json`);
  };

  // Extra accounts are local `PI_CODING_AGENT_DIR`s; only the default
  // harness runs on a remote host, there on the host's own login.
  const remoteHost = async (context: HarnessContext): Promise<RemoteProcessHost | undefined> => {
    if (!context.remote) return undefined;
    if (account) throw Object.assign(new Error("Extra Pi accounts run on this machine only"), { code: "unsupported" });
    return resolveRemoteHarnessHost(host, context);
  };
  const remoteLaunch = async (context: HarnessContext) => {
    const remote = await remoteHost(context);
    if (!remote) return {};
    return { remote, remoteLocalConfig: await remoteHarnessConfigSource(host, context, harnessId) === "local" };
  };
  return {
    descriptor: {
      id: harnessId,
      name: "Pi",
      integration: "Native RPC",
      autoSelect: false,
      priority: 20,
      setupUrl: "https://github.com/earendil-works/pi/tree/main/packages/coding-agent",
      installCommand: npmCliInstallCommand("@earendil-works/pi-coding-agent", process.platform),
      updateCommand: ["pi", "update", "--self"],
      releaseSource: { kind: "npm", package: "@earendil-works/pi-coding-agent" },
      remoteHost: { binary: PI_REMOTE_BINARY, installCommand: npmCliInstallCommand("@earendil-works/pi-coding-agent"), signInCommand: PI_REMOTE_BINARY, ...(account ? {} : { sessions: true, localConfig: true }) },
      // Private sessions run under `--no-session`.
      privateSessions: true,
    },
    staticFeatures: PI_CAPABILITIES,
    async probe(context) {
      if (context.remote) {
        if (account) return { harnessId, installed: false, authenticated: "unknown", healthy: false, message: "Extra Pi accounts run on this machine only" };
        const remote = await remoteHost(context);
        if (remote) return probeRemoteHarness(remote, harnessId, PI_REMOTE_BINARY);
      }
      try {
        const command = await resolvePiBinary();
        const env = await piEnv(command, account);
        const version = await exec(command, ["--version"], {
          timeout: 5_000,
          maxBuffer: 4_096,
          env,
          shell: windowsShim(command),
        }).then(({ stdout, stderr }) => (stdout || stderr).trim()).catch(() => undefined);
        return {
          harnessId,
          installed: true,
          authenticated: "unknown",
          healthy: true,
          state: "unknown",
          ...(version ? { version } : {}),
          message: "Native provider readiness is verified through Pi RPC model discovery",
        };
      } catch {
        return { harnessId, installed: false, authenticated: "unknown", healthy: false };
      }
    },
    async discover(context) {
      const launch = await remoteLaunch(context);
      const remote = launch.remote;
      const { rpc } = await connectPi(context, { ephemeral: true, harnessId, ...(account ? { account } : {}), ...launch });
      const runtime = createPiRuntime(context, rpc, { harnessId });
      try {
        const [models, capabilities] = await Promise.all([runtime.models(), runtime.capabilities()]);
        return {
          state: models.length ? "ready" as const : "auth-required" as const,
          authenticated: models.length > 0,
          capabilities,
          catalog: { models, agents: [] },
          ...(!models.length ? {
            message: remote
              ? `Pi on ${remote.label} has no configured models; sign in to Pi there or configure Pi on this machine`
              : "Pi is installed but no configured models are available",
          } : {}),
        };
      } finally {
        await runtime.dispose();
      }
    },
    async createRuntime(context) {
      if (!context.space) {
        throw Object.assign(new Error("Local Space context required"), { code: "unsupported" });
      }
      const launch = await remoteLaunch(context);
      if (launch.remote) {
        const { rpc } = await connectPi(context, { stateFile: stateFile(context), ephemeral: context.privateSession === true, harnessId, ...launch });
        // Print-mode title and utility runs are local CLI processes; the
        // remote leg keeps Polyth's emulated title. Release proof covers only
        // this machine, so the runtime offers no release hook.
        return createPiRuntime(context, rpc, { harnessId });
      }
      const generated = generatedPaths(context);
      await Promise.all([
        writeGenerated(generated.worker, PI_WORKER_SOURCE),
        writeGenerated(generated.bootstrap, PI_BOOTSTRAP_SOURCE),
      ]);
      const { rpc, command, env } = await connectPi(context, {
        stateFile: stateFile(context),
        // A private session is never written to Pi's session directory.
        ephemeral: context.privateSession === true,
        workerPath: generated.worker,
        bootstrapPath: generated.bootstrap,
        harnessId,
        ...(account ? { account } : {}),
      });
      try {
        const runtime = withPiTitleGeneration(
          context,
          rpc,
          createPiRuntime(context, rpc, { harnessId }),
          createPiTitleRunner({ command, cwd: context.cwd, env }),
        );
        const smallModel = createPiSmallModelRunner({ command, cwd: context.cwd, env });
        return Object.assign(runtime, {
          // Stateless utility inference must not open a Pi session or run a
          // turn with tools; the print-mode process answers and exits.
          completeSmallModel: (request: SmallModelCompletionRequest) =>
            smallModel.complete(request),
          releaseExecution: async (binding: RuntimeSessionBinding, operationId: string) => {
            if (!context.space || context.remote) return { kind: "rejected" as const, code: "unsupported", message: "Local Space context required" };
            return releaseHarnessProcessExecution(stateFile(context), binding, operationId);
          },
        });
      } catch (error) {
        await rpc.close().catch(() => undefined);
        throw error;
      }
    },
    async releaseExecution(context, binding, operationId) {
      if (!context.space) {
        return { kind: "rejected", code: "unsupported", message: "Local Space context required" };
      }
      if (context.remote) {
        return { kind: "rejected", code: "unsupported", message: "Crash-safe cross-harness switching is not available on remote hosts; Pi can still be used normally" };
      }
      return releaseHarnessProcessExecution(stateFile(context), binding, operationId);
    },
    provisioner: createPiProvisioner(harnessId),
    plugins: createPiNativePlugins({
      harnessId,
      resolveBinary: async () => {
        const command = await resolvePiBinary();
        return { command, env: await piEnv(command, account) };
      },
    }),
    source: {
      async list(context) {
        if (context.remote) return [];
        return listPiSessions(context.cwd, agentDir);
      },
      read: (context, ref) => {
        if (context.remote) throw Object.assign(new Error("Local execution only"), { code: "unsupported" });
        return readPiSession(context, ref, agentDir);
      },
    },
  };
}

export default function registerPackage(host: ServerPackageHost) {
  const accounts = createHarnessAccountFamily({
    family: "pi",
    label: "Pi",
    packageId: "backend-pi",
    storageDir: host.storageDir,
    deployment: host.deployment,
    registry: () => host.services.require(serverServiceKey<HarnessRegistry>("harnesses")),
    createProvider: (account) => createPiProvider(host, account),
    status: piAccountStatus,
    // Pi signs in from its own interactive `/login` command.
    signInCommand: (account) => harnessCommandLine([knownPiCommand ?? "pi"], accountEnv(account)),
  });
  return {
    remoteAccess: localOnlyRemoteAccess(["backend-pi"]),
    routes: accounts.routes,
    onEnable: accounts.onEnable,
    onDisable: accounts.onDisable,
  };
}
