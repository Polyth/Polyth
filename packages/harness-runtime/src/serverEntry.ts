import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type {
    AgentCapabilityContribution,
    AgentCapabilityContributionRegistry,
    AgentCapabilityDescriptor,
    Disposable,
    HarnessContext,
    HarnessDescriptor,
    HarnessProvisioningQuery,
    HarnessRegistry,
    HarnessSelection,
    HarnessSnapshot,
    HarnessUpdateStatus,
    HarnessVersionStore,
    JsonValue,
    ModelDescriptor,
    Project,
    RouteHandler,
} from "@polyth/contracts";
import { HARNESS_PERSON_DEFAULTS_SERVICE, harnessUsableByUser, type HarnessAccessRule, type HarnessPersonDefaults, type PersonHarnessDefaultDto, type SpaceContext } from "@polyth/contracts";
import {
    allowedHarnessesFor,
    hasHarnessManagerAuthority,
    hasInstanceOwnerAuthority,
    hasPersonalHarnessAuthority,
    requireHarnessManagerAuthority,
    requireInstanceOwnerAuthority,
} from "@polyth/contracts/instance-authority";
import { localOnlyRemoteAccess, packageDataDir, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { discoverHarnessExecutable, harnessExecutableChildEnv, windowsCmdShimFile, windowsCmdWrapperTarget } from "./executableDiscovery.ts";
import { createHarnessRegistry, type HarnessPreferences, harnessError } from "./index.ts";
import { createNativePluginRoutes } from "./nativePluginRoutes.ts";
import { readNativeSkillPatch } from "./nativeSkills.ts";
import { promptPrefixDiagnostics } from "./promptPrefixDiagnostics.ts";
import { createHarnessInstallJobs, createInstallContainment, installMachineOs, installSources, localInstallLauncher, remoteInstallLauncher, type HarnessInstallJobs, type InstallContainment, type InstallLauncher } from "./installJobs.ts";
import { forgetRemoteHarnessProbes, resolveRemoteHarnessHost } from "./remoteHost.ts";
import { browserOnServer, localSetupEnv, openSetupTerminal, previewSetupTerminal, readSetupAction, REMOTE_SETUP_PATH, requireSetupAuthority, setupCommand, setupTarget, type HarnessSetupTerminals } from "./setupTerminal.ts";
import { createHarnessUpdateChecker, harnessUpdateStatus } from "./updates.ts";
import { editionUnavailable, workstationEdition } from "./edition.ts";
import { pruneHarnessVersions, type HarnessVersionPrune } from "./versionStore.ts";

const MAX_HARNESS_SYSTEM_PROMPT = 64 * 1024;
type StoredHarnessPreference = {
    enabled?: boolean;
    priority?: number;
    systemPrompt?: string;
    title?: string;
    color?: string;
    privateSessions?: boolean;
};
type StoredHarnessPreferences = Record<string, StoredHarnessPreference>;
/** The account's OpenCode provider/model toggles ("Providers & Models").
 *  Applied to the catalog a picker receives, never to native discovery: the
 *  full list is still what validates existing routes and presets. */
interface ProviderVisibility {
    filter(models: ModelDescriptor[], opts?: { includeDisconnected?: boolean; userId?: string }): ModelDescriptor[];
}
type HarnessSystemPromptDescriptor = AgentCapabilityDescriptor & { targetHarnessId: string };
type ContextualCapabilityContribution = AgentCapabilityContribution & {
    resolveCapabilities(context: HarnessContext): readonly AgentCapabilityDescriptor[];
};
type HarnessProvisioningDiagnostics = HarnessProvisioningQuery & {
    desired?(context: HarnessContext): Promise<AgentCapabilityDescriptor[]>;
    reconcileSpace?(space: { spaceId: string }): Promise<unknown>;
};

export function readHarnessSelection(value: unknown): HarnessSelection {
    if (value && typeof value === "object") {
        const input = value as Record<string, unknown>;
        if (input.mode === "auto")
            return { mode: "auto" };
        if (input.mode === "pinned" && typeof input.harnessId === "string" && /^[a-z][a-z0-9-]*$/.test(input.harnessId))
            return { mode: "pinned", harnessId: input.harnessId };
    }
    throw harnessError("invalid-input", "Choose Auto or a registered harness");
}
export const MAX_HARNESS_TITLE = 48;
/** Validate one harness's title and color; an empty value clears it. */
export function readHarnessAppearance(value: unknown): { title?: string; color?: string } {
    const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
    if (input.title !== undefined && input.title !== null && typeof input.title !== "string")
        throw harnessError("invalid-input", "Harness title must be text");
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if ([...title].length > MAX_HARNESS_TITLE || /[\u0000-\u001f\u007f]/.test(title))
        throw harnessError("invalid-input", `Harness title must be one line up to ${MAX_HARNESS_TITLE} characters`);
    if (input.color !== undefined && input.color !== null && input.color !== "" && (typeof input.color !== "string" || !/^#[0-9a-f]{6}$/i.test(input.color)))
        throw harnessError("invalid-input", "Harness color must be a #rrggbb value");
    const color = typeof input.color === "string" && input.color ? input.color.toLowerCase() : "";
    return { ...(title ? { title } : {}), ...(color ? { color } : {}) };
}
async function readPreferences(file: string): Promise<StoredHarnessPreferences> {
    try {
        return JSON.parse(await readFile(file, "utf8")) as StoredHarnessPreferences;
    }
    catch (error) {
        if ((error as {
            code?: string;
        }).code === "ENOENT")
            return {};
        throw error;
    }
}
function readPreferencesSync(file: string): StoredHarnessPreferences {
    try {
        return JSON.parse(readFileSync(file, "utf8")) as StoredHarnessPreferences;
    }
    catch (error) {
        if ((error as { code?: string }).code === "ENOENT")
            return {};
        throw error;
    }
}
async function writePreferences(file: string, preferences: StoredHarnessPreferences): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(preferences), { mode: 0o600 });
    await rename(temporary, file);
}
const UPDATE_TIMEOUT_MS = 10 * 60_000;
const UPDATE_OUTPUT_TAIL = 4_000;
type HarnessRuntimeRestart = (space: HarnessContext["space"], harnessId: string) => Promise<{ restarted: number; failed: number }>;
type HarnessRuntimeReleaseIdle = (harnessId: string) => Promise<{ released: number; busy: number }>;

/** Windows cannot replace an executable that a running process has open, so
 *  a CLI's updater or installer fails while any chat still runs it (Grok's
 *  `grok.exe`, an npm shim's native program). Before replacing it, release
 *  this harness's idle chats (their next turn starts the new build) and refuse
 *  while one is still working, rather than run an updater bound to fail.
 *  Other systems replace a running file safely, so nothing is released there. */
export async function freeHarnessExecutable(
    host: Pick<ServerPackageHost, "services">,
    descriptor: Pick<HarnessDescriptor, "id" | "name">,
    platform: NodeJS.Platform = process.platform,
): Promise<{ released: number }> {
    if (platform !== "win32") return { released: 0 };
    const release = host.services.get(serverServiceKey<HarnessRuntimeReleaseIdle>("harness.runtime.releaseIdle"));
    if (!release) return { released: 0 };
    const { released, busy } = await release(descriptor.id);
    if (busy > 0) {
        throw harnessError("conflict", `${descriptor.name} is still working in ${busy === 1 ? "a chat" : `${busy} chats`}. Windows cannot replace a program while it runs; update once they finish.`);
    }
    return { released };
}
export type HarnessUpdateResult = { ok: boolean; exitCode: number | null; output: string; versions?: HarnessVersionPrune };

/** The npm package a harness CLI was installed from, and the command it
 *  installs when the update argv runs a package manager (default: `[0]`). */
export type HarnessUpdateNpmTarget = {
    npmPackage?: string;
    npmBin?: string;
    npmDistTag?: string;
    /** The npm to run instead of the one discovery finds. */
    npmCommand?: string;
};
/** Run a harness CLI's own self-update argv: resolved like the harness
 *  executable, no shell, stdin closed, bounded time and output. A CLI that
 *  npm installed (`npmPackage`) is updated by npm instead, into the npm
 *  prefix it lives in (`npm install -g <package>@<tag>`). After
 *  a successful update of a side-by-side install, the old versions no running
 *  process uses are removed (`versionStore`). */
export async function runHarnessUpdate(command: readonly string[], versionStore?: HarnessVersionStore, options: HarnessUpdateNpmTarget = {}): Promise<HarnessUpdateResult> {
    const result = await runUpdateCommand(command, options);
    if (!result.ok || !versionStore) return result;
    // The update moved the launcher to the new version; resolve it again.
    const { hit } = await discoverHarnessExecutable(command[0]!);
    const versions: HarnessVersionPrune = hit
        ? await pruneHarnessVersions(versionStore, hit.executablePath).catch((error: unknown) => ({ pruned: false as const, reason: String(error) }))
        : { pruned: false, reason: "the updated CLI was not found" };
    const removed = versions.pruned && versions.removed.length ? `\nRemoved old versions: ${versions.removed.join(", ")}` : "";
    return { ...result, output: `${result.output}${removed}`.slice(-UPDATE_OUTPUT_TAIL), versions };
}
/** Windows reports a crashed program as an NTSTATUS exit code, not a signal. */
const WINDOWS_CRASH_STATUS: Readonly<Record<number, string>> = {
    0xC000001D: "STATUS_ILLEGAL_INSTRUCTION",
    0xC0000005: "STATUS_ACCESS_VIOLATION",
    0xC0000135: "STATUS_DLL_NOT_FOUND",
    0xC0000409: "STATUS_STACK_BUFFER_OVERRUN",
};
/** The crash an update run's exit names, if it was one: a POSIX signal, or a
 *  Windows NTSTATUS such as an old build hitting an illegal instruction. */
export const updateCrashName = (signal: unknown, exitCode: number | null): string | undefined => {
    if (typeof signal === "string" && signal) return signal;
    const status = exitCode === null ? undefined : WINDOWS_CRASH_STATUS[exitCode >>> 0];
    return status ? `${status} (0x${(exitCode! >>> 0).toString(16).toUpperCase()})` : undefined;
};
const isFile = (path: string): Promise<boolean> => stat(path).then((entry) => entry.isFile(), () => false);
/**
 * The npm global prefix a CLI launcher belongs to, when npm installed
 * `packageName` there: `<prefix>\<bin>.cmd` beside `<prefix>\node_modules`
 * on Windows, `<prefix>/bin/<bin>` beside `<prefix>/lib/node_modules`
 * elsewhere. The launcher must lead into that package, so a standalone
 * binary next to a stale npm copy is not mistaken for it.
 */
export async function npmGlobalPrefixOf(
    hit: { executablePath: string; launcherPath?: string },
    packageName: string,
    platform: NodeJS.Platform = process.platform,
    hops = 2,
): Promise<string | undefined> {
    const launcher = hit.launcherPath ?? hit.executablePath;
    const launcherDir = dirname(launcher);
    const prefix = platform === "win32" ? launcherDir : dirname(launcherDir);
    const packageDir = join(prefix, ...(platform === "win32" ? [] : ["lib"]), "node_modules", ...packageName.split("/"));
    if (await isFile(join(packageDir, "package.json"))) {
        // A Windows npm launcher is a `.cmd` shim; follow it to the script it runs.
        const target = platform === "win32" ? await windowsCmdShimFile(launcher) : hit.executablePath;
        const [real, root] = target
            ? await Promise.all([realpath(target).catch(() => undefined), realpath(packageDir).catch(() => undefined)])
            : [];
        if (real && root && real.startsWith(`${root}${sep}`))
            return prefix;
    }
    if (platform !== "win32" || hops <= 0)
        return undefined;
    // Not npm's own shim: a `.cmd` wrapper on PATH (`~\.local\bin\codex.cmd`)
    // that starts the npm copy installed somewhere else. The CLI's updater
    // cannot tell how it was installed from there; the wrapper's target can.
    const target = await windowsCmdWrapperTarget(launcher);
    if (!target)
        return undefined;
    if (/\.(?:cmd|bat)$/i.test(target))
        return npmGlobalPrefixOf({ executablePath: target, launcherPath: target }, packageName, platform, hops - 1);
    // A file inside `<prefix>\node_modules\<package>`: that prefix counts only
    // when npm's shim for the package sits in it (not pnpm's or bun's store).
    const real = await realpath(target).catch(() => target);
    const at = real.indexOf([ "", "node_modules", ...packageName.split("/"), "" ].join(sep));
    if (at <= 0)
        return undefined;
    const candidate = real.slice(0, at);
    for (const entry of await readdir(candidate).catch(() => [] as string[])) {
        if (!/\.cmd$/i.test(entry))
            continue;
        const shim = join(candidate, entry);
        if (await npmGlobalPrefixOf({ executablePath: shim, launcherPath: shim }, packageName, platform, 0) === candidate)
            return candidate;
    }
    return undefined;
}
/** The npm prefix the update must install into, from the CLI's own install. */
async function updateNpmPrefix(hit: { executablePath: string; launcherPath?: string }, target: HarnessUpdateNpmTarget): Promise<string | undefined> {
    if (!target.npmPackage)
        return undefined;
    if (!target.npmBin)
        return npmGlobalPrefixOf(hit, target.npmPackage);
    const { hit: cli } = await discoverHarnessExecutable(target.npmBin);
    return cli ? npmGlobalPrefixOf(cli, target.npmPackage) : undefined;
}
async function runUpdateCommand(command: readonly string[], target: HarnessUpdateNpmTarget): Promise<HarnessUpdateResult> {
    const [binary, ...ownArgs] = command;
    if (!binary)
        throw harnessError("unsupported", "this harness has no update command");
    const { hit: found } = await discoverHarnessExecutable(binary);
    if (!found)
        throw harnessError("not-found", `${binary} is not installed`);
    // A CLI's self-updater runs `npm install -g`, which installs into npm's
    // configured prefix, not the one the CLI lives in. Polyth installs into
    // its own (`%LOCALAPPDATA%\Polyth\npm`, `~/.local`): Pi then refuses
    // ("not managed by a global npm install") and Codex would install a copy
    // nothing runs; a plain `npm install -g` (DeepSeek's dsh) the same.
    const prefix = await updateNpmPrefix(found, target);
    // A CLI that npm installed is updated the way it was installed: npm
    // itself, into that prefix. Each self-updater has its own idea of how it
    // was installed (Pi asks `npm root -g`, Codex wants its launcher's
    // environment) and refuses when that guess fails; Polyth already knows.
    // (An argv that already runs the package manager, `npmBin`, stays as is.)
    const npm = prefix && target.npmPackage && !target.npmBin ? (await discoverHarnessExecutable(target.npmCommand ?? "npm")).hit : undefined;
    const hit = npm ?? found;
    const args = npm ? ["install", "-g", `${target.npmPackage}@${target.npmDistTag ?? "latest"}`] : ownArgs;
    const env = await harnessExecutableChildEnv(hit.executablePath);
    // Without an npm to run, the self-updater still gets the right prefix.
    if (prefix) {
        for (const key of Object.keys(env))
            if (key.toLowerCase() === "npm_config_prefix")
                delete env[key];
        env.npm_config_prefix = prefix;
    }
    // Which program ran is the first question about a failed update (a CLI
    // found on PATH may not be the copy Polyth installed).
    // A `.cmd` wrapper hides the copy it starts; a failure names that too.
    const launcher = hit.launcherPath ?? hit.executablePath;
    const wrapped = !npm && process.platform === "win32" ? await windowsCmdWrapperTarget(launcher) : undefined;
    const ran = `Program: ${[launcher, ...(npm ? args : [])].join(" ")}${wrapped ? `\nIt starts: ${wrapped}` : ""}`;
    // npm installs Windows CLIs as `.cmd` shims, which only start through
    // `cmd.exe`; Node refuses them without a shell (spawn EINVAL). The argv is
    // the descriptor's fixed words; the path is quoted because the shell joins
    // it unquoted and `C:\Users\Jane Doe\…` would split.
    const shell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(hit.executablePath);
    return new Promise((resolve) => {
        try {
            const child = execFile(shell ? `"${hit.executablePath}"` : hit.executablePath, args, { env, shell, windowsHide: true, timeout: UPDATE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
                const output = `${stdout}${stderr}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim().slice(-UPDATE_OUTPUT_TAIL);
                const code = (error as { code?: unknown } | null)?.code;
                const exitCode = !error ? 0 : typeof code === "number" ? code : null;
                // A CLI that crashed (an old build hitting SIGILL on this CPU)
                // prints nothing; name the crash so the failure is legible.
                const crash = error ? updateCrashName((error as { signal?: unknown }).signal, exitCode) : undefined;
                const crashed = crash ? `${binary} stopped with ${crash}` : "";
                resolve({ ok: !error, exitCode, output: [output || (error && !crashed ? error.message : ""), crashed, error ? ran : ""].filter(Boolean).join("\n") });
            });
            child.stdin?.end();
        }
        catch (error) {
            // A launch Node refuses up front is a failed update, not a server error.
            resolve({ ok: false, exitCode: null, output: [error instanceof Error ? error.message : String(error), ran].join("\n") });
        }
    });
}
/** One background install per harness and machine: this one, or the SSH
 *  host whose own sign-in a remote project's chats run on. */
const installKey = (descriptor: HarnessDescriptor, project: Pick<Project, "remote"> | undefined): string =>
    setupTarget(descriptor, project) === "remote" && project?.remote?.kind === "ssh"
        ? `ssh:${project.remote.connectionId}:${descriptor.id}`
        : `local:${descriptor.id}`;
const prospectiveCandidate = (snapshot: HarnessSnapshot): boolean => {
    const state = snapshot.availability.state;
    return snapshot.policy.enabled
        && snapshot.policy.autoSelect
        && snapshot.availability.installed
        && snapshot.availability.healthy
        && snapshot.availability.authenticated !== false
        && (state === "ready" || state === "unknown");
};
const PERSON_DEFAULT_FILE = "default-harness.json";
const isPerson = (ctx: Pick<SpaceContext, "userId">): boolean =>
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(ctx.userId);

/**
 * A person's own default harness for new chats that pin none (Spaces §13).
 * Stored with the person (`host.people`), never with a Space or a request, and
 * honoured only while that harness is registered, not turned off in the
 * Space and usable by the person there (private owner, shared allowlists,
 * account limits); otherwise it is kept but ignored.
 */
export function personDefaults(host: ServerPackageHost) {
    const file = (ctx: SpaceContext): string | undefined => host.people && isPerson(ctx)
        ? host.people.storage(ctx.userId, host.pluginId).path(PERSON_DEFAULT_FILE)
        : undefined;
    const stored = async (ctx: SpaceContext): Promise<string | null> => {
        const path = file(ctx);
        if (!path) return null;
        try {
            const value = (JSON.parse(await readFile(path, "utf8")) as { harnessId?: unknown }).harnessId;
            return typeof value === "string" && /^[a-z][a-z0-9-]*$/.test(value) ? value : null;
        } catch {
            return null;
        }
    };
    const usable = async (ctx: SpaceContext, harnessId: string): Promise<boolean> => {
        const registry = host.services.get(serverServiceKey<HarnessRegistry>("harnesses"));
        const descriptor = registry?.get(harnessId)?.descriptor;
        if (!descriptor || !harnessUsableByUser(descriptor, ctx.userId, allowedHarnessesFor({ space: ctx }), ctx.spaceId)) return false;
        const preferences = await readPreferences(host.spaceStorage(ctx).path("harnesses/preferences.json")).catch(() => ({} as StoredHarnessPreferences));
        return preferences[harnessId]?.enabled !== false;
    };
    return {
        usable,
        async read(ctx: SpaceContext): Promise<PersonHarnessDefaultDto> {
            const harnessId = await stored(ctx);
            return { harnessId, usable: harnessId !== null && await usable(ctx, harnessId) };
        },
        async write(ctx: SpaceContext, harnessId: string | null): Promise<void> {
            const path = file(ctx);
            if (!path) throw harnessError("unsupported", "Only a signed-in person can choose a default assistant");
            await mkdir(dirname(path), { recursive: true });
            const temporary = `${path}.${randomUUID()}.tmp`;
            await writeFile(temporary, JSON.stringify(harnessId === null ? {} : { harnessId }), { mode: 0o600 });
            await rename(temporary, path);
        },
        /** The session facade's view: the saved default only while usable. */
        async usableDefault(ctx: SpaceContext): Promise<string | undefined> {
            const harnessId = await stored(ctx);
            return harnessId !== null && await usable(ctx, harnessId) ? harnessId : undefined;
        },
    };
}

export function harnessRoutes(
    host: ServerPackageHost,
    installs: HarnessInstallJobs = createHarnessInstallJobs(),
    options: { installContainment?: InstallContainment } = {},
): RouteHandler {
    const nativePlugins = createNativePluginRoutes();
    const updateChecker = createHarnessUpdateChecker();
    const localLauncher = localInstallLauncher({
        env: () => localSetupEnv(),
        ...(options.installContainment ? { containment: options.installContainment } : {}),
    });
    return async (request) => {
        if (!request.path.startsWith("/api/harnesses"))
            return false;
        const scoped = host.forSpace(request.space);
        const registry = host.services.require(serverServiceKey<HarnessRegistry>("harnesses"));
        const preferenceFile = host.spaceStorage(request.space).path("harnesses/preferences.json");
        // Another user's private account harness, a shared account not open
        // to this caller or Space, and a shared harness outside this account's
        // limits do not exist for this caller.
        const allowedHarnesses = allowedHarnessesFor(request);
        const visible = (descriptor: { id: string } & HarnessAccessRule) =>
            harnessUsableByUser(descriptor, request.space.userId, allowedHarnesses, request.space.spaceId);
        const visibleId = (harnessId: string) => visible(registry.get(harnessId)?.descriptor ?? { id: harnessId });
        const providers = () => registry.providers().filter((provider) => visible(provider.descriptor));
        // Same account-owned filter as `/api/models`: a provider turned off in
        // Providers & Models is not offered by the picker (the draft/preview
        // catalog comes from this route), even before the physical
        // `opencode.json` mirror is restarted. Only OpenCode uses those ids.
        const openCodeVisibility = host.services.get(serverServiceKey<ProviderVisibility>("models.visibility"));
        const visibleSnapshots = (rows: HarnessSnapshot[]) => rows
            .filter((row) => visibleId(row.identity.id))
            .map((row) => {
                if (row.identity.id !== "opencode" || !openCodeVisibility || !row.catalog?.models)
                    return row;
                return {
                    ...row,
                    catalog: {
                        ...row.catalog,
                        models: openCodeVisibility.filter(row.catalog.models, { userId: request.space.userId }),
                    },
                };
            });
        if (request.path === "/api/harnesses/access" && request.method === "GET") {
            request.json(200, { manage: hasHarnessManagerAuthority(request), personal: hasPersonalHarnessAuthority(request) });
            return true;
        }
        if (request.path === "/api/harnesses/default" && (request.method === "GET" || request.method === "PUT")) {
            const defaults = personDefaults(host);
            if (request.method === "PUT") {
                const input = await request.body();
                const harnessId = input.harnessId;
                if (harnessId !== null && (typeof harnessId !== "string" || !/^[a-z][a-z0-9-]*$/.test(harnessId)))
                    throw harnessError("invalid-input", "Choose a harness or none");
                // Only a harness the person may use in this Space right now.
                if (harnessId !== null && !(await defaults.usable(request.space, harnessId)))
                    throw harnessError("not-found", "harness not found");
                await defaults.write(request.space, harnessId);
            }
            request.json(200, await defaults.read(request.space) satisfies PersonHarnessDefaultDto);
            return true;
        }
        if (request.path === "/api/harnesses/preferences" && request.method === "PUT") {
            requireHarnessManagerAuthority(request);
            const input = await request.body();
            const existing = await readPreferences(preferenceFile);
            const preferences: StoredHarnessPreferences = {};
            for (const provider of registry.providers()) {
                // Keep what the caller cannot see exactly as it was.
                if (!visible(provider.descriptor)) {
                    if (existing[provider.descriptor.id]) preferences[provider.descriptor.id] = existing[provider.descriptor.id]!;
                    continue;
                }
                const value = (input.preferences as HarnessPreferences | undefined)?.[provider.descriptor.id];
                if (!value)
                    continue;
                if (typeof value.enabled !== "boolean" || !Number.isInteger(value.priority) || Math.abs(value.priority!) > 10000)
                    throw harnessError("invalid-input", "Invalid harness preferences");
                const { systemPrompt, title, color, privateSessions } = existing[provider.descriptor.id] ?? {};
                preferences[provider.descriptor.id] = {
                    enabled: value.enabled,
                    priority: value.priority,
                    ...(typeof systemPrompt === "string" && systemPrompt.trim() ? { systemPrompt } : {}),
                    ...(typeof title === "string" && title.trim() ? { title } : {}),
                    ...(typeof color === "string" && color ? { color } : {}),
                    ...(privateSessions === true ? { privateSessions } : {}),
                };
            }
            await writePreferences(preferenceFile, preferences);
            registry.invalidate({ spaceId: request.space.spaceId });
            request.json(200, preferences);
            return true;
        }
        const contextForRequest = async () => {
            const projectId = request.url.searchParams.get("projectId");
            const project = projectId ? await scoped.projects.get(projectId) : (await scoped.projects.list())[0];
            if (projectId && !project)
                throw harnessError("not-found", "project not found");
            return { space: request.space, spaceId: request.space.spaceId, projectId: project?.id ?? "__default__", cwd: project?.path ?? process.cwd(), remote: Boolean(project?.remote) };
        };
        if (request.path === "/api/harnesses/roster" && request.method === "GET") {
            const roster = await registry.roster(await contextForRequest());
            request.json(200, roster.filter((row) => visibleId(row.identity.id)));
            return true;
        }
        if (request.path === "/api/harnesses/snapshots" && request.method === "GET") {
            const context = await contextForRequest();
            let harnessId = request.url.searchParams.get("harnessId") ?? undefined;
            if (harnessId && !providers().some((provider) => provider.descriptor.id === harnessId))
                throw harnessError("not-found", "harness not found");
            const verify = request.url.searchParams.get("verify") === "1";
            // Verifying is a detail read that waits for the native answer.
            const detail = verify || request.url.searchParams.get("detail") === "1";
            const force = request.url.searchParams.get("force") === "1";
            if (!harnessId && request.url.searchParams.get("auto") === "1") {
                const summaries = visibleSnapshots(await registry.snapshots(context, { force }));
                harnessId = summaries
                    .filter(prospectiveCandidate)
                    .toSorted((left, right) => left.policy.priority - right.policy.priority || left.identity.id.localeCompare(right.identity.id))[0]
                    ?.identity.id;
                if (!harnessId) {
                    request.json(200, []);
                    return true;
                }
            }
            request.json(200, visibleSnapshots(await registry.snapshots(context, {
                ...(harnessId ? { harnessId } : {}),
                detail,
                force,
                ...(verify ? { verify } : {}),
            })));
            return true;
        }
        if (request.path === "/api/harnesses" && request.method === "GET") {
            const context = await contextForRequest();
            const [probes, preferences] = await Promise.all([registry.probe(context), readPreferences(preferenceFile)]);
            request.json(200, providers().map((provider) => ({ ...provider.descriptor, enabled: preferences[provider.descriptor.id]?.enabled ?? true, priority: preferences[provider.descriptor.id]?.priority ?? provider.descriptor.priority, ...probes.find((p) => p.harnessId === provider.descriptor.id) })));
            return true;
        }
        if (request.path === "/api/harnesses/capabilities" && request.method === "GET") {
            const projectId = request.url.searchParams.get("projectId");
            const project = projectId ? await scoped.projects.get(projectId) : (await scoped.projects.list())[0];
            if (projectId && !project)
                throw harnessError("not-found", "project not found");
            const query = host.services.get(serverServiceKey<HarnessProvisioningQuery>("harness.provisioning"));
            if (!query) {
                request.json(200, []);
                return true;
            }
            const context = { space: request.space, spaceId: request.space.spaceId, projectId: project?.id ?? "__default__", cwd: project?.path ?? process.cwd(), remote: Boolean(project?.remote) };
            request.json(200, query.status(context));
            return true;
        }
        if (request.path === "/api/harnesses/prompt-prefix-diagnostics" && request.method === "GET") {
            const requestedProjectId = request.url.searchParams.get("projectId") ?? undefined;
            const sessionId = request.url.searchParams.get("sessionId") ?? undefined;
            const requestedHarnessId = request.url.searchParams.get("harnessId") ?? undefined;
            const session = sessionId ? await scoped.sessions.snapshot(sessionId) : undefined;
            if (requestedProjectId && session && session.projectId !== requestedProjectId)
                throw harnessError("invalid-input", "session does not belong to the requested project");
            const projectId = requestedProjectId ?? session?.projectId;
            const project = projectId ? await scoped.projects.get(projectId) : (await scoped.projects.list())[0];
            if (projectId && !project)
                throw harnessError("not-found", "project not found");
            if (session && project && session.projectId !== project.id)
                throw harnessError("not-found", "session project not found in this Space");
            const resolvedHarnessId = session?.resolvedHarnessId
                ?? (session?.harness?.mode === "pinned" ? session.harness.harnessId : undefined);
            if (requestedHarnessId && resolvedHarnessId && requestedHarnessId !== resolvedHarnessId)
                throw harnessError("invalid-input", "requested harness does not match the session runtime");
            const harnessId = requestedHarnessId ?? resolvedHarnessId;
            if (harnessId && !providers().some((provider) => provider.descriptor.id === harnessId))
                throw harnessError("not-found", "harness not found");
            const context: HarnessContext = {
                space: request.space,
                spaceId: request.space.spaceId,
                projectId: project?.id ?? "__default__",
                cwd: session?.worktreePath ?? project?.path ?? process.cwd(),
                remote: Boolean(project?.remote),
                ...(sessionId ? { sessionId } : {}),
            };
            const provisioning = host.services.get(
                serverServiceKey<HarnessProvisioningDiagnostics>("harness.provisioning"),
            );
            if (!provisioning?.desired)
                throw harnessError("unsupported", "prompt prefix diagnostics are unavailable");
            request.json(200, promptPrefixDiagnostics(await provisioning.desired(context), harnessId));
            return true;
        }
        const systemPrompt = request.path.match(/^\/api\/harnesses\/([a-z][a-z0-9-]*)\/system-prompt$/);
        if (systemPrompt && (request.method === "GET" || request.method === "PUT")) {
            const harnessId = systemPrompt[1]!;
            if (!providers().some((provider) => provider.descriptor.id === harnessId))
                throw harnessError("not-found", "harness not found");
            if (request.method === "GET") {
                const preferences = await readPreferences(preferenceFile);
                request.json(200, { systemPrompt: preferences[harnessId]?.systemPrompt ?? "" });
                return true;
            }
            requireHarnessManagerAuthority(request);
            const input = await request.body();
            if (typeof input.systemPrompt !== "string" || input.systemPrompt.length > MAX_HARNESS_SYSTEM_PROMPT || input.systemPrompt.includes("\0"))
                throw harnessError("invalid-input", `System prompt must be text up to ${MAX_HARNESS_SYSTEM_PROMPT} characters`);
            const preferences = await readPreferences(preferenceFile);
            const current = preferences[harnessId] ?? {};
            if (input.systemPrompt.trim()) {
                preferences[harnessId] = { ...current, systemPrompt: input.systemPrompt };
            }
            else {
                const { systemPrompt: _systemPrompt, ...rest } = current;
                if (Object.keys(rest).length)
                    preferences[harnessId] = rest;
                else
                    delete preferences[harnessId];
            }
            await writePreferences(preferenceFile, preferences);
            registry.invalidate({ spaceId: request.space.spaceId, harnessId });
            const provisioning = host.services.get(
                serverServiceKey<HarnessProvisioningDiagnostics>("harness.provisioning"),
            );
            if (provisioning?.reconcileSpace) {
                try {
                    await provisioning.reconcileSpace({ spaceId: request.space.spaceId });
                }
                catch (error) {
                    console.warn("[polyth] harness system prompt live reconcile failed", error);
                }
            }
            request.json(200, { systemPrompt: preferences[harnessId]?.systemPrompt ?? "" });
            return true;
        }
        const appearance = request.path.match(/^\/api\/harnesses\/([a-z][a-z0-9-]*)\/appearance$/);
        if (appearance && request.method === "PUT") {
            requireHarnessManagerAuthority(request);
            const harnessId = appearance[1]!;
            if (!providers().some((provider) => provider.descriptor.id === harnessId))
                throw harnessError("not-found", "harness not found");
            const next = readHarnessAppearance(await request.body());
            const preferences = await readPreferences(preferenceFile);
            const { title: _title, color: _color, ...rest } = preferences[harnessId] ?? {};
            const merged = { ...rest, ...next };
            if (Object.keys(merged).length)
                preferences[harnessId] = merged;
            else
                delete preferences[harnessId];
            await writePreferences(preferenceFile, preferences);
            // Presentation only: snapshots take it on read, no re-probe.
            request.json(200, next);
            return true;
        }
        // New conversations on this harness run as private sessions: Polyth
        // keeps them, the harness saves nothing to its own history. Sessions
        // that already exist keep how they started.
        const privateSessions = request.path.match(/^\/api\/harnesses\/([a-z][a-z0-9-]*)\/private-sessions$/);
        if (privateSessions && request.method === "PUT") {
            requireHarnessManagerAuthority(request);
            const harnessId = privateSessions[1]!;
            const provider = providers().find((candidate) => candidate.descriptor.id === harnessId);
            if (!provider)
                throw harnessError("not-found", "harness not found");
            if (provider.descriptor.privateSessions !== true)
                throw harnessError("unsupported", `${provider.descriptor.name} can't run private sessions`);
            const input = await request.body();
            if (typeof input.enabled !== "boolean")
                throw harnessError("invalid-input", "Private sessions must be on or off");
            const preferences = await readPreferences(preferenceFile);
            const { privateSessions: _privateSessions, ...rest } = preferences[harnessId] ?? {};
            const merged = input.enabled ? { ...rest, privateSessions: true } : rest;
            if (Object.keys(merged).length)
                preferences[harnessId] = merged;
            else
                delete preferences[harnessId];
            await writePreferences(preferenceFile, preferences);
            // Read when a conversation starts and overlaid on snapshots: no re-probe.
            request.json(200, { enabled: input.enabled });
            return true;
        }
        if (request.path === "/api/harnesses/updates" && request.method === "GET") {
            const context = await contextForRequest();
            const harnessId = request.url.searchParams.get("harnessId") ?? undefined;
            const targets = providers().filter((provider) => !harnessId || provider.descriptor.id === harnessId);
            if (harnessId && !targets.length)
                throw harnessError("not-found", "harness not found");
            const force = request.url.searchParams.get("force") === "1";
            const owner = hasInstanceOwnerAuthority(request);
            const snapshots = await registry.snapshots(context, harnessId ? { harnessId } : {});
            request.json(200, await Promise.all(targets.map(async (provider): Promise<HarnessUpdateStatus> => {
                const { descriptor } = provider;
                try {
                    return await harnessUpdateStatus({
                        descriptor,
                        snapshot: snapshots.find((row) => row.identity.id === descriptor.id),
                        remote: context.remote,
                        owner,
                        checker: updateChecker,
                        force,
                    });
                }
                catch {
                    return { harnessId: descriptor.id, available: false, reason: "unavailable", canUpdate: false };
                }
            })));
            return true;
        }
        // A host install runs as the connection's SSH identity: only for a
        // person allowed to use that connection (Spaces §14.6), like a chat.
        const sshUsable = (connectionId: string): boolean => {
            const ssh = host.services.get(serverServiceKey<{ usable?(id: string, principal: unknown): boolean }>("ssh"));
            return !ssh?.usable || ssh.usable(connectionId, {
                kind: "person", userId: request.space.userId, spaceId: request.space.spaceId, instanceOwner: hasInstanceOwnerAuthority(request),
            });
        };
        // Background installs: the server runs the harness's own installer
        // for this machine (or the project's SSH host) without a terminal.
        // Installs are machine-wide, so local ones are listed for every
        // harness manager; a host's only for projects on that host.
        if (request.path === "/api/harnesses/installs" && request.method === "GET") {
            if (request.space.deployment === "multi-tenant-sandboxed" || !hasHarnessManagerAuthority(request)) {
                request.json(200, []);
                return true;
            }
            const projectId = request.url.searchParams.get("projectId");
            const project = projectId ? await scoped.projects.get(projectId) : undefined;
            if (projectId && !project)
                throw harnessError("not-found", "project not found");
            // At most one per harness: the install for where this project
            // would set it up.
            if (project?.remote?.kind === "ssh" && !sshUsable(project.remote.connectionId)) {
                request.json(200, providers().flatMap((provider) => {
                    const key = installKey(provider.descriptor, project);
                    const job = key.startsWith("local:") ? installs.get(key) : undefined;
                    return job ? [job] : [];
                }));
                return true;
            }
            request.json(200, providers().flatMap((provider) => {
                const job = installs.get(installKey(provider.descriptor, project));
                return job ? [job] : [];
            }));
            return true;
        }
        const install = request.path.match(/^\/api\/harnesses\/([a-z][a-z0-9-]*)\/install$/);
        if (install && (request.method === "GET" || request.method === "POST" || request.method === "DELETE")) {
            const provider = registry.get(install[1]!);
            if (!provider || !visible(provider.descriptor))
                throw harnessError("not-found", "harness not found");
            const descriptor = provider.descriptor;
            // The workstation edition starts no installer: no Node.js download
            // from nodejs.org and no npm tarball. The preview (GET) still names
            // the exact command so a person can run it themselves.
            if (request.method === "POST" && workstationEdition())
                throw editionUnavailable(`${descriptor.name} installation`);
            const input = request.method === "POST" ? await request.body() : {};
            const projectId = request.method === "POST" ? input.projectId : request.url.searchParams.get("projectId");
            const project = typeof projectId === "string" && projectId ? await scoped.projects.get(projectId) : undefined;
            if (projectId && !project)
                throw harnessError("not-found", "project not found");
            requireSetupAuthority(request, descriptor, "install");
            const target = setupTarget(descriptor, project);
            if (target === "remote" && project?.remote?.kind === "ssh" && !sshUsable(project.remote.connectionId))
                throw harnessError("not-found", "unknown SSH connection");
            const chosen = setupCommand(descriptor, "install", target);
            if (!chosen)
                throw harnessError("unsupported", `${descriptor.name} has no automatic installer for ${target === "remote" ? "this SSH host" : "this machine"}; follow its setup guide`);
            const remote = target === "remote" && project?.remote?.kind === "ssh"
                ? { connectionId: project.remote.connectionId, host: await resolveRemoteHarnessHost(host, { remote: true, projectId: project.id, spaceId: request.space.spaceId, space: request.space }) }
                : undefined;
            if (target === "remote" && !remote?.host)
                throw harnessError("unsupported", "This project's host cannot install harnesses");
            const key = installKey(descriptor, project);
            const preview = {
                harnessId: descriptor.id,
                harnessName: descriptor.name,
                target,
                machine: remote ? { kind: "remote" as const, label: remote.host!.label } : { kind: "local" as const, os: installMachineOs() },
                command: chosen.command,
                sources: installSources(chosen.command),
                browserOnMachine: !remote && browserOnServer(request),
                ...(descriptor.setupUrl ? { setupUrl: descriptor.setupUrl } : {}),
                ...(workstationEdition() ? { manualOnly: true as const } : {}),
            };
            if (request.method === "GET") {
                request.json(200, { preview, job: installs.get(key) ?? null });
                return true;
            }
            if (request.method === "DELETE") {
                request.json(200, await installs.cancel(key) ?? null);
                return true;
            }
            const harnessId = descriptor.id;
            // A local install is checked where it landed (this machine),
            // whatever project is open; a host install in that project.
            const context: HarnessContext = remote && project
                ? { space: request.space, spaceId: request.space.spaceId, projectId: project.id, cwd: project.path, remote: true }
                : { space: request.space, spaceId: request.space.spaceId, projectId: "__default__", cwd: homedir(), remote: false };
            // A reinstall over a CLI that chats still run is the same file swap.
            if (!remote) await freeHarnessExecutable(host, descriptor);
            const launch: InstallLauncher = remote ? remoteInstallLauncher(remote.host!, REMOTE_SETUP_PATH) : localLauncher;
            request.json(200, installs.start({
                key,
                queueKey: remote ? `ssh:${remote.connectionId}` : "local",
                preview,
                launch,
                async verify() {
                    // The CLI is new: every cached answer about it is stale.
                    registry.invalidate({ harnessId });
                    if (remote?.host) forgetRemoteHarnessProbes(remote.host.label);
                    host.services.get(serverServiceKey<{ invalidateModels(): void }>("runtime.catalog"))?.invalidateModels();
                    if (descriptor.releaseSource)
                        updateChecker.forget(descriptor.releaseSource);
                    const [snapshot] = await registry.snapshots(context, { harnessId, force: true });
                    return {
                        installed: snapshot?.availability.installed === true,
                        ...(snapshot?.identity.version ? { version: snapshot.identity.version } : {}),
                        state: snapshot?.availability.state ?? "unknown",
                    };
                },
            }));
            return true;
        }
        const setup = request.path.match(/^\/api\/harnesses\/([a-z][a-z0-9-]*)\/setup-terminal$/);
        if (setup && (request.method === "GET" || request.method === "POST")) {
            const provider = registry.get(setup[1]!);
            if (!provider || !visible(provider.descriptor))
                throw harnessError("not-found", "harness not found");
            const input = request.method === "POST" ? await request.body() : {};
            const action = readSetupAction(request.method === "POST" ? input.action : request.url.searchParams.get("action"));
            const projectId = request.method === "POST" ? input.projectId : request.url.searchParams.get("projectId");
            const project = typeof projectId === "string" && projectId ? await scoped.projects.get(projectId) : undefined;
            if (projectId && !project)
                throw harnessError("not-found", "project not found");
            requireSetupAuthority(request, provider.descriptor, action);
            // A sign-in terminal stays; an install terminal would run the same
            // download this edition refuses, so only its preview is offered.
            if (action === "install" && workstationEdition())
                throw editionUnavailable(`${provider.descriptor.name} installation in a terminal`);
            if (request.method === "GET") {
                request.json(200, await previewSetupTerminal({ descriptor: provider.descriptor, action, project, localBrowser: browserOnServer(request) }));
                return true;
            }
            // The terminal lives in a project's Terminal view (and its Space).
            if (!project)
                throw harnessError("invalid-input", "Open a project first: the terminal opens in its Terminal view");
            const result = await openSetupTerminal({
                descriptor: provider.descriptor,
                action,
                project,
                localBrowser: browserOnServer(request),
                terminals: host.services.get(serverServiceKey<HarnessSetupTerminals>("terminal")),
            });
            request.json(200, result);
            return true;
        }
        const maintenance = request.path.match(/^\/api\/harnesses\/([a-z][a-z0-9-]*)\/(restart|update|refresh-models)$/);
        if (maintenance && request.method === "POST") {
            const provider = registry.get(maintenance[1]!);
            if (!provider || !visible(provider.descriptor))
                throw harnessError("not-found", "harness not found");
            const harnessId = provider.descriptor.id;
            // Registry snapshots and the server model catalog both hold model
            // lists; drop them together so pickers cannot re-read a stale half.
            const invalidateModels = () => {
                registry.invalidate({ harnessId });
                host.services.get(serverServiceKey<{ invalidateModels(): void }>("runtime.catalog"))?.invalidateModels();
            };
            if (maintenance[2] === "refresh-models") {
                const context = await contextForRequest();
                invalidateModels();
                // A forced probe also drops adapter-owned discovery caches.
                const [snapshot] = await registry.snapshots(context, { harnessId, detail: true, force: true });
                // Fence a catalog load that raced the probe and read the old cache.
                host.services.get(serverServiceKey<{ invalidateModels(): void }>("runtime.catalog"))?.invalidateModels();
                request.json(200, snapshot ?? null);
                return true;
            }
            requireInstanceOwnerAuthority(request, "harness maintenance requires the instance owner");
            if (maintenance[2] === "restart") {
                const restart = host.services.get(serverServiceKey<HarnessRuntimeRestart>("harness.runtime.restart"));
                if (!restart)
                    throw harnessError("unsupported", "runtime restart is unavailable");
                const result = await restart(request.space, harnessId);
                invalidateModels();
                request.json(200, result);
                return true;
            }
            if (maintenance[2] === "update" && workstationEdition())
                throw editionUnavailable(`Updating ${provider.descriptor.name}`);
            if (!provider.descriptor.updateCommand?.length)
                throw harnessError("unsupported", "this harness has no update command");
            await freeHarnessExecutable(host, provider.descriptor);
            const source = provider.descriptor.releaseSource;
            const result = await runHarnessUpdate(provider.descriptor.updateCommand, provider.versionStore, source?.kind === "npm" ? { npmPackage: source.package, ...(source.bin ? { npmBin: source.bin } : {}), ...(source.distTag ? { npmDistTag: source.distTag } : {}) } : {});
            invalidateModels();
            if (result.ok && provider.descriptor.releaseSource)
                updateChecker.forget(provider.descriptor.releaseSource);
            request.json(200, result);
            return true;
        }
        // Plugin scopes are written to disk, so the plugin routes never guess a
        // project: no first-project fallback and never the server's own cwd.
        const pluginContext = async () => {
            const projectId = request.url.searchParams.get("projectId");
            const project = projectId ? await scoped.projects.get(projectId) : undefined;
            if (projectId && !project)
                throw harnessError("not-found", "project not found");
            const base = { space: request.space, spaceId: request.space.spaceId };
            if (!project)
                return { ...base, projectId: "__default__", cwd: homedir(), remote: false };
            return {
                ...base,
                projectId: project.id,
                cwd: project.path,
                remote: Boolean(project.remote),
                project: { id: project.id, name: project.name || project.id, path: project.path },
            };
        };
        if (await nativePlugins(request, { registry, context: pluginContext }))
            return true;
        const skills = request.path.match(/^\/api\/harnesses\/([a-z][a-z0-9-]*)\/skills$/);
        if (skills && (request.method === "GET" || request.method === "PUT")) {
            const provider = providers().find((candidate) => candidate.descriptor.id === skills[1]);
            if (!provider)
                throw harnessError("not-found", "harness not found");
            if (!provider.skills)
                throw harnessError("unsupported", "this harness has no native skills Polyth can read");
            // Native skills live in the host's own folders, never a tenant's.
            if (request.space.deployment === "multi-tenant-sandboxed")
                throw harnessError("forbidden", "native harness skills are unavailable in a sandboxed deployment");
            const { space, spaceId, projectId, cwd, remote } = await pluginContext();
            const context = { space, spaceId, projectId, cwd, remote };
            if (request.method === "GET") {
                request.json(200, await provider.skills.list(context));
                return true;
            }
            requireInstanceOwnerAuthority(request, "changing which native skills harnesses inherit requires the instance owner");
            request.json(200, await provider.skills.update(context, readNativeSkillPatch(await request.body())));
            registry.invalidate({ harnessId: provider.descriptor.id });
            return true;
        }
        const control = request.path.match(/^\/api\/harnesses\/([a-z][a-z0-9-]*)\/controls\/([^/]+)$/);
        if (control && request.method === "POST") {
            requireHarnessManagerAuthority(request);
            const provider = providers().find((candidate) => candidate.descriptor.id === control[1]);
            if (!provider)
                throw harnessError("not-found", "harness not found");
            if (!provider.applyControl)
                throw harnessError("unsupported", "this harness has no editable generic controls");
            const context = await contextForRequest();
            const [snapshot] = await registry.snapshots(context, { harnessId: provider.descriptor.id, detail: true });
            const descriptor = snapshot?.configuration?.controls.find((candidate) => candidate.id === decodeURIComponent(control[2]!));
            if (!descriptor)
                throw harnessError("not-found", "harness control not found");
            if (descriptor.applySemantics === "read-only" || descriptor.available === false)
                throw harnessError("conflict", descriptor.unavailableReason ?? "harness control is read-only");
            const input = await request.body();
            await provider.applyControl(context, descriptor.id, input.value as JsonValue);
            registry.invalidate({ spaceId: context.spaceId, projectId: context.projectId, cwd: context.cwd, harnessId: provider.descriptor.id });
            request.json(200, (await registry.snapshots(context, { harnessId: provider.descriptor.id, detail: true, force: true }))[0]);
            return true;
        }
        if (request.path === "/api/harnesses/sessions" && request.method === "POST") {
            const input = await request.body();
            const project = typeof input.projectId === "string" ? await scoped.projects.get(input.projectId) : undefined;
            if (!project)
                throw harnessError("not-found", "project not found");
            const ref = await scoped.sessions.create({ projectId: project.id, harness: readHarnessSelection(input.selection) });
            request.json(200, await scoped.sessions.snapshot(ref.id));
            return true;
        }
        const featuresMatch = request.path.match(/^\/api\/harnesses\/sessions\/([^/]+)\/features$/);
        if (featuresMatch && request.method === "GET") {
            const features = scoped.sessions.runtimeFeatures;
            if (!features)
                throw harnessError("unsupported", "runtime features are unavailable");
            request.json(200, await features(featuresMatch[1]!));
            return true;
        }
        const match = request.path.match(/^\/api\/harnesses\/sessions\/([^/]+)$/);
        if (match && request.method === "POST") {
            const input = await request.body();
            if (!scoped.sessions.switchHarness)
                throw harnessError("unsupported", "harness switching is unavailable");
            if (input.timing !== undefined && input.timing !== "after-turn" && input.timing !== "stop-now")
                throw harnessError("invalid-input", "invalid switch timing");
            request.json(200, await scoped.sessions.switchHarness(match[1]!, readHarnessSelection(input.selection), input.timing as "after-turn" | "stop-now" | undefined));
            return true;
        }
        const cancel = request.path.match(/^\/api\/harnesses\/sessions\/([^/]+)\/cancel$/);
        if (cancel && request.method === "POST") {
            if (!scoped.sessions.cancelHarnessSwitch)
                throw harnessError("unsupported", "harness switch cancellation is unavailable");
            request.json(200, await scoped.sessions.cancelHarnessSwitch(cancel[1]!));
            return true;
        }
        const restart = request.path.match(/^\/api\/harnesses\/sessions\/([^/]+)\/restart$/);
        if (restart && request.method === "POST") {
            if (!scoped.sessions.restartRuntime)
                throw harnessError("unsupported", "runtime restart is unavailable");
            request.json(200, await scoped.sessions.restartRuntime(restart[1]!));
            return true;
        }
        return false;
    };
}

function harnessSystemPromptContribution(
    host: ServerPackageHost,
    registry: HarnessRegistry,
): ContextualCapabilityContribution {
    return {
        descriptor: {
            id: "harness-runtime.system-prompts",
            kind: "instruction",
            owner: "harness-runtime",
            scope: "deployment",
            revision: "1",
            title: "Harness system prompts",
            text: "",
        },
        resolveCapabilities(context: HarnessContext): readonly AgentCapabilityDescriptor[] {
            if (!context.space)
                return [];
            const preferences = readPreferencesSync(host.spaceStorage(context.space).path("harnesses/preferences.json"));
            return registry.providers().flatMap((provider) => {
                const text = preferences[provider.descriptor.id]?.systemPrompt;
                if (typeof text !== "string" || !text.trim() || text.length > MAX_HARNESS_SYSTEM_PROMPT)
                    return [];
                return [{
                    id: `harness-runtime.system-prompt.${provider.descriptor.id}`,
                    kind: "instruction",
                    owner: "harness-runtime",
                    scope: "space",
                    spaceId: context.spaceId,
                    revision: "1",
                    title: `${provider.descriptor.name} system prompt`,
                    text,
                    targetHarnessId: provider.descriptor.id,
                } as HarnessSystemPromptDescriptor];
            });
        },
    };
}

export default function registerPackage(host: ServerPackageHost) {
    let promptContribution: Disposable | undefined;
    const installs = createHarnessInstallJobs();
    const installContainment = createInstallContainment(() => join(packageDataDir(host), "install-executions"));
    const defaults = personDefaults(host);
    // Answers only while the package is enabled: a disabled package's saved
    // defaults pin nothing.
    let active = false;
    host.services.provide(serverServiceKey<HarnessPersonDefaults>(HARNESS_PERSON_DEFAULTS_SERVICE), {
        usableDefault: async (ctx) => active ? defaults.usableDefault(ctx) : undefined,
    });
    return {
        routes: harnessRoutes(host, installs, { installContainment }),
        remoteAccess: localOnlyRemoteAccess(["harnesses"]),
        onEnable() {
            active = true;
            // An installer a crashed Polyth left running is released, never adopted.
            void installContainment.recover().catch((error: unknown) => console.warn("[polyth] harness install recovery failed", error));
            if (promptContribution) return;
            const registry = host.services.require(serverServiceKey<ReturnType<typeof createHarnessRegistry>>("harnesses"));
            registry.configurePolicy(async (context) => context.space
                ? readPreferences(host.spaceStorage(context.space).path("harnesses/preferences.json"))
                : {});
            const capabilities = host.services.require(serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"));
            promptContribution = capabilities.register("harness-runtime", harnessSystemPromptContribution(host, registry));
        },
        async onDisable() {
            active = false;
            // No installer outlives the package that started it.
            await installs.interruptAll();
            const contribution = promptContribution;
            if (contribution) await contribution.dispose();
            promptContribution = undefined;
        },
    };
}
