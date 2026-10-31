import { CAP, type Plugin, type PluginContext } from "@polyth/contracts";
import {
  createOpenCodeRuntime,
  type OpenCodeAdapterOptions,
} from "./index.ts";
import type { ProtocolSelection } from "./protocol.ts";

export interface BackendOpenCodePluginConfig {
  projectId?: string;
  cwd?: string;
  port?: number;
  hostname?: string;
  bin?: string;
  configDir?: string;
  runtimeDir?: string;
  /** @deprecated Use configDir. */
  dataDir?: string;
  sessionIdMap?: Map<string, string>;
  protocol?: ProtocolSelection;
  configTargetId?: string;
  startupDeadlineMs?: number;
  probeDeadlineMs?: number;
}

const plugin: Plugin<BackendOpenCodePluginConfig> = {
  manifest: {
    id: "backend-opencode",
    version: "0.1.0",
    trust: "privileged",
    provides: ["polyth.agentRuntime"],
  },
  async setup(ctx: PluginContext, config: BackendOpenCodePluginConfig) {
    const cwd = typeof config.cwd === "string" ? config.cwd : process.cwd();
    const opts: OpenCodeAdapterOptions & { sessionIdMap?: Map<string, string> } = {
      projectId: typeof config.projectId === "string" ? config.projectId : undefined,
      cwd,
      port: typeof config.port === "number" ? config.port : undefined,
      hostname: typeof config.hostname === "string" ? config.hostname : undefined,
      bin: typeof config.bin === "string" ? config.bin : undefined,
      configDir: typeof config.configDir === "string"
        ? config.configDir
        : typeof config.dataDir === "string"
          ? config.dataDir
          : undefined,
      runtimeDir: typeof config.runtimeDir === "string" ? config.runtimeDir : undefined,
      sessionIdMap: config.sessionIdMap,
      protocol: config.protocol,
      configTargetId: typeof config.configTargetId === "string" ? config.configTargetId : undefined,
      startupDeadlineMs: typeof config.startupDeadlineMs === "number"
        ? config.startupDeadlineMs
        : undefined,
      probeDeadlineMs: typeof config.probeDeadlineMs === "number"
        ? config.probeDeadlineMs
        : undefined,
    };
    const runtime = await createOpenCodeRuntime(opts);
    ctx.provide(CAP.runtime, runtime);
    ctx.effect(() => runtime.dispose());
  },
};

export default plugin;
