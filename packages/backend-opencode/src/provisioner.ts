import {
  existsSync,
  mkdirSync,
  lstatSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, relative, sep } from "node:path";
import type {
  CapabilitySecretResolver,
  HarnessCapabilityRecord,
  HarnessCapabilitySupport,
  HarnessContext,
  HarnessProvisioner,
  HarnessProvisioningPlan,
} from "@polyth/contracts";
import { mcpNativeNameCollision } from "@polyth/harness-runtime";
import { renderCapabilityText } from "@polyth/harness-runtime/capability-text";
import { atomicWriteSync } from "@polyth/plugins";
import type { BackendConfigApplier } from "./config.ts";
import { stripJsonc } from "./config.ts";

const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_SKILL_NAME = 64;

export type OpenCodeLaunchOverlay = {
  configContent: string;
  /** File config is required: OpenCode 1.18 ignores inline skills.paths. */
  configPath?: string;
  skills?: Array<{ capabilityId: string; name: string; path: string }>;
  mcpNames?: Record<string, string>;
  env: Record<string, string>;
  desiredRevision: string;
  /** Capabilities admitted by the physical OpenCode process launch. */
  capabilityIds: string[];
  /** Text admitted separately by the native prompt path. */
  prompt?: { text: string; capabilityIds: string[] };
};

type OverlayRecord = {
  mcp: Record<string, Record<string, unknown>>;
  configPath?: string;
  skills?: OpenCodeLaunchOverlay["skills"];
  mcpNames?: Record<string, string>;
  env: Record<string, string>;
  desiredRevision: string;
  capabilityIds: string[];
  prompt?: { text: string; capabilityIds: string[] };
};

const overlayStore = new Map<string, OverlayRecord>();

const overlayKeyOf = (context: HarnessContext): string =>
  JSON.stringify([context.spaceId, context.projectId, resolve(context.cwd)]);

const serializeOverlay = (record: OverlayRecord): OpenCodeLaunchOverlay => {
  const config: Record<string, unknown> = {};
  if (Object.keys(record.mcp).length > 0) config.mcp = record.mcp;
  return {
    configContent: Object.keys(config).length > 0 ? JSON.stringify(config) : "",
    env: { ...record.env },
    ...(record.configPath ? { configPath: record.configPath } : {}),
    ...(record.skills ? { skills: record.skills.map((skill) => ({ ...skill })) } : {}),
    ...(record.mcpNames ? { mcpNames: { ...record.mcpNames } } : {}),
    desiredRevision: record.desiredRevision,
    capabilityIds: [...record.capabilityIds],
    ...(record.prompt
      ? { prompt: { text: record.prompt.text, capabilityIds: [...record.prompt.capabilityIds] } }
      : {}),
  };
};

export function peekOpenCodeLaunchOverlay(input: {
  cwd: string;
  spaceId?: string;
  projectId?: string;
}): OpenCodeLaunchOverlay | undefined {
  const cwd = resolve(input.cwd);
  if (!input.projectId) return undefined;
  const record = overlayStore.get(JSON.stringify([input.spaceId, input.projectId, cwd]));
  return record ? serializeOverlay(record) : undefined;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function applyOpenCodeLaunchOverlay(
  env: NodeJS.ProcessEnv,
  overlay: OpenCodeLaunchOverlay | undefined,
  profile: "legacy" | "v2" = "legacy",
): NodeJS.ProcessEnv {
  if (!overlay) return { ...env };
  const next: NodeJS.ProcessEnv = { ...env, ...overlay.env };
  // V2 normalizes the V1 config form itself. Keep one immutable overlay.
  const { configPath, configContent } = overlay;
  if (configPath) {
    if (env.OPENCODE_CONFIG && resolve(env.OPENCODE_CONFIG) !== configPath) {
      throw new Error("Native Polyth skills require a private OPENCODE_CONFIG; an existing custom config cannot be relocated safely");
    }
    next.OPENCODE_CONFIG = configPath;
  }
  if (!configContent.trim()) return next;
  const existing = env.OPENCODE_CONFIG_CONTENT?.trim();
  if (!existing) {
    next.OPENCODE_CONFIG_CONTENT = configContent;
    return next;
  }
  let base: Record<string, unknown>;
  try {
    const parsed = JSON.parse(stripJsonc(existing)) as unknown;
    if (!isPlainObject(parsed)) throw new Error("not an object");
    base = parsed;
  } catch {
    throw new Error("invalid existing OPENCODE_CONFIG_CONTENT; refusing to overwrite user configuration");
  }
  const parsedExtra = JSON.parse(stripJsonc(configContent)) as unknown;
  if (!isPlainObject(parsedExtra)) throw new Error("invalid generated OpenCode overlay configuration");
  const extra = parsedExtra;
  const baseMcp = isPlainObject(base.mcp) ? base.mcp : {};
  const extraMcp = isPlainObject(extra.mcp) ? extra.mcp : {};
  const baseSkills = isPlainObject(base.skills) ? base.skills : {};
  const extraSkills = isPlainObject(extra.skills) ? extra.skills : {};
  next.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    ...base,
    ...extra,
    ...(Object.keys(extraSkills).length ? { skills: {
      ...baseSkills, ...extraSkills,
      paths: [...new Set([...(Array.isArray(baseSkills.paths) ? baseSkills.paths : []), ...(Array.isArray(extraSkills.paths) ? extraSkills.paths : [])])],
    } } : {}),
    ...(profile === "v2" && isPlainObject(baseMcp.servers)
      ? { mcp: { ...baseMcp, servers: { ...baseMcp.servers, ...Object.fromEntries(Object.entries(extraMcp).map(([name, value]) => {
        const entry = value as Record<string, unknown>;
        const { enabled, ...fields } = entry;
        return [name, { ...fields, ...(typeof enabled === "boolean" ? { disabled: !enabled } : {}) }];
      })) } } }
      : Object.keys(baseMcp).length || Object.keys(extraMcp).length ? { mcp: { ...baseMcp, ...extraMcp } } : {}),
  });
  return next;
}

const supportFor = (_context: HarnessContext): HarnessCapabilitySupport => ({
  harnessId: "opencode",
  targetLifetime: "physical-runtime",
  kinds: {
    instruction: { modes: ["prompt"], mutability: "immediate", configScope: "project", remote: false },
    "mcp-server": { modes: ["config"], mutability: "requires-restart", configScope: "project", remote: false },
    // Tool delivery stays on the portable scoped MCP bridge. Its stdio
    // protocol preserves the tool error and cancellation path that OpenCode
    // v2's generated-plugin ABI does not expose stably enough for Polyth.
    tool: { modes: ["mcp"], mutability: "requires-restart", remote: false, configScope: "project" },
    skill: { modes: ["filesystem"], mutability: "requires-restart", configScope: "project", remote: false },
    context: { modes: ["prompt"], mutability: "immediate", configScope: "project", remote: false },
    extension: { modes: ["unsupported"], mutability: "immutable" },
  },
});

const runtimeRoot = (context: HarnessContext, ...parts: string[]): string | undefined => {
  if (!context.space) return undefined;
  if (context.space.spaceId !== context.spaceId) throw new Error("OpenCode Space identity mismatch");
  if (lstatSync(context.space.storageDir).isSymbolicLink()) throw new Error("OpenCode Space storage cannot be a symlink");
  const projectKey = createHash("sha256").update(JSON.stringify([context.projectId, resolve(context.cwd)])).digest("hex");
  const base = realpathSync(context.space.storageDir);
  const target = join(base, "runtime", "opencode", projectKey, ...parts);
  let cursor = base;
  for (const part of relative(base, target).split(sep)) {
    if (!part || part === "." || part === "..") throw new Error("Invalid private OpenCode path");
    cursor = join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error("Symlink in private OpenCode storage");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return target;
};

const revisionToken = (revision: string): string => createHash("sha256").update(revision).digest("hex");

const writeRevisionFile = (path: string, content: string): void => {
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink() || readFileSync(path, "utf8") !== content) {
      throw new Error("Refusing to modify an immutable OpenCode revision");
    }
    return;
  }
  atomicWriteSync(path, content, 0o600);
};

const writeSecretFile = (
  context: HarnessContext,
  revision: string,
  filename: string,
  value: string,
): string | undefined => {
  const dir = runtimeRoot(context, "revisions", revisionToken(revision), "secrets");
  if (!dir) return undefined;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, filename.replace(/[^A-Za-z0-9._-]+/g, "_"));
  writeRevisionFile(path, value);
  return path;
};

const fileRef = (path: string): string => `{file:${path}}`;
const envRef = (name: string): string => `{env:${name}}`;

const secretSlot = (
  context: HarnessContext,
  revision: string,
  env: Record<string, string>,
  filename: string,
  envName: string,
  value: string,
): string => {
  const path = writeSecretFile(context, revision, filename, value);
  if (path) return fileRef(path);
  env[envName] = value;
  return envRef(envName);
};

const overlayMcpEntry = (
  context: HarnessContext,
  revision: string,
  env: Record<string, string>,
  capability: Extract<HarnessProvisioningPlan["items"][number]["capability"], { kind: "mcp-server" }>,
  secrets: CapabilitySecretResolver,
): Record<string, unknown> => {
  const values = secrets.mcpSecrets(capability.id);
  const prefix = createHash("sha1").update(capability.id).digest("hex").slice(0, 12);
  if (capability.transport.kind === "stdio") {
    const environment: Record<string, string> = {};
    for (const key of capability.transport.envKeys) {
      const envName = `POLYTH_MCP_${prefix}_${key.replace(/[^A-Za-z0-9]/g, "_")}`.slice(0, 80);
      environment[key] = secretSlot(context, revision, env, `mcp-${prefix}-env-${key.replace(/[^A-Za-z0-9._-]+/g, "_")}`, envName, values[key] ?? "");
    }
    return {
      type: "local",
      command: [capability.transport.command, ...capability.transport.args].filter(Boolean),
      enabled: true,
      ...(Object.keys(environment).length ? { environment } : {}),
    };
  }
  const headers: Record<string, string> = {};
  for (const key of capability.transport.headersSecretRefs) {
    const envName = `POLYTH_MCP_${prefix}_${key.replace(/[^A-Za-z0-9]/g, "_")}`.slice(0, 80);
    headers[key] = secretSlot(context, revision, env, `mcp-${prefix}-hdr-${key.replace(/[^A-Za-z0-9._-]+/g, "_")}`, envName, values[key] ?? "");
  }
  return {
    type: "remote",
    url: capability.transport.url,
    enabled: true,
    ...(Object.keys(headers).length ? { headers } : {}),
  };
};

export function polythSkillId(owner: string, name: string): string {
  const raw = `polyth-${owner}-${name}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (SKILL_NAME_RE.test(raw) && raw.length <= MAX_SKILL_NAME) return raw;
  const hash = createHash("sha1").update(`${owner}:${name}`).digest("hex").slice(0, 8);
  const clipped = raw.slice(0, MAX_SKILL_NAME - 9).replace(/-+$/g, "");
  const fallback = `${clipped}-${hash}`.replace(/-+/g, "-");
  return SKILL_NAME_RE.test(fallback) && fallback.length <= MAX_SKILL_NAME ? fallback : `polyth-skill-${hash}`;
}

const dropOverlay = (context: HarnessContext): void => { overlayStore.delete(overlayKeyOf(context)); };

const pruneRetiredRevisions = (context: HarnessContext, keep: readonly string[]): void => {
  const root = runtimeRoot(context, "revisions");
  if (!root || !existsSync(root)) return;
  const live = new Set(keep.map(revisionToken));
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || live.has(entry.name)) continue;
    const target = join(root, entry.name);
    if (!target.startsWith(root)) continue;
    rmSync(target, { recursive: true, force: true });
  }
};

export function createOpenCodeProvisioner(_applier: BackendConfigApplier): HarnessProvisioner {
  return {
    support: (context) => supportFor(context),
    async apply(context, plan, secrets: CapabilitySecretResolver) {
      const recordFor = (
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
      if (context.remote) {
        return {
          harnessId: "opencode",
          desiredRevision: plan.desiredRevision,
          records: plan.items.map((item) => recordFor(item, "unsupported", "Remote OpenCode does not project onto the local host runtime")),
        };
      }

      const records: HarnessCapabilityRecord[] = [];
      for (const item of plan.items.filter((row) => row.capability.kind === "instruction" || row.capability.kind === "context")) {
        if (item.mode === "unsupported") records.push(recordFor(item, "unsupported", "Capability scope is narrower than the OpenCode project target"));
        else records.push(recordFor(item, "pending", "Staged for OpenCode prompt projection"));
      }

      const overlayEnv: Record<string, string> = {};
      const overlayMcp: Record<string, Record<string, unknown>> = {};
      const spawnCapabilityIds: string[] = [];
      const nativeSkills: NonNullable<OpenCodeLaunchOverlay["skills"]> = [];
      const mcpNames: Record<string, string> = {};
      let configPath: string | undefined;
      const skillItems = plan.items.filter((item) => item.capability.kind === "skill");
      try {
        for (const item of skillItems) {
          if (item.capability.kind !== "skill") continue;
          if (item.mode === "unsupported") {
            records.push(recordFor(item, "unsupported", "Skill scope is narrower than the OpenCode project target"));
            continue;
          }
          const name = polythSkillId(item.capability.owner, item.capability.name);
          if (nativeSkills.some((skill) => skill.name === name)) throw new Error("Native OpenCode skill name collision");
          const root = runtimeRoot(context, "revisions", revisionToken(plan.desiredRevision), "skills");
          if (!root) throw new Error("Native OpenCode skills require Space storage");
          const dir = runtimeRoot(context, "revisions", revisionToken(plan.desiredRevision), "skills", name)!;
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          const path = join(dir, "SKILL.md");
          writeRevisionFile(path, `---\nname: ${name}\ndescription: ${JSON.stringify(item.capability.description)}\npolyth-owned: "true"\n---\n${item.capability.instructions}\n`);
          writeRevisionFile(join(dir, ".polyth-owned"), item.capability.id);
          nativeSkills.push({ capabilityId: item.capability.id, name, path });
        }
        if (nativeSkills.length) {
          configPath = runtimeRoot(context, "revisions", revisionToken(plan.desiredRevision), "opencode.json")!;
          const root = runtimeRoot(context, "revisions", revisionToken(plan.desiredRevision), "skills")!;
          writeRevisionFile(configPath, JSON.stringify({ $schema: "https://opencode.ai/config.json", skills: { paths: [root] } }));
        }
        for (const skill of nativeSkills) {
          const item = skillItems.find((candidate) => candidate.capability.id === skill.capabilityId)!;
          records.push(recordFor(item, "pending", "Staged for native OpenCode skill discovery"));
          spawnCapabilityIds.push(skill.capabilityId);
        }
      } catch {
        configPath = undefined;
        nativeSkills.length = 0;
        for (const item of skillItems) {
          if (!records.some((record) => record.capabilityId === item.capability.id)) records.push(recordFor(item, "failed", "Could not stage private native OpenCode skills"));
        }
      }

      const mcpItems = plan.items.filter((item) => item.capability.kind === "mcp-server");
      const toolItems = plan.items.filter((item) => item.capability.kind === "tool");
      try {
        for (const item of mcpItems) {
          if (item.capability.kind !== "mcp-server") continue;
          const collision = mcpNativeNameCollision(plan.items, item.capability.id);
          if (collision) {
            records.push(recordFor(item, "failed", collision));
            continue;
          }
          if (item.mode === "unsupported") {
            records.push(recordFor(item, "unsupported", "OpenCode does not support this capability"));
            continue;
          }
          if (!item.capability.enabled) {
            records.push(recordFor(item, "applied", "Retired from Polyth desired state"));
            continue;
          }
          const entry = overlayMcpEntry(context, plan.desiredRevision, overlayEnv, item.capability, secrets);
          overlayMcp[item.capability.name] = entry;
          mcpNames[item.capability.id] = item.capability.name;
          spawnCapabilityIds.push(item.capability.id);
          records.push(recordFor(item, "pending", "Staged as a private OpenCode launch overlay"));
        }
        for (const item of toolItems) {
          if (records.some((row) => row.capabilityId === item.capability.id)) continue;
          const collision = mcpNativeNameCollision(plan.items, item.capability.id);
          if (collision) {
            records.push(recordFor(item, "failed", collision));
            continue;
          }
          records.push(recordFor(
            item,
            item.mode === "unsupported" ? "unsupported" : "pending",
            item.mode === "unsupported"
              ? "OpenCode does not support this capability"
              : "Presented through the scoped Polyth MCP capability bridge",
          ));
          if (item.mode !== "unsupported") spawnCapabilityIds.push(item.capability.id);
        }
      } catch (error) {
        for (const item of [...mcpItems, ...toolItems]) {
          if (records.some((row) => row.capabilityId === item.capability.id)) continue;
          records.push(recordFor(item, item.mode === "unsupported" ? "unsupported" : "failed", (error as Error).message.slice(0, 280)));
        }
      }

      for (const item of plan.items.filter((row) => row.capability.kind === "extension")) {
        records.push(recordFor(item, "unsupported", "OpenCode has no portable projection for this capability"));
      }

      const promptIds = records.filter((record) => record.status === "pending" && record.mode === "prompt").map((record) => record.capabilityId);
      const promptText = promptIds.length ? renderCapabilityText(plan) : undefined;
      overlayStore.set(overlayKeyOf(context), {
        mcp: overlayMcp,
        configPath,
        skills: nativeSkills,
        mcpNames,
        env: overlayEnv,
        desiredRevision: plan.desiredRevision,
        capabilityIds: spawnCapabilityIds,
        ...(promptText ? { prompt: { text: promptText, capabilityIds: promptIds } } : {}),
      });
      pruneRetiredRevisions(context, plan.keepRevisions ?? [plan.desiredRevision]);
      return { harnessId: "opencode", desiredRevision: plan.desiredRevision, records };
    },
    release(context, options) {
      if (context.sessionId) return;
      dropOverlay(context);
      const keep = new Set((options?.keepRevisions ?? []).map(revisionToken));
      const root = runtimeRoot(context);
      if (!root || !existsSync(root)) return;
      const revisionsRoot = join(root, "revisions");
      if (existsSync(revisionsRoot)) {
        for (const entry of readdirSync(revisionsRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || keep.has(entry.name)) continue;
          const target = join(revisionsRoot, entry.name);
          if (!target.startsWith(revisionsRoot)) continue;
          rmSync(target, { recursive: true, force: true });
        }
      }
      if (keep.size === 0) rmSync(root, { recursive: true, force: true });
    },
  };
}
