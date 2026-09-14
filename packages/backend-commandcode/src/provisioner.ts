import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type {
  CapabilitySecretResolver,
  HarnessCapabilityRecord,
  HarnessCapabilitySupport,
  HarnessContext,
  HarnessProvisioner,
  HarnessProvisioningPlan,
} from "@polyth/contracts";
import { createLaunchOverlayStore, type LaunchOverlayStore } from "@polyth/harness-runtime";
import { renderCapabilityText } from "@polyth/harness-runtime/capability-text";
import { atomicWriteSync } from "@polyth/plugins";

export interface CommandCodeLaunchOverlay {
  promptModFile?: string;
  promptCapabilityIds: string[];
  skillRoot?: string;
  skillCapabilityIds: string[];
}

export const commandCodeOverlays: LaunchOverlayStore<CommandCodeLaunchOverlay> =
  createLaunchOverlayStore<CommandCodeLaunchOverlay>();

const support = (_context: HarnessContext): HarnessCapabilitySupport => ({
  harnessId: "commandcode",
  targetLifetime: "session",
  kinds: {
    // Command Code starts a fresh headless process for every Polyth turn. The
    // next admission can therefore pick up a newer transient Mod immediately.
    instruction: { modes: ["prompt"], mutability: "immediate", configScope: "session" },
    context: { modes: ["prompt"], mutability: "immediate", remote: false, configScope: "session" },
    // The documented CLI accepts repeatable, session-local --skill roots.
    skill: { modes: ["native"], mutability: "immediate", remote: false, configScope: "session" },
    // Native MCP management is persistent user/project/local configuration.
    // Until Command Code exposes a documented transient MCP projection, Polyth
    // must not rewrite vendor configuration to emulate one.
    "mcp-server": { modes: ["unsupported"], mutability: "immutable" },
    tool: { modes: ["unsupported"], mutability: "immutable" },
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

const revisionToken = (revision: string): string =>
  createHash("sha256").update(revision).digest("hex").slice(0, 24);

const targetKey = (context: HarnessContext): string =>
  createHash("sha256").update(JSON.stringify([
    context.projectId,
    resolve(context.cwd),
    context.sessionId ?? "",
  ])).digest("hex").slice(0, 24);

const privateDirectory = (spaceRoot: string, ...parts: string[]): string => {
  let current = resolve(spaceRoot);
  const rootStat = lstatSync(current);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Space storage root is not a private directory");
  }
  for (const part of parts) {
    current = join(current, part);
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("Command Code capability storage contains a non-directory component");
      }
    } else {
      mkdirSync(current, { mode: 0o700 });
    }
  }
  return current;
};

const existingPrivateDirectory = (spaceRoot: string, ...parts: string[]): string | undefined => {
  let current = resolve(spaceRoot);
  const rootStat = lstatSync(current);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Space storage root is not a private directory");
  }
  for (const part of parts) {
    current = join(current, part);
    if (!existsSync(current)) return undefined;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Command Code capability storage contains a non-directory component");
    }
  }
  return current;
};

const writeRevisionFile = (path: string, body: string): void => {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("Command Code capability file is not private");
    }
    if (readFileSync(path, "utf8") !== body) {
      throw new Error("Command Code capability revision is immutable");
    }
    return;
  }
  atomicWriteSync(path, body, 0o600);
};

const promptModDocument = (promptFile: string): string => [
  'import { readFile } from "node:fs/promises";',
  "",
  "export default async function polythCapabilityPrompt(cmd) {",
  `  const prompt = await readFile(${JSON.stringify(promptFile)}, "utf8");`,
  "  if (!prompt.trim()) return;",
  "  cmd.hooks({ appendSystemPrompt: () => prompt });",
  "}",
  "",
].join("\n");

const skillDocument = (
  skill: Extract<HarnessProvisioningPlan["items"][number]["capability"], { kind: "skill" }>,
): string => `---
name: ${JSON.stringify(skill.name)}
description: ${JSON.stringify(skill.description.replace(/[\r\n]+/g, " "))}
---
${skill.instructions}
`;

const pruneRetiredRevisions = (context: HarnessContext, keep: readonly string[]): void => {
  if (!context.space || context.space.spaceId !== context.spaceId) return;
  const revisions = existingPrivateDirectory(
    context.space.storageDir,
    "runtime",
    "commandcode",
    "capabilities",
    targetKey(context),
    "revisions",
  );
  if (!revisions) return;
  const live = new Set(keep.map(revisionToken));
  for (const entry of readdirSync(revisions, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || live.has(entry.name)) continue;
    rmSync(join(revisions, entry.name), { recursive: true, force: true });
  }
};

export function createCommandCodeProvisioner(): HarnessProvisioner {
  return {
    support: (context) => support(context),
    async apply(context, plan, _secrets: CapabilitySecretResolver) {
      if (context.remote) {
        return {
          harnessId: "commandcode",
          desiredRevision: plan.desiredRevision,
          records: plan.items.map((item) => record(item, "unsupported", "Command Code adapter is local-only")),
        };
      }
      if (!context.space || context.space.spaceId !== context.spaceId) {
        return {
          harnessId: "commandcode",
          desiredRevision: plan.desiredRevision,
          records: plan.items.map((item) => record(item, "failed", "Local Space storage is required")),
        };
      }

      const revisionRoot = privateDirectory(
        context.space.storageDir,
        "runtime",
        "commandcode",
        "capabilities",
        targetKey(context),
        "revisions",
        revisionToken(plan.desiredRevision),
      );
      const overlay: CommandCodeLaunchOverlay = {
        promptCapabilityIds: [],
        skillCapabilityIds: [],
      };
      const records: HarnessCapabilityRecord[] = [];

      const promptItems = plan.items.filter((item) =>
        item.mode !== "unsupported"
        && (item.capability.kind === "instruction" || item.capability.kind === "context"));
      if (promptItems.length) {
        try {
          const prompt = renderCapabilityText(plan);
          if (!prompt.trim()) throw new Error("Command Code prompt projection is empty");
          const promptFile = join(revisionRoot, "system-prompt.txt");
          writeRevisionFile(promptFile, prompt);
          const promptModFile = join(revisionRoot, "polyth-capabilities.ts");
          writeRevisionFile(promptModFile, promptModDocument(promptFile));
          overlay.promptModFile = promptModFile;
          overlay.promptCapabilityIds = promptItems.map((item) => item.capability.id);
          for (const item of promptItems) {
            records.push(record(item, "pending", "Staged for transient Command Code appendSystemPrompt projection"));
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Could not stage Command Code prompt projection";
          for (const item of promptItems) records.push(record(item, "failed", reason));
        }
      }

      const skillItems = plan.items.filter((item) => item.capability.kind === "skill");
      const duplicateSkillNames = new Set(skillItems.flatMap((item, index) => {
        if (item.capability.kind !== "skill") return [];
        const name = item.capability.name;
        return skillItems.some((candidate, candidateIndex) =>
          candidateIndex !== index
          && candidate.capability.kind === "skill"
          && candidate.capability.name === name)
          ? [name]
          : [];
      }));
      let skillRoot: string | undefined;
      for (const item of skillItems) {
        if (item.capability.kind !== "skill") continue;
        if (item.mode === "unsupported") {
          records.push(record(item, "unsupported", "Command Code does not support this skill scope"));
          continue;
        }
        if (duplicateSkillNames.has(item.capability.name)) {
          records.push(record(item, "failed", `Native Command Code skill name collision: ${item.capability.name}`));
          continue;
        }
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.capability.name) || item.capability.name.length > 64) {
          records.push(record(item, "failed", "Native Command Code skill name is invalid"));
          continue;
        }
        try {
          skillRoot ??= privateDirectory(revisionRoot, "skills");
          const directory = privateDirectory(skillRoot, item.capability.name);
          writeRevisionFile(join(directory, "SKILL.md"), skillDocument(item.capability));
          overlay.skillCapabilityIds.push(item.capability.id);
          records.push(record(item, "pending", "Staged for documented Command Code --skill projection"));
        } catch {
          records.push(record(item, "failed", "Could not stage the private native Command Code skill"));
        }
      }
      if (skillRoot && overlay.skillCapabilityIds.length) overlay.skillRoot = skillRoot;

      const preRecorded = new Set(records.map((item) => item.capabilityId));
      for (const item of plan.items) {
        if (preRecorded.has(item.capability.id)) continue;
        if (item.mode === "unsupported" || item.capability.kind === "mcp-server" || item.capability.kind === "tool") {
          const reason = item.capability.kind === "mcp-server"
            ? "Command Code has no verified non-persistent MCP projection; Polyth will not mutate vendor MCP files"
            : item.capability.kind === "tool"
              ? "Polyth tools require a verified transient Command Code tool bridge"
              : "Command Code has no verified transient projection for this capability";
          records.push(record(item, "unsupported", reason));
        } else {
          records.push(record(item, "unsupported", "Command Code has no verified transient projection for this capability"));
        }
      }

      const pendingIds = records.filter((item) => item.status === "pending").map((item) => item.capabilityId);
      if (pendingIds.length) {
        commandCodeOverlays.set(context, overlay, "commandcode", {
          desiredRevision: plan.desiredRevision,
          capabilityIds: pendingIds,
        });
      } else {
        commandCodeOverlays.delete(context, "commandcode");
      }
      pruneRetiredRevisions(context, [...(plan.keepRevisions ?? []), plan.desiredRevision]);
      return { harnessId: "commandcode", desiredRevision: plan.desiredRevision, records };
    },
    release(context, options) {
      commandCodeOverlays.release(context);
      pruneRetiredRevisions(context, options?.keepRevisions ?? []);
      if (!context.space || context.space.spaceId !== context.spaceId || (options?.keepRevisions?.length ?? 0) > 0) return;
      const root = existingPrivateDirectory(
        context.space.storageDir,
        "runtime",
        "commandcode",
        "capabilities",
        targetKey(context),
      );
      if (root) rmSync(root, { recursive: true, force: true });
    },
  };
}
