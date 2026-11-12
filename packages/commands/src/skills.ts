// Managed skill installations belong to a Space and optionally a stable project ID.
// Native harness folders remain read-only discovery sources; managed writes never
// touch a repository, server HOME, or vendor-specific configuration file.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteSync } from "@polyth/plugins";
import { roleAtLeast } from "@polyth/contracts";
import type {
  AgentCapabilityDescriptor,
  HarnessContext,
  ProjectService,
  SpaceContext,
  SpaceStorage,
} from "@polyth/contracts";
import type {
  CapabilityInstallationScope,
  SkillInstallationDto,
  SkillInstallationInput,
  SkillOrigin,
  SkillReachDto,
} from "@polyth/contracts/capability-installations";
import type { CommandService } from "./index.ts";
import { skillCommandId, type SlashCommand } from "./catalog.ts";
import { capabilityRule, reachHasAlways, sameReach, skillReach, validReach } from "./skillReach.ts";
import {
  BUNDLE_LIMITS,
  instructionsWithBundle,
  removeBundle,
  validBundleHash,
  writeBundle,
  type SkillBundleFile,
} from "./skillBundles.ts";

export interface StoredSkill extends SkillInstallationDto {
  scope: CapabilityInstallationScope;
  revision: number;
  /** Folder of this skill's files under the Space's bundle store. */
  bundleHash?: string;
  /** Older files: harnesses the skill was withheld from. Read as `reach`;
   * the next change to the skill stores `reach` instead. */
  offHarnesses?: string[];
}
interface SkillDocument { version: 1; skills: StoredSkill[] }

/** A complete skill copied from a catalog source or a harness's own folder. */
export interface SkillCopyInput {
  name: string;
  description: string;
  instructions: string;
  disallowedTools?: string[];
  origin: SkillOrigin;
  files: readonly SkillBundleFile[];
  /** Replace a different skill that already holds the name. */
  replace?: boolean;
}

export interface SkillService {
  /** Effective list. Project entries override broader Space entries by name. */
  list(space: SpaceContext, projectId?: string): Promise<SkillInstallationDto[]>;
  save(
    space: SpaceContext,
    scope: CapabilityInstallationScope,
    input: SkillInstallationInput,
    projectId?: string,
  ): Promise<SkillInstallationDto>;
  remove(
    space: SpaceContext,
    scope: CapabilityInstallationScope,
    name: string,
    projectId?: string,
    expectedRevision?: number,
  ): Promise<boolean>;
  /** Stores a skill with its files. A same-named skill of the same origin is
   * updated in place; a different one needs `replace`. */
  installCopy(
    space: SpaceContext,
    scope: CapabilityInstallationScope,
    input: SkillCopyInput,
    projectId?: string,
  ): Promise<SkillInstallationDto>;
  /** Stores which harnesses get one managed skill. `expectedRevision` refuses
   * a reach worked out from a copy that has since changed. */
  setReach(
    space: SpaceContext,
    scope: CapabilityInstallationScope,
    name: string,
    reach: SkillReachDto,
    projectId?: string,
    expectedRevision?: number,
  ): Promise<SkillInstallationDto>;
  /** Managed skills only, every scope that applies to the project. */
  listManaged(space: SpaceContext, projectId?: string): StoredSkill[];
  /** What the caller may write. Checks the role only, not a project's existence. */
  access(space: SpaceContext): { project: boolean; space: boolean };
  /** The folder of a stored skill's files, or undefined when it has none. */
  bundleDir(space: SpaceContext, skill: Pick<StoredSkill, "bundleHash">): string | undefined;
  /** The instructions as an agent should receive them. */
  agentInstructions(space: SpaceContext, skill: SkillInstallationDto): string;
  /** Synchronous canonical desired state consumed by the shared harness registry. */
  managedCapabilities(context: HarnessContext): readonly AgentCapabilityDescriptor[];
  /** Cleanup hook for a deleted project; inherited Space skills are untouched. */
  removeProject(space: SpaceContext, projectId: string): void;
}

const error = (code: string, message: string): Error => Object.assign(new Error(message), { code });
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const validDisallowedTools = (value: unknown): value is string[] | undefined =>
  value === undefined
  || (Array.isArray(value)
    && value.length <= 128
    && value.every((name) =>
      typeof name === "string"
      && Boolean(name.trim())
      && name.length <= 256
      && !/[\r\n\u0000]/.test(name))
    && new Set(value).size === value.length);
const normalizeDisallowedTools = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw error("invalid-input", "disallowedTools must be an array");
  const names = value.map((name) => typeof name === "string" ? name.trim() : "");
  if (!validDisallowedTools(names)) {
    throw error("invalid-input", "disallowedTools must contain at most 128 unique non-empty tool names");
  }
  return names;
};
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const validOrigin = (value: unknown): boolean => {
  if (value === undefined) return true;
  const origin = value as Partial<SkillOrigin> | null;
  return Boolean(origin)
    && (origin!.kind === "catalog" || origin!.kind === "harness")
    && typeof origin!.contentHash === "string";
};
const validHarnessIds = (value: unknown): boolean =>
  value === undefined || (Array.isArray(value) && value.length <= 256 && value.every((id) => typeof id === "string" && id.length <= 128));
/** The same source, so an install is an update rather than a name clash. */
const sameOrigin = (a: SkillOrigin | undefined, b: SkillOrigin): boolean => {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === "catalog" && b.kind === "catalog") return a.sourceId === b.sourceId && a.path === b.path;
  if (a.kind === "harness" && b.kind === "harness") return a.harnessId === b.harnessId && a.nativeName === b.nativeName;
  return false;
};
const EVERY_HARNESS: SkillReachDto = { default: "all" };
/** The reach worth storing: nothing when every harness gets it on demand. */
const reachField = (reach: SkillReachDto): { reach?: SkillReachDto } =>
  sameReach(reach, EVERY_HARNESS) ? {} : { reach };
/** A skill record as a client sees it: the storage folder stays on the server. */
const publicSkill = (skill: StoredSkill): SkillInstallationDto => {
  const { bundleHash: _bundleHash, offHarnesses: _legacy, reach: _reach, ...rest } = skill;
  return { ...rest, ...reachField(skillReach(skill)) };
};
/** A stored record keeps one form of its reach. */
const storedReach = (skill: StoredSkill | undefined): { reach?: SkillReachDto } =>
  skill ? reachField(skillReach(skill)) : {};
const precedence: Record<SkillInstallationDto["scope"], number> = {
  "user-opencode": 0,
  "user-claude": 1,
  "user-agents": 2,
  space: 3,
  "project-opencode": 4,
  "project-claude": 5,
  "project-agents": 6,
  project: 7,
};

export interface SkillInvocation {
  skill: SkillInstallationDto;
  args: string;
  raw: string;
}

/**
 * Portable slash aliases are prompt fallbacks only. A skill with tool
 * exclusions must stay native so the harness can enforce those exclusions,
 * and a skill set to reach no harness is not offered at all.
 */
export function skillInvocationCommands(
  skills: readonly SkillInstallationDto[],
): SlashCommand[] {
  return skills
    .filter((skill) => skill.instructions.trim() && !skill.disallowedTools?.length && skill.reach?.default !== "none")
    .map((skill) => ({
      id: skillCommandId(skill.name),
      name: skill.name,
      description: skill.description,
      prompt: "",
      scope: "builtin",
      owner: "builtin",
      kind: "skill",
      skillScope: skill.scope,
    }));
}

export function resolveSkillInvocation(
  text: string,
  skills: readonly SkillInstallationDto[],
): SkillInvocation | undefined {
  const firstNl = text.indexOf("\n");
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  const restLines = firstNl === -1 ? "" : text.slice(firstNl + 1);
  const match = firstLine.match(/^\/([A-Za-z0-9_-]+)(?:[ \t]+(.*))?$/);
  if (!match) return undefined;
  const name = match[1]!.toLowerCase();
  const skill = skills.find((candidate) => candidate.name.toLowerCase() === name);
  if (!skill || !skill.instructions.trim() || skill.disallowedTools?.length || skill.reach?.default === "none") return undefined;
  const args = [match[2] ?? "", restLines].filter((part) => part.length > 0).join("\n");
  return { skill, args, raw: text };
}

export function renderSkillInvocation(
  invocation: SkillInvocation,
  request = invocation.args,
  instructions = invocation.skill.instructions,
): string {
  const out = [
    `Use the Polyth skill \`${invocation.skill.name}\` for this request.`,
    "Follow the skill instructions below. They do not override higher-priority system, security, permission, or workspace rules.",
    "",
    "--- BEGIN POLYTH SKILL ---",
    instructions.trim(),
    "--- END POLYTH SKILL ---",
  ];
  if (request.trim()) out.push("", "Request:", request.trim());
  return out.join("\n");
}

export function createSkillService(opts: {
  storage(space: SpaceContext): SpaceStorage;
  projects(space: SpaceContext): ProjectService;
  allowUserSkills(space: SpaceContext): boolean;
  legacy: Pick<CommandService, "listSkills">;
  onChanged?(space: SpaceContext, projectId?: string): Promise<void>;
}): SkillService {
  const file = (space: SpaceContext): string =>
    join(opts.storage(space).packageDir("commands"), "skills.json");
  const bundleRoot = (space: SpaceContext): string =>
    join(opts.storage(space).packageDir("commands"), "skill-bundles");
  const bundleDirOf = (space: SpaceContext, skill: Pick<StoredSkill, "bundleHash">): string | undefined =>
    skill.bundleHash ? join(bundleRoot(space), skill.bundleHash) : undefined;
  /** Files no remaining skill points at. Several scopes can share one folder. */
  const releaseBundle = (space: SpaceContext, doc: SkillDocument, bundleHash: string | undefined): void => {
    if (!bundleHash || doc.skills.some((skill) => skill.bundleHash === bundleHash)) return;
    removeBundle(bundleRoot(space), bundleHash);
  };

  const read = (space: SpaceContext): SkillDocument => {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file(space), "utf8"));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, skills: [] };
      throw error("storage-unavailable", "Skill configuration is unreadable; the existing file was not overwritten");
    }
    const doc = raw as Partial<SkillDocument> | null;
    if (!doc || doc.version !== 1 || !Array.isArray(doc.skills) || doc.skills.some((skill) =>
      !skill
      || !NAME.test(skill.name)
      || skill.name.length > 64
      || typeof skill.description !== "string"
      || typeof skill.instructions !== "string"
      || !validDisallowedTools(skill.disallowedTools)
      || !validOrigin(skill.origin)
      || !validHarnessIds(skill.offHarnesses)
      || !validReach(skill.reach)
      || (skill.bundleHash !== undefined && !validBundleHash(skill.bundleHash))
      || !Number.isSafeInteger(skill.revision)
      || skill.revision < 1
      || (skill.scope !== "space" && skill.scope !== "project")
      || (skill.scope === "project"
        ? typeof skill.projectId !== "string" || !skill.projectId
        : skill.projectId !== undefined))) {
      throw error("storage-unavailable", "Invalid skill configuration; the existing file was not overwritten");
    }
    return doc as SkillDocument;
  };

  const write = (space: SpaceContext, doc: SkillDocument): void =>
    atomicWriteSync(file(space), JSON.stringify(doc, null, 2), 0o600);

  const requireProject = async (space: SpaceContext, projectId: string): Promise<void> => {
    if (!projectId || !await opts.projects(space).get(projectId)) {
      // Foreign and unknown IDs are intentionally indistinguishable.
      throw error("not-found", "project not found");
    }
  };

  const writeOwner = async (
    space: SpaceContext,
    scope: CapabilityInstallationScope,
    projectId?: string,
  ): Promise<string | undefined> => {
    if (scope !== "project" && scope !== "space") {
      throw error("invalid-input", "install skills in this project or this Space; native folders are read-only");
    }
    if (scope === "project") {
      if (!projectId) throw error("invalid-input", "projectId is required for project scope");
      await requireProject(space, projectId);
    } else if (projectId !== undefined) {
      // A project id on a Space-scoped write is never accepted and ignored.
      throw error("invalid-input", "projectId is only valid for project scope");
    }
    if (space.role === "viewer" || (scope === "space" && space.role === "member")) {
      throw error("forbidden", "insufficient role to manage this scope");
    }
    return scope === "project" ? projectId : undefined;
  };

  const effectiveManaged = (space: SpaceContext, projectId?: string): StoredSkill[] => {
    const byName = new Map<string, StoredSkill>();
    for (const skill of read(space).skills) {
      if (skill.scope === "space") byName.set(skill.name, skill);
    }
    if (projectId !== undefined) {
      for (const skill of read(space).skills) {
        if (skill.scope === "project" && skill.projectId === projectId) byName.set(skill.name, skill);
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  };

  const changed = async (space: SpaceContext, projectId?: string): Promise<void> => {
    try {
      await opts.onChanged?.(space, projectId);
    } catch {
      // Desired state is durable; target-specific provisioning exposes failures.
    }
  };

  const list = async (space: SpaceContext, projectId?: string): Promise<SkillInstallationDto[]> => {
    let project: Awaited<ReturnType<ProjectService["get"]>> | undefined;
    if (projectId !== undefined) {
      await requireProject(space, projectId);
      project = await opts.projects(space).get(projectId);
    }

    // Native filesystem discovery is compatibility-only and belongs to the
    // single-operator local profile. Shared-server Spaces must never inherit
    // capabilities from a host path or process HOME that another user can see.
    const native = project && !project.remote && space.deployment === "local-trusted"
      ? await opts.legacy.listSkills(project.path, { includeUser: opts.allowUserSkills(space) })
      : [];

    // Re-check after filesystem I/O so a project removed during discovery cannot
    // be used to answer a stale request for a now-foreign/nonexistent resource.
    if (projectId !== undefined) await requireProject(space, projectId);

    const rows: SkillInstallationDto[] = native.map((skill) => ({
      ...skill,
      readOnly: true,
      ...(skill.scope.startsWith("project-") ? { projectId } : {}),
    }));
    rows.push(...read(space).skills.filter((skill) =>
      skill.scope === "space" || (projectId !== undefined && skill.projectId === projectId)).map(publicSkill));

    const byName = new Map<string, SkillInstallationDto>();
    for (const skill of rows) {
      const prior = byName.get(skill.name);
      if (!prior || precedence[skill.scope] > precedence[prior.scope]) byName.set(skill.name, skill);
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  };

  return {
    list,

    async save(space, scope, input, projectId) {
      const owner = await writeOwner(space, scope, projectId);
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const description = typeof input.description === "string" ? input.description.trim() : "";
      const instructions = typeof input.instructions === "string" ? input.instructions.trim() : "";
      const disallowedTools = normalizeDisallowedTools(input.disallowedTools);
      if (!NAME.test(name) || name.length > 64) {
        throw error("invalid-input", "skill name must be lowercase letters, digits and single hyphens (at most 64 characters)");
      }
      if (!description || description.length > 4096) {
        throw error("invalid-input", "description is required (at most 4096 characters)");
      }
      if (!instructions || instructions.length > 64 * 1024) {
        throw error("invalid-input", "instructions are required (at most 65536 characters)");
      }
      const expected = input.expectedRevision ?? 0;
      if (!Number.isSafeInteger(expected) || expected < 0) {
        throw error("invalid-input", "expectedRevision must be a non-negative integer");
      }

      const doc = read(space);
      const index = doc.skills.findIndex((skill) => skill.name === name && skill.projectId === owner);
      const current = doc.skills[index];
      if ((current?.revision ?? 0) !== expected) {
        throw error("conflict", "skill changed since you loaded it");
      }
      const skill: StoredSkill = {
        // A copy keeps its source, files and harness choices through an edit.
        ...(current ? {
          ...(current.origin ? { origin: current.origin } : {}),
          ...(current.bundle ? { bundle: current.bundle } : {}),
          ...(current.bundleHash ? { bundleHash: current.bundleHash } : {}),
          ...storedReach(current),
          ...(current.modified || (current.origin && current.instructions !== instructions) ? { modified: true } : {}),
        } : {}),
        name,
        description,
        instructions,
        ...(disallowedTools.length ? { disallowedTools } : {}),
        scope,
        revision: expected + 1,
        ...(owner !== undefined ? { projectId: owner } : {}),
      };
      if (index < 0) doc.skills.push(skill);
      else doc.skills[index] = skill;
      write(space, doc);
      await changed(space, owner);
      return publicSkill(skill);
    },

    async installCopy(space, scope, input, projectId) {
      const owner = await writeOwner(space, scope, projectId);
      if (!NAME.test(input.name) || input.name.length > 64) {
        throw error("invalid-input", "skill name must be lowercase letters, digits and single hyphens (at most 64 characters)");
      }
      const description = input.description.trim();
      if (!description || description.length > 4096) throw error("invalid-input", "this skill has no usable description");
      if (!input.instructions.trim() || Buffer.byteLength(input.instructions) > BUNDLE_LIMITS.instructionBytes) {
        throw error("invalid-input", "this skill's instructions are empty or too long to install");
      }
      const doc = read(space);
      const index = doc.skills.findIndex((skill) => skill.name === input.name && skill.projectId === owner);
      const current = doc.skills[index];
      if (current && !input.replace && !sameOrigin(current.origin, input.origin)) {
        throw Object.assign(error("conflict", `a different skill named ${input.name} is already here`), { reason: "name-taken" });
      }
      const bundleHash = writeBundle(bundleRoot(space), input.files);
      const skill: StoredSkill = {
        name: input.name,
        description,
        instructions: input.instructions.trim(),
        ...(input.disallowedTools?.length ? { disallowedTools: input.disallowedTools } : {}),
        scope,
        revision: (current?.revision ?? 0) + 1,
        ...(owner !== undefined ? { projectId: owner } : {}),
        origin: input.origin,
        bundle: { files: input.files.length, bytes: input.files.reduce((sum, item) => sum + item.bytes.length, 0) },
        bundleHash,
        ...storedReach(current),
      };
      const previous = current?.bundleHash;
      if (index < 0) doc.skills.push(skill);
      else doc.skills[index] = skill;
      write(space, doc);
      releaseBundle(space, doc, previous === bundleHash ? undefined : previous);
      await changed(space, owner);
      return publicSkill(skill);
    },

    async setReach(space, scope, name, reach, projectId, expectedRevision) {
      const owner = await writeOwner(space, scope, projectId);
      if (!validReach(reach)) throw error("invalid-input", "invalid reach");
      const doc = read(space);
      const index = doc.skills.findIndex((skill) => skill.name === name && skill.projectId === owner);
      const current = doc.skills[index];
      if (!current) throw error("not-found", "skill not found");
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw error("conflict", "skill changed since you loaded it");
      }
      // Its instructions in every session would reach a harness without the
      // tool block the skill relies on.
      if (current.disallowedTools?.length && reachHasAlways(reach)) {
        throw error("invalid-input", "a skill that blocks tools cannot be always on");
      }
      const { offHarnesses: _legacy, reach: _previous, ...rest } = current;
      const skill: StoredSkill = {
        ...rest,
        ...reachField(reach),
        revision: current.revision + 1,
      };
      doc.skills[index] = skill;
      write(space, doc);
      await changed(space, owner);
      return publicSkill(skill);
    },

    listManaged(space, projectId) {
      return read(space).skills.filter((skill) =>
        skill.scope === "space" || (projectId !== undefined && skill.projectId === projectId));
    },

    access(space) {
      return { project: roleAtLeast(space.role, "member"), space: roleAtLeast(space.role, "admin") };
    },

    bundleDir: bundleDirOf,

    agentInstructions(space, skill) {
      const stored = read(space).skills.find((candidate) =>
        candidate.name === skill.name && candidate.projectId === skill.projectId);
      const dir = stored ? bundleDirOf(space, stored) : undefined;
      return dir ? instructionsWithBundle(skill.instructions, dir) : skill.instructions;
    },

    async remove(space, scope, name, projectId, expectedRevision) {
      const owner = await writeOwner(space, scope, projectId);
      if (!NAME.test(name)) throw error("invalid-input", "invalid skill name");
      const doc = read(space);
      const index = doc.skills.findIndex((skill) => skill.name === name && skill.projectId === owner);
      if (index < 0) return false;
      if (expectedRevision !== undefined && doc.skills[index]!.revision !== expectedRevision) {
        throw error("conflict", "skill changed since you loaded it");
      }
      const [removed] = doc.skills.splice(index, 1);
      write(space, doc);
      releaseBundle(space, doc, removed?.bundleHash);
      await changed(space, owner);
      return true;
    },

    managedCapabilities(context) {
      if (!context.space || context.space.spaceId !== context.spaceId) return [];
      const projectId = context.projectId && context.projectId !== "__default__"
        ? context.projectId
        : undefined;
      const space = context.space;
      return effectiveManaged(space, projectId).flatMap((skill): AgentCapabilityDescriptor[] => {
        const reach = skillReach(skill);
        if (reach.default === "none") return [];
        // The files live on this host, so a remote target gets the text alone.
        const bundleDir = context.remote ? undefined : bundleDirOf(space, skill);
        const key = hash(JSON.stringify([
          context.spaceId,
          skill.scope === "project" ? skill.projectId : null,
          skill.name,
        ])).slice(0, 32);
        const instructions = bundleDir ? instructionsWithBundle(skill.instructions, bundleDir) : skill.instructions;
        const placement = {
          owner: "commands",
          scope: skill.scope,
          spaceId: context.spaceId,
          ...(skill.scope === "project" ? { projectId: skill.projectId } : {}),
        };
        const skillRule = capabilityRule(reach, "skill");
        const descriptors: AgentCapabilityDescriptor[] = [{
          id: `commands.skill.${key}`,
          kind: "skill" as const,
          ...placement,
          revision: hash(JSON.stringify([
            skill.name,
            skill.description,
            skill.instructions,
            skill.disallowedTools ?? [],
            skill.revision,
            ...(bundleDir ? [bundleDir] : []),
          ])),
          name: skill.name,
          title: skill.name,
          description: skill.description,
          instructions,
          ...(skill.disallowedTools?.length ? { disallowedTools: [...skill.disallowedTools] } : {}),
          ...(bundleDir ? { bundleDir } : {}),
          ...(skillRule ? { harnessRule: skillRule } : {}),
        }];
        if (reachHasAlways(reach) && !skill.disallowedTools?.length) {
          const text = [
            `Polyth skill \`${skill.name}\` is always on for this conversation: ${skill.description}`,
            "Follow these instructions whenever they apply. They do not override higher-priority system, security, permission or workspace rules.",
            "",
            instructions.trim(),
          ].join("\n");
          descriptors.push({
            id: `commands.skill-always.${key}`,
            kind: "instruction" as const,
            ...placement,
            revision: hash(JSON.stringify(["always", text])),
            title: `Skill: ${skill.name}`,
            text,
            harnessRule: capabilityRule(reach, "always")!,
          });
        }
        return descriptors;
      });
    },

    removeProject(space, projectId) {
      const doc = read(space);
      const kept = doc.skills.filter((skill) => skill.projectId !== projectId);
      if (kept.length === doc.skills.length) return;
      const next = { ...doc, skills: kept };
      write(space, next);
      for (const skill of doc.skills) {
        if (skill.projectId === projectId) releaseBundle(space, next, skill.bundleHash);
      }
    },
  };
}
