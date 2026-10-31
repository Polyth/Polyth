// Polyth-owned policy for a harness's own skills, plus the folder discovery
// every backend shares. Vendor folder layouts and launch options stay in the
// backend; this module never writes a harness's native files.
import { mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { atomicWrite } from "@polyth/plugins";
import type {
    HarnessNativeSkillDto,
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

const DEFAULT_POLICY: NativeSkillPolicy = { inherit: false, muted: [] };

/** Reads the stored policy. A missing or unreadable file is the safe default:
 * nothing native is inherited. */
export async function readNativeSkillPolicy(file: string): Promise<NativeSkillPolicy> {
    try {
        const raw = JSON.parse(await readFile(file, "utf8")) as Partial<NativeSkillPolicy> | null;
        return {
            inherit: raw?.inherit === true,
            muted: Array.isArray(raw?.muted)
                ? raw.muted.filter((name): name is string => !nativeSkillNameError(name)).slice(0, MAX_SKILLS)
                : [],
        };
    }
    catch {
        return { ...DEFAULT_POLICY, muted: [] };
    }
}

export async function updateNativeSkillPolicy(file: string, patch: HarnessNativeSkillPolicyPatch): Promise<NativeSkillPolicy> {
    const current = await readNativeSkillPolicy(file);
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

/** First `description:` of a SKILL.md front matter, single line, trimmed. */
export function skillDescription(text: string): string | undefined {
    const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const line = front?.[1]?.split(/\r?\n/).find((entry) => /^description\s*:/.test(entry));
    const value = line?.replace(/^description\s*:\s*/, "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
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
