import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import type { HarnessContext, HarnessProvider, HarnessRegistry, RuntimeSessionBinding, SmallModelCompletionRequest } from "@polyth/contracts";
import { releaseHarnessProcessExecution } from "@polyth/harness-runtime";
import { harnessExecutableChildEnv } from "@polyth/harness-runtime/executable-discovery";
import { npmCliInstallCommand } from "@polyth/harness-runtime/installers";
import {
  execRemoteHarness,
  probeRemoteHarness,
  readRemoteFile,
  remoteHarnessLaunch,
  remoteHome,
  resolveRemoteHarnessHost,
  writeRemoteFile,
  type RemoteProcessHost,
} from "@polyth/harness-runtime/remote-host";
import { createHarnessAccountFamily, harnessCommandLine, linkAccountOverlay, type HarnessAccountStatus, type ResolvedHarnessAccount } from "@polyth/harness-runtime/accounts";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { COMMANDCODE_BRIDGE_SOURCE } from "./bridgeSource.ts";
import { createCommandCodeSmallModelRunner } from "./smallModel.ts";
import {
  commandCodeCompatibility,
  commandCodeCompatibilityMessage,
  commandCodeStatus,
  commandCodeLauncher,
  commandCodeVersion,
  discoverCommandCodeModels,
  resolveCommandCodeBinary,
  type CommandCodeCli,
  type CommandCodeCompatibility,
  type CommandCodeStatus,
} from "./discovery.ts";
import {
  commandCodeExecutionModeControl,
  readCommandCodeExecutionMode,
  writeCommandCodeExecutionMode,
} from "./executionMode.ts";
import { createCommandCodeCapabilitySync } from "./capabilitySync.ts";
import { createCommandCodeProvisioner } from "./provisioner.ts";
import { createCommandCodeRpc } from "./rpc.ts";
import { COMMANDCODE_CAPABILITIES, createCommandCodeRuntime, type CommandCodeBindingIo } from "./runtime.ts";
import { createCommandCodeTitleSync } from "./titleSync.ts";
import {
  commandCodeInputCapabilities,
  decorateCommandCodeTurnInput,
} from "./turnInput.ts";
import { COMMANDCODE_WORKER_SOURCE } from "./workerSource.ts";

const COMMANDCODE_PRESENTED_CAPABILITIES = commandCodeInputCapabilities(COMMANDCODE_CAPABILITIES);

const writeGenerated = async (file: string, content: string): Promise<void> => {
  const current = await readFile(file, "utf8").catch(() => undefined);
  if (current === content) return;
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, content, { mode: 0o600 });
  await rename(temp, file);
};

/** Bare name of the CLI on a remote host's harness PATH. */
const COMMANDCODE_REMOTE_BINARY = "command-code";
/** Content-addressed so hosts never run a worker/bridge pair from another
 * Polyth version, and concurrent launches never rewrite a file in use. */
const REMOTE_SOURCE_KEY = createHash("sha256")
  .update(COMMANDCODE_WORKER_SOURCE).update("\0").update(COMMANDCODE_BRIDGE_SOURCE)
  .digest("hex").slice(0, 16);

/** The CLI on a remote host, run in the project path on the host's login. */
const remoteCommandCodeCli = (remote: RemoteProcessHost): CommandCodeCli => ({
  async run(args, cwd, timeoutMs) {
    const { code, stdout, stderr } = await execRemoteHarness(remote, [COMMANDCODE_REMOTE_BINARY, ...args], timeoutMs, cwd ? { cwd } : {});
    if (code === 0) return String(stdout || stderr || "").trim();
    throw Object.assign(new Error(`Command Code on ${remote.label} exited ${code}`), { stdout, stderr });
  },
});

const remoteBindingIo = (remote: RemoteProcessHost): CommandCodeBindingIo => ({
  read: (file) => readRemoteFile(remote, file),
  write: (file, text) => writeRemoteFile(remote, file, text),
});

const compatibilityOrUndefined = async (command: string | CommandCodeCli): Promise<CommandCodeCompatibility | undefined> =>
  commandCodeCompatibility(command).catch(() => undefined);

/** Command Code reads its login from `~/.commandcode` (`os.homedir()`), so an
 *  extra account runs with a private home whose own `.commandcode` holds that
 *  login and its native projects, while every other entry links back to the
 *  real home for the tools the agent runs. */
const accountEnv = (account?: ResolvedHarnessAccount): Record<string, string> =>
  account ? { HOME: account.dir, ...(process.platform === "win32" ? { USERPROFILE: account.dir } : {}) } : {};
const prepareCommandCodeAccount = (account: ResolvedHarnessAccount) =>
  linkAccountOverlay({ root: account.dir, real: process.env.HOME?.trim() || homedir(), own: [".commandcode"] });


/** `status --json` is the CLI's local sign-in report; it runs no model turn. */
const commandCodeAccountStatus = async (account?: ResolvedHarnessAccount): Promise<HarnessAccountStatus> => {
  const command = await resolveCommandCodeBinary();
  const status = await commandCodeStatus(command, undefined, accountEnv(account));
  return {
    loggedIn: status.authenticated,
    ...(status.authenticated === true && status.accountLabel ? { email: status.accountLabel } : {}),
  };
};

export function createCommandCodeProvider(host: ServerPackageHost, account?: ResolvedHarnessAccount): HarnessProvider {
  const harnessId = account ? account.harnessId : "commandcode";
  const env = accountEnv(account);
  const resolveBinary = async () => {
    const command = await resolveCommandCodeBinary();
    if (account) await prepareCommandCodeAccount(account);
    return command;
  };
  const runtimeKeyFor = (context: HarnessContext) => createHash("sha256")
    .update(JSON.stringify([context.projectId, context.cwd, context.sessionId ?? "catalog", ...(account ? [harnessId] : [])]))
    .digest("hex");
  // Extra accounts are private local homes; only the default harness runs on
  // a remote host, there on the host's own login.
  const remoteHost = async (context: HarnessContext): Promise<RemoteProcessHost | undefined> => {
    if (!context.remote) return undefined;
    if (account) throw Object.assign(new Error("Extra Command Code accounts run on this machine only"), { code: "unsupported" });
    return resolveRemoteHarnessHost(host, context);
  };
  /** Worker, bridge Mod and binding receipts live on the host beside the CLI. */
  const remotePaths = async (remote: RemoteProcessHost, context: HarnessContext) => {
    const root = posix.join(await remoteHome(remote), ".local", "share", "polyth", "runtimes", "commandcode");
    const generated = posix.join(root, "generated", REMOTE_SOURCE_KEY);
    const bindingKey = createHash("sha256").update(JSON.stringify([context.spaceId, runtimeKeyFor(context)])).digest("hex");
    return {
      worker: posix.join(generated, "commandcode-worker.mjs"),
      bridge: posix.join(generated, "polyth-commandcode-bridge.ts"),
      binding: posix.join(root, "runtime", `${bindingKey}.binding.json`),
    };
  };
  const paths = (context: HarnessContext) => {
    if (!context.space) throw Object.assign(new Error("Local Space context required"), { code: "unsupported" });
    const runtimeKey = runtimeKeyFor(context);
    const projectKey = createHash("sha256")
      .update(JSON.stringify([context.projectId, context.cwd]))
      .digest("hex");
    const root = host.spaceStorage(context.space).packageDir(host.pluginId);
    return {
      root,
      worker: join(root, "generated", "commandcode-worker.mjs"),
      bridge: join(root, "generated", "polyth-commandcode-bridge.ts"),
      authority: join(root, "runtime", `${runtimeKey}.authority.json`),
      binding: join(root, "runtime", `${runtimeKey}.binding.json`),
      executionMode: join(root, "config", `${projectKey}.json`),
    };
  };

  const materialize = async (context: HarnessContext) => {
    const p = paths(context);
    await mkdir(join(p.root, "generated"), { recursive: true });
    await mkdir(join(p.root, "runtime"), { recursive: true });
    await Promise.all([
      writeGenerated(p.worker, COMMANDCODE_WORKER_SOURCE),
      writeGenerated(p.bridge, COMMANDCODE_BRIDGE_SOURCE),
    ]);
    return p;
  };

  const executionMode = async (context: HarnessContext) =>
    context.space ? readCommandCodeExecutionMode(paths(context).executionMode) : "follow-polyth" as const;

  return {
    descriptor: {
      id: harnessId,
      name: "Command Code",
      integration: "Official headless AgentEvent + Mod bridge",
      autoSelect: false,
      priority: 65,
      setupUrl: "https://commandcode.ai/docs/quickstart",
      installCommand: npmCliInstallCommand("command-code@latest", process.platform),
      updateCommand: ["commandcode", "update"],
      releaseSource: { kind: "npm", package: "command-code" },
      signInCommand: "command-code login",
      remoteHost: { binary: COMMANDCODE_REMOTE_BINARY, installCommand: npmCliInstallCommand("command-code@latest"), signInCommand: `${COMMANDCODE_REMOTE_BINARY} login`, ...(account ? {} : { sessions: true }) },
    },
    staticFeatures: COMMANDCODE_PRESENTED_CAPABILITIES,
    async probe(context) {
      if (context.remote) {
        if (account) return { harnessId, installed: false, authenticated: "unknown", healthy: false, message: "Extra Command Code accounts run on this machine only" };
        const remote = await remoteHost(context);
        if (remote) return probeRemoteHarness(remote, harnessId, COMMANDCODE_REMOTE_BINARY);
      }
      let command: string;
      try {
        command = await resolveBinary();
      } catch {
        return {
          harnessId,
          installed: false,
          authenticated: "unknown",
          healthy: false,
          state: "not-installed" as const,
        };
      }
      const [version, status, compatibility] = await Promise.all([
        commandCodeVersion(command),
        commandCodeStatus(command, context.cwd, env).catch((): CommandCodeStatus => ({ authenticated: "unknown" })),
        compatibilityOrUndefined(command),
      ]);
      if (!compatibility) {
        return {
          harnessId,
          installed: true,
          authenticated: status.authenticated,
          healthy: false,
          state: "degraded" as const,
          ...(version ? { version } : {}),
          message: "Command Code is installed, but Polyth could not verify its documented CLI surface",
        };
      }
      if (!compatibility.compatible) {
        return {
          harnessId,
          installed: true,
          authenticated: status.authenticated,
          healthy: false,
          state: "incompatible" as const,
          ...(version ? { version } : {}),
          message: commandCodeCompatibilityMessage(compatibility),
        };
      }
      return {
        harnessId,
        installed: true,
        authenticated: status.authenticated,
        healthy: true,
        state: status.authenticated === false ? "auth-required" as const : "unknown" as const,
        ...(version ? { version } : {}),
        ...(status.accountLabel ? { message: `Signed in as ${status.accountLabel}` } : {}),
      };
    },
    async discover(context) {
      const remote = await remoteHost(context);
      const command = remote ? remoteCommandCodeCli(remote) : await resolveBinary();
      const [status, compatibility, mode] = await Promise.all([
        commandCodeStatus(command, context.cwd, env).catch((): CommandCodeStatus => ({ authenticated: "unknown" })),
        compatibilityOrUndefined(command),
        executionMode(context),
      ]);
      const controls = [commandCodeExecutionModeControl(mode)];
      if (!compatibility) {
        return {
          state: "degraded" as const,
          authenticated: status.authenticated,
          capabilities: COMMANDCODE_PRESENTED_CAPABILITIES,
          catalog: { models: [], agents: [] },
          controls,
          message: "Polyth could not verify the installed Command Code CLI surface",
        };
      }
      if (!compatibility.compatible) {
        return {
          state: "incompatible" as const,
          authenticated: status.authenticated,
          capabilities: COMMANDCODE_PRESENTED_CAPABILITIES,
          catalog: { models: [], agents: [] },
          controls,
          message: commandCodeCompatibilityMessage(compatibility),
        };
      }
      if (status.authenticated === false) {
        return {
          state: "auth-required" as const,
          authenticated: false,
          capabilities: COMMANDCODE_PRESENTED_CAPABILITIES,
          catalog: { models: [], agents: [] },
          controls,
          message: "Sign in with Command Code to discover the native model catalog",
        };
      }
      const models = await discoverCommandCodeModels(command, context.cwd, status, env);
      return {
        state: "ready" as const,
        authenticated: status.authenticated === true,
        capabilities: COMMANDCODE_PRESENTED_CAPABILITIES,
        catalog: { models, agents: [], modes: ["follow-polyth", "plan"] },
        controls,
        ...(status.accountLabel ? { message: status.accountLabel } : {}),
      };
    },
    async applyControl(context, controlId, value) {
      if (!context.space) {
        throw Object.assign(new Error("Local Space context required"), { code: "unsupported" });
      }
      if (controlId !== "execution-mode") {
        throw Object.assign(new Error(`Unsupported Command Code control: ${controlId}`), { code: "unsupported" });
      }
      await writeCommandCodeExecutionMode(paths(context).executionMode, value);
    },
    async createRuntime(context) {
      if (!context.space) throw Object.assign(new Error("Local Space context required"), { code: "unsupported" });
      const remote = await remoteHost(context);
      const command = remote ? remoteCommandCodeCli(remote) : await resolveBinary();
      const compatibility = await compatibilityOrUndefined(command);
      if (!compatibility) {
        throw Object.assign(
          new Error("Polyth could not verify the installed Command Code CLI surface; update Command Code and retry"),
          { code: "unsupported" },
        );
      }
      if (!compatibility.compatible) {
        throw Object.assign(new Error(commandCodeCompatibilityMessage(compatibility)), { code: "unsupported" });
      }
      let rpc: Awaited<ReturnType<typeof createCommandCodeRpc>>;
      let bindingFile: string;
      let bridgePath: string;
      let bindingIo: CommandCodeBindingIo | undefined;
      let childEnv: NodeJS.ProcessEnv | undefined;
      const p = paths(context);
      if (remote) {
        // The worker runs on the host with Node beside the CLI, so its bridge
        // Mod, steering socket and admission receipts stay together there.
        const rp = await remotePaths(remote, context);
        await Promise.all([
          writeRemoteFile(remote, rp.worker, COMMANDCODE_WORKER_SOURCE, { ifAbsent: true }),
          writeRemoteFile(remote, rp.bridge, COMMANDCODE_BRIDGE_SOURCE, { ifAbsent: true }),
          mkdir(join(p.root, "runtime"), { recursive: true }),
        ]);
        rpc = await createCommandCodeRpc({
          workerPath: rp.worker,
          command: COMMANDCODE_REMOTE_BINARY,
          bridgePath: rp.bridge,
          cwd: context.cwd,
          stateFile: p.authority,
          stableAuthority: true,
          launch: remoteHarnessLaunch(remote, ["node", rp.worker], {
            cwd: context.cwd,
            env: { POLYTH_COMMANDCODE_BIN: COMMANDCODE_REMOTE_BINARY, POLYTH_COMMANDCODE_BRIDGE_PATH: rp.bridge },
          }),
        });
        bindingFile = rp.binding;
        bridgePath = rp.bridge;
        bindingIo = remoteBindingIo(remote);
      } else {
        const local = command as string;
        childEnv = { ...await harnessExecutableChildEnv(local), ...env };
        await materialize(context);
        rpc = await createCommandCodeRpc({
          workerPath: p.worker,
          command: local,
          bridgePath: p.bridge,
          cwd: context.cwd,
          env: childEnv,
          stateFile: p.authority,
          stableAuthority: true,
        });
        bindingFile = p.binding;
        bridgePath = p.bridge;
      }
      try {
        const capabilitySync = createCommandCodeCapabilitySync(context, rpc, harnessId);
        const titleSync = createCommandCodeTitleSync(capabilitySync);
        const runtime = decorateCommandCodeTurnInput(createCommandCodeRuntime({
          context,
          rpc: titleSync.rpc,
          bindingFile,
          bridgePath,
          ...(bindingIo ? { bindingIo } : {}),
          harnessId,
          models: async () => {
            const status = await commandCodeStatus(command, context.cwd, env).catch((): CommandCodeStatus => ({ authenticated: "unknown" }));
            return discoverCommandCodeModels(command, context.cwd, status, env);
          },
          // Read this project-scoped control for every turn, so switching into
          // or out of native Plan mode applies on the next admission without a
          // runtime restart. Follow-Polyth remains fail-closed when no policy is
          // available; we never fall back to Command Code's interactive default.
          permissionMode: async () => {
            if (await readCommandCodeExecutionMode(p.executionMode) === "plan") return "plan";
            if (!context.sessionId) return "dont-ask";
            try {
              const sessions = host.forSpace(context.space!).sessions;
              if (!sessions.autoAcceptGet) return "dont-ask";
              const policy = await sessions.autoAcceptGet(context.sessionId);
              return policy.effective ? "auto-accept" : "dont-ask";
            } catch {
              return "dont-ask";
            }
          },
        }), context.cwd);

        const ensureSession = runtime.ensureSession.bind(runtime);
        runtime.ensureSession = async (input) => {
          titleSync.capture(input.title);
          return ensureSession(input);
        };
        if (runtime.createSessionOperation) {
          const createSessionOperation = runtime.createSessionOperation.bind(runtime);
          runtime.createSessionOperation = async (input, operationId) => {
            titleSync.capture(input.title);
            return createSessionOperation(input, operationId);
          };
        }
        if (runtime.resetSessionOperation) {
          const resetSessionOperation = runtime.resetSessionOperation.bind(runtime);
          runtime.resetSessionOperation = async (input, operationId) => {
            titleSync.capture(input.title);
            return resetSessionOperation(input, operationId);
          };
        }

        // Native Command Code custom agents are intentionally not exposed:
        // every delegated worker is a canonical Polyth child session.
        if (remote) {
          // Print-mode utility turns are a local CLI run, and release proof
          // covers this machine only; the remote leg offers neither.
          return Object.assign(runtime, { agents: async () => [] });
        }
        const smallModel = createCommandCodeSmallModelRunner({ command: command as string, cwd: context.cwd, env: childEnv });
        return Object.assign(runtime, {
          agents: async () => [],
          // Stateless utility inference (commit messages, auditors) runs one
          // headless print-mode turn instead of a bound native session.
          completeSmallModel: (request: SmallModelCompletionRequest) => smallModel.complete(request),
          releaseExecution: async (binding: RuntimeSessionBinding, operationId: string) => {
            if (!context.space || context.remote) return { kind: "rejected" as const, code: "unsupported", message: "Local Space context required" };
            return releaseHarnessProcessExecution(paths(context).authority, binding, operationId);
          },
        });
      } catch (error) {
        await rpc.close().catch(() => undefined);
        throw error;
      }
    },
    provisioner: createCommandCodeProvisioner(harnessId),
    async releaseExecution(context, binding, operationId) {
      if (!context.space) return { kind: "rejected", code: "unsupported", message: "Local Space context required" };
      if (context.remote) return { kind: "rejected", code: "unsupported", message: "Crash-safe cross-harness switching is not available on remote hosts; Command Code can still be used normally" };
      return releaseHarnessProcessExecution(paths(context).authority, binding, operationId);
    },
  };
}

export default function registerPackage(host: ServerPackageHost) {
  const accounts = createHarnessAccountFamily({
    family: "commandcode",
    label: "Command Code",
    packageId: "backend-commandcode",
    storageDir: host.storageDir,
    deployment: host.deployment,
    registry: () => host.services.require(serverServiceKey<HarnessRegistry>("harnesses")),
    createProvider: (account) => createCommandCodeProvider(host, account),
    status: commandCodeAccountStatus,
    signInCommand: (account) => harnessCommandLine([commandCodeLauncher() ?? "command-code", "login"], accountEnv(account)),
    prepare: prepareCommandCodeAccount,
  });
  return {
    remoteAccess: localOnlyRemoteAccess(["backend-commandcode"]),
    routes: accounts.routes,
    onEnable: accounts.onEnable,
    onDisable: accounts.onDisable,
  };
}
