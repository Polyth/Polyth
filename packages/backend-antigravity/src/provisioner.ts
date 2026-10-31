import type {
  CapabilitySecretResolver,
  HarnessCapabilityRecord,
  HarnessCapabilitySupport,
  HarnessProvisioner,
  HarnessProvisioningPlan,
  JsonObject,
} from "@polyth/contracts";
import {
  createLaunchOverlayStore,
  mcpNativeNameCollision,
  type LaunchOverlayStore,
} from "@polyth/harness-runtime";
import { renderCapabilityText } from "@polyth/harness-runtime/capability-text";

export interface AntigravityLaunchOverlay {
  mcpServers?: Record<string, JsonObject>;
  disabledMcpNames?: string[];
  prompt?: { text: string; capabilityIds: string[] };
  launchCapabilityIds: string[];
}

export const antigravityOverlays: LaunchOverlayStore<AntigravityLaunchOverlay> =
  createLaunchOverlayStore<AntigravityLaunchOverlay>();

const support = (harnessId: string): HarnessCapabilitySupport => ({
  harnessId,
  targetLifetime: "session",
  kinds: {
    instruction: { modes: ["prompt"], mutability: "immediate", configScope: "session" },
    "mcp-server": { modes: ["config"], mutability: "session-create", remote: false, configScope: "session" },
    tool: { modes: ["mcp"], mutability: "session-create", remote: false, configScope: "session" },
    skill: { modes: ["prompt"], mutability: "immediate", remote: false, configScope: "session" },
    context: { modes: ["prompt"], mutability: "immediate", remote: false, configScope: "session" },
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
  ...(status === "applied" || status === "unverifiable" ? { appliedRevision: item.capability.revision } : {}),
  ...(reason ? { reason } : {}),
});

/** `harnessId` is `antigravity` or one of its account harnesses. */
export function createAntigravityProvisioner(harnessId = "antigravity"): HarnessProvisioner {
  return {
    support: () => support(harnessId),
    async apply(context, plan, secrets: CapabilitySecretResolver) {
      if (context.remote) {
        return {
          harnessId,
          desiredRevision: plan.desiredRevision,
          records: plan.items.map((item) => record(item, "unsupported", "Antigravity adapter is local-only")),
        };
      }
      const overlay: AntigravityLaunchOverlay = {
        mcpServers: {},
        disabledMcpNames: [],
        launchCapabilityIds: [],
      };
      const records: HarnessCapabilityRecord[] = [];

      for (const item of plan.items) {
        if (item.capability.kind === "instruction"
          || item.capability.kind === "skill"
          || item.capability.kind === "context") {
          if (item.mode === "unsupported") {
            records.push(record(item, "unsupported", "Antigravity does not support this prompt scope"));
          } else {
            records.push(record(item, "pending", "Staged for Antigravity prompt projection"));
          }
        } else if (item.capability.kind === "mcp-server") {
          const collision = mcpNativeNameCollision(plan.items, item.capability.id);
          if (collision) {
            records.push(record(item, "failed", collision));
            continue;
          }
          if (item.mode === "unsupported") {
            records.push(record(item, "unsupported", "Antigravity does not support this capability"));
            continue;
          }
          if (!item.capability.enabled) {
            overlay.disabledMcpNames!.push(item.capability.name);
            records.push(record(item, "pending", "Staged MCP removal for the next private Antigravity home"));
            continue;
          }
          const values = secrets.mcpSecrets(item.capability.id);
          const serverConfig: JsonObject = item.capability.transport.kind === "stdio"
            ? {
              command: item.capability.transport.command,
              args: item.capability.transport.args,
              env: Object.fromEntries(item.capability.transport.envKeys.map((key) => [key, values[key] ?? ""])),
              disabled: false,
            }
            : {
              serverUrl: item.capability.transport.url,
              headers: Object.fromEntries(item.capability.transport.headersSecretRefs.map((key) => [key, values[key] ?? ""])),
              disabled: false,
            };
          overlay.mcpServers![item.capability.name] = serverConfig;
          records.push(record(item, "pending", "Staged as a private Antigravity MCP plugin"));
        } else if (item.capability.kind === "tool") {
          const collision = mcpNativeNameCollision(plan.items, item.capability.id);
          if (collision) {
            records.push(record(item, "failed", collision));
            continue;
          }
          if (item.mode === "unsupported") {
            records.push(record(item, "unsupported", "Antigravity does not support this tool scope"));
          } else {
            records.push(record(item, "pending", "Presented through the scoped Polyth MCP capability bridge"));
          }
        } else {
          records.push(record(item, "unsupported", "Antigravity has no portable projection for this capability"));
        }
      }

      if (Object.keys(overlay.mcpServers!).length === 0) {
        delete overlay.mcpServers;
      }
      const promptCapabilityIds = records
        .filter((item) => item.status === "pending"
          && (item.kind === "instruction" || item.kind === "skill" || item.kind === "context"))
        .map((item) => item.capabilityId);
      const promptText = promptCapabilityIds.length ? renderCapabilityText(plan) : undefined;
      if (promptText?.trim()) {
        overlay.prompt = { text: promptText, capabilityIds: promptCapabilityIds };
      }
      overlay.launchCapabilityIds = records
        .filter((item) => item.status === "pending" && item.kind !== "instruction" && item.kind !== "context")
        .map((item) => item.capabilityId);
      const pendingIds = records.filter((item) => item.status === "pending").map((item) => item.capabilityId);
      if (pendingIds.length) {
        antigravityOverlays.set(context, overlay, harnessId, {
          desiredRevision: plan.desiredRevision,
          capabilityIds: pendingIds,
        });
      } else {
        antigravityOverlays.delete(context, harnessId);
      }
      return { harnessId, desiredRevision: plan.desiredRevision, records };
    },
    release(context) {
      antigravityOverlays.release(context);
    },
  };
}
