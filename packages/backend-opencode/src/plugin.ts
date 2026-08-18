import { CAP, type Plugin, type PluginContext } from "@polyth/contracts";
import {
  createOpenCodeRuntime,
  type OpenCodeAdapterOptions,
} from "./index.ts";

export interface BackendOpenCodePluginConfig {
  cwd?: string;
  port?: number;
  hostname?: string;
  bin?: string;
  dataDir?: string;
  sessionIdMap?: Map<string, string>;
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
      cwd,
      port: typeof config.port === "number" ? config.port : undefined,
      hostname: typeof config.hostname === "string" ? config.hostname : undefined,
      bin: typeof config.bin === "string" ? config.bin : undefined,
      dataDir: typeof config.dataDir === "string" ? config.dataDir : undefined,
      sessionIdMap: config.sessionIdMap,
    };
    const runtime = await createOpenCodeRuntime(opts);
    ctx.provide(CAP.runtime, runtime);
    ctx.effect(() => runtime.dispose());
  },
};

export default plugin;
