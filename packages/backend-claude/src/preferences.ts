// Space preferences for one Claude Code harness: whether Claude predicts the
// next prompt, and whether its own skills are inherited. Polyth owns these;
// Claude's native settings files are never edited.
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { HarnessContext, HarnessControlDescriptor, JsonValue } from "@polyth/contracts";
import type {
    HarnessNativePluginManager,
    HarnessNativeSkillDto,
    HarnessNativeSkillListDto,
    HarnessNativeSkillManager,
} from "@polyth/contracts/capability-installations";
import {
    applyNativeSkillPolicy,
    readNativeSkillPolicy,
    scanSkillFolder,
    updateNativeSkillPolicy,
} from "@polyth/harness-runtime/native-skills";
import { atomicWrite } from "@polyth/plugins";
import { DEFAULT_CLAUDE_LAUNCH_PREFERENCES, type ClaudeLaunchPreferences } from "./index.ts";

export const PROMPT_SUGGESTIONS_CONTROL = "prompt-suggestions";

export interface ClaudePreferenceFiles {
    /** Directory of this harness's preference files in the request's Space,
     * or undefined when there is no local Space. */
    dir(context: HarnessContext): string | undefined;
}

/** Native skills reach a Space only on the single-operator local profile:
 * shared-server Spaces never inherit capabilities from the host's HOME. */
export const nativeSkillsUnsupported = (context: HarnessContext): string | undefined =>
    context.remote ? "Claude Code skills are only read on this host"
        : !context.space || context.space.deployment !== "local-trusted"
            ? "Inheriting Claude Code's own skills is available on a local, single-user Polyth only"
            : undefined;

async function readPromptSuggestions(file: string): Promise<boolean> {
    try {
        const value = JSON.parse(await readFile(file, "utf8")) as { promptSuggestions?: unknown } | null;
        return value?.promptSuggestions !== false;
    }
    catch {
        return DEFAULT_CLAUDE_LAUNCH_PREFERENCES.promptSuggestions;
    }
}

export function promptSuggestionsControl(enabled: boolean): HarnessControlDescriptor {
    return {
        id: PROMPT_SUGGESTIONS_CONTROL,
        label: "Prompt suggestions",
        description: "After each reply Claude Code predicts what you might ask next. Press Tab in an empty composer to use it. Suggestions reuse the reply's prompt cache.",
        kind: "toggle",
        scope: "harness",
        placement: "harness-settings",
        applySemantics: "new-session-only",
        danger: "none",
        available: true,
        value: enabled,
    };
}

export function createClaudePreferences(options: {
    harnessId: string;
    files: ClaudePreferenceFiles;
    /** The account's Claude configuration directory. */
    configDir(): string;
    plugins: HarnessNativePluginManager;
}) {
    const file = (context: HarnessContext, name: string): string | undefined => {
        const dir = options.files.dir(context);
        return dir ? join(dir, name) : undefined;
    };
    const suggestionsFile = (context: HarnessContext) => file(context, "preferences.json");
    const skillsFile = (context: HarnessContext) => file(context, "native-skills.json");

    const promptSuggestions = async (context: HarnessContext): Promise<boolean> => {
        const path = suggestionsFile(context);
        return path ? readPromptSuggestions(path) : DEFAULT_CLAUDE_LAUNCH_PREFERENCES.promptSuggestions;
    };

    const discover = async (context: HarnessContext): Promise<Omit<HarnessNativeSkillDto, "enabled">[]> => {
        const project = context.projectId && context.projectId !== "__default__"
            ? await scanSkillFolder(join(context.cwd, ".claude", "skills"), "project")
            : [];
        const user = await scanSkillFolder(join(options.configDir(), "skills"), "user");
        // Skills of plugins that are installed and turned on in Claude itself.
        const plugin: Omit<HarnessNativeSkillDto, "enabled">[] = [];
        try {
            const list = await options.plugins.list(context);
            for (const row of list.plugins) {
                if (row.enabled !== true) continue;
                const skills = row.components?.find((component) => component.kind === "skill");
                for (const name of skills?.names ?? []) {
                    plugin.push({ name: `${row.name}:${name}`, source: "plugin", plugin: row.id });
                }
            }
        }
        catch {
            // Plugin skills are optional discovery; folder skills still list.
        }
        return [...project, ...user, ...plugin];
    };

    const skills: HarnessNativeSkillManager = {
        async list(context): Promise<HarnessNativeSkillListDto> {
            const unsupported = nativeSkillsUnsupported(context);
            const path = skillsFile(context);
            const policy = path && !unsupported ? await readNativeSkillPolicy(path) : { inherit: false, muted: [] };
            return {
                harnessId: options.harnessId,
                inherit: policy.inherit,
                skills: unsupported ? [] : applyNativeSkillPolicy(await discover(context), policy),
                supported: !unsupported,
                ...(unsupported ? { unsupportedReason: unsupported } : {}),
                applies: "next-session",
                checkedAt: Date.now(),
            };
        },
        async update(context, patch) {
            const unsupported = nativeSkillsUnsupported(context);
            if (unsupported) throw Object.assign(new Error(unsupported), { code: "unsupported" });
            const path = skillsFile(context);
            if (!path) throw Object.assign(new Error("Local Space context required"), { code: "unsupported" });
            await updateNativeSkillPolicy(path, patch);
            return skills.list(context);
        },
    };

    return {
        skills,
        promptSuggestions,
        async controls(context: HarnessContext): Promise<HarnessControlDescriptor[]> {
            return suggestionsFile(context) ? [promptSuggestionsControl(await promptSuggestions(context))] : [];
        },
        async applyControl(context: HarnessContext, controlId: string, value: JsonValue): Promise<void> {
            if (controlId !== PROMPT_SUGGESTIONS_CONTROL) {
                throw Object.assign(new Error(`Unsupported Claude Code control: ${controlId}`), { code: "unsupported" });
            }
            if (typeof value !== "boolean") throw Object.assign(new Error("Prompt suggestions must be on or off"), { code: "invalid-control" });
            const path = suggestionsFile(context);
            if (!path) throw Object.assign(new Error("Local Space context required"), { code: "unsupported" });
            await mkdir(dirname(path), { recursive: true });
            await atomicWrite(path, `${JSON.stringify({ version: 1, promptSuggestions: value }, null, 2)}\n`, 0o600);
        },
        /** Everything one native launch needs, read fresh for each query. */
        async launch(context: HarnessContext): Promise<ClaudeLaunchPreferences> {
            const unsupported = nativeSkillsUnsupported(context);
            const path = skillsFile(context);
            const policy = path && !unsupported ? await readNativeSkillPolicy(path) : { inherit: false, muted: [] };
            return { promptSuggestions: await promptSuggestions(context), inheritSkills: policy.inherit, mutedSkills: policy.muted };
        },
    };
}

/** Claude's configuration directory for an account (`CLAUDE_CONFIG_DIR`) or
 * the user's own `~/.claude`. */
export const claudeConfigDir = (accountDir?: string): string =>
    accountDir || process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
