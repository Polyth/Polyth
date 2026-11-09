// Polyth-owned policy for a harness's own skills, plus the folder discovery
// every backend shares. Vendor folder layouts and launch options stay in the
// backend; this module never writes a harness's native files.
import { mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { atomicWrite } from "@polyth/plugins";
import type { HarnessContext } from "@polyth/contracts";
import type {
    HarnessNativeSkillDto,
    HarnessNativeSkillListDto,
    HarnessNativeSkillManager,
    HarnessNativeSkillPolicyPatch,
    HarnessNativeSkillSource,
} from "@polyth/contracts/capability-installations";

const MAX_SKILLS = 500;
const MAX_NAME = 200;
const MAX_DESCRIPTION = 300;
const MAX_SKILL_FILE = 64 * 1024;

const coded = (message: string, code: string): Error => Object.assign(new Error(message), { code });

/** A skill name as the harness matches it: `name` or `plugin:name`. */
export const nativeSkillNameError = (name: unknown): string | undefined => {
    if (typeof name !== "string" || !name) return "Skill name is required.";
    if (name.length > MAX_NAME) return "Skill name is too long.";
    if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]*$/.test(name)) return "Skill name contains unsupported characters.";
    return undefined;
};

export function readNativeSkillPatch(input: Record<string, unknown>): HarnessNativeSkillPolicyPatch {
    const patch: HarnessNativeSkillPolicyPatch = {};
    if (input.inherit !== undefined) {
        if (typeof input.inherit !== "boolean") throw coded("inherit must be true or false", "invalid-input");
        patch.inherit = input.inherit;
    }
    if (input.skill !== undefined) {
        const skill = input.skill as Record<string, unknown> | null;
        if (!skill || typeof skill !== "object" || Array.isArray(skill)) throw coded("skill must be an object", "invalid-input");
        const error = nativeSkillNameError(skill.name);
        if (error) throw coded(error, "invalid-input");
        if (typeof skill.enabled !== "boolean") throw coded("skill.enabled must be true or false", "invalid-input");
        patch.skill = { name: skill.name as string, enabled: skill.enabled };
    }
    if (patch.inherit === undefined && !patch.skill) throw coded("Nothing to change", "invalid-input");
    return patch;
}

export interface NativeSkillPolicy {
    /** Offer the harness's own skills to its model. */
    inherit: boolean;
    /** Inherited skills the Space muted, by harness-matched name. */
    muted: string[];
}

/** Reads the stored policy. With no stored choice (no file, or a file without
 * `inherit`) the harness's own default applies; an unreadable file is the
 * safe default: nothing native is inherited. */
export async function readNativeSkillPolicy(file: string, defaultInherit = false): Promise<NativeSkillPolicy> {
    let text: string;
    try {
        text = await readFile(file, "utf8");
    }
    catch (error) {
        return { inherit: (error as NodeJS.ErrnoException).code === "ENOENT" && defaultInherit, muted: [] };
    }
    try {
        const raw = JSON.parse(text) as Partial<NativeSkillPolicy> | null;
        return {
            inherit: typeof raw?.inherit === "boolean" ? raw.inherit : defaultInherit,
            muted: Array.isArray(raw?.muted)
                ? raw.muted.filter((name): name is string => !nativeSkillNameError(name)).slice(0, MAX_SKILLS)
                : [],
        };
    }
    catch {
        return { inherit: false, muted: [] };
    }
}

/** Applies one change and stores the whole policy, `inherit` included, so a
 * later change of the harness default never flips a Space that chose. */
export async function updateNativeSkillPolicy(file: string, patch: HarnessNativeSkillPolicyPatch, defaultInherit = false): Promise<NativeSkillPolicy> {
    const current = await readNativeSkillPolicy(file, defaultInherit);
    const muted = new Set(current.muted);
    if (patch.skill) {
        if (patch.skill.enabled) muted.delete(patch.skill.name);
        else muted.add(patch.skill.name);
    }
    const next: NativeSkillPolicy = {
        inherit: patch.inherit ?? current.inherit,
        muted: [...muted].sort().slice(0, MAX_SKILLS),
    };
    await mkdir(dirname(file), { recursive: true });
    await atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`, 0o600);
    return next;
}

export interface ParsedSkillFile {
    /** Top-level front-matter fields. A list keeps its items; nested maps are dropped. */
    fields: Record<string, string | string[]>;
    /** Everything after the front matter. The whole file when it has none. */
    body: string;
}

const unquote = (value: string): string => {
    if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
        try {
            const parsed = JSON.parse(value) as unknown;
            if (typeof parsed === "string") return parsed;
        }
        catch {
            // A YAML-only escape: fall through to the plain inner text.
        }
        return value.slice(1, -1);
    }
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
    return value;
};

/** The small YAML subset skill front matter uses: scalars, quoted scalars, block
 * scalars (`|`, `>`, with chomping), multi-line plain scalars, inline and dash
 * lists. Untrusted input, so it is never evaluated and a malformed file simply
 * yields fewer fields. */
export function parseSkillFile(raw: string): ParsedSkillFile {
    const source = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    const opening = source.match(/^---[ \t]*\n/);
    if (!opening) return { fields: {}, body: source.trim() };
    const start = opening[0].length;
    const closing = /\n---[ \t]*(?:\n|$)/g;
    closing.lastIndex = start - 1;
    const match = closing.exec(source);
    if (!match) return { fields: {}, body: source.trim() };
    const lines = source.slice(start, match.index).split("\n");
    const fields: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>;
    for (let index = 0; index < lines.length; index++) {
        const head = lines[index]!.match(/^([A-Za-z0-9_-]+)[ \t]*:(?:[ \t]+(.*))?$/);
        if (!head) continue;
        const key = head[1]!;
        const value = (head[2] ?? "").replace(/[ \t]+#.*$/, "").trim();
        const nested: string[] = [];
        while (index + 1 < lines.length && (/^[ \t]+/.test(lines[index + 1]!) || !lines[index + 1]!.trim())) {
            nested.push(lines[++index]!);
        }
        const block = value.match(/^([|>])[+-]?\d*$/);
        if (block) {
            const present = nested.filter((line) => line.trim());
            const indent = Math.min(...present.map((line) => line.match(/^[ \t]*/)![0].length));
            const text = nested.map((line) => line.slice(indent).trimEnd());
            fields[key] = (block[1] === "|" ? text.join("\n") : text.join(" ").replace(/ {2,}/g, " ")).trim();
            continue;
        }
        if (!value && nested.some((line) => /^[ \t]*-[ \t]+/.test(line))) {
            fields[key] = nested.flatMap((line) => {
                const item = line.match(/^[ \t]*-[ \t]+(.*)$/);
                return item ? [unquote(item[1]!.trim())] : [];
            }).filter(Boolean);
            continue;
        }
        if (value.startsWith("[") && value.endsWith("]")) {
            fields[key] = value.slice(1, -1).split(",").map((item) => unquote(item.trim())).filter(Boolean);
            continue;
        }
        // A plain scalar may run on over indented lines. A nested map has no
        // value on its own line, so it is dropped rather than read as text.
        if (!value) continue;
        const continued = nested.map((line) => line.trim()).filter(Boolean);
        fields[key] = unquote([value, ...continued].join(" "));
    }
    return { fields, body: source.slice(match.index + match[0].length).trim() };
}

/** A field that should be one line of text, or undefined. */
export const skillTextField = (parsed: ParsedSkillFile, key: string): string | undefined => {
    const value = parsed.fields[key];
    const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    return text || undefined;
};

/** A field holding tool names: a list, or one comma- or space-separated line. */
export const skillListField = (parsed: ParsedSkillFile, key: string): string[] => {
    const value = parsed.fields[key];
    const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\s]+/) : [];
    return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
};

/** The description of a SKILL.md, one line and capped for a list. */
export function skillDescription(text: string): string | undefined {
    const value = skillTextField(parseSkillFile(text), "description");
    if (!value) return undefined;
    return value.length > MAX_DESCRIPTION ? `${value.slice(0, MAX_DESCRIPTION - 1)}…` : value;
}

/** Skills in one `<root>/<name>/SKILL.md` folder. Entries that resolve
 * outside the root (symlink escape) are skipped, never followed. */
export async function scanSkillFolder(
    root: string,
    source: HarnessNativeSkillSource,
    options: { prefix?: string; plugin?: string } = {},
): Promise<Omit<HarnessNativeSkillDto, "enabled">[]> {
    let names: string[];
    let realRoot: string;
    try {
        realRoot = await realpath(root);
        names = (await readdir(realRoot, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
            .map((entry) => entry.name)
            .filter((name) => !name.startsWith("."))
            .sort();
    }
    catch {
        return [];
    }
    const found: Omit<HarnessNativeSkillDto, "enabled">[] = [];
    for (const name of names.slice(0, MAX_SKILLS)) {
        const qualified = `${options.prefix ?? ""}${name}`;
        if (nativeSkillNameError(qualified)) continue;
        let text: string;
        try {
            const file = await realpath(join(realRoot, name, "SKILL.md"));
            if (!file.startsWith(realRoot + sep)) continue;
            text = (await readFile(file, "utf8")).slice(0, MAX_SKILL_FILE);
        }
        catch {
            continue;
        }
        const description = skillDescription(text);
        found.push({
            name: qualified,
            source,
            ...(description ? { description } : {}),
            ...(options.plugin ? { plugin: options.plugin } : {}),
        });
    }
    return found;
}

/** Applies a policy to discovered skills. Earlier sources win a name clash. */
export function applyNativeSkillPolicy(
    discovered: readonly Omit<HarnessNativeSkillDto, "enabled">[],
    policy: NativeSkillPolicy,
): HarnessNativeSkillDto[] {
    const muted = new Set(policy.muted);
    const seen = new Set<string>();
    const rows: HarnessNativeSkillDto[] = [];
    for (const skill of discovered) {
        if (seen.has(skill.name)) continue;
        seen.add(skill.name);
        rows.push({ ...skill, enabled: policy.inherit && !muted.has(skill.name) });
    }
    return rows;
}

/** Why this target has no native skills Polyth can read, or undefined. They live
 * in the host's own folders, so only a local single-user Polyth may see them. */
export const nativeSkillsUnavailable = (context: HarnessContext, harnessName: string): string | undefined =>
    context.remote ? `${harnessName} skills are only read on this host`
        : !context.space || context.space.deployment !== "local-trusted"
            ? `Reading ${harnessName}'s own skills is available on a local, single-user Polyth only`
            : undefined;

/** One place a harness's CLI reads skills from. */
export interface NativeSkillFolder {
    root: string;
    source: HarnessNativeSkillSource;
}

/** A harness's folders in the order it reads them: this project's (when the
 * target has one), then the person's, then what ships with the harness. */
export function nativeSkillFolders(
    context: Pick<HarnessContext, "projectId" | "cwd">,
    spec: { project?: readonly string[]; user?: readonly string[]; bundled?: readonly string[] },
): NativeSkillFolder[] {
    const inProject = context.projectId && context.projectId !== "__default__";
    return [
        ...(inProject ? (spec.project ?? []).map((path) => ({ root: join(context.cwd, path), source: "project" as const })) : []),
        ...(spec.user ?? []).map((root) => ({ root, source: "user" as const })),
        ...(spec.bundled ?? []).map((root) => ({ root, source: "bundled" as const })),
    ];
}

/** The folder of a named skill among `folders`, confined like the scan. */
async function locateInFolders(folders: readonly NativeSkillFolder[], name: string): Promise<string | undefined> {
    if (nativeSkillNameError(name) || name.includes(":")) return undefined;
    for (const folder of folders) {
        try {
            const realRoot = await realpath(folder.root);
            const file = await realpath(join(realRoot, name, "SKILL.md"));
            if (file.startsWith(realRoot + sep)) return dirname(file);
        }
        catch {
            // Not in this folder: the next one may have it.
        }
    }
    return undefined;
}

/** Manager for a harness that loads its skills by itself and offers no way to
 * filter them per launch. Polyth lists them truthfully, read-only, and they can
 * be copied into Polyth to reach every other harness. Vendor folder layouts stay
 * in the backend. Earlier folders win a name clash, as they do in the scan. */
export function createFolderSkillManager(options: {
    harnessId: string;
    harnessName: string;
    folders(context: HarnessContext): readonly NativeSkillFolder[] | Promise<readonly NativeSkillFolder[]>;
}): HarnessNativeSkillManager {
    const unavailable = (context: HarnessContext) => nativeSkillsUnavailable(context, options.harnessName);
    return {
        async list(context): Promise<HarnessNativeSkillListDto> {
            const reason = unavailable(context);
            const found = reason ? [] : (await Promise.all((await options.folders(context)).map((folder) =>
                scanSkillFolder(folder.root, folder.source)))).flat();
            return {
                harnessId: options.harnessId,
                inherit: !reason,
                skills: applyNativeSkillPolicy(found, { inherit: true, muted: [] }).map((skill) => ({ ...skill, locked: true })),
                supported: !reason,
                ...(reason ? { unsupportedReason: reason } : {}),
                applies: "next-session",
                checkedAt: Date.now(),
                control: "none",
            };
        },
        async update() {
            throw Object.assign(
                new Error(`${options.harnessName} loads its own skills by itself; remove the skill from its folder to turn it off`),
                { code: "unsupported" },
            );
        },
        async locate(context, name) {
            if (unavailable(context)) return undefined;
            return locateInFolders(await options.folders(context), name);
        },
    };
}

/** `locate` for a harness whose list comes from somewhere else (Claude Code). */
export const locateNativeSkill = locateInFolders;
