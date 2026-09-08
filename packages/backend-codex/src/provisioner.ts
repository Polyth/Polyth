import type {
  CapabilitySecretResolver,
  HarnessCapabilityRecord,
  HarnessCapabilitySupport,
  HarnessContext,
  HarnessProvisioner,
  HarnessProvisioningPlan,
} from "@polyth/contracts";
import { createLaunchOverlayStore, mcpNativeNameCollision, type LaunchOverlayStore } from "@polyth/harness-runtime";

export interface CodexLaunchOverlay {
  developerInstructions?: string;
  mcpServers?: Record<string, Record<string, unknown>>;
}

export const codexOverlays: LaunchOverlayStore<CodexLaunchOverlay> = createLaunchOverlayStore<CodexLaunchOverlay>();

const support = (_context: HarnessContext): HarnessCapabilitySupport => ({
  harnessId: "codex",
  targetLifetime: "session",
  kinds: {
    instruction: { modes: ["config"], mutability: "session-create", configScope: "session" },
    "mcp-server": { modes: ["config"], mutability: "session-create", remote: false, configScope: "session" },
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

export function createCodexProvisioner(): HarnessProvisioner {
  return {
    support: (context) => support(context),
    async apply(context, plan, secrets: CapabilitySecretResolver) {
      if (context.remote) {
        return {
          harnessId: "codex",
          desiredRevision: plan.desiredRevision,
          records: plan.items.map((item) => record(item, "unsupported", "Codex adapter is local-only")),
        };
      }
      const overlay: CodexLaunchOverlay = {};
      const instructions = plan.items.filter((item) => item.capability.kind === "instruction" && item.mode !== "unsupported");
      if (instructions.length) {
        overlay.developerInstructions = instructions
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
            url: item.capability.transport.url,
            http_headers: Object.fromEntries(item.capability.transport.headersSecretRefs.map((key) => [key, values[key] ?? ""])),
          };
        }
      }
      if (Object.keys(overlay.mcpServers).length === 0) delete overlay.mcpServers;
      codexOverlays.set(context, overlay, "codex", {
        desiredRevision: plan.desiredRevision,
        capabilityIds: plan.items
          .filter((item) => item.mode !== "unsupported" && !mcpNativeNameCollision(plan.items, item.capability.id))
          .map((item) => item.capability.id),
      });
      return {
        harnessId: "codex",
        desiredRevision: plan.desiredRevision,
        records: plan.items.map((item) => {
          const collision = mcpNativeNameCollision(plan.items, item.capability.id);
          if (collision) return record(item, "failed", collision);
          if (item.mode === "unsupported") {
            return record(item, "unsupported", "Codex has no verified projection for this capability");
          }
          return record(item, "pending", item.capability.kind === "instruction"
            ? "Staged for the next Codex thread/start"
            : "Staged for the next Codex thread/start");
        }),
      };
    },
    release(context) {
      codexOverlays.release(context);
    },
  };
}
