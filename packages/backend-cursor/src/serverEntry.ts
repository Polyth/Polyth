import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { HarnessRegistry, HarnessVersionStore } from "@polyth/contracts";
import { createAcpProvider } from "@polyth/backend-acp";
import { discoverHarnessExecutable, harnessExecutableChildEnv } from "@polyth/backend-acp/executable-discovery";
import type { RegisteredAcpProfile } from "@polyth/backend-acp/profile";
import { createHarnessAccountFamily, harnessCommandLine, linkAccountOverlay, type HarnessAccountStatus, type ResolvedHarnessAccount } from "@polyth/harness-runtime/accounts";
import { vendorScriptInstallCommand } from "@polyth/harness-runtime/installers";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { createCursorClientTranslator } from "./todos.ts";
import { cursorModelDiscoverySupport } from "./version.ts";
import { createCursorSmallModelRunner } from "./smallModel.ts";
import { cursorSessionsDir, listCursorSessions, readCursorSession } from "./history.ts";
const exec = promisify(execFile);
/** Cursor's CLI installers (cursor.com/docs/cli/installation). */
const CURSOR_INSTALLER = { posix: "https://cursor.com/install", windowsPowerShell: "https://cursor.com/install?win32=true" };
/** The installer and `agent update` put each release in
 *  `…/cursor-agent/versions/<release>/` and point the launcher at its
 *  `cursor-agent`; old releases are never removed. */
export const CURSOR_VERSION_STORE: HarnessVersionStore = {
    directory(executablePath) {
        const versions = dirname(dirname(executablePath));
        return basename(versions) === "versions" && basename(dirname(versions)) === "cursor-agent" ? versions : undefined;
    },
    entry: /^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[0-9a-f]+$/,
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const cursorContextTokens = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        const rounded = Math.round(value);
        return rounded > 0 ? rounded : undefined;
    }
    if (typeof value !== "string") return undefined;
    const match = /^\s*(\d+(?:\.\d+)?)\s*([km]?)\s*$/i.exec(value);
    if (!match) return undefined;
    const multiplier = match[2]?.toLowerCase() === "k"
        ? 1_000
        : match[2]?.toLowerCase() === "m"
            ? 1_000_000
            : 1;
    const tokens = Number(match[1]) * multiplier;
    if (!Number.isFinite(tokens) || tokens <= 0) return undefined;
    const rounded = Math.round(tokens);
    return rounded > 0 ? rounded : undefined;
};

/** `providerID` is the harness id, matching the ACP session's own catalog. */
export const cursorModels = (result: unknown, providerID = "cursor") => {
    const rows = asRecord(result)?.models;
    if (!Array.isArray(rows)) return undefined;
    return rows.flatMap((value) => {
        const row = asRecord(value);
        const modelID = typeof row?.value === "string" && row.value.trim() ? row.value : undefined;
        if (!row || !modelID) return [];
        const configs = Array.isArray(row.configOptions) ? row.configOptions : [];
        const configRows = configs.map(asRecord);
        const thought = configRows.find((option) => option?.category === "thought_level");
        const contextOptions = configRows.filter((option) =>
            /context/i.test(`${option?.category ?? ""} ${option?.name ?? ""} ${option?.id ?? ""}`));
        const embeddedMatches = [...modelID.matchAll(/(?:^|[,[(])\s*context\s*=\s*([\s\S]*?)(?=\s*(?:,|\]|\)|$))/gi)];
        const contextOptionValues = contextOptions
            .map((option) => option?.currentValue ?? option?.value)
            .filter((value) => value !== undefined && value !== null && value !== "");
        const parsedContextValues = [
            ...contextOptionValues.map(cursorContextTokens),
            ...embeddedMatches.map((match) => cursorContextTokens(match[1])),
        ];
        const contextValues = parsedContextValues.filter((value): value is number => value !== undefined);
        const hasContextEvidence = contextOptionValues.length > 0 || embeddedMatches.length > 0;
        const contextConflict = hasContextEvidence && (
            parsedContextValues.some((value) => value === undefined)
            || new Set(contextValues).size > 1
        );
        const context = !contextConflict && contextValues.length > 0 ? contextValues[0] : undefined;
        const variants = (Array.isArray(thought?.options) ? thought.options : []).flatMap((value) => {
            const option = asRecord(value);
            return typeof option?.value === "string" && option.value !== "auto" && option.value !== "default"
                ? [option.value]
                : [];
        });
        return [{
            providerID,
            modelID,
            name: typeof row.name === "string" && row.name.trim() ? row.name : modelID,
            connected: true,
            ...(contextConflict ? { contextStatus: "conflict" as const } : {}),
            ...(context !== undefined ? { context } : {}),
            ...(variants.length ? { variants } : {}),
        }];
    });
};

const methodMissing = (error: unknown) =>
    (error as { rpcCode?: number }).rpcCode === -32601
    || /method not found/i.test((error as { message?: string }).message ?? "");

const windowsShim = (command: string) => process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
/** Last resolved executable, for the synchronous sign-in command. */
let knownCursorCommand: string | undefined;
const resolveCursorBinary = async () => {
    const configured = process.env.POLYTH_CURSOR_BIN?.trim();
    for (const binary of configured ? [configured] : ["agent", "cursor-agent"]) {
        const report = await discoverHarnessExecutable(binary);
        if (!report.hit) continue;
        const command = report.hit.executablePath;
        const env = await harnessExecutableChildEnv(command);
        try {
            const version = (await exec(command, ["--version"], { timeout: 5000, maxBuffer: 4096, env, shell: windowsShim(command) })).stdout.trim();
            if (!configured && binary === "agent"
                && !/cursor-agent/i.test(command)
                && !/^\d{4}\.\d{2}\.\d{2}(?:-|$)/.test(version)) continue;
            knownCursorCommand = report.hit.launcherPath ?? command;
            return { command, version, env };
        } catch { /* try the next candidate */ }
    }
    throw Object.assign(new Error("Cursor Agent CLI was not found"), { code: "not-installed" });
};

// Cursor blocks session/prompt until these extension requests receive valid
// nested outcomes. Decline unsupported UI explicitly instead of stranding the turn.
export const cursorClientRequest = (method: string) => {
    if (method === "cursor/ask_question") {
        return {
            handled: true,
            result: {
                outcome: {
                    outcome: "skipped",
                    reason: "Interactive Cursor questions are not exposed by Polyth",
                },
            },
        } as const;
    }
    if (method === "cursor/create_plan") {
        return {
            handled: true,
            result: { outcome: { outcome: "cancelled" } },
        } as const;
    }
    return { handled: false } as const;
};

/** On Linux Cursor Agent keeps its login (`cursor/auth.json`), CLI config and
 *  ACP transcripts (`cursor/acp-sessions`) under `$XDG_CONFIG_HOME/cursor`. An
 *  account gets a private config root that links every other entry of the
 *  real `~/.config` back, so tools the agent runs keep their git/gh config. */
const accountConfigRoot = (account: ResolvedHarnessAccount) => join(account.dir, "config");
const realConfigRoot = () => process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
const accountEnv = (account?: ResolvedHarnessAccount): Record<string, string> =>
    account ? { XDG_CONFIG_HOME: accountConfigRoot(account) } : {};
const prepareCursorAccount = (account: ResolvedHarnessAccount) =>
    linkAccountOverlay({ root: accountConfigRoot(account), real: realConfigRoot(), own: ["cursor"] });
const accountSessionsDir = (account?: ResolvedHarnessAccount) =>
    account ? join(accountConfigRoot(account), "cursor", "acp-sessions") : cursorSessionsDir();

/** `agent status --format json` is the CLI's local sign-in report. */
const cursorAccountStatus = async (account?: ResolvedHarnessAccount): Promise<HarnessAccountStatus> => {
    const { command, env } = await resolveCursorBinary();
    const { stdout } = await exec(command, ["status", "--format", "json"], {
        timeout: 20_000,
        maxBuffer: 64 * 1024,
        env: { ...env, ...accountEnv(account) },
        shell: windowsShim(command),
    }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
    const report = asRecord(JSON.parse(stdout));
    const user = asRecord(report?.userInfo);
    if (typeof report?.isAuthenticated !== "boolean") return { loggedIn: "unknown" };
    return {
        loggedIn: report.isAuthenticated,
        ...(report.isAuthenticated && typeof user?.email === "string" && user.email ? { email: user.email } : {}),
    };
};

export function createCursorProfile(account?: ResolvedHarnessAccount): RegisteredAcpProfile {
    const harnessId = account ? account.harnessId : "cursor";
    const profile: RegisteredAcpProfile = {
        descriptor: {
            id: harnessId,
            name: "Cursor",
            integration: "ACP v1",
            autoSelect: false,
            priority: 60,
            setupUrl: "https://cursor.com/docs/cli/acp",
            updateCommand: ["agent", "update"],
            releaseSource: { kind: "page", url: "https://cursor.com/install", pattern: "downloads\\.cursor\\.com/lab/([0-9]{4}\\.[0-9]{2}\\.[0-9]{2}-[0-9a-f]+)/" },
            // The agent publishes `cursor_login` as its ACP auth method; the
            // CLI runs that flow.
            installCommand: vendorScriptInstallCommand(CURSOR_INSTALLER, process.platform),
            signInCommand: "agent login",
            remoteHost: { binary: "cursor-agent", installCommand: vendorScriptInstallCommand(CURSOR_INSTALLER), signInCommand: "cursor-agent login" },
        },
        // `agent acp` has no --model flag (verified: it is accepted and
        // ignored). Model selection goes through the ACP session API only.
        command: process.env.POLYTH_CURSOR_BIN?.trim() || "agent", args: ["acp"],
        ...(account ? { env: { ...process.env, ...accountEnv(account) } } : {}),
        initializeClientMeta: { parameterizedModelPicker: true },
        clientRequest: cursorClientRequest,
        // Clock-seeded revisions stay ahead of snapshots from an earlier leg.
        createClientTranslator: () => createCursorClientTranslator({ revisionClock: Date.now }),
        admitOnThought: true,
        versionStore: CURSOR_VERSION_STORE,
        // `agent -p --mode ask` is the CLI's read-only print mode; the ACP
        // session command (`agent acp`) cannot be reused for a stateless turn.
        utilityCompletion: ({ command, cwd, env }) => createCursorSmallModelRunner({ command, cwd, env }),
        async discoverModels(connection) {
            try {
                return cursorModels(await connection.rpc.request("cursor/list_available_models", {}, 10_000), harnessId);
            } catch (error) {
                if (methodMissing(error)) return undefined;
                throw error;
            }
        },
        // Older Cursor builds that lack the direct catalog extension fall back
        // to session metadata. Do not mutate every model row during discovery.
        probeModelControls: false,
        supportsModelDiscovery: cursorModelDiscoverySupport,
        async probe(context) {
            if (context.remote)
                return { harnessId, installed: false, authenticated: "unknown", healthy: false, message: "Local execution only" };
            try {
                const { command, version, env } = await resolveCursorBinary();
                if (account) await prepareCursorAccount(account);
                profile.command = command;
                profile.env = { ...env, ...accountEnv(account) };
                // Installation alone is not proof of authentication. The profile is
                // offered for explicit selection but excluded from automatic routing
                // until a native auth/status contract is verified.
                return { harnessId, installed: true, authenticated: "unknown", healthy: true, version, message: "Native sign-in status is not available" };
            }
            catch {
                return { harnessId, installed: false, authenticated: "unknown", healthy: false };
            }
        },
        source: {
            async list(context) {
                if (context.remote) return [];
                return listCursorSessions(context.cwd, accountSessionsDir(account));
            },
            read: (context, ref) => {
                if (context.remote) throw Object.assign(new Error("Local execution only"), { code: "unsupported" });
                return readCursorSession(context, ref, accountSessionsDir(account));
            },
        },
    };
    return profile;
}

export default function registerPackage(host: ServerPackageHost) {
    const accounts = createHarnessAccountFamily({
        family: "cursor",
        label: "Cursor",
        packageId: "backend-cursor",
        storageDir: host.storageDir,
        deployment: host.deployment,
        registry: () => host.services.require(serverServiceKey<HarnessRegistry>("harnesses")),
        createProvider: (account) => createAcpProvider(host, createCursorProfile(account)),
        status: cursorAccountStatus,
        signInCommand: (account) => harnessCommandLine([knownCursorCommand ?? "agent", "login"], accountEnv(account)),
        prepare: prepareCursorAccount,
        // Outside Linux the CLI ignores XDG_CONFIG_HOME for its login.
        ...(process.platform === "linux" ? {} : { unsupported: "Extra Cursor accounts need a Linux Polyth server" }),
    });
    return {
        remoteAccess: localOnlyRemoteAccess(["backend-cursor"]),
        routes: accounts.routes,
        onEnable: accounts.onEnable,
        onDisable: accounts.onDisable,
    };
}
export { cursorModelDiscoverySupport };
