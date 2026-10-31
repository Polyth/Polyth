import type {
  AgentCapabilityContribution,
  JsonObject,
  SecureSafeEntryDto,
  SecureSafePartition,
  SecureSafeService,
  ToolExecutionContext,
} from "@polyth/contracts";
import { secureSafeEnvRef } from "./index.ts";

/** List only the metadata visible to the active Space/project: the acting
 *  person's own entries (which resolve first) and the Space's. */
export function createCredentialVaultListAgentTool(
  resolveVault: (spaceId: string) => SecureSafeService | undefined,
  resolvePersonal: (spaceId: string, userId: string) => SecureSafeService | undefined = () => undefined,
): AgentCapabilityContribution {
  return {
    descriptor: {
      id: "secure-safe.credential-vault-list",
      kind: "tool",
      owner: "secure-safe",
      scope: "project",
      revision: "2",
      name: "polyth_credential_vault_list",
      description: "When the current task needs a stored credential or handle, list saved Credential Vault entries available to the current Space and project: the acting person's own (`partition: personal`, used first) and the Space's. Returns metadata only, never credential values.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      trust: "pure",
      mutating: false,
    },
    async execute(_input: JsonObject, context: ToolExecutionContext) {
      if (!context.spaceId) {
        throw Object.assign(new Error("An active Polyth Space is required for Credential Vault access"), {
          code: "invalid-input",
        });
      }
      const vault = resolveVault(context.spaceId);
      if (!vault) {
        throw Object.assign(new Error("Credential Vault is unavailable for the active Space"), {
          code: "unavailable",
        });
      }
      // Only the acting person's own partition; system work has no person.
      const personal = context.actorUserId ? resolvePersonal(context.spaceId, context.actorUserId) : undefined;
      const visible = (entry: SecureSafeEntryDto) => entry.scope === "global" || entry.projectId === context.projectId;
      const row = (entry: SecureSafeEntryDto, partition: SecureSafePartition) => ({
        handle: entry.handle,
        label: entry.label,
        purpose: entry.purpose,
        kind: entry.kind,
        scope: entry.scope,
        partition,
        envRef: secureSafeEnvRef(entry.handle),
      });
      const own = (personal?.list() ?? []).filter(visible).map((entry) => row(entry, "personal"));
      const shadowed = new Set(own.map((entry) => entry.envRef));
      // A Space handle the person's own entry shadows would never resolve.
      const handles = [
        ...own,
        ...vault.list().filter(visible).map((entry) => row(entry, "space"))
          .filter((entry) => !shadowed.has(entry.envRef)),
      ];
      return {
        output: JSON.stringify({ handles }),
        metadata: { count: handles.length },
      };
    },
  };
}
