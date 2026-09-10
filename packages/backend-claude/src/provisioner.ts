import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  AgentCapabilityDescriptor,
  CapabilitySecretResolver,
  HarnessCapabilityRecord,
  HarnessCapabilitySupport,
  HarnessContext,
  HarnessProvisioner,
  HarnessProvisioningPlan,
} from "@polyth/contracts";
import { mcpNativeNameCollision, createLaunchOverlayStore, type LaunchOverlayStore } from "@polyth/harness-runtime";
import { renderCapabilityText } from "@polyth/harness-runtime/capability-text";
import { atomicWriteSync } from "@polyth/plugins";

type ClaudeMcpServer = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
} | {
  type: "http";
  url: string;
  headers?: Record<string, string>;
};

export interface ClaudeLaunchOverlay {
  append?: string;
  mcpServers?: Record<string, ClaudeMcpServer>;
  plugins?: Array<{ type: "local"; path: string }>;
  skills?: string[];
  verification?: {
    promptIds: string[];
    skills: Array<{ capabilityId: string; canonicalName: string }>;
    mcpServers: Array<{ capabilityId: string; name: string; enabled: boolean }>;
    tools: Array<{ capabilityId: string; name: string }>;
  };
}

export const claudeOverlays: LaunchOverlayStore<ClaudeLaunchOverlay> = createLaunchOverlayStore<ClaudeLaunchOverlay>();

const support = (_context: HarnessContext): HarnessCapabilitySupport => ({
  harnessId: "claude",
  targetLifetime: "session",
  kinds: {
    instruction: { modes: ["native"], mutability: "session-create", configScope: "session" },
    "mcp-server": { modes: ["native"], mutability: "session-create", remote: false, configScope: "session" },
    tool: { modes: ["mcp"], mutability: "session-create", remote: false, configScope: "session" },
    skill: { modes: ["filesystem"], mutability: "session-create", remote: false, configScope: "session" },
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

const revisionToken = (revision: string): string => createHash("sha256").update(revision).digest("hex");
const targetToken = (context: HarnessContext): string => createHash("sha256").update(JSON.stringify([
  context.projectId, resolve(context.cwd), context.sessionId ?? "",
])).digest("hex");

const within = (root: string, path: string): boolean => {
  const value = relative(root, path);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
};

/** Every component below the trusted Space/package root is server-owned. Refuse
 * an existing symlink instead of following it during materialization/cleanup. */
const ensurePrivateDirectory = (trustedRoot: string, path: string): void => {
  const rootStat = lstatSync(trustedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Space storage root is not a canonical directory");
  }
  const root = realpathSync(trustedRoot);
  const target = resolve(path);
  if (!within(root, target)) throw new Error("Claude plugin path escapes Space storage");
  let cursor = root;
  for (const component of relative(root, target).split(/[\\/]+/).filter(Boolean)) {
    cursor = join(cursor, component);
    if (!existsSync(cursor)) mkdirSync(cursor, { mode: 0o700 });
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Claude plugin path contains a non-directory or symlink");
    }
  }
};

const writeImmutable = (path: string, body: string): void => {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Claude plugin file is not a regular file");
    if (readFileSync(path, "utf8") !== body) throw new Error("Claude plugin revision is not immutable");
    return;
  }
  atomicWriteSync(path, body, 0o600);
};

const safeSkillId = (capability: Extract<AgentCapabilityDescriptor, { kind: "skill" }>): string => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(capability.name) || capability.name.length > 64) {
    throw new Error("Claude skill name is not a safe identifier");
  }
  const suffix = createHash("sha256").update(capability.id).digest("hex").slice(0, 10);
  return `${capability.name.slice(0, 53).replace(/-+$/g, "")}-${suffix}`;
};

const yamlScalar = (value: string): string => JSON.stringify(value.replace(/[\r\n]+/g, " "));
type MaterializedSkills = { pluginPath: string; canonicalNames: Map<string, string> };

const materializeSkills = (
  rootFor: (context: HarnessContext) => string | undefined,
  context: HarnessContext,
  plan: HarnessProvisioningPlan,
  skills: Array<Extract<AgentCapabilityDescriptor, { kind: "skill" }>>,
): MaterializedSkills => {
  const trustedRoot = rootFor(context);
  if (!trustedRoot) throw new Error("Local Space storage is required for native Claude skills");
  ensurePrivateDirectory(context.space!.storageDir, trustedRoot);
  const revision = revisionToken(plan.desiredRevision);
  const pluginName = `polyth-${createHash("sha256").update(JSON.stringify([
    context.spaceId, targetToken(context), revision,
  ])).digest("hex").slice(0, 16)}`;
  const pluginPath = join(trustedRoot, "runtime", "claude", targetToken(context), "revisions", revision, "plugin");
  ensurePrivateDirectory(trustedRoot, join(pluginPath, ".claude-plugin"));
  ensurePrivateDirectory(trustedRoot, join(pluginPath, "skills"));
  writeImmutable(join(pluginPath, ".claude-plugin", "plugin.json"), `${JSON.stringify({
    name: pluginName,
    version: "1.0.0",
    description: "Space-private skills materialized by Polyth",
  }, null, 2)}\n`);
  const canonicalNames = new Map<string, string>();
  for (const capability of skills) {
    const skillId = safeSkillId(capability);
    const skillDir = join(pluginPath, "skills", skillId);
    ensurePrivateDirectory(trustedRoot, skillDir);
    writeImmutable(join(skillDir, "SKILL.md"), [
      "---",
      `name: ${skillId}`,
      `description: ${yamlScalar(capability.description)}`,
      "---",
      "",
      capability.instructions,
      "",
    ].join("\n"));
    canonicalNames.set(capability.id, `${pluginName}:${skillId}`);
  }
  return { pluginPath, canonicalNames };
};

export interface ClaudeProvisionerOptions {
  /** Must return this package's root inside the already validated Space. */
  storageRoot?: (context: HarnessContext) => string | undefined;
}

export function createClaudeProvisioner(options: ClaudeProvisionerOptions = {}): HarnessProvisioner {
  const rootFor = (context: HarnessContext): string | undefined => {
    if (!context.space || context.space.spaceId !== context.spaceId) return undefined;
    return options.storageRoot?.(context)
      ?? join(context.space.storageDir, "packages", "backend-claude");
  };
  const runtimeRoot = (context: HarnessContext): string | undefined => {
    const root = rootFor(context);
    return root ? join(root, "runtime", "claude", targetToken(context)) : undefined;
  };
  const prune = (context: HarnessContext, keepRevisions: readonly string[]): void => {
    const trustedRoot = rootFor(context);
    const targetRoot = runtimeRoot(context);
    if (!trustedRoot || !targetRoot) return;
    const revisionsRoot = join(targetRoot, "revisions");
    if (!existsSync(revisionsRoot)) return;
    ensurePrivateDirectory(context.space!.storageDir, trustedRoot);
    ensurePrivateDirectory(trustedRoot, revisionsRoot);
    const keep = new Set(keepRevisions.map(revisionToken));
    for (const entry of readdirSync(revisionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || keep.has(entry.name)) continue;
      const path = join(revisionsRoot, entry.name);
      if (!within(realpathSync(trustedRoot), resolve(path))) continue;
      rmSync(path, { recursive: true, force: true });
    }
  };
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
      const overlay: ClaudeLaunchOverlay = {
        verification: { promptIds: [], skills: [], mcpServers: [], tools: [] },
      };
      const verification = overlay.verification!;
      const records: HarnessCapabilityRecord[] = [];
      const append = renderCapabilityText(plan);
      if (append) overlay.append = append;
      overlay.mcpServers = {};
      const skillItems = plan.items.filter((item) => item.capability.kind === "skill" && item.mode !== "unsupported");
      let materialized: MaterializedSkills | undefined;
      if (skillItems.length) {
        try {
          materialized = materializeSkills(rootFor, context, plan, skillItems.map((item) => item.capability as Extract<AgentCapabilityDescriptor, { kind: "skill" }>));
          overlay.plugins = [{ type: "local", path: materialized.pluginPath }];
          overlay.skills = [...materialized.canonicalNames.values()];
        } catch (error) {
          for (const item of skillItems) records.push(record(item, "failed", (error as Error).message.slice(0, 280)));
        }
      }
      for (const item of plan.items) {
        if (records.some((row) => row.capabilityId === item.capability.id)) continue;
        const collision = mcpNativeNameCollision(plan.items, item.capability.id);
        if (collision) {
          records.push(record(item, "failed", collision));
          continue;
        }
        if (item.mode === "unsupported") {
          records.push(record(item, "unsupported", "Claude Agent SDK has no verified projection"));
          continue;
        }
        if (item.capability.kind === "skill") {
          const canonicalName = materialized?.canonicalNames.get(item.capability.id);
          if (!canonicalName) {
            records.push(record(item, "failed", "Claude skill was not materialized"));
            continue;
          }
          verification.skills.push({ capabilityId: item.capability.id, canonicalName });
        } else if (item.capability.kind === "mcp-server") {
          verification.mcpServers.push({
            capabilityId: item.capability.id,
            name: item.capability.name,
            enabled: item.capability.enabled,
          });
          if (item.capability.enabled) {
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
        } else if (item.capability.kind === "tool") {
          verification.tools.push({ capabilityId: item.capability.id, name: item.capability.name });
        } else {
          verification.promptIds.push(item.capability.id);
        }
        records.push(record(item, "pending", "Staged for the next Claude native session"));
      }
      if (Object.keys(overlay.mcpServers).length === 0) delete overlay.mcpServers;
      claudeOverlays.set(context, overlay, "claude", {
        desiredRevision: plan.desiredRevision,
        capabilityIds: records.filter((item) => item.status === "pending").map((item) => item.capabilityId),
      });
      prune(context, plan.keepRevisions ?? [plan.desiredRevision]);
      return { harnessId: "claude", desiredRevision: plan.desiredRevision, records };
    },
    release(context, releaseOptions) {
      claudeOverlays.release(context);
      prune(context, releaseOptions?.keepRevisions ?? []);
      const targetRoot = runtimeRoot(context);
      if (targetRoot && existsSync(targetRoot) && (releaseOptions?.keepRevisions?.length ?? 0) === 0) {
        const trustedRoot = rootFor(context);
        if (trustedRoot && within(realpathSync(trustedRoot), resolve(targetRoot))) {
          ensurePrivateDirectory(context.space!.storageDir, trustedRoot);
          ensurePrivateDirectory(trustedRoot, targetRoot);
          rmSync(targetRoot, { recursive: true, force: true });
        }
      }
    },
  };
}
