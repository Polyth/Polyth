// Claude Code's own plugin system, read and managed in its native scope.
//
// Listing uses the CLI's machine-readable reports; components come from a
// bounded, symlink-confined read of each installed plugin directory. Every
// mutation is one `claude plugin …` command without `-y`/`--accept-command`:
// a marketplace-declared install command must be shown to a person, so it is
// refused here and reported as `confirmation-required`.
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HarnessContext, MutationOutcome } from "@polyth/contracts";
import type {
    HarnessNativePluginManager,
    NativePluginAction,
    NativePluginComponentDto,
    NativePluginDto,
    NativePluginListDto,
    NativePluginMarketplaceDto,
    NativePluginScope,
    NativePluginSupportDto,
} from "@polyth/contracts/capability-installations";
import { nativePluginRefError, readNativePluginCli, runNativePluginCli } from "@polyth/harness-runtime/native-plugins";

export interface ClaudeNativePluginsOptions {
    harnessId: string;
    /** The executable and its environment, including the account's `CLAUDE_CONFIG_DIR`. */
    resolveBinary(): Promise<{ command: string; env: NodeJS.ProcessEnv }>;
    /** The Space inherits Claude's own skills (Settings → Harnesses → Skills). */
    inheritsSkills?(context: HarnessContext): Promise<boolean>;
}

const ACTIONS: NativePluginAction[] = ["install", "uninstall", "enable", "disable", "update"];
const INSTALL_SCOPES: NativePluginScope[] = ["user", "project", "local"];
/** Scopes each command accepts for `--scope` (from `claude plugin <action> --help`, 2.1.x).
 * Only `update` can target the administrator's managed scope. */
const ACTION_SCOPES: Record<NativePluginAction, readonly NativePluginScope[]> = {
    install: INSTALL_SCOPES,
    uninstall: INSTALL_SCOPES,
    enable: INSTALL_SCOPES,
    disable: INSTALL_SCOPES,
    update: [...INSTALL_SCOPES, "managed"],
};
const LIST_SCOPES = new Set<NativePluginScope>(["user", "project", "local", "synced", "managed"]);
const READ_TIMEOUT_MS = 20_000;
const INSTALL_TIMEOUT_MS = 180_000;
const CHANGE_TIMEOUT_MS = 60_000;
const MAX_PLUGINS = 200;
const MAX_ENTRIES = 200;
const MAX_NAMES = 50;
const MAX_FILE_BYTES = 256 * 1024;
const LIST_SOURCE = "claude plugin list --json";
/** A marketplace-declared command needs a person's confirmation (`-y` or `--accept-command`). */
const CONFIRMATION = /--accept-command|--yes\b|(?:^|\s)-y\b|shownCommand|\bconfirmation\b/i;

const support = (context: HarnessContext): NativePluginSupportDto => ({
    actions: context.remote ? [] : [...ACTIONS],
    installScopes: context.remote ? [] : [...INSTALL_SCOPES],
    installHint: "plugin@marketplace",
    applies: "next-session",
    marketplaces: true,
});

const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
const parseArray = (stdout: string, what: string): unknown[] => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    }
    catch {
        throw Object.assign(new Error(`Claude Code returned an unreadable ${what}`), { code: "native-command-failed" });
    }
    if (!Array.isArray(parsed)) throw Object.assign(new Error(`Claude Code returned an unexpected ${what}`), { code: "native-command-failed" });
    return parsed;
};

/** Path inside `root` after resolving symlinks, or undefined if it escapes or is missing. */
const confined = async (root: string, path: string): Promise<string | undefined> => {
    try {
        const real = await realpath(path);
        return real === root || real.startsWith(root + sep) ? real : undefined;
    }
    catch {
        return undefined;
    }
};

const readBoundedJson = async (root: string, path: string): Promise<unknown> => {
    const file = await confined(root, path);
    if (!file) return undefined;
    try {
        const info = await lstat(file);
        if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined;
        return JSON.parse(await readFile(file, "utf8"));
    }
    catch {
        return undefined;
    }
};

const entries = async (root: string, path: string) => {
    const dir = await confined(root, path);
    if (!dir) return [];
    try {
        return (await readdir(dir, { withFileTypes: true })).slice(0, MAX_ENTRIES).map((entry) => ({ name: entry.name, path: join(dir, entry.name) }));
    }
    catch {
        return [];
    }
};

/** A manifest path value is relative to the plugin root and must stay inside it. */
const manifestPath = (root: string, value: unknown): string | undefined => {
    const path = text(value);
    if (!path || isAbsolute(path)) return undefined;
    const target = resolve(root, path);
    const rel = relative(root, target);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? target : undefined;
};

const names = (list: string[]) => list.slice(0, MAX_NAMES);

const skillComponent = async (root: string, inherited = false): Promise<NativePluginComponentDto | undefined> => {
    const found: string[] = [];
    for (const entry of await entries(root, join(root, "skills"))) {
        if (await confined(root, join(entry.path, "SKILL.md"))) found.push(entry.name);
    }
    return found.length ? {
        kind: "skill",
        count: found.length,
        names: names(found),
        ...(inherited ? {
            effect: "active" as const,
            reason: "This Space inherits Claude Code's own skills; muted skills stay hidden",
        } : {
            effect: "hidden-by-polyth" as const,
            reason: "Polyth starts Claude sessions with only its own skills. Turn on Inherit Claude Code skills in the Skills tab to offer these",
        }),
    } : undefined;
};

const markdownComponent = async (
    root: string,
    dir: string,
    kind: "command" | "agent",
): Promise<NativePluginComponentDto | undefined> => {
    const found = (await entries(root, join(root, dir)))
        .filter((entry) => entry.name.endsWith(".md"))
        .map((entry) => entry.name.slice(0, -3));
    if (!found.length) return undefined;
    return kind === "agent" ? {
        kind,
        count: found.length,
        names: names(found),
        effect: "hidden-by-polyth",
        reason: "Native subagents are disabled; Polyth delegates through its own child sessions",
    } : {
        kind,
        count: found.length,
        names: names(found),
        effect: "unknown",
        reason: "Not verified whether plugin commands still resolve under Polyth's skills allowlist",
    };
};

const hookComponent = async (root: string, manifest: Record<string, unknown> | undefined): Promise<NativePluginComponentDto | undefined> => {
    const declared = manifest?.hooks;
    const document = record(declared)
        ?? record(await readBoundedJson(root, manifestPath(root, declared) ?? join(root, "hooks", "hooks.json")));
    const events = record(document?.hooks) ?? {};
    let count = 0;
    for (const matchers of Object.values(events)) {
        if (!Array.isArray(matchers)) continue;
        for (const matcher of matchers) {
            const handlers = record(matcher)?.hooks;
            count += Array.isArray(handlers) ? handlers.length : 1;
        }
    }
    const eventNames = Object.keys(events).filter((name) => Array.isArray(events[name]));
    return count ? {
        kind: "hook",
        count,
        names: names(eventNames),
        effect: "active",
        reason: "Claude sessions load every settings source, so hooks of enabled plugins run on this host",
    } : undefined;
};

const mcpComponent = async (root: string, manifest: Record<string, unknown> | undefined): Promise<NativePluginComponentDto | undefined> => {
    const declared = manifest?.mcpServers;
    const document = record(declared)
        ?? record(await readBoundedJson(root, manifestPath(root, declared) ?? join(root, ".mcp.json")));
    // `.mcp.json` wraps servers in `mcpServers`; an inline manifest value is the map itself.
    const servers = record(document?.mcpServers) ?? (record(declared) ? document : undefined) ?? {};
    const serverNames = Object.keys(servers).filter((name) => record(servers[name]));
    return serverNames.length ? {
        kind: "mcp-server",
        count: serverNames.length,
        names: names(serverNames),
        effect: "active",
        reason: "Claude sessions load every settings source, so MCP servers of enabled plugins connect",
    } : undefined;
};

/** Reads what a plugin contributes. Only the plugin directory is read, and only
 * when it lies inside the account's Claude configuration directory. */
async function readComponents(configRoot: string | undefined, installPath: string, inheritedSkills = false): Promise<NativePluginComponentDto[] | undefined> {
    if (!configRoot || !isAbsolute(installPath)) return undefined;
    const root = await confined(configRoot, installPath);
    if (!root) return undefined;
    const manifest = record(await readBoundedJson(root, join(root, ".claude-plugin", "plugin.json")));
    const components = await Promise.all([
        skillComponent(root, inheritedSkills),
        markdownComponent(root, "commands", "command"),
        markdownComponent(root, "agents", "agent"),
        hookComponent(root, manifest),
        mcpComponent(root, manifest),
    ]);
    return components.filter((component): component is NativePluginComponentDto => Boolean(component));
}

const configRootFor = async (env: NodeJS.ProcessEnv): Promise<string | undefined> => {
    const dir = text(env.CLAUDE_CONFIG_DIR) ?? join(text(env.HOME) ?? homedir(), ".claude");
    try {
        return await realpath(dir);
    }
    catch {
        return undefined;
    }
};

const sourceFor = (marketplace: string | undefined, scope: NativePluginScope): NativePluginDto["source"] => {
    if (marketplace === "skills-dir") return { kind: "local" };
    if (!marketplace || scope === "synced") return { kind: "unknown" };
    return { kind: "marketplace", ref: marketplace };
};

export async function parseClaudePluginList(
    harnessId: string,
    stdout: string,
    context: Pick<HarnessContext, "cwd">,
    configRoot: string | undefined,
    inheritedSkills = false,
): Promise<{ plugins: NativePluginDto[]; warnings: string[] }> {
    const warnings: string[] = [];
    const rows = parseArray(stdout, "plugin list");
    if (rows.length > MAX_PLUGINS) warnings.push(`Showing the first ${MAX_PLUGINS} of ${rows.length} plugins`);
    const plugins: NativePluginDto[] = [];
    for (const row of rows.slice(0, MAX_PLUGINS)) {
        const entry = record(row);
        const id = text(entry?.id);
        const scope = text(entry?.scope) as NativePluginScope | undefined;
        if (!entry || !id) continue;
        if (!scope || !LIST_SCOPES.has(scope)) {
            warnings.push(`Skipped ${id}: unrecognized scope`);
            continue;
        }
        const at = id.lastIndexOf("@");
        const name = at > 0 ? id.slice(0, at) : id;
        const marketplace = at > 0 ? id.slice(at + 1) : undefined;
        const projectPath = text(entry.projectPath);
        const installPath = text(entry.installPath);
        const otherProject = (scope === "project" || scope === "local") && projectPath !== undefined && projectPath !== context.cwd;
        const synced = scope === "synced";
        // Claude can only update a managed plugin, and Polyth has one read-only
        // flag: offering a switch or Remove that always fails is worse.
        const managed = scope === "managed";
        const components = installPath ? await readComponents(configRoot, installPath, inheritedSkills) : undefined;
        plugins.push({
            harnessId,
            id,
            name,
            ...(text(entry.version) ? { version: text(entry.version) } : {}),
            source: sourceFor(marketplace, scope),
            scope,
            ...(projectPath ? { projectPath } : {}),
            enabled: typeof entry.enabled === "boolean" ? entry.enabled : "unknown",
            ...(components ? { components } : {}),
            evidence: { stage: "discovered", source: LIST_SOURCE },
            ...(otherProject || synced || managed ? { readOnly: true } : {}),
            ...(otherProject ? { note: `Installed for another project (${projectPath})` }
                : synced ? { note: "Synced from the Claude account; manage it in Claude" }
                : managed ? { note: "Set by an administrator in Claude's managed settings; it cannot be turned off or removed here" }
                : {}),
        });
    }
    return { plugins, warnings };
}

export function parseClaudeMarketplaces(stdout: string): NativePluginMarketplaceDto[] {
    return parseArray(stdout, "marketplace list").flatMap((row) => {
        const entry = record(row);
        const name = text(entry?.name);
        if (!entry || !name) return [];
        const source = text(entry.source);
        const ref = text(entry.repo) ?? text(entry.url);
        return [{ name, ...(source ? { source } : {}), ...(ref ? { ref } : {}) }];
    });
}

/** Builds the exact argv for one mutation, or a rejection before any process starts. */
export function claudePluginMutationArgs(
    input: { action: NativePluginAction; plugin: string; scope?: NativePluginScope },
): { args: string[] } | { code: string; message: string } {
    if (!ACTIONS.includes(input.action)) return { code: "unsupported", message: `Claude Code cannot ${String(input.action)} plugins` };
    const refError = nativePluginRefError(input.plugin);
    if (refError) return { code: "invalid-input", message: refError };
    const scope = input.scope ?? (input.action === "install" ? "user" : undefined);
    if (scope === "managed" && !ACTION_SCOPES[input.action].includes(scope)) {
        return { code: "unsupported", message: `Managed Claude Code plugins are set by an administrator; Claude Code cannot ${input.action} them` };
    }
    if (scope && !ACTION_SCOPES[input.action].includes(scope)) {
        return { code: "invalid-input", message: `Claude Code cannot ${input.action} a plugin in the ${scope} scope` };
    }
    return { args: ["plugin", input.action, input.plugin, ...(scope ? ["--scope", scope] : [])] };
}

export function createClaudeNativePlugins(options: ClaudeNativePluginsOptions): HarnessNativePluginManager {
    const { harnessId } = options;
    return {
        support,
        async list(context, listOptions) {
            if (context.remote) {
                return { harnessId, support: support(context), plugins: [], warnings: ["Claude Code plugins are only read on this host"], checkedAt: Date.now() };
            }
            const { command, env } = await options.resolveBinary();
            const read = (args: string[]) => readNativePluginCli({ command, args, env, cwd: context.cwd, timeoutMs: READ_TIMEOUT_MS, signal: listOptions?.signal });
            const [plugins, marketplaces] = await Promise.allSettled([
                read(["plugin", "list", "--json"]),
                read(["plugin", "marketplace", "list", "--json"]),
            ]);
            if (plugins.status === "rejected") throw plugins.reason;
            const inherited = await options.inheritsSkills?.(context).catch(() => false) ?? false;
            const parsed = await parseClaudePluginList(harnessId, plugins.value.stdout, context, await configRootFor(env), inherited);
            const result: NativePluginListDto = {
                harnessId,
                support: support(context),
                plugins: parsed.plugins,
                checkedAt: Date.now(),
            };
            const warnings = [...parsed.warnings];
            if (marketplaces.status === "fulfilled") {
                try {
                    result.marketplaces = parseClaudeMarketplaces(marketplaces.value.stdout);
                }
                catch (error) {
                    warnings.push((error as Error).message);
                }
            }
            else warnings.push("Claude Code marketplaces could not be read");
            if (warnings.length) result.warnings = warnings;
            return result;
        },
        async mutate(context, input, mutationOptions): Promise<MutationOutcome<{ pendingRestart: boolean; message?: string }>> {
            if (context.remote) return { kind: "rejected", code: "unsupported", message: "Claude Code plugins are only managed on this host" };
            const planned = claudePluginMutationArgs(input);
            if ("code" in planned) return { kind: "rejected", code: planned.code, message: planned.message };
            let binary: { command: string; env: NodeJS.ProcessEnv };
            try {
                binary = await options.resolveBinary();
            }
            catch (error) {
                return { kind: "rejected", code: "not-installed", message: (error as Error).message };
            }
            const outcome = await runNativePluginCli({
                command: binary.command,
                args: planned.args,
                env: binary.env,
                cwd: context.cwd,
                timeoutMs: input.action === "install" || input.action === "update" ? INSTALL_TIMEOUT_MS : CHANGE_TIMEOUT_MS,
                operationId: mutationOptions.operationId,
                ...(mutationOptions.signal ? { signal: mutationOptions.signal } : {}),
            });
            if (outcome.kind === "confirmed") {
                return { kind: "confirmed", value: { pendingRestart: false, message: "Applies to new Claude Code sessions" } };
            }
            if (outcome.kind === "rejected" && outcome.code === "native-command-failed" && CONFIRMATION.test(outcome.message)) {
                return {
                    kind: "rejected",
                    code: "confirmation-required",
                    message: `This plugin runs a marketplace-declared command that must be confirmed in a terminal with \`claude plugin ${input.action}\`. ${outcome.message}`.trim(),
                };
            }
            return outcome;
        },
    };
}
