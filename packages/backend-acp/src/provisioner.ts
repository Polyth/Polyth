import type {
  CapabilitySecretResolver,
  HarnessCapabilityRecord,
  HarnessCapabilitySupport,
  HarnessContext,
  HarnessProvisioner,
  HarnessProvisioningPlan,
} from "@polyth/contracts";
import { createLaunchOverlayStore, mcpNativeNameCollision, type LaunchOverlayStore } from "@polyth/harness-runtime";

export type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
  | { type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> };

export interface AcpLaunchOverlay {
  mcpServers: AcpMcpServer[];
  mcpHttp: boolean;
}

export const acpOverlays: LaunchOverlayStore<AcpLaunchOverlay> = createLaunchOverlayStore<AcpLaunchOverlay>();

const support = (harnessId: string, _context: HarnessContext, mcpHttp: boolean): HarnessCapabilitySupport => ({
  harnessId,
  targetLifetime: "session",
  kinds: {
    instruction: { modes: ["unsupported"], mutability: "immutable" },
    "mcp-server": {
      modes: ["native"],
      mutability: "session-create",
      remote: false,
      configScope: "session",
    },
    tool: { modes: ["mcp"], mutability: "session-create", remote: false, configScope: "session" },
    skill: { modes: ["unsupported"], mutability: "immutable" },
    context: { modes: ["unsupported"], mutability: "immutable" },
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

export function createAcpProvisioner(harnessId: string, mcpHttp = false): HarnessProvisioner {
  return {
    support: (context) => support(harnessId, context, mcpHttp),
    async apply(context, plan, secrets: CapabilitySecretResolver) {
      if (context.remote) {
        return {
          harnessId,
          desiredRevision: plan.desiredRevision,
          records: plan.items.map((item) => record(item, "unsupported", "ACP adapter is local-only")),
        };
      }
      const mcpServers: AcpMcpServer[] = [];
      for (const item of plan.items) {
        if (item.capability.kind !== "mcp-server" || item.mode === "unsupported" || !item.capability.enabled) continue;
        if (mcpNativeNameCollision(plan.items, item.capability.id)) continue;
        const values = secrets.mcpSecrets(item.capability.id);
        if (item.capability.transport.kind === "stdio") {
          mcpServers.push({
            name: item.capability.name,
            command: item.capability.transport.command,
            args: item.capability.transport.args,
            env: item.capability.transport.envKeys.map((name) => ({ name, value: values[name] ?? "" })),
          });
        } else if (mcpHttp) {
          mcpServers.push({
            type: "http",
            name: item.capability.name,
            url: item.capability.transport.url,
            headers: item.capability.transport.headersSecretRefs.map((name) => ({ name, value: values[name] ?? "" })),
          });
        }
      }
      acpOverlays.set(context, { mcpServers, mcpHttp }, harnessId, {
        desiredRevision: plan.desiredRevision,
        capabilityIds: plan.items
          .filter((item) => item.mode !== "unsupported" && !mcpNativeNameCollision(plan.items, item.capability.id))
          .map((item) => item.capability.id),
      });
      return {
        harnessId,
        desiredRevision: plan.desiredRevision,
        records: plan.items.map((item) => {
          const collision = mcpNativeNameCollision(plan.items, item.capability.id);
          if (collision) return record(item, "failed", collision);
          if (item.capability.kind === "mcp-server" && item.capability.transport.kind === "http" && !mcpHttp) {
            return record(item, "unsupported", "ACP agent did not advertise HTTP MCP");
          }
          if (item.mode === "unsupported") {
            return record(item, "unsupported", "ACP v1 has no standard projection for this capability");
          }
          return record(item, "pending", "Staged for the next ACP session/new");
        }),
      };
    },
    release(context) {
      acpOverlays.release(context);
    },
  };
}
