// Global behavior instructions (WP9). The server owns the canonical revisioned
// copy under its data directory. Harness projectors consume the decorated
// effective text; a failed target must not roll the canonical file back.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWrite } from "@polyth/plugins";

export interface BehaviorState {
  text: string;
  revision: string;
  pathLabel: string;
}

export interface WorkspaceInstructionsPolicy {
  enabled: boolean;
}

export interface BehaviorService {
  get(): Promise<BehaviorState>;
  put(text: string, expectedRevision: string): Promise<BehaviorState>;
  subagentPolicy(): Promise<{ enabled: boolean }>;
  putSubagentPolicy(enabled: boolean): Promise<{ enabled: boolean }>;
  /** Whether workspace-root AGENTS.md is included in fresh runtime-leg prompts. */
  workspaceInstructionsPolicy(): Promise<WorkspaceInstructionsPolicy>;
  putWorkspaceInstructionsPolicy(enabled: boolean): Promise<WorkspaceInstructionsPolicy>;
  refresh(): Promise<void>;
  /** Current revision+digest for the model-visible instructions-applied event. */
  current(): Promise<{ revision: string; digest: string } | null>;
  /** Decorated model-visible text (favorites + Secure Safe). */
  effectiveText(): Promise<string>;
}

const MAX_BYTES = 256 * 1024;

export const behaviorRevision = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);

export const favoriteSubagentRoutingSection = `## Favorite subagent routing (mandatory)

Before delegating work, evaluate the task and explicitly choose the best-fit agent from the user's favorites. Never spawn a subagent that merely inherits the parent or default model. If no suitable favorite is available, do the work directly. If the chosen agent stalls, errors, or returns unusable work, switch to a different favorite; do not repeatedly retry the same failed choice.`;

export function createBehaviorService(opts: {
  file: string;
  policyFile?: string;
  /** Fired after canonical persistence. Projector failure must not roll the file back. */
  onChanged?: () => Promise<void>;
  /** Server-owned instructions appended at apply/digest time but not exposed
   *  as editable behavior text. */
  decorate?(text: string): string;
}): BehaviorService {
  mkdirSync(dirname(opts.file), { recursive: true });

  const readText = async (): Promise<string> => {
    try {
      return await readFile(opts.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    }
  };

  const pathLabel = "global behavior";
  const readPolicy = async (): Promise<{ enabled: boolean; workspaceInstructionsEnabled: boolean }> => {
    if (!opts.policyFile) return { enabled: false, workspaceInstructionsEnabled: false };
    try {
      const value = JSON.parse(await readFile(opts.policyFile, "utf8")) as {
        enabled?: unknown;
        workspaceInstructionsEnabled?: unknown;
      };
      return {
        enabled: value.enabled !== false,
        // This setting was added after the original policy file. Preserve the
        // safe default for existing files that do not carry it.
        workspaceInstructionsEnabled: value.workspaceInstructionsEnabled === true,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { enabled: true, workspaceInstructionsEnabled: false };
      }
      throw err;
    }
  };
  const writePolicy = async (policy: { enabled: boolean; workspaceInstructionsEnabled: boolean }): Promise<void> => {
    if (!opts.policyFile) return;
    await atomicWrite(opts.policyFile, `${JSON.stringify(policy, null, 2)}\n`);
  };
  const effective = async (text: string): Promise<string> => {
    const decorated = opts.decorate?.(text) ?? text;
    if (!(await readPolicy()).enabled) return decorated;
    const base = decorated.trimEnd();
    return `${base}${base ? "\n\n" : ""}${favoriteSubagentRoutingSection}\n`;
  };
  const apply = async (): Promise<void> => {
    try {
      await opts.onChanged?.();
    } catch {
      // Canonical desired state is not hostage to a projector.
    }
  };

  return {
    async get(): Promise<BehaviorState> {
      const text = await readText();
      return { text, revision: behaviorRevision(text), pathLabel };
    },

    async put(text: string, expectedRevision: string): Promise<BehaviorState> {
      if (typeof text !== "string") {
        throw Object.assign(new Error("behavior text must be a string"), { code: "invalid-input" });
      }
      if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
        throw Object.assign(new Error("behavior text exceeds 256 KiB"), { code: "invalid-input" });
      }
      const before = await readText();
      const currentRev = behaviorRevision(before);
      if (expectedRevision !== currentRev) {
        throw Object.assign(new Error("behavior text changed since you loaded it"), { code: "conflict" });
      }
      await atomicWrite(opts.file, text);
      await apply();
      return { text, revision: behaviorRevision(text), pathLabel };
    },

    subagentPolicy: async () => ({ enabled: (await readPolicy()).enabled }),

    async putSubagentPolicy(enabled: boolean): Promise<{ enabled: boolean }> {
      const current = await readPolicy();
      const next = { enabled, workspaceInstructionsEnabled: current.workspaceInstructionsEnabled };
      await writePolicy(next);
      await apply();
      return { enabled };
    },

    workspaceInstructionsPolicy: async () => ({
      enabled: (await readPolicy()).workspaceInstructionsEnabled,
    }),

    async putWorkspaceInstructionsPolicy(enabled: boolean): Promise<WorkspaceInstructionsPolicy> {
      const current = await readPolicy();
      const next = { enabled: current.enabled, workspaceInstructionsEnabled: enabled };
      await writePolicy(next);
      // This setting is consumed at session admission; changing it does not
      // require reprovisioning any already-running harness.
      return { enabled };
    },

    refresh: apply,
    effectiveText: async () => effective(await readText()),

    async current(): Promise<{ revision: string; digest: string } | null> {
      const text = await effective(await readText());
      if (!text.trim()) return null;
      const digest = createHash("sha256").update(text, "utf8").digest("hex");
      return { revision: digest.slice(0, 12), digest };
    },
  };
}
