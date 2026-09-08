import type {
  CapabilitySecretResolver,
  HarnessCapabilityRecord,
  HarnessCapabilitySupport,
  HarnessContext,
  HarnessProvisioner,
  HarnessProvisioningPlan,
} from "@polyth/contracts";
import { mcpNativeNameCollision, createLaunchOverlayStore, type LaunchOverlayStore } from "@polyth/harness-runtime";

export interface ClaudeLaunchOverlay {
  append?: string;
  mcpServers?: Record<string, {
    command: string;
    args?: string[];
    env?: Record<string, string>;
  } | {
    type: "http";
    url: string;
    headers?: Record<string, string>;
  }>;
}

export const claudeOverlays: LaunchOverlayStore<ClaudeLaunchOverlay> = createLaunchOverlayStore<ClaudeLaunchOverlay>();

const support = (_context: HarnessContext): HarnessCapabilitySupport => ({
  harnessId: "claude",
  targetLifetime: "session",
  kinds: {
    instruction: { modes: ["native"], mutability: "session-create", configScope: "session" },
    "mcp-server": { modes: ["native"], mutability: "session-create", remote: false, configScope: "session" },
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

const staged = (plan: HarnessProvisioningPlan): HarnessCapabilityRecord[] =>
  plan.items.map((item) => {
    const collision = mcpNativeNameCollision(plan.items, item.capability.id);
    if (collision) return record(item, "failed", collision);
    if (item.mode === "unsupported") {
      if (item.capability.kind === "skill") {
        return record(item, "unsupported", "Claude Agent SDK supports skills, but Polyth does not yet provide a safe private portable skill-source projection for this adapter");
      }
      return record(item, "unsupported", "Claude Agent SDK has no verified projection");
    }
    return record(item, "pending", "Staged for the next Claude native session");
  });

export function createClaudeProvisioner(): HarnessProvisioner {
  return {
    support: (context) => support(context),
    async apply(context, plan, secrets: CapabilitySecretResolver) {
      if (context.remote) {
        return {
          harnessId: "claude",
          desiredRevision: plan.desiredRevision,
          records: plan.items.map((item) => record(item, "unsupported", "Claude adapter is local-only")),
        };
      }
      const overlay: ClaudeLaunchOverlay = {};
      const instructions = plan.items.filter((item) => item.capability.kind === "instruction" && item.mode !== "unsupported");
      if (instructions.length) {
        overlay.append = instructions
          .map((item) => item.capability.kind === "instruction" ? item.capability.text : "")
          .join("\n\n");
      }
      overlay.mcpServers = {};
      for (const item of plan.items) {
        if (item.capability.kind !== "mcp-server" || item.mode === "unsupported" || !item.capability.enabled) continue;
        if (mcpNativeNameCollision(plan.items, item.capability.id)) continue;
        const values = secrets.mcpSecrets(item.capability.id);
        if (item.capability.transport.kind === "stdio") {
          overlay.mcpServers[item.capability.name] = {
            command: item.capability.transport.command,
            args: item.capability.transport.args,
            env: Object.fromEntries(item.capability.transport.envKeys.map((key) => [key, values[key] ?? ""])),
          };
        } else {
          overlay.mcpServers[item.capability.name] = {
            type: "http",
            url: item.capability.transport.url,
            headers: Object.fromEntries(item.capability.transport.headersSecretRefs.map((key) => [key, values[key] ?? ""])),
          };
        }
      }
      if (Object.keys(overlay.mcpServers).length === 0) delete overlay.mcpServers;
      claudeOverlays.set(context, overlay, "claude", {
        desiredRevision: plan.desiredRevision,
        capabilityIds: plan.items.filter((item) => item.mode !== "unsupported" && !mcpNativeNameCollision(plan.items, item.capability.id)).map((item) => item.capability.id),
      });
      return {
        harnessId: "claude",
        desiredRevision: plan.desiredRevision,
        records: staged(plan),
      };
    },
    release(context) {
      claudeOverlays.release(context);
    },
  };
}
