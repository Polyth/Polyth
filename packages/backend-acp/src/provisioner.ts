import type {
  CapabilitySecretResolver,
  HarnessCapabilityRecord,
  HarnessCapabilitySupport,
  HarnessProvisioner,
  HarnessProvisioningPlan,
} from "@polyth/contracts";
import { isAbsolute } from "node:path";
import { createLaunchOverlayStore, mcpNativeNameCollision, type LaunchOverlayStore } from "@polyth/harness-runtime";
import { renderCapabilityText } from "@polyth/harness-runtime/capability-text";
import { discoverHarnessExecutable } from "@polyth/harness-runtime/executable-discovery";

export type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
  | { type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> };

export interface AcpLaunchOverlay {
  mcpServers: AcpMcpServer[];
  mcpHttp: boolean;
  /** Lets negotiation report an unsupported native transport without blocking
   * stdio servers and the permission-gated Polyth MCP fallback. */
  mcpCapabilityIds?: Record<string, string>;
  /** Delivered as a separate text block, not as native session configuration. */
  prompt?: { text: string; capabilityIds: string[] };
}

export const acpOverlays: LaunchOverlayStore<AcpLaunchOverlay> = createLaunchOverlayStore<AcpLaunchOverlay>();

const support = (harnessId: string): HarnessCapabilitySupport => ({
  harnessId,
  targetLifetime: "session",
  kinds: {
    instruction: { modes: ["prompt"], mutability: "session-create", remote: false, configScope: "session" },
    "mcp-server": { modes: ["native"], mutability: "session-create", remote: false, configScope: "session" },
    tool: { modes: ["mcp"], mutability: "session-create", remote: false, configScope: "session" },
    skill: { modes: ["prompt"], mutability: "session-create", remote: false, configScope: "session" },
    context: { modes: ["prompt"], mutability: "session-create", remote: false, configScope: "session" },
    extension: { modes: ["unsupported"], mutability: "immutable" },
  },
});

const record = (
  item: HarnessProvisioningPlan["items"][number],
  status: HarnessCapabilityRecord["status"],
  reason?: string,
): HarnessCapabilityRecord => ({
  capabilityId: item.capability.id,
  kind: item.capability.kind,
  owner: item.capability.owner,
  desiredRevision: item.capability.revision,
  mode: item.mode,
  status,
  mutability: item.mutability,
  ...(reason ? { reason } : {}),
});

export interface AcpProvisionerOptions {
  /** The agent accepts only absolute stdio MCP commands (ACP names the field
   *  a path). Bare names are resolved on this machine the way harness CLIs
   *  are; a command that cannot be found is recorded as failed, not sent. */
  absoluteMcpCommands?: boolean;
}

/** The absolute executable for a bare stdio MCP command, if this host has one. */
const absoluteMcpCommand = async (command: string): Promise<string | undefined> => {
  if (isAbsolute(command)) return command;
  if (/[\\/]/.test(command)) return undefined;
  const { hit } = await discoverHarnessExecutable(command);
  return hit ? hit.launcherPath ?? hit.executablePath : undefined;
};

export function createAcpProvisioner(harnessId: string, mcpHttp = false, options: AcpProvisionerOptions = {}): HarnessProvisioner {
  return {
    support: () => support(harnessId),
    async apply(context, plan, secrets: CapabilitySecretResolver) {
      if (context.remote) {
        return {
          harnessId,
          desiredRevision: plan.desiredRevision,
          records: plan.items.map((item) => record(item, "unsupported", "Polyth capabilities are not delivered to a remote host yet")),
        };
      }
      const mcpServers: AcpMcpServer[] = [];
      const mcpCapabilityIds: Record<string, string> = {};
      const unresolved = new Map<string, string>();
      for (const item of plan.items) {
        if (item.capability.kind !== "mcp-server" || item.mode === "unsupported" || !item.capability.enabled) continue;
        if (mcpNativeNameCollision(plan.items, item.capability.id)) continue;
        if (item.capability.transport.kind === "http" && !mcpHttp) continue;
        let command = item.capability.transport.kind === "stdio" ? item.capability.transport.command : "";
        if (item.capability.transport.kind === "stdio" && options.absoluteMcpCommands) {
          const resolved = await absoluteMcpCommand(command).catch(() => undefined);
          if (!resolved) {
            unresolved.set(item.capability.id, `MCP server command "${command}" was not found on this machine; this agent needs an absolute executable path`);
            continue;
          }
          command = resolved;
        }
        mcpCapabilityIds[item.capability.name] = item.capability.id;
        const values = secrets.mcpSecrets(item.capability.id);
        if (item.capability.transport.kind === "stdio") {
          mcpServers.push({
            name: item.capability.name,
            command,
            args: item.capability.transport.args,
            env: item.capability.transport.envKeys.map((name) => ({ name, value: values[name] ?? "" })),
          });
        } else {
          mcpServers.push({
            type: "http",
            name: item.capability.name,
            url: item.capability.transport.url,
            headers: item.capability.transport.headersSecretRefs.map((name) => ({ name, value: values[name] ?? "" })),
          });
        }
      }
      const records = plan.items.map((item) => {
        const collision = mcpNativeNameCollision(plan.items, item.capability.id);
        if (collision) return record(item, "failed", collision);
        const missing = unresolved.get(item.capability.id);
        if (missing) return record(item, "failed", missing);
        if (item.capability.kind === "mcp-server" && item.capability.transport.kind === "http" && !mcpHttp) {
          return record(item, "unsupported", "ACP agent did not advertise HTTP MCP");
        }
        if (item.mode === "unsupported") {
          return record(item, "unsupported", "ACP v1 has no standard projection for this capability");
        }
        return record(item, "pending", item.mode === "prompt"
          ? "Staged for the next ACP session's prompts"
          : "Staged for the next ACP session/new");
      });
      const promptIds = records.filter((item) => item.status === "pending" && item.mode === "prompt")
        .map((item) => item.capabilityId);
      acpOverlays.set(context, {
        mcpServers,
        mcpHttp,
        mcpCapabilityIds,
        ...(promptIds.length ? { prompt: { text: renderCapabilityText(plan) ?? "", capabilityIds: promptIds } } : {}),
      }, harnessId, {
        desiredRevision: plan.desiredRevision,
        // session/new/load/resume only confirm MCP configuration. Text has its
        // own receipt after a successful session/prompt response.
        capabilityIds: records.filter((item) => item.status === "pending" && item.mode !== "prompt")
          .map((item) => item.capabilityId),
      });
      return { harnessId, desiredRevision: plan.desiredRevision, records };
    },
    release(context) {
      acpOverlays.release(context);
    },
  };
}
