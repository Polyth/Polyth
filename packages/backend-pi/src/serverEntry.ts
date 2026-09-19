import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HarnessContext, HarnessProvider, HarnessRegistry, RuntimeSessionBinding } from "@polyth/contracts";
import { captureCapabilityLaunch, provisioningTarget, releaseProcessExecution } from "@polyth/harness-runtime";
import { discoverHarnessExecutable, harnessExecutableChildEnv } from "@polyth/harness-runtime/executable-discovery";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { createPiRpc } from "./rpc.ts";
import { createPiRuntime, PI_CAPABILITIES } from "./runtime.ts";
import { createPiTitleRunner, withPiTitleGeneration } from "./title.ts";
import { createPiCapabilitySync } from "./capabilitySync.ts";
import { createPiProvisioner, piOverlays } from "./provisioner.ts";
import { PI_BOOTSTRAP_SOURCE } from "./bootstrapSource.ts";
import { PI_WORKER_SOURCE } from "./workerSource.ts";

const exec = promisify(execFile);
const windowsShim = (command: string) => process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);

const resolvePiBinary = async () => {
  const report = await discoverHarnessExecutable(process.env.POLYTH_PI_BIN?.trim() || "pi");
  if (!report.hit) {
    throw Object.assign(new Error(`Pi CLI was not found (${report.searched.slice(0, 8).join(", ") || "no searchable locations"})`), {
      code: "not-installed",
    });
  }
  return report.hit.executablePath;
};

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
  options: { stateFile?: string; ephemeral?: boolean; workerPath?: string; bootstrapPath?: string } = {},
) => {
  const command = await resolvePiBinary();
  const env = await harnessExecutableChildEnv(command);
  const staged = piOverlays.peek(context, "pi");
  const projection = staged && options.workerPath && options.bootstrapPath ? staged : undefined;
  if (projection) {
    captureCapabilityLaunch({
      target: provisioningTarget(context, "pi"),
      desiredRevision: projection.desiredRevision,
    });
  }
  const rpc = await createPiRpc({
    command,
    cwd: context.cwd,
    env,
    args: options.ephemeral ? ["--no-session"] : [],
    ...(projection ? {
      workerPath: options.workerPath,
      bootstrapPath: options.bootstrapPath,
      extensionPath: projection.value.extensionFile,
      toolBridge: projection.value.toolBridge,
    } : {}),
    stateFile: options.stateFile,
    stableAuthority: Boolean(options.stateFile),
  });
  return {
    rpc: projection ? createPiCapabilitySync(context, rpc) : rpc,
    command,
    env,
  };
};

export default function registerPackage(host: ServerPackageHost) {
  const registry = host.services.require(serverServiceKey<HarnessRegistry>("harnesses"));
  const generatedPaths = (context: HarnessContext) => {
    if (!context.space) throw Object.assign(new Error("Local Space context required"), { code: "unsupported" });
    const root = join(host.spaceStorage(context.space).packageDir(host.pluginId), "generated");
    return { worker: join(root, "pi-worker.mjs"), bootstrap: join(root, "pi-bootstrap.mjs") };
  };
  const stateFile = (context: HarnessContext) => {
    const key = createHash("sha256")
      .update(JSON.stringify([context.projectId, context.cwd, context.sessionId ?? "catalog"]))
      .digest("hex");
    return host.spaceStorage(context.space!).path(`runtime/pi/${key}.json`);
  };

  const provider: HarnessProvider = {
    descriptor: {
      id: "pi",
      name: "Pi",
      integration: "Native RPC",
      autoSelect: false,
      priority: 70,
      setupUrl: "https://github.com/earendil-works/pi/tree/main/packages/coding-agent",
      installCommand: "npm install -g @earendil-works/pi-coding-agent",
    },
    staticFeatures: PI_CAPABILITIES,
    async probe(context) {
      if (context.remote) {
        return {
          harnessId: "pi",
          installed: false,
          authenticated: "unknown",
          healthy: false,
          message: "Local execution only",
        };
      }
      try {
        const command = await resolvePiBinary();
        const env = await harnessExecutableChildEnv(command);
        const version = await exec(command, ["--version"], {
          timeout: 5_000,
          maxBuffer: 4_096,
          env,
          shell: windowsShim(command),
        }).then(({ stdout, stderr }) => (stdout || stderr).trim()).catch(() => undefined);
        return {
          harnessId: "pi",
          installed: true,
          authenticated: "unknown",
          healthy: true,
          state: "unknown",
          ...(version ? { version } : {}),
          message: "Native provider readiness is verified through Pi RPC model discovery",
        };
      } catch {
        return { harnessId: "pi", installed: false, authenticated: "unknown", healthy: false };
      }
    },
    async discover(context) {
      if (context.remote) throw Object.assign(new Error("Local execution only"), { code: "unsupported" });
      const { rpc } = await connectPi(context, { ephemeral: true });
      const runtime = createPiRuntime(context, rpc);
      try {
        const [models, capabilities] = await Promise.all([runtime.models(), runtime.capabilities()]);
        return {
          state: models.length ? "ready" as const : "auth-required" as const,
          authenticated: models.length > 0,
          capabilities,
          catalog: { models, agents: [] },
          ...(!models.length ? { message: "Pi is installed but no configured models are available" } : {}),
        };
      } finally {
        await runtime.dispose();
      }
    },
    async createRuntime(context) {
      if (!context.space || context.remote) {
        throw Object.assign(new Error("Local Space context required"), { code: "unsupported" });
      }
      const generated = generatedPaths(context);
      await Promise.all([
        writeGenerated(generated.worker, PI_WORKER_SOURCE),
        writeGenerated(generated.bootstrap, PI_BOOTSTRAP_SOURCE),
      ]);
      const { rpc, command, env } = await connectPi(context, {
        stateFile: stateFile(context),
        workerPath: generated.worker,
        bootstrapPath: generated.bootstrap,
      });
      try {
        const runtime = withPiTitleGeneration(
          context,
          rpc,
          createPiRuntime(context, rpc),
          createPiTitleRunner({ command, cwd: context.cwd, env }),
        );
        return Object.assign(runtime, {
          releaseExecution: async (binding: RuntimeSessionBinding, operationId: string) => {
            if (!context.space || context.remote) return { kind: "rejected" as const, code: "unsupported", message: "Local Space context required" };
            if (process.platform !== "linux") {
              return {
                kind: "rejected" as const,
                code: "unsupported",
                message: "Crash-safe cross-harness switching currently requires Linux; Pi can still be used normally",
              };
            }
            return releaseProcessExecution(stateFile(context), binding, operationId);
          },
        });
      } catch (error) {
        await rpc.close().catch(() => undefined);
        throw error;
      }
    },
    async releaseExecution(context, binding, operationId) {
      if (!context.space || context.remote) {
        return { kind: "rejected", code: "unsupported", message: "Local Space context required" };
      }
      if (process.platform !== "linux") {
        return {
          kind: "rejected",
          code: "unsupported",
          message: "Crash-safe cross-harness switching currently requires Linux; Pi can still be used normally",
        };
      }
      return releaseProcessExecution(stateFile(context), binding, operationId);
    },
    provisioner: createPiProvisioner(),
  };

  let registration: ReturnType<HarnessRegistry["register"]> | undefined;
  return {
    remoteAccess: localOnlyRemoteAccess(["backend-pi"]),
    onEnable() { registration = registry.register(provider); },
    onDisable() { registration?.dispose(); },
  };
}
