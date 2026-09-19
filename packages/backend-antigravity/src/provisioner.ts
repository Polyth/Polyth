import type {
  CapabilitySecretResolver,
  HarnessCapabilityRecord,
  HarnessCapabilitySupport,
  HarnessContext,
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
  promptText?: string;
  capabilityIds: string[];
}

export const antigravityOverlays: LaunchOverlayStore<AntigravityLaunchOverlay> =
  createLaunchOverlayStore<AntigravityLaunchOverlay>();

const support = (_context: HarnessContext): HarnessCapabilitySupport => ({
  harnessId: "antigravity",
  targetLifetime: "session",
  kinds: {
    instruction: { modes: ["prompt"], mutability: "immediate", configScope: "session" },
    "mcp-server": { modes: ["config"], mutability: "session-create", remote: false, configScope: "session" },
    tool: { modes: ["mcp"], mutability: "session-create", remote: false, configScope: "session" },
    skill: { modes: ["unsupported"], mutability: "immutable" },
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

export function createAntigravityProvisioner(): HarnessProvisioner {
  return {
    support: (context) => support(context),
    async apply(context, plan, secrets: CapabilitySecretResolver) {
      if (context.remote) {
        return {
          harnessId: "antigravity",
          desiredRevision: plan.desiredRevision,
          records: plan.items.map((item) => record(item, "unsupported", "Antigravity adapter is local-only")),
        };
      }
      const overlay: AntigravityLaunchOverlay = {
        mcpServers: {},
        capabilityIds: [],
      };
      const records: HarnessCapabilityRecord[] = [];

      for (const item of plan.items) {
        if (item.capability.kind === "instruction" || item.capability.kind === "context") {
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
            records.push(record(item, "applied", "Retired from Polyth desired state"));
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
      const promptText = renderCapabilityText(plan);
      if (promptText) {
        overlay.promptText = promptText;
      }
      const pendingIds = records.filter((r) => r.status === "pending").map((r) => r.capabilityId);
      overlay.capabilityIds = pendingIds;
      antigravityOverlays.set(context, overlay, "antigravity", {
        desiredRevision: plan.desiredRevision,
        capabilityIds: pendingIds,
      });
      return { harnessId: "antigravity", desiredRevision: plan.desiredRevision, records };
    },
    release(context) {
      antigravityOverlays.release(context);
    },
  };
}
