// One view of every skill this Polyth can reach: the ones it manages, which go to
// every harness, and the ones each harness has of its own. Vendor knowledge stays
// in each backend's `skills` manager; this file only sees that shared seam, so a
// new harness joins by declaring its folders.
import { homedir } from "node:os";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type {
  HarnessContext,
  HarnessProvider,
  HarnessRegistry,
  HarnessRosterItem,
  HarnessSnapshot,
  ProjectService,
  SpaceContext,
} from "@polyth/contracts";
import type {
  CapabilityInstallationScope,
  HarnessNativeSkillListDto,
  SkillAdoptInput,
  SkillDelivery,
  SkillFileDto,
  SkillFilePreviewDto,
  SkillHarnessDto,
  SkillInstallationDto,
  SkillLibraryDetailDto,
  SkillLibraryDto,
  SkillLibraryEntryDto,
  SkillLibraryNativeDto,
  SkillReachInput,
} from "@polyth/contracts/capability-installations";
import { harnessFamilyOf } from "@polyth/contracts";
import { parseSkillFile, skillDescription, skillListField, skillTextField } from "@polyth/harness-runtime/native-skills";
import { humanizeSkillName, type SkillCatalog } from "./skillCatalog.ts";
import { applyReachPatch, skillReach, type ReachPatch } from "./skillReach.ts";
import {
  bundleContentHash,
  previewFile,
  readFolderBundle,
  skillFileKind,
} from "./skillBundles.ts";
import type { SkillService, StoredSkill } from "./skills.ts";

const SNAPSHOT_WAIT_MS = 2_500;
const NATIVE_WAIT_MS = 8_000;
/** A harness's own list can take a CLI call, and which harnesses are installed
 * takes a probe of each, so a recent answer is used at once and refreshed behind it. */
const NATIVE_FRESH_MS = 15_000;
const INSTALLED_FRESH_MS = 60_000;
const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code });

/** Which providers this person may know about at all. */
export type HarnessVisibility = (provider: HarnessProvider) => boolean;

export interface SkillLibraryDeps {
  skills: SkillService;
  catalog: SkillCatalog;
  projects(space: SpaceContext): ProjectService;
  registry(): HarnessRegistry | undefined;
  now?(): number;
}

export interface SkillLibrary {
  /** `fresh` re-reads one harness's own skills, or every harness's (`true`).
   * Polyth's own skills are always read as they are. */
  list(space: SpaceContext, projectId: string | undefined, visible: HarnessVisibility, options?: { fresh?: string | true }): Promise<SkillLibraryDto>;
  detail(space: SpaceContext, projectId: string | undefined, name: string, visible: HarnessVisibility): Promise<SkillLibraryDetailDto>;
  file(space: SpaceContext, projectId: string | undefined, name: string, path: string, visible: HarnessVisibility): Promise<SkillFilePreviewDto>;
  /** Copies a skill out of one harness so Polyth delivers it to every harness. */
  adopt(space: SpaceContext, input: SkillAdoptInput, visible: HarnessVisibility): Promise<SkillInstallationDto>;
  /** Changes which harnesses get a managed skill. Choosing `some` keeps the
   * skill where it works now, which takes the harnesses this person can see. */
  setReach(space: SpaceContext, input: SkillReachInput, visible: HarnessVisibility): Promise<SkillInstallationDto>;
  /** Takes the source's current copy, whichever kind of source it is. */
  update(space: SpaceContext, scope: CapabilityInstallationScope, name: string, projectId: string | undefined, visible: HarnessVisibility): Promise<SkillInstallationDto>;
}

const withTimeout = async <T>(work: Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((done) => { timer = setTimeout(() => done(undefined), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const deliveryOf = async (provider: HarnessProvider, context: HarnessContext): Promise<{ delivery: SkillDelivery; enforcesBlockedTools: boolean }> => {
  try {
    const entry = (await provider.provisioner?.support(context))?.kinds.skill;
    const mode = entry?.modes.find((item) => item !== "unsupported");
    if (!entry || !mode || (context.remote && entry.remote === false)) return { delivery: "none", enforcesBlockedTools: false };
    return { delivery: mode === "prompt" ? "prompt" : "native", enforcesBlockedTools: entry.skillDisallowedTools === true };
  } catch {
    return { delivery: "none", enforcesBlockedTools: false };
  }
};

/** File rows for a folder without reading a byte of them. Links are not followed. */
function listFolder(dir: string): SkillFileDto[] {
  const rows: SkillFileDto[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current).sort()) {
      if (name === ".git" || name === "node_modules" || name === ".DS_Store" || name === ".polyth-owned") continue;
      const stat = lstatSync(join(current, name));
      const path = prefix ? `${prefix}/${name}` : name;
      if (stat.isDirectory()) walk(join(current, name), path);
      else if (stat.isFile() && rows.length < 2000) rows.push({ path, bytes: stat.size, kind: skillFileKind(path, (stat.mode & 0o111) !== 0) });
    }
  };
  walk(dir, "");
  return rows;
}

function readInside(dir: string, path: string): SkillFilePreviewDto {
  const root = resolve(dir);
  const target = resolve(root, path);
  if (!target.startsWith(root + sep)) throw fail("invalid-path", "file is outside this skill");
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw fail("not-found", "file not found");
  const executable = (stat.mode & 0o111) !== 0;
  if (skillFileKind(path, executable) === "binary") return { path, kind: "binary", bytes: stat.size };
  return previewFile(path, readFileSync(target), executable);
}

const withoutInstructions = (skill: StoredSkill): Omit<SkillInstallationDto, "instructions"> => {
  const { instructions: _instructions, bundleHash: _bundleHash, ...rest } = skill;
  return rest;
};

export function createSkillLibrary(deps: SkillLibraryDeps): SkillLibrary {
  const now = deps.now ?? Date.now;

  const contextOf = async (space: SpaceContext, projectId: string | undefined): Promise<HarnessContext> => {
    const base = { space, spaceId: space.spaceId };
    if (!projectId) return { ...base, projectId: "__default__", cwd: homedir(), remote: false };
    const project = await deps.projects(space).get(projectId);
    // Foreign and unknown IDs are intentionally indistinguishable.
    if (!project) throw fail("not-found", "project not found");
    return { ...base, projectId: project.id, cwd: project.path, remote: Boolean(project.remote) };
  };

  const missingCache = new Map<string, { at: number; ids: ReadonlySet<string>; refreshing?: boolean }>();
  const readMissing = async (key: string, registry: HarnessRegistry, context: HarnessContext): Promise<ReadonlySet<string>> => {
    const remember = (rows: readonly HarnessSnapshot[]) => {
      const ids = new Set(rows.filter((row) => row.availability.state === "not-installed").map((row) => row.identity.id));
      missingCache.set(key, { at: now(), ids });
      return ids;
    };
    // A slow probe finishes for the next read even when this one stops waiting.
    const work = registry.snapshots(context).then(remember);
    return (await withTimeout(work, SNAPSHOT_WAIT_MS).catch(() => undefined)) ?? new Set();
  };
  const missingHarnesses = async (registry: HarnessRegistry, context: HarnessContext): Promise<ReadonlySet<string>> => {
    const key = `${context.spaceId}\0${context.projectId}`;
    const cached = missingCache.get(key);
    if (!cached) return readMissing(key, registry, context);
    if (now() - cached.at >= INSTALLED_FRESH_MS && !cached.refreshing) {
      cached.refreshing = true;
      void readMissing(key, registry, context).catch(() => undefined).finally(() => { cached.refreshing = false; });
    }
    return cached.ids;
  };

  /** The harnesses added here: registered, open to this person, switched on, and
   * not known to be missing from this machine. Native checks that are still
   * running never hold the list back. */
  const addedHarnesses = async (context: HarnessContext, visible: HarnessVisibility) => {
    const registry = deps.registry();
    if (!registry) return [];
    const roster: HarnessRosterItem[] = await registry.roster(context).catch(() => []);
    const missing = await missingHarnesses(registry, context);
    const added: Array<{ provider: HarnessProvider; row: HarnessRosterItem }> = [];
    for (const row of roster) {
      if (!row.policy.enabled || missing.has(row.identity.id)) continue;
      const provider = registry.get(row.identity.id);
      if (provider && visible(provider)) added.push({ provider, row });
    }
    return added;
  };

  const nativeCache = new Map<string, { at: number; list: HarnessNativeSkillListDto; refreshing?: boolean }>();
  const readNative = async (key: string, provider: HarnessProvider, context: HarnessContext): Promise<HarnessNativeSkillListDto | undefined> => {
    try {
      const list = await withTimeout(provider.skills!.list(context), NATIVE_WAIT_MS);
      if (list) nativeCache.set(key, { at: now(), list });
      return list;
    } catch {
      nativeCache.delete(key);
      return undefined;
    }
  };
  /** Keyed by Space and project: another project's folders are another answer. */
  const nativeList = async (provider: HarnessProvider, context: HarnessContext, fresh: boolean): Promise<HarnessNativeSkillListDto | undefined> => {
    if (!provider.skills) return undefined;
    const key = `${context.spaceId}\0${context.projectId}\0${provider.descriptor.id}`;
    const cached = nativeCache.get(key);
    if (!cached || fresh) return readNative(key, provider, context);
    if (now() - cached.at >= NATIVE_FRESH_MS && !cached.refreshing) {
      cached.refreshing = true;
      void readNative(key, provider, context).finally(() => { cached.refreshing = false; });
    }
    return cached.list;
  };

  /** A project's copy overrides the Space's, as it does for the harnesses. */
  const effectiveManaged = (space: SpaceContext, projectId: string | undefined): Map<string, StoredSkill> => {
    const byName = new Map<string, StoredSkill>();
    const rows = deps.skills.listManaged(space, projectId);
    for (const skill of rows) if (skill.scope === "space") byName.set(skill.name, skill);
    for (const skill of rows) if (skill.scope === "project") byName.set(skill.name, skill);
    return byName;
  };

  const harnessOriginChanged = async (skill: StoredSkill, context: HarnessContext): Promise<boolean> => {
    if (skill.origin?.kind !== "harness") return false;
    try {
      const dir = await deps.registry()?.get(skill.origin.harnessId)?.skills?.locate?.(context, skill.origin.nativeName);
      return dir ? bundleContentHash(readFolderBundle(dir)) !== skill.origin.contentHash : false;
    } catch {
      return false;
    }
  };

  /** Reading those folders opens every `SKILL.md` in them, and they rarely hold
   * anything a harness has not already reported. */
  const discoveredCache = new Map<string, { at: number; rows: SkillInstallationDto[]; refreshing?: boolean }>();
  const readDiscovered = async (key: string, space: SpaceContext, projectId: string | undefined): Promise<SkillInstallationDto[]> => {
    const rows = (await deps.skills.list(space, projectId).catch(() => [])).filter((skill) => skill.readOnly);
    discoveredCache.set(key, { at: now(), rows });
    return rows;
  };
  const discoveredFolders = async (space: SpaceContext, projectId: string | undefined, fresh: boolean): Promise<SkillInstallationDto[]> => {
    const key = `${space.spaceId}\0${projectId ?? ""}`;
    const cached = discoveredCache.get(key);
    if (!cached || fresh) return readDiscovered(key, space, projectId);
    if (now() - cached.at >= NATIVE_FRESH_MS && !cached.refreshing) {
      cached.refreshing = true;
      void readDiscovered(key, space, projectId).finally(() => { cached.refreshing = false; });
    }
    return cached.rows;
  };

  const build = async (space: SpaceContext, projectId: string | undefined, visible: HarnessVisibility, fresh?: string | true) => {
    const context = await contextOf(space, projectId);
    const added = await addedHarnesses(context, visible);
    const lists = await Promise.all(added.map(({ provider }) =>
      nativeList(provider, context, fresh === true || fresh === provider.descriptor.id)));
    const rosterNames = new Map(added.map(({ row }) => [row.identity.id, row.identity.name]));
    const harnesses: SkillHarnessDto[] = await Promise.all(added.map(async ({ provider, row }, index) => {
      const list = lists[index];
      const family = harnessFamilyOf(row.identity);
      return {
        id: row.identity.id,
        name: row.identity.accountLabel && !row.identity.name.includes(row.identity.accountLabel)
          ? `${row.identity.name} · ${row.identity.accountLabel}`
          : row.identity.name,
        family,
        familyName: rosterNames.get(family) ?? deps.registry()?.get(family)?.descriptor.name ?? row.identity.defaultName ?? row.identity.name,
        ...(row.identity.accountLabel ? { accountLabel: row.identity.accountLabel } : {}),
        ...(row.identity.color ? { color: row.identity.color } : {}),
        ...await deliveryOf(provider, context),
        nativeSkills: !list?.supported ? "none" as const : list.control === "none" ? "listed" as const : "controlled" as const,
        inherits: Boolean(list?.inherit),
      };
    }));

    const entries = new Map<string, SkillLibraryEntryDto>();
    const entryFor = (name: string): SkillLibraryEntryDto => {
      let entry = entries.get(name);
      if (!entry) {
        const plain = name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
        entry = { name, title: humanizeSkillName(plain), description: "", natives: [] };
        entries.set(name, entry);
      }
      return entry;
    };

    const managed = effectiveManaged(space, projectId);
    await Promise.all([...managed.values()].map(async (skill) => {
      const entry = entryFor(skill.name);
      entry.managed = withoutInstructions(skill);
      entry.description = skill.description;
      const state = deps.catalog.originState(space, skill);
      if (state.catalogId) entry.catalogId = state.catalogId;
      if (state.avatar) entry.avatar = state.avatar;
      if (state.updateAvailable || await harnessOriginChanged(skill, context)) entry.updateAvailable = true;
    }));

    // A plugin's skill is `plugin:skill` to its harness and plain `skill` once
    // copied; those are one skill, and one row.
    const copiedAs = new Map([...managed.values()].flatMap((skill) =>
      (skill.origin?.kind === "harness" ? [[`${skill.origin.harnessId}\0${skill.origin.nativeName}`, skill.name]] : []) as Array<[string, string]>));
    added.forEach(({ provider }, index) => {
      const list = lists[index];
      if (!list?.supported) return;
      for (const skill of list.skills) {
        const entry = entryFor(copiedAs.get(`${provider.descriptor.id}\0${skill.name}`) ?? skill.name);
        if (!entry.description && skill.description) entry.description = skill.description;
        const native: SkillLibraryNativeDto = {
          harnessId: provider.descriptor.id,
          source: skill.source,
          enabled: skill.enabled,
          locked: list.control === "none" || skill.locked === true,
          importable: !skill.noFolder && Boolean(provider.skills?.locate),
          nativeName: skill.name,
        };
        entry.natives.push(native);
      }
    });

    // Folders no added harness claims, read for the `/name` fallback.
    for (const skill of await discoveredFolders(space, projectId, fresh === true)) {
      const known = entries.get(skill.name);
      if (known && (known.natives.length || known.managed)) continue;
      const entry = entryFor(skill.name);
      entry.description = skill.description;
      entry.discoveredIn = skill.scope;
    }
    return { context, added, harnesses, entries, managed };
  };

  /** A copied plugin skill goes by its plain name; its harness's name still finds it. */
  const entryNamed = (entries: ReadonlyMap<string, SkillLibraryEntryDto>, name: string): SkillLibraryEntryDto | undefined =>
    entries.get(name) ?? [...entries.values()].find((entry) => entry.natives.some((native) => native.nativeName === name));

  const dirOfNative = async (
    context: HarnessContext,
    added: ReadonlyArray<{ provider: HarnessProvider }>,
    entry: SkillLibraryEntryDto,
  ): Promise<string | undefined> => {
    for (const native of entry.natives) {
      if (!native.importable) continue;
      const provider = added.find((item) => item.provider.descriptor.id === native.harnessId)?.provider;
      const dir = await provider?.skills?.locate?.(context, native.nativeName);
      if (dir) return dir;
    }
    return undefined;
  };

  return {
    async list(space, projectId, visible, options) {
      const { harnesses, entries } = await build(space, projectId, visible, options?.fresh);
      return {
        harnesses,
        skills: [...entries.values()].sort((a, b) => a.title.localeCompare(b.title)),
        access: {
          ...deps.skills.access(space),
          sources: deps.skills.access(space).space,
          // The route that knows the caller decides this.
          nativePolicy: false,
        },
      };
    },

    async detail(space, projectId, name, visible) {
      const { context, added, entries, managed } = await build(space, projectId, visible);
      const entry = entryNamed(entries, name);
      if (!entry) throw fail("not-found", "skill not found");
      const stored = managed.get(entry.name);
      if (stored) {
        const dir = deps.skills.bundleDir(space, stored);
        return {
          entry,
          instructions: stored.instructions,
          files: dir ? listFolder(dir) : [],
          ...(stored.origin?.kind === "catalog" && stored.origin.url ? { url: stored.origin.url } : {}),
        };
      }
      const dir = await dirOfNative(context, added, entry);
      if (dir) {
        return { entry, instructions: parseSkillFile(readFileSync(join(dir, "SKILL.md"), "utf8")).body, files: listFolder(dir) };
      }
      const discovered = (await deps.skills.list(space, projectId)).find((skill) => skill.name === entry.name);
      // A plugin's skill has no folder Polyth can read; its description is all there is.
      return { entry, instructions: discovered?.instructions ?? "", files: [] };
    },

    async file(space, projectId, name, path, visible) {
      const { context, added, entries, managed } = await build(space, projectId, visible);
      const entry = entryNamed(entries, name);
      if (!entry) throw fail("not-found", "skill not found");
      const stored = managed.get(entry.name);
      const dir = stored ? deps.skills.bundleDir(space, stored) : await dirOfNative(context, added, entry);
      if (!dir) throw fail("not-found", "file not found");
      return readInside(dir, path);
    },

    async adopt(space, input, visible) {
      const context = await contextOf(space, input.projectId);
      const provider = deps.registry()?.get(input.harnessId);
      if (!provider || !visible(provider)) throw fail("not-found", "harness not found");
      const dir = await provider.skills?.locate?.(context, input.name);
      if (!dir) throw fail("not-found", "this skill has no folder Polyth can copy");
      const files = readFolderBundle(dir);
      const main = files.find((file) => file.path === "SKILL.md");
      if (!main) throw fail("invalid-input", "this skill has no instructions");
      const text = main.bytes.toString("utf8");
      const parsed = parseSkillFile(text);
      const description = skillTextField(parsed, "description") ?? skillDescription(text);
      if (!description) throw fail("invalid-input", "this skill has no description, so an agent could not tell when to use it");
      const disallowedTools = skillListField(parsed, "disallowed-tools");
      return deps.skills.installCopy(space, input.scope, {
        // A plugin's namespace means nothing to the other harnesses.
        name: input.name.includes(":") ? input.name.slice(input.name.lastIndexOf(":") + 1) : input.name,
        description: description.length > 1024 ? `${description.slice(0, 1023)}…` : description,
        instructions: parsed.body,
        ...(disallowedTools.length ? { disallowedTools } : {}),
        origin: {
          kind: "harness",
          harnessId: provider.descriptor.id,
          harnessName: provider.descriptor.name,
          nativeName: input.name,
          contentHash: bundleContentHash(files),
          installedAt: now(),
        },
        files,
        ...(input.replace ? { replace: true } : {}),
      }, input.projectId);
    },

    async setReach(space, input, visible) {
      const patches = [input.default !== undefined, input.family !== undefined, input.harness !== undefined].filter(Boolean).length;
      if (patches !== 1) throw fail("invalid-input", "change one of default, family or harness");
      const projectId = input.scope === "project" ? input.projectId : undefined;
      const stored = deps.skills.listManaged(space, projectId).find((skill) =>
        skill.name === input.name && skill.scope === input.scope && (input.scope === "space" || skill.projectId === projectId));
      if (!stored) throw fail("not-found", "skill not found");
      const context = await contextOf(space, projectId);
      const harnesses = (await addedHarnesses(context, visible)).map(({ row }) => ({ id: row.identity.id, family: harnessFamilyOf(row.identity) }));
      const patch: ReachPatch = input.default !== undefined
        ? { default: input.default }
        : input.family !== undefined
          ? { family: input.family }
          : { harness: input.harness! };
      const reach = applyReachPatch(skillReach(stored), patch, harnesses);
      return deps.skills.setReach(space, input.scope, input.name, reach, input.projectId, stored.revision);
    },

    async update(space, scope, name, projectId, visible) {
      const stored = deps.skills.listManaged(space, projectId).find((skill) =>
        skill.name === name && skill.scope === scope && (scope === "space" || skill.projectId === projectId));
      if (!stored?.origin) throw fail("not-found", "this skill has no source to update from");
      if (stored.origin.kind === "catalog") return deps.catalog.update(space, scope, name, projectId);
      return this.adopt(space, { harnessId: stored.origin.harnessId, name: stored.origin.nativeName, scope, ...(projectId ? { projectId } : {}) }, visible);
    },
  };
}
