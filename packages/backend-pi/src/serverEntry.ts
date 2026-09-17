import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HarnessContext, HarnessProvider, HarnessRegistry } from "@polyth/contracts";
import { releaseProcessExecution } from "@polyth/harness-runtime";
import { discoverHarnessExecutable, harnessExecutableChildEnv } from "@polyth/harness-runtime/executable-discovery";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { createPiRpc } from "./rpc.ts";
import { createPiRuntime, PI_CAPABILITIES } from "./runtime.ts";

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

const connectPi = async (context: HarnessContext, options: { stateFile?: string; ephemeral?: boolean } = {}) => {
  const command = await resolvePiBinary();
  const env = await harnessExecutableChildEnv(command);
  return createPiRpc({
    command,
    cwd: context.cwd,
    env,
    args: options.ephemeral ? ["--no-session"] : [],
    stateFile: options.stateFile,
    stableAuthority: Boolean(options.stateFile),
  });
};

export default function registerPackage(host: ServerPackageHost) {
  const registry = host.services.require(serverServiceKey<HarnessRegistry>("harnesses"));
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
      const rpc = await connectPi(context, { ephemeral: true });
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
      const rpc = await connectPi(context, { stateFile: stateFile(context) });
      try {
        const runtime = createPiRuntime(context, rpc);
        return Object.assign(runtime, {
          releaseExecution: async (binding, operationId) => {
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
  };

  let registration: ReturnType<HarnessRegistry["register"]> | undefined;
  return {
    remoteAccess: localOnlyRemoteAccess(["backend-pi"]),
    onEnable() { registration = registry.register(provider); },
    onDisable() { registration?.dispose(); },
  };
}
