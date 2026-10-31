import { dirname } from "node:path";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { stripJsonc } from "./config.ts";

export const OPENCODE_V2_DELEGATION_PLUGIN_FILENAME = "polyth-delegation-v2.mjs";

export const OPENCODE_V2_DELEGATION_PLUGIN_SOURCE = `export default {
  id: "polyth.delegation",
  async setup(ctx) {
    const registration = await ctx.permission.hook("evaluate", async (event) => {
      if (process.env.POLYTH_AGENT_BETA === "1" && (event.action === "edit" || event.action === "bash")) {
        event.effect = "deny";
        event.message = "Agent beta mode is read-only for the workspace; edit and shell execution are disabled";
        return;
      }
      if (event.action !== "subagent") return;
      event.effect = "deny";
      event.message = "Native OpenCode delegation is disabled in Polyth; use agent.spawn";
    });
    return () => registration.dispose();
  },
};
`;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

export function mergeOpenCodeV2DelegationConfigContent(
  configContent: string | undefined,
  pluginPath: string,
): string {
  const parsed: unknown = JSON.parse(stripJsonc(configContent?.trim() || "{}"));
  const config = record(parsed);
  if (!config) throw new Error("OpenCode inline config must be an object");

  const plugins = Array.isArray(config.plugins) ? [...config.plugins] : [];
  const filteredPlugins = plugins.filter((entry) =>
    !(typeof entry === "string" && entry === pluginPath));
  filteredPlugins.push(pluginPath);

  const permissions = Array.isArray(config.permissions) ? [...config.permissions] : [];
  permissions.push({ action: "subagent", resource: "*", effect: "deny" });

  return JSON.stringify({
    ...config,
    permissions,
    plugins: filteredPlugins,
  });
}

export function applyOpenCodeV2DelegationGuard(
  env: NodeJS.ProcessEnv,
  pluginPath: string,
): NodeJS.ProcessEnv {
  return {
    ...env,
    OPENCODE_CONFIG_CONTENT: mergeOpenCodeV2DelegationConfigContent(
      env.OPENCODE_CONFIG_CONTENT,
      pluginPath,
    ),
  };
}

export async function materializeOpenCodeV2DelegationPlugin(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, OPENCODE_V2_DELEGATION_PLUGIN_SOURCE, { mode: 0o600 });
  await rename(temp, path);
}
