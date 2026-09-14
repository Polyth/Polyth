import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HarnessContext, HarnessProvider, HarnessRegistry } from "@polyth/contracts";
import { releaseProcessExecution } from "@polyth/harness-runtime";
import { harnessExecutableChildEnv } from "@polyth/harness-runtime/executable-discovery";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { COMMANDCODE_BRIDGE_SOURCE } from "./bridgeSource.ts";
import {
  commandCodeCompatibility,
  commandCodeCompatibilityMessage,
  commandCodeStatus,
  commandCodeVersion,
  discoverCommandCodeAgents,
  discoverCommandCodeModels,
  resolveCommandCodeBinary,
  type CommandCodeCompatibility,
} from "./discovery.ts";
import { createCommandCodeRpc } from "./rpc.ts";
import { COMMANDCODE_CAPABILITIES, createCommandCodeRuntime } from "./runtime.ts";
import { createCommandCodeTitleSync } from "./titleSync.ts";
import { COMMANDCODE_WORKER_SOURCE } from "./workerSource.ts";

const writeGenerated = async (file: string, content: string): Promise<void> => {
  const current = await readFile(file, "utf8").catch(() => undefined);
  if (current === content) return;
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, content, { mode: 0o600 });
  await rename(temp, file);
};

const compatibilityOrUndefined = async (command: string): Promise<CommandCodeCompatibility | undefined> =>
  commandCodeCompatibility(command).catch(() => undefined);

export default function registerPackage(host: ServerPackageHost) {
  const registry = host.services.require(serverServiceKey<HarnessRegistry>("harnesses"));

  const paths = (context: HarnessContext) => {
    if (!context.space) throw Object.assign(new Error("Local Space context required"), { code: "unsupported" });
    const key = createHash("sha256")
      .update(JSON.stringify([context.projectId, context.cwd, context.sessionId ?? "catalog"]))
      .digest("hex");
    const root = host.spaceStorage(context.space).packageDir(host.pluginId);
    return {
      root,
      worker: join(root, "generated", "commandcode-worker.mjs"),
      bridge: join(root, "generated", "polyth-commandcode-bridge.ts"),
      authority: join(root, "runtime", `${key}.authority.json`),
      binding: join(root, "runtime", `${key}.binding.json`),
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

  const provider: HarnessProvider = {
    descriptor: {
      id: "commandcode",
      name: "Command Code",
      integration: "Official headless AgentEvent + Mod bridge",
      autoSelect: false,
      priority: 65,
      setupUrl: "https://commandcode.ai/docs/quickstart",
      installCommand: "npm install -g command-code@latest",
      signInCommand: "command-code login",
    },
    staticFeatures: COMMANDCODE_CAPABILITIES,
    async probe(context) {
      if (context.remote) {
        return { harnessId: "commandcode", installed: false, authenticated: "unknown", healthy: false, message: "Local execution only" };
      }
      let command: string;
      try {
        command = await resolveCommandCodeBinary();
      } catch {
        return {
          harnessId: "commandcode",
          installed: false,
          authenticated: "unknown",
          healthy: false,
          state: "not-installed" as const,
        };
      }
      const [version, status, compatibility] = await Promise.all([
        commandCodeVersion(command),
        commandCodeStatus(command).catch(() => ({ authenticated: "unknown" as const })),
        compatibilityOrUndefined(command),
      ]);
      if (!compatibility) {
        return {
          harnessId: "commandcode",
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
          harnessId: "commandcode",
          installed: true,
          authenticated: status.authenticated,
          healthy: false,
          state: "incompatible" as const,
          ...(version ? { version } : {}),
          message: commandCodeCompatibilityMessage(compatibility),
        };
      }
      return {
        harnessId: "commandcode",
        installed: true,
        authenticated: status.authenticated,
        healthy: true,
        state: status.authenticated === false ? "auth-required" as const : "unknown" as const,
        ...(version ? { version } : {}),
        ...(status.accountLabel ? { message: `Signed in as ${status.accountLabel}` } : {}),
      };
    },
    async discover(context) {
      if (context.remote) throw Object.assign(new Error("Local execution only"), { code: "unsupported" });
      const command = await resolveCommandCodeBinary();
      const [status, compatibility, agents] = await Promise.all([
        commandCodeStatus(command).catch(() => ({ authenticated: "unknown" as const })),
        compatibilityOrUndefined(command),
        discoverCommandCodeAgents(context.cwd),
      ]);
      if (!compatibility) {
        return {
          state: "degraded" as const,
          authenticated: status.authenticated,
          capabilities: COMMANDCODE_CAPABILITIES,
          catalog: { models: [], agents },
          message: "Polyth could not verify the installed Command Code CLI surface",
        };
      }
      if (!compatibility.compatible) {
        return {
          state: "incompatible" as const,
          authenticated: status.authenticated,
          capabilities: COMMANDCODE_CAPABILITIES,
          catalog: { models: [], agents },
          message: commandCodeCompatibilityMessage(compatibility),
        };
      }
      if (status.authenticated === false) {
        return {
          state: "auth-required" as const,
          authenticated: false,
          capabilities: COMMANDCODE_CAPABILITIES,
          catalog: { models: [], agents },
          message: "Sign in with Command Code to discover the native model catalog",
        };
      }
      const models = await discoverCommandCodeModels(command, context.cwd);
      return {
        state: "ready" as const,
        authenticated: status.authenticated === true,
        capabilities: COMMANDCODE_CAPABILITIES,
        catalog: { models, agents },
        ...(status.accountLabel ? { message: status.accountLabel } : {}),
      };
    },
    async createRuntime(context) {
      if (!context.space || context.remote) throw Object.assign(new Error("Local Space context required"), { code: "unsupported" });
      const command = await resolveCommandCodeBinary();
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
      const env = await harnessExecutableChildEnv(command);
      const p = await materialize(context);
      const rpc = await createCommandCodeRpc({
        workerPath: p.worker,
        command,
        bridgePath: p.bridge,
        cwd: context.cwd,
        env,
        stateFile: p.authority,
        stableAuthority: true,
      });
      try {
        const titleSync = createCommandCodeTitleSync(rpc);
        const runtime = createCommandCodeRuntime({
          context,
          rpc: titleSync.rpc,
          bindingFile: p.binding,
          bridgePath: p.bridge,
          models: () => discoverCommandCodeModels(command, context.cwd),
          // Resolve the canonical policy for every turn: a user can change
          // auto-accept while the session is alive. Missing policy/service and
          // all lookup failures stay fail-closed in native dont-ask mode.
          permissionMode: async () => {
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
        });

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

        // The documented native registry re-scans custom agents each turn, so
        // do not freeze this list at runtime construction time.
        return Object.assign(runtime, {
          agents: () => discoverCommandCodeAgents(context.cwd),
        });
      } catch (error) {
        await rpc.close().catch(() => undefined);
        throw error;
      }
    },
    async releaseExecution(context, binding, operationId) {
      if (!context.space || context.remote) return { kind: "rejected", code: "unsupported", message: "Local Space context required" };
      if (process.platform !== "linux") {
        return {
          kind: "rejected",
          code: "unsupported",
          message: "Crash-safe cross-harness switching currently requires Linux; Command Code can still be used normally",
        };
      }
      return releaseProcessExecution(paths(context).authority, binding, operationId);
    },
  };

  let registration: ReturnType<HarnessRegistry["register"]> | undefined;
  return {
    remoteAccess: localOnlyRemoteAccess(["backend-commandcode"]),
    onEnable() { registration = registry.register(provider); },
    onDisable() { registration?.dispose(); },
  };
}