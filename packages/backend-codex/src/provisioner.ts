import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import type {
  CapabilitySecretResolver,
  HarnessCapabilityRecord,
  HarnessCapabilitySupport,
  HarnessContext,
  HarnessProvisioner,
  HarnessProvisioningPlan,
} from "@polyth/contracts";
import { createLaunchOverlayStore, mcpNativeNameCollision, type LaunchOverlayStore } from "@polyth/harness-runtime";
import { renderCapabilityText } from "@polyth/harness-runtime/capability-text";
import { atomicWriteSync } from "@polyth/plugins";

export interface CodexNativeSkill {
  capabilityId: string;
  name: string;
  path: string;
}

export interface CodexNativeMcp {
  capabilityId: string;
  name: string;
  tools: Array<{ capabilityId: string; name: string }>;
}

export interface CodexLaunchOverlay {
  developerInstructions?: string;
  mcpServers?: Record<string, Record<string, unknown>>;
  nativeSkills?: {
    root: string;
    skills: CodexNativeSkill[];
  };
  nativeMcp?: CodexNativeMcp[];
  stagedCapabilityIds?: string[];
}

export const codexOverlays: LaunchOverlayStore<CodexLaunchOverlay> = createLaunchOverlayStore<CodexLaunchOverlay>();

const support = (_context: HarnessContext): HarnessCapabilitySupport => ({
  harnessId: "codex",
  targetLifetime: "session",
  kinds: {
    instruction: { modes: ["config"], mutability: "session-create", configScope: "session" },
    "mcp-server": { modes: ["config"], mutability: "session-create", remote: false, configScope: "session" },
    tool: { modes: ["mcp"], mutability: "session-create", remote: false, configScope: "session" },
    skill: { modes: ["native"], mutability: "session-create", remote: false, configScope: "session" },
    context: { modes: ["prompt"], mutability: "session-create", remote: false, configScope: "session" },
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

const targetRoot = (context: HarnessContext): string | undefined => {
  if (!context.space || context.space.spaceId !== context.spaceId) return undefined;
  return join(context.space.storageDir, "runtime", "codex", "capabilities", targetKey(context));
};

/** Every component below Space storage is adapter-derived. Reject a replaced
 * directory instead of following a symlink into another Space or user path. */
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
        throw new Error("Codex capability storage contains a non-directory component");
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
      throw new Error("Codex capability storage contains a non-directory component");
    }
  }
  return current;
};

const writeRevisionFile = (path: string, body: string): void => {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Codex capability file is not private");
    if (readFileSync(path, "utf8") !== body) throw new Error("Codex capability revision is immutable");
    return;
  }
  atomicWriteSync(path, body, 0o600);
};

const skillDocument = (
  skill: Extract<HarnessProvisioningPlan["items"][number]["capability"], { kind: "skill" }>,
): string =>
  `---
name: ${JSON.stringify(skill.name)}
description: ${JSON.stringify(skill.description)}
---
${skill.instructions}
`;

const pruneRetiredRevisions = (context: HarnessContext, keep: readonly string[]): void => {
  if (!context.space || context.space.spaceId !== context.spaceId) return;
  const revisions = existingPrivateDirectory(
    context.space.storageDir,
    "runtime",
    "codex",
    "capabilities",
    targetKey(context),
    "revisions",
  );
  if (!revisions) return;
  const live = new Set(keep.map(revisionToken));
  for (const entry of readdirSync(revisions, { withFileTypes: true })) {
    if (!entry.isDirectory() || live.has(entry.name)) continue;
    rmSync(join(revisions, entry.name), { recursive: true, force: true });
  }
};

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
      const instructions = renderCapabilityText(plan);
      if (instructions) overlay.developerInstructions = instructions;

      const records: HarnessCapabilityRecord[] = [];
      const skillItems = plan.items.filter((item) => item.capability.kind === "skill");
      const nativeSkills: CodexNativeSkill[] = [];
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
          records.push(record(item, "unsupported", "Codex does not support this skill scope"));
          continue;
        }
        if (duplicateSkillNames.has(item.capability.name)) {
          records.push(record(item, "failed", `Native Codex skill name collision: ${item.capability.name}`));
          continue;
        }
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.capability.name) || item.capability.name.length > 64) {
          records.push(record(item, "failed", "Native Codex skill name is invalid"));
          continue;
        }
        try {
          const root = targetRoot(context);
          if (!root || !context.space) throw new Error("Native Codex skills require Space storage");
          skillRoot ??= privateDirectory(
            context.space.storageDir,
            "runtime",
            "codex",
            "capabilities",
            basename(root),
            "revisions",
            revisionToken(plan.desiredRevision),
            "skills",
          );
          const directory = privateDirectory(skillRoot, item.capability.name);
          const path = join(directory, "SKILL.md");
          writeRevisionFile(path, skillDocument(item.capability));
          nativeSkills.push({ capabilityId: item.capability.id, name: item.capability.name, path });
          records.push(record(item, "pending", "Staged for native Codex skill discovery"));
        } catch {
          records.push(record(item, "failed", "Could not stage the private native Codex skill"));
        }
      }
      if (skillRoot && nativeSkills.length) overlay.nativeSkills = { root: skillRoot, skills: nativeSkills };

      overlay.mcpServers = {};
      const nativeMcp: CodexNativeMcp[] = [];
      const nativeTools = plan.items.flatMap((item) =>
        item.capability.kind === "tool" && item.mode !== "unsupported"
          ? [{ capabilityId: item.capability.id, name: item.capability.name }]
          : []);
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
        nativeMcp.push({
          name: item.capability.name,
          capabilityId: item.capability.id,
          tools: item.capability.id === "polyth.agent-tools" ? nativeTools : [],
        });
      }
      if (Object.keys(overlay.mcpServers).length === 0) delete overlay.mcpServers;
      if (nativeMcp.length) overlay.nativeMcp = nativeMcp;

      const preRecorded = new Set(records.map((item) => item.capabilityId));
      for (const item of plan.items) {
        if (preRecorded.has(item.capability.id)) continue;
        const collision = mcpNativeNameCollision(plan.items, item.capability.id);
        if (collision) {
          records.push(record(item, "failed", collision));
        } else if (item.mode === "unsupported") {
          records.push(record(item, "unsupported", "Codex has no verified projection for this capability"));
        } else {
          records.push(record(item, "pending", item.capability.kind === "mcp-server" || item.capability.kind === "tool"
            ? "Staged for native Codex MCP verification"
            : "Staged for the next Codex thread/start"));
        }
      }
      const nativelyVerifiedIds = new Set([
        ...nativeSkills.map((item) => item.capabilityId),
        ...nativeMcp.flatMap((item) => [item.capabilityId, ...item.tools.map((tool) => tool.capabilityId)]),
      ]);
      overlay.stagedCapabilityIds = records
        .filter((item) => item.status === "pending" && !nativelyVerifiedIds.has(item.capabilityId))
        .map((item) => item.capabilityId);
      pruneRetiredRevisions(context, [...(plan.keepRevisions ?? []), plan.desiredRevision]);
      codexOverlays.set(context, overlay, "codex", {
        desiredRevision: plan.desiredRevision,
        capabilityIds: records.filter((item) => item.status === "pending").map((item) => item.capabilityId),
      });
      return { harnessId: "codex", desiredRevision: plan.desiredRevision, records };
    },
    release(context, options) {
      codexOverlays.release(context);
      pruneRetiredRevisions(context, options?.keepRevisions ?? []);
      const root = targetRoot(context);
      if (root && context.space && (options?.keepRevisions?.length ?? 0) === 0) {
        const checked = existingPrivateDirectory(
          context.space.storageDir,
          "runtime",
          "codex",
          "capabilities",
          targetKey(context),
        );
        if (checked) rmSync(checked, { recursive: true, force: true });
      }
    },
  };
}
