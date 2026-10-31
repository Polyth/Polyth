// Background harness installs.
//
// Settings installs a harness CLI without a terminal: the server runs the
// backend's own fixed installer through the machine's system shell, with
// stdin closed, and reports plain-language progress. The browser never sends
// a command. One install per harness and machine runs at a time (a second
// start joins it), and installs on one machine run one after another, because
// npm-based installers share the per-user Node.js download. After a clean
// exit Polyth probes the harness again, so "installed" means Polyth finds it.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
    HarnessAvailabilityState,
    HarnessInstallDto,
    HarnessInstallFailureKind,
    HarnessInstallMachine,
    HarnessInstallPreviewDto,
    RemoteHost,
} from "@polyth/contracts";
import { createProcessContainmentBoundary, releaseProcessContainmentRecord, type ProcessContainmentBoundary } from "./authority.ts";

/** A launched installer: merged output, exactly one exit, and a kill that
 *  ends its whole process tree (best effort on an SSH host). */
export interface InstallProcess {
    onOutput(listener: (text: string) => void): void;
    onExit(listener: (code: number | null) => void): void;
    kill(): Promise<void>;
}
export type InstallLauncher = (command: string) => Promise<InstallProcess>;
export type InstallVerification = { installed: boolean; version?: string; state: HarnessAvailabilityState };

const OUTPUT_LIMIT = 24_000;
const ACTIVITY_LIMIT = 140;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_RETAIN_MS = 30 * 60_000;
const MAX_RETAINED = 32;
const KILL_GRACE_MS = 3_000;
const CLOSE_GRACE_MS = 1_000;
/** The probe after an install normally answers in seconds. */
const VERIFY_TIMEOUT_MS = 90_000;

/** Hosts an install command downloads from, in order of appearance. npm
 *  itself reaches the public registry. */
export function installSources(command: string): string[] {
    const hosts = [...command.matchAll(/https:\/\/([A-Za-z0-9.-]+)/g)].map((match) => match[1]!.toLowerCase());
    // POSIX `npm install …`; the Windows script calls `npm.cmd` through a variable.
    if (/\bnpm\s+install\b|\bnpm\.cmd\b/.test(command)) hosts.push("registry.npmjs.org");
    return [...new Set(hosts)];
}

export const installMachineOs = (platform: NodeJS.Platform = process.platform): Extract<HarnessInstallMachine, { kind: "local" }>["os"] =>
    platform === "darwin" || platform === "win32" || platform === "linux" ? platform : "other";

// CSI (colours, cursor moves), OSC (titles, links) and other two-byte escapes.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
/** Lines that say nothing to a person watching an install. */
const NOISE = /^(?:npm (?:warn|notice)\b|.*\bdeprecated\b|[-=_.:*#\s]+$)/i;
// Spinner frames and bullets a script prints before its words.
const LEADING_MARKS = /^[\s⠀-⣿|/\\>*•·-]+/u;

/** An installer's merged output as a person would read it: escapes removed,
 *  carriage-return redraws (spinners, progress bars) collapsed to their final
 *  state, bounded to the newest text. */
export function createInstallOutput(limit = OUTPUT_LIMIT) {
    let committed = "";
    let partial = "";
    let overwrite = false;
    let truncated = false;
    const bound = () => {
        // A line that never ends (dots, a bar without `\r`) is bounded too.
        if (partial.length > limit) { partial = partial.slice(-limit); truncated = true; }
        if (committed.length <= limit) return;
        const cut = committed.indexOf("\n", committed.length - limit);
        committed = committed.slice(cut >= 0 ? cut + 1 : committed.length - limit);
        truncated = true;
    };
    return {
        append(chunk: string): void {
            const clean = chunk.replace(ANSI, "");
            for (const token of clean.split(/(\r\n|\n|\r)/)) {
                if (token === "\n" || token === "\r\n") {
                    committed += `${partial}\n`;
                    partial = "";
                    overwrite = false;
                } else if (token === "\r") {
                    overwrite = true;
                } else if (token) {
                    if (overwrite) { partial = ""; overwrite = false; }
                    partial += token.replace(CONTROL, "");
                }
            }
            bound();
        },
        text(): string {
            return `${committed}${partial}`.replace(/\n{3,}/g, "\n\n").trimEnd();
        },
        get truncated(): boolean { return truncated; },
        /** The newest line worth showing as "what it is doing now". */
        activity(): string | undefined {
            const lines = `${committed}${partial}`.split("\n");
            for (let index = lines.length - 1; index >= 0; index--) {
                const line = lines[index]!.replace(LEADING_MARKS, "").trim();
                if (!line || NOISE.test(line) || !/[A-Za-z]{2}/.test(line)) continue;
                return line.length > ACTIVITY_LIMIT ? `${line.slice(0, ACTIVITY_LIMIT - 1)}…` : line;
            }
            return undefined;
        },
    };
}

const FAILURE_PATTERNS: ReadonlyArray<readonly [HarnessInstallFailureKind, RegExp]> = [
    ["disk-space", /no space left on device|\bENOSPC\b|not enough (?:disk )?space|disk (?:is )?full/i],
    ["checksum", /checksum|integrity check|\bEINTEGRITY\b|security halt|hash mismatch|download was damaged/i],
    ["unsupported-platform", /unsupported (?:operating system|os|architecture|platform|cpu)|not supported on (?:this|your)|cannot install node\.js on this system|currently supports? (?:64-bit )?(?:windows|macos|linux)|only (?:supports?|runs on) (?:macos|linux)/i],
    ["permission", /permission denied|\bEACCES\b|\bEPERM\b|access is denied|operation not permitted|read-only file system/i],
    ["prerequisite", /\b(?:curl|wget|bash|tar|unzip|powershell|git)\b[^\n]{0,24}?(?:command not found|: not found|is not recognized)|neither curl nor wget|curl or wget (?:is )?required|is not recognized as an internal or external command/i],
    ["network", /could ?n[o']t resolve|failed to connect|connection (?:refused|reset|timed out)|network is unreachable|\bENOTFOUND\b|\bEAI_AGAIN\b|\bETIMEDOUT\b|\bECONNRESET\b|\bECONNREFUSED\b|could not (?:reach|connect)|check (?:your|the) internet|unable to (?:access|connect)|\bssl\b|certificate|remote name could not be resolved|no such host is known|temporary failure in name resolution|network or dns|failed to download|downloading [^\n]* failed/i],
];

const MISSING_TOOL = /\b(curl|wget|bash|tar|unzip|powershell|git)\b[^\n]{0,24}?(?:command not found|: not found|is not recognized)/i;

const lastLines = (text: string, count: number): string => text.split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !NOISE.test(line))
    .slice(-count)
    .join("\n");

/** Why an installer failed, from its exit and its own last words. */
export function classifyInstallFailure(output: string, exitCode: number | null, name = "The harness"): { kind: HarnessInstallFailureKind; message: string; tool?: string } {
    const tail = output.slice(-6_000);
    const kind = FAILURE_PATTERNS.find(([, pattern]) => pattern.test(tail))?.[0] ?? "unknown";
    switch (kind) {
        case "network": return { kind, message: "The download did not get through. Check the internet connection, proxy or firewall, then try again." };
        case "permission": return { kind, message: "The installer was not allowed to write where it needed to." };
        case "disk-space": return { kind, message: "The disk is full. Free some space, then try again." };
        case "unsupported-platform": return { kind, message: `${name} does not support this system.` };
        case "checksum": return { kind, message: "A download arrived damaged, so the installer stopped to stay safe. Trying again usually helps." };
        case "prerequisite": {
            const tool = MISSING_TOOL.exec(tail)?.[1]?.toLowerCase();
            return tool
                ? { kind, message: `The installer needs ${tool}, which this machine does not have.`, tool }
                : { kind, message: "The installer needs a tool this machine does not have." };
        }
        default: {
            const last = lastLines(output, 2);
            return { kind: "unknown", message: last || (exitCode === null ? "The installer stopped unexpectedly." : `The installer stopped with exit code ${exitCode}.`) };
        }
    }
}

/** Environment of a local install: the server's, with the PATH a setup
 *  terminal gets and npm's chatter turned off. */
export function installEnvironment(base: NodeJS.ProcessEnv, extra: Readonly<Record<string, string>>, platform: NodeJS.Platform = process.platform): Record<string, string> {
    const env: Record<string, string> = {};
    // Credential Vault references resolve only in the composer shell, never here.
    for (const [key, value] of Object.entries(base)) if (value !== undefined && !/^POLYTH_SAFE_/i.test(key)) env[key] = value;
    for (const [key, value] of Object.entries(extra)) {
        // Windows names are case-insensitive: one `Path`/`PATH` entry only.
        if (platform === "win32") for (const existing of Object.keys(env)) if (existing.toUpperCase() === key.toUpperCase()) delete env[existing];
        env[key] = value;
    }
    return {
        ...env,
        NO_COLOR: "1",
        npm_config_fund: "false",
        npm_config_audit: "false",
        npm_config_update_notifier: "false",
        npm_config_progress: "false",
    };
}

/** Kernel containment for local installers (a systemd user scope on Linux),
 *  with one private record per install so a later Polyth process can release
 *  an installer that outlived a crash. Undefined where the platform has none;
 *  the process group (or `taskkill /T`) is then the only stop. */
export interface InstallContainment {
    create(): Promise<{ boundary: ProcessContainmentBoundary; release(): Promise<void> } | undefined>;
    /** Release what an earlier Polyth process left running. */
    recover(): Promise<void>;
}

export function createInstallContainment(location: string | (() => string), options: {
    boundary?: typeof createProcessContainmentBoundary;
    release?: typeof releaseProcessContainmentRecord;
} = {}): InstallContainment {
    const createBoundary = options.boundary ?? createProcessContainmentBoundary;
    const releaseRecord = options.release ?? releaseProcessContainmentRecord;
    const forget = (file: string) => unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    // Resolved on first use: the package data directory is created on demand.
    const directory = () => typeof location === "string" ? location : location();
    return {
        async create() {
            const dir = directory();
            await mkdir(dir, { recursive: true, mode: 0o700 });
            const file = join(dir, `${randomUUID()}.authority`);
            const boundary = createBoundary(undefined, { file });
            if (!boundary) return undefined;
            let releasing: Promise<void> | undefined;
            return {
                boundary,
                release: () => releasing ??= boundary.close().then(() => forget(file)),
            };
        },
        async recover() {
            const dir = directory();
            const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return [] as string[];
                throw error;
            });
            for (const name of names) {
                if (!/^[0-9a-f-]{36}\.authority$/i.test(name)) continue;
                const file = join(dir, name);
                try {
                    await releaseRecord(file);
                    await forget(file);
                } catch (error) {
                    // Unproven release: keep the record and say so; never guess.
                    console.warn(`[polyth] an earlier harness install could not be released: ${file}`, error);
                }
            }
        },
    };
}

/** Runs installers on this machine: `/bin/sh -c` in its own process group, or
 *  `cmd.exe` with a verbatim command line, from the home directory, stdin
 *  closed so nothing can wait for an answer. */
export function localInstallLauncher(options: {
    env: () => Promise<Readonly<Record<string, string>>>;
    platform?: NodeJS.Platform;
    containment?: InstallContainment;
}): InstallLauncher {
    const platform = options.platform ?? process.platform;
    return async (command) => {
        const env = installEnvironment(process.env, await options.env(), platform);
        const windows = platform === "win32";
        const contained = windows ? undefined : await options.containment?.create();
        const launch = contained ? contained.boundary.launch("/bin/sh", ["-c", command]) : { command: "/bin/sh", args: ["-c", command] };
        let child;
        try {
            child = windows
                ? spawn(env.ComSpec ?? env.COMSPEC ?? "cmd.exe", [`/d /s /c "${command}"`], { cwd: homedir(), env, stdio: ["ignore", "pipe", "pipe"], windowsVerbatimArguments: true, windowsHide: true })
                : spawn(launch.command, launch.args, { cwd: homedir(), env, stdio: ["ignore", "pipe", "pipe"], detached: true });
        } catch (error) {
            await contained?.release().catch(() => undefined);
            throw error;
        }
        if (child.pid !== undefined) contained?.boundary.launcherStarted?.(child.pid);
        // Once the shell is gone, nothing it left behind keeps running.
        const releaseContainment = () => {
            if (!contained) return;
            contained.boundary.launcherExited();
            void contained.release().catch((error: unknown) => console.warn("[polyth] harness install containment was not released", error));
        };
        const outputs = new Set<(text: string) => void>();
        const exits = new Set<(code: number | null) => void>();
        let exited = false;
        let code: number | null = null;
        let closed = false;
        const emit = (text: string) => { if (text) for (const listener of outputs) listener(text); };
        for (const stream of [child.stdout, child.stderr]) {
            const decoder = new StringDecoder("utf8");
            stream?.on("data", (chunk: Buffer) => emit(decoder.write(chunk)));
            stream?.on("end", () => emit(decoder.end()));
            stream?.on("error", () => {});
        }
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            releaseContainment();
            for (const listener of exits) listener(code);
        };
        child.on("error", (error) => {
            emit(`${error.message}\n`);
            exited = true;
            finish();
        });
        child.on("exit", (exitCode) => {
            exited = true;
            code = typeof exitCode === "number" ? exitCode : null;
            // Let the pipes drain; a lingering grandchild may hold them open.
            if (closed) finish();
            else setTimeout(finish, CLOSE_GRACE_MS);
        });
        child.on("close", () => { closed = true; if (exited) finish(); });
        const pid = child.pid;
        return {
            onOutput: (listener) => { outputs.add(listener); },
            onExit: (listener) => { exits.add(listener); },
            kill: async () => {
                if (exited || pid === undefined) return;
                // The scope ends every descendant, including one that left the group.
                if (contained) await contained.release().catch(() => undefined);
                if (exited) return;
                if (windows) {
                    await new Promise<void>((resolve) => {
                        execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
                    });
                    return;
                }
                try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ }
                await new Promise<void>((resolve) => {
                    if (exited) return resolve();
                    const timer = setTimeout(() => {
                        try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
                        resolve();
                    }, KILL_GRACE_MS);
                    child.once("exit", () => { clearTimeout(timer); resolve(); });
                });
            },
        };
    };
}

/** Runs installers on an SSH host as the SSH user, on the host's harness
 *  PATH, stdin closed. Cancelling closes the connection. */
const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

export function remoteInstallLauncher(remote: Pick<RemoteHost, "start">, setupPath: string): InstallLauncher {
    return async (command) => {
        // The host's login shell (csh, fish, …) only starts POSIX `sh`.
        const handle = await remote.start(`exec /bin/sh -c ${shellQuote(`${setupPath}; ( ${command} ) </dev/null 2>&1`)}`);
        return {
            onOutput: (listener) => { handle.onOutput(listener); },
            onExit: (listener) => { handle.onExit(listener); },
            kill: () => handle.kill(),
        };
    };
}

type JobEntry = {
    key: string;
    queueKey: string;
    dto: Omit<HarnessInstallDto, "output" | "activity" | "truncated">;
    output: ReturnType<typeof createInstallOutput>;
    process?: InstallProcess;
    cancelRequested?: boolean;
    interrupted?: boolean;
};

const ACTIVE = new Set<HarnessInstallDto["phase"]>(["queued", "running", "verifying"]);
export const installActive = (job: Pick<HarnessInstallDto, "phase"> | undefined): boolean => Boolean(job && ACTIVE.has(job.phase));

export interface HarnessInstallStart {
    /** One install per key (harness + machine) at a time. */
    key: string;
    /** Installs that share a key here run one after another (one machine). */
    queueKey: string;
    preview: HarnessInstallPreviewDto;
    launch: InstallLauncher;
    verify(): Promise<InstallVerification>;
}

export type HarnessInstallJobs = ReturnType<typeof createHarnessInstallJobs>;

export function createHarnessInstallJobs(options: { now?: () => number; timeoutMs?: number; retainMs?: number } = {}) {
    const now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retainMs = options.retainMs ?? DEFAULT_RETAIN_MS;
    const entries = new Map<string, JobEntry>();
    const queues = new Map<string, Promise<void>>();

    const snapshot = (entry: JobEntry): HarnessInstallDto => {
        const activity = entry.output.activity();
        return {
            ...entry.dto,
            output: entry.output.text(),
            ...(activity ? { activity } : {}),
            ...(entry.output.truncated ? { truncated: true } : {}),
        };
    };
    const prune = () => {
        for (const entry of [...entries.values()]) {
            if (!ACTIVE.has(entry.dto.phase) && now() - (entry.dto.finishedAt ?? entry.dto.startedAt) > retainMs) entries.delete(entry.key);
        }
        const finished = [...entries.values()].filter((entry) => !ACTIVE.has(entry.dto.phase));
        const excess = finished.length - MAX_RETAINED;
        if (excess > 0) {
            for (const entry of finished.toSorted((a, b) => (a.dto.finishedAt ?? 0) - (b.dto.finishedAt ?? 0)).slice(0, excess)) entries.delete(entry.key);
        }
    };
    const settle = (entry: JobEntry, patch: Partial<JobEntry["dto"]>) => {
        entry.dto = { ...entry.dto, ...patch, finishedAt: now() };
    };

    async function run(entry: JobEntry, input: HarnessInstallStart): Promise<void> {
        // Cancelled or interrupted while it waited for its turn.
        if (entry.dto.phase !== "queued" || entry.cancelRequested || entry.interrupted) return;
        entry.dto = { ...entry.dto, phase: "running" };
        let exitCode: number | null;
        let timedOut = false;
        try {
            const child = await input.launch(entry.dto.command);
            entry.process = child;
            child.onOutput((text) => entry.output.append(text));
            exitCode = await new Promise<number | null>((resolve) => {
                const timer = setTimeout(() => {
                    timedOut = true;
                    void child.kill();
                }, timeoutMs);
                timer.unref?.();
                child.onExit((code) => { clearTimeout(timer); resolve(code); });
                // A cancel that raced the launch.
                if (entry.cancelRequested || entry.interrupted) void child.kill();
            });
        } catch (error) {
            entry.output.append(`${error instanceof Error ? error.message : String(error)}\n`);
            settle(entry, { phase: "failed", exitCode: null, failure: classifyInstallFailure(entry.output.text(), null, entry.dto.harnessName) });
            return;
        } finally {
            entry.process = undefined;
        }
        if (entry.interrupted) {
            settle(entry, { phase: "failed", exitCode, failure: { kind: "interrupted", message: "Polyth stopped before the install finished." } });
            return;
        }
        // A Stop that came after the installer had already succeeded stops
        // nothing: report what is now installed.
        if (entry.cancelRequested && exitCode !== 0) {
            settle(entry, { phase: "cancelled", exitCode });
            return;
        }
        if (timedOut) {
            settle(entry, { phase: "failed", exitCode, failure: { kind: "timeout", message: `The installer was still running after ${Math.round(timeoutMs / 60_000)} minutes, so Polyth stopped it.` } });
            return;
        }
        if (exitCode !== 0) {
            settle(entry, { phase: "failed", exitCode, failure: classifyInstallFailure(entry.output.text(), exitCode, entry.dto.harnessName) });
            return;
        }
        entry.dto = { ...entry.dto, phase: "verifying", exitCode };
        try {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const result = await Promise.race([
                input.verify(),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error("the check did not answer in time")), VERIFY_TIMEOUT_MS);
                    timer.unref?.();
                }),
            ]).finally(() => clearTimeout(timer));
            if (result.installed) {
                settle(entry, { phase: "succeeded", result: { installed: true, ...(result.version ? { version: result.version } : {}), state: result.state } });
            } else {
                // `curl … | bash` exits with bash's 0 when curl failed and
                // bash read an empty script: the installer's own words then
                // say why nothing was installed.
                const said = classifyInstallFailure(entry.output.text(), exitCode, entry.dto.harnessName);
                settle(entry, {
                    phase: "failed",
                    result: { installed: false, state: result.state },
                    failure: said.kind !== "unknown" ? said : { kind: "not-found-after-install", message: `The installer finished, but Polyth does not find ${entry.dto.harnessName} yet. Restarting Polyth lets it read the new location.` },
                });
            }
        } catch (error) {
            settle(entry, { phase: "failed", failure: { kind: "unknown", message: `The installer finished, but checking ${entry.dto.harnessName} failed: ${error instanceof Error ? error.message : String(error)}` } });
        }
    }

    return {
        get(key: string): HarnessInstallDto | undefined {
            prune();
            const entry = entries.get(key);
            return entry ? snapshot(entry) : undefined;
        },
        list(filter: (key: string, job: HarnessInstallDto) => boolean = () => true): HarnessInstallDto[] {
            prune();
            return [...entries.values()].map((entry) => [entry.key, snapshot(entry)] as const)
                .filter(([key, job]) => filter(key, job))
                .map(([, job]) => job)
                .toSorted((a, b) => b.startedAt - a.startedAt);
        },
        /** Start an install, or join the one already under way for this key. */
        start(input: HarnessInstallStart): HarnessInstallDto {
            prune();
            const existing = entries.get(input.key);
            if (existing && ACTIVE.has(existing.dto.phase)) return snapshot(existing);
            const entry: JobEntry = {
                key: input.key,
                queueKey: input.queueKey,
                dto: { ...input.preview, id: randomUUID(), phase: "queued", startedAt: now() },
                output: createInstallOutput(),
            };
            entries.set(input.key, entry);
            const previous = queues.get(input.queueKey) ?? Promise.resolve();
            const next = previous.then(() => run(entry, input)).catch(() => undefined);
            queues.set(input.queueKey, next);
            void next.then(() => { if (queues.get(input.queueKey) === next) queues.delete(input.queueKey); });
            return snapshot(entry);
        },
        /** Stop a queued or running install. Verification cannot be stopped. */
        async cancel(key: string): Promise<HarnessInstallDto | undefined> {
            const entry = entries.get(key);
            if (!entry) return undefined;
            if (entry.dto.phase === "queued") {
                entry.cancelRequested = true;
                settle(entry, { phase: "cancelled" });
            } else if (entry.dto.phase === "running") {
                entry.cancelRequested = true;
                await entry.process?.kill();
            }
            return snapshot(entry);
        },
        /** Package teardown: stop every install; none is left running. */
        async interruptAll(): Promise<void> {
            const active = [...entries.values()].filter((entry) => ACTIVE.has(entry.dto.phase));
            await Promise.all(active.map(async (entry) => {
                entry.interrupted = true;
                if (entry.dto.phase === "queued") settle(entry, { phase: "failed", failure: { kind: "interrupted", message: "Polyth stopped before the install started." } });
                else await entry.process?.kill();
            }));
        },
    };
}
