// OpenCode capability projector. Persistent user/global config still goes
// through BackendConfigApplier. Space/project runtime capabilities (MCP,
// package tools, generated skills, instructions and context) are delivered as
// a private launch overlay via OPENCODE_CONFIG_CONTENT — never written into
// project `.opencode/` files.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type {
  CapabilitySecretResolver,
  HarnessCapabilityRecord,
  HarnessCapabilitySupport,
  HarnessContext,
  HarnessProvisioner,
  HarnessProvisioningPlan,
} from "@polyth/contracts";
import { atomicWriteSync } from "@polyth/plugins";
import { mcpNativeNameCollision } from "@polyth/harness-runtime";
import type { BackendConfigApplier } from "./config.ts";
import { stripJsonc } from "./config.ts";

const OWNED_MARKER = ".polyth-owned";
const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_SKILL_NAME = 64;

export type OpenCodeLaunchOverlay = {
  configContent: string;
  env: Record<string, string>;
  desiredRevision: string;
  capabilityIds: string[];
};

type OverlayRecord = {
  mcp: Record<string, Record<string, unknown>>;
  skills: { paths: string[] } | null;
  instructions: string[];
  env: Record<string, string>;
  desiredRevision: string;
  capabilityIds: string[];
};

const overlayStore = new Map<string, OverlayRecord>();

const overlayKeyOf = (context: HarnessContext): string =>
  JSON.stringify([context.spaceId, context.projectId, resolve(context.cwd)]);

const serializeOverlay = (record: OverlayRecord): OpenCodeLaunchOverlay => {
  const config: Record<string, unknown> = {};
  if (Object.keys(record.mcp).length > 0) config.mcp = record.mcp;
  if (record.skills) config.skills = record.skills;
  if (record.instructions.length) config.instructions = record.instructions;
  return {
    configContent: Object.keys(config).length > 0 ? JSON.stringify(config) : "",
    env: { ...record.env },
    desiredRevision: record.desiredRevision,
    capabilityIds: [...record.capabilityIds],
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

const uniqueStrings = (values: unknown): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(values)) return out;
  for (const item of values) {
    if (typeof item !== "string" || !item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
};

const mergeSkillConfig = (base: unknown, extra: unknown): Record<string, unknown> | undefined => {
  if (base === undefined && extra === undefined) return undefined;
  const baseObj = isPlainObject(base) ? base : {};
  const extraObj = isPlainObject(extra) ? extra : {};
  const paths = uniqueStrings([...(Array.isArray(baseObj.paths) ? baseObj.paths : []), ...(Array.isArray(extraObj.paths) ? extraObj.paths : [])]);
  const urls = uniqueStrings([...(Array.isArray(baseObj.urls) ? baseObj.urls : []), ...(Array.isArray(extraObj.urls) ? extraObj.urls : [])]);
  const merged: Record<string, unknown> = { ...baseObj, ...extraObj };
  if (paths.length) merged.paths = paths;
  else delete merged.paths;
  if (urls.length) merged.urls = urls;
  else delete merged.urls;
  return merged;
};

export function applyOpenCodeLaunchOverlay(
  env: NodeJS.ProcessEnv,
  overlay: OpenCodeLaunchOverlay | undefined,
): NodeJS.ProcessEnv {
  if (!overlay) return { ...env };
  const next: NodeJS.ProcessEnv = { ...env, ...overlay.env };
  if (!overlay.configContent.trim()) return next;
  const existing = env.OPENCODE_CONFIG_CONTENT?.trim();
  if (!existing) {
    next.OPENCODE_CONFIG_CONTENT = overlay.configContent;
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
  const parsedExtra = JSON.parse(stripJsonc(overlay.configContent)) as unknown;
  if (!isPlainObject(parsedExtra)) {
    throw new Error("invalid generated OpenCode overlay configuration");
  }
  const extra = parsedExtra;
  const baseMcp = isPlainObject(base.mcp) ? base.mcp : {};
  const extraMcp = isPlainObject(extra.mcp) ? extra.mcp : {};
  const skills = mergeSkillConfig(base.skills, extra.skills);
  const instructions = uniqueStrings([
    ...(Array.isArray(base.instructions) ? base.instructions : []),
    ...(Array.isArray(extra.instructions) ? extra.instructions : []),
  ]);
  next.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    ...base,
    ...extra,
    ...(Object.keys(baseMcp).length || Object.keys(extraMcp).length
      ? { mcp: { ...baseMcp, ...extraMcp } }
      : {}),
    ...(skills ? { skills } : {}),
    ...(instructions.length ? { instructions } : {}),
  });
  return next;
}

const supportFor = (_context: HarnessContext): HarnessCapabilitySupport => ({
  harnessId: "opencode",
  targetLifetime: "physical-runtime",
  kinds: {
    // A project runtime can isolate deployment/Space/project instructions. A
    // session-scoped instruction is narrower than the physical config target
    // and is therefore rejected by the shared planner rather than leaked.
    instruction: { modes: ["config"], mutability: "requires-restart", configScope: "project", remote: false },
    "mcp-server": { modes: ["config"], mutability: "requires-restart", configScope: "project", remote: false },
    tool: { modes: ["mcp"], mutability: "requires-restart", remote: false, configScope: "project" },
    skill: { modes: ["filesystem"], mutability: "requires-restart", configScope: "project", remote: false },
    context: { modes: ["config"], mutability: "requires-restart", configScope: "project", remote: false },
    extension: { modes: ["unsupported"], mutability: "immutable" },
  },
});

const runtimeRoot = (context: HarnessContext, ...parts: string[]): string | undefined => {
  if (!context.space) return undefined;
  const projectId = context.projectId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "project";
  const projectKey = `${projectId}-${createHash("sha1").update(resolve(context.cwd)).digest("hex").slice(0, 8)}`;
  return join(context.space.storageDir, "runtime", "opencode", projectKey, ...parts);
};

const revisionToken = (revision: string): string => {
  const safe = revision.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
  return safe || "rev";
};

const writeSecretFile = (context: HarnessContext, revision: string, filename: string, value: string): string | undefined => {
  const dir = runtimeRoot(context, "revisions", revisionToken(revision), "secrets");
  if (!dir) return undefined;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, filename.replace(/[^A-Za-z0-9._-]+/g, "_"));
  atomicWriteSync(path, value, 0o600);
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
    headers[key] = secretSlot(
      context,
      revision,
      env,
      `mcp-${prefix}-hdr-${key.replace(/[^A-Za-z0-9._-]+/g, "_")}`,
      envName,
      values[key] ?? "",
    );
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
  return SKILL_NAME_RE.test(fallback) && fallback.length <= MAX_SKILL_NAME
    ? fallback
    : `polyth-skill-${hash}`;
}

const writeOwnedSkill = (
  root: string,
  capability: Extract<HarnessProvisioningPlan["items"][number]["capability"], { kind: "skill" }>,
): { status: "pending" | "failed"; skillId?: string; reason?: string } => {
  const skillId = polythSkillId(capability.owner, capability.name);
  const dir = join(root, skillId);
  if (existsSync(dir) && !existsSync(join(dir, OWNED_MARKER))) {
    return { status: "failed", reason: "Refusing to overwrite a user-owned skill directory" };
  }
  mkdirSync(dir, { recursive: true });
  const body = `---
name: ${skillId}
description: ${JSON.stringify(capability.description)}
metadata:
  polyth-owned: "true"
  polyth-capability-id: ${JSON.stringify(capability.id)}
---

${capability.instructions}
`;
  writeFileSync(join(dir, "SKILL.md"), body);
  writeFileSync(join(dir, OWNED_MARKER), `${capability.id}\n`);
  return { status: "pending", skillId };
};

const writeOwnedInstruction = (
  context: HarnessContext,
  revision: string,
  capability: Extract<HarnessProvisioningPlan["items"][number]["capability"], { kind: "instruction" | "context" }>,
): string | undefined => {
  const root = runtimeRoot(context, "revisions", revisionToken(revision), "instructions");
  if (!root) return undefined;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const suffix = createHash("sha1").update(capability.id).digest("hex").slice(0, 12);
  const path = join(root, `${capability.kind}-${suffix}.md`);
  const text = capability.kind === "context"
    ? `# ${capability.title}\n\n${capability.text}`
    : capability.text;
  atomicWriteSync(path, text.endsWith("\n") ? text : `${text}\n`, 0o600);
  return path;
};

const removeOwnedSkills = (root: string, keep: Set<string>): void => {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const marker = join(dir, OWNED_MARKER);
    if (!existsSync(marker)) continue;
    const id = readFileSync(marker, "utf8").trim();
    if (!keep.has(id) && !keep.has(entry.name)) rmSync(dir, { recursive: true, force: true });
  }
};

const dropOverlay = (context: HarnessContext): void => {
  overlayStore.delete(overlayKeyOf(context));
};

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

export function createOpenCodeProvisioner(applier: BackendConfigApplier): HarnessProvisioner {
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
        ...(status === "applied" || status === "unverifiable"
          ? { appliedRevision: item.capability.revision }
          : {}),
        ...(reason ? { reason } : {}),
      });
      if (context.remote) {
        return {
          harnessId: "opencode",
          desiredRevision: plan.desiredRevision,
          records: plan.items.map((item) => recordFor(
            item,
            "unsupported",
            "Remote OpenCode does not project onto the local host config",
          )),
        };
      }
      const authority = applier.configAuthority?.();
      const readOnly = authority?.kind === "read-only";
      const records: HarnessCapabilityRecord[] = [];
      const overlayInstructions: string[] = [];
      const capabilityIds: string[] = [];

      const instructionItems = plan.items.filter((item) => item.capability.kind === "instruction");
      const deploymentInstructions = instructionItems.filter((item) => item.capability.scope === "deployment");
      const deploymentText = deploymentInstructions
        .filter((item) => item.mode !== "unsupported")
        .map((item) => item.capability.kind === "instruction" ? item.capability.text : "")
        .join("\n\n");
      if (deploymentInstructions.length) {
        if (readOnly) {
          for (const item of deploymentInstructions) {
            records.push(recordFor(
              item,
              item.mode === "unsupported" ? "unsupported" : "pending",
              item.mode === "unsupported"
                ? "OpenCode has no projection for this instruction"
                : "Waiting for writable OpenCode config authority",
            ));
          }
        } else {
          try {
            await applier.applyBehavior(deploymentText);
            for (const item of deploymentInstructions) {
              records.push(recordFor(
                item,
                item.mode === "unsupported" ? "unsupported" : "applied",
                item.mode === "unsupported" ? "OpenCode has no projection for this instruction" : undefined,
              ));
            }
          } catch (error) {
            for (const item of deploymentInstructions) {
              records.push(recordFor(item, "failed", (error as Error).message.slice(0, 280)));
            }
          }
        }
      }
      for (const item of instructionItems.filter((row) => row.capability.scope !== "deployment")) {
        if (item.capability.kind !== "instruction") continue;
        if (item.mode === "unsupported") {
          records.push(recordFor(item, "unsupported", "Instruction scope is narrower than the OpenCode project runtime"));
          continue;
        }
        const path = writeOwnedInstruction(context, plan.desiredRevision, item.capability);
        if (!path) {
          records.push(recordFor(item, "unsupported", "OpenCode private instructions require Space-owned runtime storage"));
          continue;
        }
        overlayInstructions.push(path);
        capabilityIds.push(item.capability.id);
        records.push(recordFor(item, "pending", "Staged as a private OpenCode instruction source"));
      }

      const mcpItems = plan.items.filter((item) => item.capability.kind === "mcp-server");
      const toolItems = plan.items.filter((item) => item.capability.kind === "tool");
      const overlayEnv: Record<string, string> = {};
      const overlayMcp: Record<string, Record<string, unknown>> = {};
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
          // Disabled/tombstoned canonical MCPs are omitted from the private
          // overlay so they never shadow user-owned OpenCode MCP entries.
          if (!item.capability.enabled) {
            records.push(recordFor(item, "applied", "Retired from Polyth desired state"));
            continue;
          }
          overlayMcp[item.capability.name] = overlayMcpEntry(context, plan.desiredRevision, overlayEnv, item.capability, secrets);
          capabilityIds.push(item.capability.id);
          records.push(recordFor(item, "pending", "Staged as a private OpenCode launch overlay"));
        }
        for (const item of toolItems) {
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
              : "Staged as a private OpenCode launch overlay",
          ));
          if (item.mode !== "unsupported") capabilityIds.push(item.capability.id);
        }
      } catch (error) {
        for (const item of [...mcpItems, ...toolItems]) {
          if (records.some((row) => row.capabilityId === item.capability.id)) continue;
          records.push(recordFor(
            item,
            item.mode === "unsupported" ? "unsupported" : "failed",
            (error as Error).message.slice(0, 280),
          ));
        }
      }

      const skillItems = plan.items.filter((item) => item.capability.kind === "skill");
      const skillRoot = runtimeRoot(context, "revisions", revisionToken(plan.desiredRevision), "skills");
      const keep = new Set<string>();
      let skills: { paths: string[] } | null = null;
      for (const item of skillItems) {
        if (item.capability.kind !== "skill") continue;
        if (item.mode === "unsupported") {
          records.push(recordFor(item, "unsupported", "OpenCode has no portable projection for this capability"));
          continue;
        }
        if (!skillRoot) {
          records.push(recordFor(item, "unsupported", "OpenCode skills require Space-owned private runtime storage"));
          continue;
        }
        mkdirSync(skillRoot, { recursive: true });
        keep.add(item.capability.id);
        const outcome = writeOwnedSkill(skillRoot, item.capability);
        if (outcome.skillId) keep.add(outcome.skillId);
        records.push(recordFor(
          item,
          outcome.status === "failed" ? "failed" : "pending",
          outcome.reason ?? (outcome.status === "pending" ? "Staged as a private OpenCode launch overlay" : undefined),
        ));
        if (outcome.status === "pending") capabilityIds.push(item.capability.id);
      }
      if (skillRoot && (keep.size || existsSync(skillRoot))) {
        removeOwnedSkills(skillRoot, keep);
        if (keep.size) skills = { paths: [skillRoot] };
      }

      for (const item of plan.items.filter((item) => item.capability.kind === "context")) {
        if (item.capability.kind !== "context") continue;
        if (item.mode === "unsupported") {
          records.push(recordFor(item, "unsupported", "Context scope is narrower than the OpenCode project runtime"));
          continue;
        }
        const path = writeOwnedInstruction(context, plan.desiredRevision, item.capability);
        if (!path) {
          records.push(recordFor(item, "unsupported", "OpenCode context requires Space-owned private runtime storage"));
          continue;
        }
        overlayInstructions.push(path);
        capabilityIds.push(item.capability.id);
        records.push(recordFor(item, "pending", "Staged as a private OpenCode instruction source"));
      }
      for (const item of plan.items.filter((item) => item.capability.kind === "extension")) {
        records.push(recordFor(item, "unsupported", "OpenCode has no portable projection for this capability"));
      }

      const overlay: OverlayRecord = {
        mcp: overlayMcp,
        skills,
        instructions: overlayInstructions,
        env: overlayEnv,
        desiredRevision: plan.desiredRevision,
        capabilityIds,
      };
      overlayStore.set(overlayKeyOf(context), overlay);
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
