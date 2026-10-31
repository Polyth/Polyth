// Global behavior instructions. The server owns the canonical revisioned
// copy under its data directory. Harness projectors consume the decorated
// effective text; a failed target must not roll the canonical file back.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWrite, type ServerBehaviorSectionRegistry } from "@polyth/plugins";

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
  /** Decorated model-visible text: the editable text, server-owned sections
   *  (credential boundary, package rules), the privacy default and, unless
   *  turned off, favorite-subagent routing. */
  effectiveText(): Promise<string>;
}

const MAX_BYTES = 256 * 1024;

export const behaviorRevision = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);

export const favoriteSubagentRoutingSection = `## Favorite delegated-agent routing (mandatory)

Before delegating work, evaluate the task and explicitly choose the best-fit model/harness from the user's favorites: call the Polyth control tool with action agent.models once for a ranked shortlist of favorite and most-used harness/model pairs with live quota headroom, skip BLOCKED or UNAVAILABLE rows, and pass the chosen harnessId and model to agent.spawn. Delegation itself must use the Polyth control tool with action agent.spawn so the worker is a canonical child session; never use a harness-native Agent, Task, task, invoke_subagent, or equivalent spawn surface. Never create a delegated child that merely inherits the parent or default model. If no suitable favorite is available, do the work directly. If the chosen child stalls, errors, or returns unusable work, create a different canonical child with another favorite; do not repeatedly retry the same failed choice.`;

/** Server-owned default for every agent in every harness, Polyth Agents
 *  included: the person's identity stays private unless they directly allow
 *  one disclosure. Always part of the effective text; neither the editable
 *  text nor the subagent policy can remove it. */
export const privacyBehaviorSection = `## Privacy by default (mandatory)

Protect the user's privacy and anonymity. Without their direct permission for that specific disclosure, never put their email addresses, real name, usernames or account IDs, phone number, location, or device, host and network details (including home-directory paths that contain their name) into anything that leaves this machine or could later be published: commits and their author, co-author and sign-off lines, pull requests, issues, comments, package and licence metadata, web forms, search queries, posts, messages, and logs, screenshots or files you share. Never do anything that identifies them or links a pseudonymous identity to who they are. Do not fill such details in yourself from a harness account field or a global config; use the project's configured identity or a neutral placeholder, and redact them from what you share. Permission covers only the item and place the user named. Normal local work with their data is unaffected. If a task seems to need such a detail, leave it out and ask.`;

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
    const sections = [(opts.decorate?.(text) ?? text).trimEnd(), privacyBehaviorSection];
    if ((await readPolicy()).enabled) sections.push(favoriteSubagentRoutingSection);
    return `${sections.filter(Boolean).join("\n\n")}\n`;
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

/** Host side of `SERVER_BEHAVIOR_SECTIONS`: package sections in id order. A
 *  throwing section drops only itself, never the global behavior text. */
export function createBehaviorSectionRegistry(): {
  registry(changed: () => Promise<void>): ServerBehaviorSectionRegistry;
  sections(): string[];
} {
  const sections = new Map<string, () => string>();
  return {
    registry: (changed) => ({
      register(id, section) {
        if (sections.has(id)) {
          throw Object.assign(new Error(`behavior section already registered: ${id}`), { code: "conflict" });
        }
        sections.set(id, section);
        return {
          dispose: () => {
            if (sections.get(id) === section) sections.delete(id);
          },
        };
      },
      changed,
    }),
    sections: () => [...sections.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([id, section]) => {
        try {
          const text = section().trim();
          return text ? [text] : [];
        } catch (error) {
          console.error(`[polyth] behavior section failed: ${id}`, error);
          return [];
        }
      }),
  };
}
