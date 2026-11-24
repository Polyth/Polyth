import type {
  AgentCapabilityContribution,
  JsonObject,
  SecureSafeEntryDto,
  SecureSafePartition,
  SecureSafeService,
  ToolExecutionContext,
} from "@polyth/contracts";
import {
  extractSecureSafeEnvRefs,
  secureSafeEnvRef,
  VAULT_RUN_TOOL_ID,
  type VaultRunService,
} from "./index.ts";

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

const runText = (value: unknown, field: string, max: number): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error(`${field} is required`), { code: "invalid-input" });
  }
  const text = value.trim();
  if (text.length > max) {
    throw Object.assign(new Error(`${field} must be at most ${max} characters`), { code: "invalid-input" });
  }
  return text;
};

/** Run one bounded local command with Credential Vault refs resolved for the
 *  session's person. Each key's Vault approval level decides whether a call
 *  needs that person's card; the agent gets only
 *  the redacted output, exit status and flags, never a value or the env. */
export function createCredentialVaultRunAgentTool(
  resolveRunner: () => VaultRunService | undefined,
): AgentCapabilityContribution {
  return {
    descriptor: {
      id: VAULT_RUN_TOOL_ID,
      kind: "tool",
      owner: "secure-safe",
      scope: "project",
      revision: "1",
      name: "polyth_credential_vault_run",
      description: "Run one bounded local command with stored Credential Vault secrets resolved by the server. The command must reference a POLYTH_SAFE_* env ref. Whether a call asks the person depends on the level they gave each key in the Vault (fully safe, safe under Auto-Approve, Full access only, or always ask); the strictest key wins. Only the redacted output, exit code and timeout/truncation flags come back to you; you never receive the value or the environment.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["command", "purpose"],
        properties: {
          command: {
            type: "string",
            description: "Bounded local command (≤8000 chars) that contains at least one POLYTH_SAFE_* Credential Vault env ref.",
          },
          purpose: { type: "string", description: "One line on what this run is for; shown on the approval card." },
          timeoutSeconds: {
            type: "integer",
            minimum: 10,
            maximum: 600,
            description: "Command timeout in seconds (default 120).",
          },
        },
      },
      // Credentialed and mutating: never auto-approved by trust alone.
      trust: "credentialed",
      mutating: true,
    },
    async execute(input: JsonObject, context: ToolExecutionContext) {
      const command = runText(input.command, "command", 8_000);
      if (command.includes("\0")) {
        throw Object.assign(new Error("command must not contain NUL"), { code: "invalid-input" });
      }
      const purpose = runText(input.purpose, "purpose", 200);
      const timeoutSeconds = input.timeoutSeconds === undefined ? 120 : input.timeoutSeconds;
      if (typeof timeoutSeconds !== "number" || !Number.isInteger(timeoutSeconds)
        || timeoutSeconds < 10 || timeoutSeconds > 600) {
        throw Object.assign(new Error("timeoutSeconds must be an integer between 10 and 600"), { code: "invalid-input" });
      }
      if (extractSecureSafeEnvRefs(command).length === 0) {
        throw Object.assign(new Error("no Vault env refs; run it in your own shell"), { code: "invalid-input" });
      }
      if (!context.sessionId) {
        throw Object.assign(new Error("A canonical Polyth session is required for a Credential Vault run"), {
          code: "unavailable",
        });
      }
      const runner = resolveRunner();
      if (!runner) {
        throw Object.assign(new Error("The Credential Vault run boundary is unavailable for this call"), {
          code: "unavailable",
        });
      }
      const result = await runner.run({
        sessionId: context.sessionId,
        projectId: context.projectId,
        command,
        purpose,
        ...(context.actorUserId ? { actorUserId: context.actorUserId } : {}),
        timeoutMs: timeoutSeconds * 1_000,
      });
      return {
        output: JSON.stringify({
          output: result.output,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          truncated: result.truncated,
        }),
        metadata: {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          truncated: result.truncated,
        },
      };
    },
  };
}

const REQUEST_HANDLE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const requestText = (value: unknown, field: string, max: number, required: boolean): string | undefined => {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && !value.trim())) {
    throw Object.assign(new Error(`${field} is required`), { code: "invalid-input" });
  }
  const text = value.trim();
  if (text.length > max) {
    throw Object.assign(new Error(`${field} must be at most ${max} characters`), { code: "invalid-input" });
  }
  return text || undefined;
};

/** Ask the person for a credential through the protected Vault form. The
 *  call waits until they save or dismiss it; the value goes from the form to
 *  the server and never reaches the agent, its input or its output. */
export function createCredentialVaultRequestAgentTool(): AgentCapabilityContribution {
  return {
    descriptor: {
      id: "secure-safe.credential-vault-request",
      kind: "tool",
      owner: "secure-safe",
      scope: "project",
      revision: "1",
      name: "polyth_credential_vault_request",
      description: "When the current task needs a credential (API key, token, password) that polyth_credential_vault_list does not have, show the user Polyth's protected Credential Vault form and wait for them to save or dismiss it. You choose the handle, label, purpose and kind; the user types only the value, which is stored server-side and never returned to you. Returns the handle, its envRef and whether it was saved. Use this instead of asking the user to paste a secret or telling them to keep it to themselves.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["handle", "label"],
        properties: {
          handle: {
            type: "string",
            description: "Stable name for the credential: starts with a letter; letters, digits, '.', '_' or '-' (for example STRIPE_LIVE_KEY).",
          },
          label: { type: "string", description: "Short human name shown on the form, for example \"Stripe live key\"." },
          purpose: { type: "string", description: "One line on what it will be used for." },
          kind: { type: "string", enum: ["env", "token", "password"], description: "env (default), token or password." },
        },
      },
      // The call itself changes nothing: the person decides in the form, so
      // a separate approval card in front of it would only ask twice.
      trust: "pure",
      mutating: false,
    },
    async execute(input: JsonObject, context: ToolExecutionContext) {
      const handle = requestText(input.handle, "handle", 64, true)!;
      if (!REQUEST_HANDLE.test(handle)) {
        throw Object.assign(new Error("handle must start with a letter and contain only letters, numbers, '.', '_', or '-'"), {
          code: "invalid-input",
        });
      }
      const label = requestText(input.label, "label", 128, true)!;
      const purpose = requestText(input.purpose, "purpose", 500, false);
      const kind = input.kind;
      if (kind !== undefined && kind !== "env" && kind !== "token" && kind !== "password") {
        throw Object.assign(new Error("kind must be env, token, or password"), { code: "invalid-input" });
      }
      if (!context.requestSecret) {
        throw Object.assign(new Error("The Credential Vault form is unavailable for this call; tell the user, and do not collect the secret another way"), {
          code: "unavailable",
        });
      }
      const result = await context.requestSecret({
        handle,
        label,
        ...(purpose ? { purpose } : {}),
        ...(kind ? { kind } : {}),
      });
      const envRef = secureSafeEnvRef(result.handle ?? handle);
      const output = result.action === "saved"
        ? {
            status: "saved",
            handle: result.handle ?? handle,
            envRef,
            next: `Use $${envRef} with polyth_credential_vault_run (the person approves the card); for Browser sign-in use polyth_browser_fill_from_vault. You never receive the value.`,
          }
        : {
            status: "dismissed",
            handle,
            next: "The user did not store this credential. Say so; do not ask them to paste it in chat.",
          };
      return { output: JSON.stringify(output), metadata: { status: output.status } };
    },
  };
}
