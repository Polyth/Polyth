import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { HarnessRegistry, RuntimeEvent } from "@polyth/contracts";
import { createAcpProvider } from "@polyth/backend-acp";
import type { RegisteredAcpProfile } from "@polyth/backend-acp/profile";
import { createHarnessAccountFamily, harnessCommandLine, type HarnessAccountStatus, type ResolvedHarnessAccount } from "@polyth/harness-runtime/accounts";
import { discoverHarnessExecutable, harnessExecutableChildEnv } from "@polyth/harness-runtime/executable-discovery";
import { npmCliInstallCommand } from "@polyth/harness-runtime/installers";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { classifyDshPromptFailure, dshFailedMcpServer } from "./failures.ts";
import { canonicalDshModelId, dshModelIdCodec } from "./models.ts";
import { latestPromptUsage, listNativeSessions, promptRecordedSince, readNativeDialogue, readNativeSession, resolveDshHome, zstdAvailable } from "./nativeLog.ts";
const exec = promisify(execFile);

const NPM_PACKAGE = "@deepseek-ai/dsh";
/** Polyth's `--patch` overlay: native subagents off (see the file). */
export const ACP_PATCH = fileURLToPath(new URL("../assets/acp.patch.yml", import.meta.url));
/** The sign-in helper Polyth offers as the DeepSeek sign-in command. */
export const SIGN_IN_SCRIPT = fileURLToPath(new URL("../bin/sign-in.mjs", import.meta.url));
/** `dsh --version` prints a bare semver; other `dsh` binaries (the Debian
 *  distributed shell, node-dsh) do not, nor do they describe DeepSeek. */
const DSH_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

const windowsShim = (command: string) => process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);

/** Executables already proven to be DeepSeek Harness, by path. */
const verified = new Map<string, string>();

/** Resolve `dsh` and prove it is DeepSeek Harness, not another `dsh`. */
export const resolveDshBinary = async (): Promise<{ command: string; version: string; env: NodeJS.ProcessEnv }> => {
    const report = await discoverHarnessExecutable(process.env.POLYTH_DEEPSEEK_BIN?.trim() || "dsh");
    if (!report.hit) throw Object.assign(new Error("DeepSeek Harness (dsh) was not found"), { code: "not-installed" });
    const command = report.hit.executablePath;
    const env = await harnessExecutableChildEnv(command);
    const version = (await exec(command, ["--version"], { timeout: 10_000, maxBuffer: 4096, env, shell: windowsShim(command) })).stdout.trim();
    if (!DSH_VERSION.test(version)) throw Object.assign(new Error(`${command} is not DeepSeek Harness`), { code: "not-installed" });
    if (verified.get(command) !== version) {
        const help = await exec(command, ["--help"], { timeout: 10_000, maxBuffer: 64 * 1024, env, shell: windowsShim(command) })
            .then(({ stdout, stderr }) => `${stdout}\n${stderr}`, () => "");
        if (!/DeepSeek Harness/i.test(help)) throw Object.assign(new Error(`${command} is not DeepSeek Harness`), { code: "not-installed" });
        verified.set(command, version);
    }
    return { command, version, env };
};

/**
 * `DSH_HOME` holds one login's credential store, `.env`, profiles and native
 * sessions. An extra account must not inherit the server's own
 * `DEEPSEEK_API_KEY`: dsh lets the launch environment win over every store,
 * so the account would silently run on the default key.
 */
const accountEnv = (base: NodeJS.ProcessEnv, account?: ResolvedHarnessAccount): NodeJS.ProcessEnv => {
    if (!account) return base;
    const { DEEPSEEK_API_KEY: _shared, ...rest } = base;
    return { ...rest, DSH_HOME: account.dir };
};

/**
 * There is no native sign-in report to read without opening a credential
 * store or spending a turn. A key in the default harness's own launch
 * environment is the one configuration Polyth can see; everything else is
 * verified by the first turn, whose failure is classified as a sign-in error.
 */
const dshAccountStatus = async (): Promise<HarnessAccountStatus> => {
    await resolveDshBinary();
    return { loggedIn: "unknown" };
};

const MAX_SETTLE_ATTEMPTS = 8;
const SETTLE_RETRY_MS = 150;
const MAX_TRACKED_SESSIONS = 256;

export function createDeepSeekProfile(account?: ResolvedHarnessAccount): RegisteredAcpProfile {
    const harnessId = account ? account.harnessId : "deepseek";
    const home = () => account ? account.dir : resolveDshHome(profile.env ?? process.env);
    /** Responses already published, per native session; a resumed session's
     *  earlier prompt is never reported twice in one server lifetime. */
    const published = new Map<string, Set<string>>();
    const profile: RegisteredAcpProfile = {
        descriptor: {
            id: harnessId,
            name: "DeepSeek",
            integration: "ACP v1",
            autoSelect: false,
            priority: 55,
            setupUrl: "https://platform.deepseek.com/api_keys",
            installCommand: npmCliInstallCommand(NPM_PACKAGE, process.platform),
            updateCommand: ["npm", "install", "-g", `${NPM_PACKAGE}@latest`],
            releaseSource: { kind: "npm", package: NPM_PACKAGE },
            remoteHost: { binary: "dsh", installCommand: npmCliInstallCommand(NPM_PACKAGE) },
        },
        command: process.env.POLYTH_DEEPSEEK_BIN?.trim() || "dsh",
        args: ["--profile", "acp", "--patch", ACP_PATCH],
        // The overlay file is on this machine only; an SSH host runs its own
        // shipped profile, native subagents included (documented limitation).
        remoteArgs: ["--profile", "acp"],
        ...(account ? { env: accountEnv(process.env, account) } : {}),
        modelIdCodec: dshModelIdCodec,
        // dsh validates and connects every MCP server before it publishes a
        // session, requires absolute stdio commands, and refuses the whole
        // session when one server fails; that server alone is left out.
        absoluteMcpCommands: true,
        mcpServerFailure: dshFailedMcpServer,
        classifyPromptFailure: classifyDshPromptFailure,
        toolNameFromTitle: true,
        // dsh's ACP wire carries committed messages only, so a long first
        // response is silent there; its log records the turn at once.
        async probeAdmission({ backendSessionId, sentAt }) {
            if (!zstdAvailable()) return false;
            const log = await readNativeSession(home(), backendSessionId);
            return log ? promptRecordedSince(log.events, sentAt) : false;
        },
        reportsUsage: zstdAvailable(),
        async settleTurn({ backendSessionId, turnId }) {
            if (!zstdAvailable()) return [];
            for (let attempt = 1; attempt <= MAX_SETTLE_ATTEMPTS; attempt++) {
                const log = await readNativeSession(home(), backendSessionId);
                const usage = log ? latestPromptUsage(log.events) : undefined;
                if (usage && (usage.complete || attempt === MAX_SETTLE_ATTEMPTS)) {
                    let seen = published.get(backendSessionId);
                    if (!seen) {
                        seen = new Set();
                        published.set(backendSessionId, seen);
                        if (published.size > MAX_TRACKED_SESSIONS) published.delete(published.keys().next().value!);
                    }
                    const events: RuntimeEvent[] = [];
                    for (const row of usage.rows) {
                        if (seen.has(row.messageId)) continue;
                        seen.add(row.messageId);
                        events.push({
                            type: "usage/recorded",
                            model: { providerID: harnessId, modelID: canonicalDshModelId(row.provider, row.model) },
                            tokens: row.tokens,
                            turnId,
                            harnessId,
                            agentKind: "main",
                            quality: "exact",
                        });
                    }
                    return events;
                }
                await new Promise((resolve) => setTimeout(resolve, SETTLE_RETRY_MS).unref?.());
            }
            return [];
        },
        async probe(context) {
            if (context.remote)
                return { harnessId, installed: false, authenticated: "unknown", healthy: false, message: "Local execution only" };
            try {
                const { command, version, env } = await resolveDshBinary();
                profile.command = command;
                profile.env = accountEnv(env, account);
                const keyed = !account && Boolean(env.DEEPSEEK_API_KEY?.trim());
                return {
                    harnessId,
                    installed: true,
                    authenticated: "unknown",
                    healthy: true,
                    version,
                    message: keyed
                        ? "Uses DEEPSEEK_API_KEY from the Polyth server environment; the key is verified on the first turn"
                        : "The DeepSeek API key is verified on the first turn",
                };
            }
            catch {
                return { harnessId, installed: false, authenticated: "unknown", healthy: false };
            }
        },
        source: {
            async list(context) {
                if (context.remote || !zstdAvailable()) return [];
                return listNativeSessions(home(), context.cwd);
            },
            read(context, ref) {
                if (context.remote) throw Object.assign(new Error("Local execution only"), { code: "unsupported" });
                return readNativeDialogue(home(), context.cwd, ref);
            },
        },
    };
    return profile;
}

export default function registerPackage(host: ServerPackageHost) {
    const accounts = createHarnessAccountFamily({
        family: "deepseek",
        label: "DeepSeek",
        packageId: "backend-deepseek",
        storageDir: host.storageDir,
        deployment: host.deployment,
        registry: () => host.services.require(serverServiceKey<HarnessRegistry>("harnesses")),
        createProvider: (account) => createAcpProvider(host, createDeepSeekProfile(account)),
        status: dshAccountStatus,
        // dsh has no login command; the helper stores a key for this login's
        // DSH_HOME. It runs on this machine with the server's Node.
        signInCommand: (account) => harnessCommandLine([process.execPath, SIGN_IN_SCRIPT], {
            // The desktop app hosts the server in Electron, whose binary
            // starts another app window unless told to act as Node.js.
            ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
            ...(account ? { DSH_HOME: account.dir } : {}),
        }),
    });
    return {
        remoteAccess: localOnlyRemoteAccess(["backend-deepseek"]),
        routes: accounts.routes,
        onEnable: accounts.onEnable,
        onDisable: accounts.onDisable,
    };
}
