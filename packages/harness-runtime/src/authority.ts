import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Duplex } from "node:stream";
import type { ExecutionReleaseProof, MutationOutcome, RuntimeSessionBinding } from "@polyth/contracts";
export type ProcessAuthorityProof = {
    authorityId: string;
    generation: number;
};

/** Read-only maintenance evidence, never an instruction to terminate a process.
 * A missing PID, socket or state file is deliberately not accepted. */
export function hasDurableProcessRelease(file: string, expected: ProcessAuthorityProof): boolean {
    if (!Number.isSafeInteger(expected.generation) || expected.generation <= 0) return false;
    const exact = (value: Partial<State> | undefined) => value?.authorityId === expected.authorityId && value.generation === expected.generation;
    const state = readOwnedJson<State>(file);
    if (!exact(state)) return false;
    if (state!.released === true) return true;
    // The supervisor writes this receipt once the executor tree is gone; release()
    // accepts it as the same proof when the server never persisted `released`.
    const receipt = `${file}.${expected.authorityId}.${expected.generation}.released`;
    return state!.receiptFile === receipt && exact(readOwnedJson<ProcessAuthorityProof>(receipt));
}
function readOwnedJson<T>(file: string): Partial<T> | undefined {
    let descriptor: number | undefined;
    try {
        descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = fstatSync(descriptor);
        if (!info.isFile() || info.size <= 0 || info.size > 1024 * 1024) return undefined;
        const bytes = Buffer.alloc(info.size + 1);
        const length = readSync(descriptor, bytes, 0, bytes.length, 0);
        if (length !== info.size) return undefined;
        return JSON.parse(bytes.toString("utf8", 0, length)) as Partial<T>;
    } catch { return undefined; }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
}
type State = ProcessAuthorityProof & {
    pid?: number;
    startTime?: string;
    receiptFile?: string;
    released?: boolean;
    releasedAuthorities: ProcessAuthorityProof[];
    receipts: Record<string, string>;
    containment?: ProcessContainment;
    /** Boot first observed while a legacy, uncontained executor lacked release
     * proof. A later boot is the external boundary that proves it cannot still
     * execute; the observing boot itself is never sufficient. */
    legacyRecoveryBootId?: string;
};

export type ProcessContainment = {
    kind: "systemd-user-scope";
    unit: string;
    bootId: string;
};

export interface ProcessContainmentController {
    create(proof: ProcessAuthorityProof): ProcessContainment;
    launch(
        containment: ProcessContainment,
        command: string,
        args: readonly string[],
    ): { command: string; args: string[] };
    release(containment: ProcessContainment): Promise<boolean>;
    /** Distinguishes an admitted launch from a not-yet-created unit. */
    status?(containment: ProcessContainment): Promise<"active" | "empty" | "unknown">;
}

export interface ProcessAuthorityOptions {
    /** Test/embedding seam. `false` preserves the receipt-only legacy mode. */
    containment?: ProcessContainmentController | false;
}

const unknown = (message: string) => Object.assign(new Error(message), { code: "outcome-unknown" });
const unavailable = (message: string) => Object.assign(new Error(message), { code: "unavailable" });
/** A launch target's directory is gone. Retrying launches a provider process
 * into a deleted directory, so callers must reclaim the dead incarnation
 * rather than re-drive the same spawn. */
export const workspaceUnavailableError = (message: string) => Object.assign(unavailable(message), {
    reason: "workspace-unavailable" as const,
    retryAfterMs: 60_000,
});
export const isWorkspaceUnavailableError = (error: unknown): boolean =>
    (error as { code?: unknown } | null)?.code === "unavailable"
    && (error as { reason?: unknown } | null)?.reason === "workspace-unavailable";
const SYSTEMD_SCOPE_RE = /^polyth-runtime-[a-f0-9]{24}-[1-9][0-9]*\.scope$/;
const BOOT_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const systemdScopeUnit = (proof: ProcessAuthorityProof): string | undefined => {
    if (
        typeof proof.authorityId !== "string"
        || !Number.isSafeInteger(proof.generation)
        || proof.generation <= 0
    ) {
        return undefined;
    }
    const authority = createHash("sha256").update(proof.authorityId).digest("hex").slice(0, 24);
    return `polyth-runtime-${authority}-${proof.generation}.scope`;
};
const currentBootId = () => {
    try {
        return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    }
    catch {
        return "";
    }
};
const executableOnPath = (name: string) => {
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
        if (!directory)
            continue;
        const candidate = join(directory, name);
        try {
            accessSync(candidate, constants.X_OK);
            return candidate;
        }
        catch { /* continue */ }
    }
    return undefined;
};
const command = (
    executable: string,
    args: readonly string[],
    timeoutMs = 2_000,
): Promise<{ code: number | null; stdout: string }> => new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, [...args], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, code: number | null = null) => {
        if (settled)
            return;
        settled = true;
        if (timer)
            clearTimeout(timer);
        if (error)
            rejectCommand(error);
        else
            resolveCommand({ code, stdout });
    };
    child.stdout?.on("data", chunk => {
        if (stdout.length < 16_384)
            stdout += String(chunk).slice(0, 16_384 - stdout.length);
    });
    child.once("error", error => finish(error));
    child.once("exit", code => finish(undefined, code));
    timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error(`process containment command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
});

let detectedContainment: ProcessContainmentController | null | undefined;
const systemdContainment = (): ProcessContainmentController | undefined => {
    if (detectedContainment !== undefined)
        return detectedContainment ?? undefined;
    const systemdRun = executableOnPath("systemd-run");
    const systemctl = executableOnPath("systemctl");
    if (!systemdRun || !systemctl) {
        detectedContainment = null;
        return undefined;
    }
    const probe = spawnSync(systemctl, ["--user", "show-environment"], {
        stdio: "ignore",
        timeout: 1_000,
    });
    if (probe.status !== 0) {
        detectedContainment = null;
        return undefined;
    }
    if (!BOOT_ID_RE.test(currentBootId())) {
        detectedContainment = null;
        return undefined;
    }
    const inspect = async (unit: string) => {
        const result = await command(systemctl, [
            "--user",
            "show",
            unit,
            "--property=LoadState",
            "--property=ActiveState",
        ], 1_000);
        if (result.code !== 0)
            return undefined;
        return Object.fromEntries(result.stdout.trim().split("\n").map(line => {
            const equals = line.indexOf("=");
            return equals < 0 ? [line, ""] : [line.slice(0, equals), line.slice(equals + 1)];
        }));
    };
    detectedContainment = {
        create(proof) {
            const unit = systemdScopeUnit(proof);
            if (!unit)
                throw unavailable("Process authority cannot form a containment identity");
            return {
                kind: "systemd-user-scope",
                unit,
                bootId: currentBootId(),
            };
        },
        launch(containment, executable, args) {
            return {
                command: systemdRun,
                args: [
                    "--user",
                    "--scope",
                    `--unit=${containment.unit}`,
                    "--quiet",
                    "--collect",
                    executable,
                    ...args,
                ],
            };
        },
        async status(containment) {
            if (!SYSTEMD_SCOPE_RE.test(containment.unit)) return "unknown";
            const state = await inspect(containment.unit);
            if (!state) return "unknown";
            return state.LoadState === "not-found" || state.ActiveState === "inactive" || state.ActiveState === "failed"
                ? "empty" : "active";
        },
        async release(containment) {
            if (!SYSTEMD_SCOPE_RE.test(containment.unit))
                return false;
            let state = await inspect(containment.unit);
            if (!state)
                return false;
            if (state.LoadState === "not-found"
                || state.ActiveState === "inactive"
                || state.ActiveState === "failed")
                return true;
            await command(systemctl, [
                "--user",
                "kill",
                "--kill-who=all",
                "--signal=SIGKILL",
                containment.unit,
            ]).catch(() => undefined);
            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline) {
                state = await inspect(containment.unit);
                if (state && (state.LoadState === "not-found"
                    || state.ActiveState === "inactive"
                    || state.ActiveState === "failed"))
                    return true;
                await new Promise(resolveWait => setTimeout(resolveWait, 20));
            }
            return false;
        },
    };
    return detectedContainment;
};

/** Kernel containment for an owner that supplies its own PTY/stdio launcher.
 * An optional private record supports exact-boundary release after restart. */
export interface ProcessContainmentBoundary {
    launch(command: string, args: readonly string[]): { command: string; args: string[] };
    launcherStarted?(pid: number): void;
    launcherExited(): void;
    close(): Promise<void>;
}

interface TerminalContainmentRecord extends ProcessAuthorityProof {
    kind: "terminal-containment";
    containment: ProcessContainment;
    ownerPid: number;
    ownerStartTime: string;
    launched: boolean;
    observed: boolean;
    exited: boolean;
    released: boolean;
    pid?: number;
    startTime?: string;
}

const persistContainmentRecord = (file: string | undefined, record: TerminalContainmentRecord): void => {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
};

const readContainmentRecord = (file: string): TerminalContainmentRecord => {
    const descriptor = openSync(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    let record: TerminalContainmentRecord;
    try {
        if (!fstatSync(descriptor).isFile()) throw unknown("Invalid terminal containment record");
        const buffer = Buffer.alloc(16_385);
        const length = readSync(descriptor, buffer, 0, buffer.length, 0);
        if (length > 16_384) throw unknown("Terminal containment record is oversized");
        record = JSON.parse(buffer.subarray(0, length).toString("utf8")) as TerminalContainmentRecord;
    } finally { closeSync(descriptor); }
    if (record?.kind !== "terminal-containment"
        || record.containment?.kind !== "systemd-user-scope"
        || record.containment.unit !== systemdScopeUnit(record)
        || !BOOT_ID_RE.test(record.containment.bootId)
        || !Number.isSafeInteger(record.ownerPid) || record.ownerPid <= 0
        || typeof record.ownerStartTime !== "string" || !/^\d+$/.test(record.ownerStartTime)
        || [record.launched, record.observed, record.exited, record.released].some(value => typeof value !== "boolean")
        || (record.pid !== undefined && (!Number.isSafeInteger(record.pid) || record.pid <= 0))
        || (record.startTime !== undefined && (typeof record.startTime !== "string" || !/^\d+$/.test(record.startTime)))) {
        throw unknown("Terminal containment record is malformed");
    }
    return record;
};

/** Recover only an exact persisted terminal authority, never an ambient PID. */
export async function releaseProcessContainmentRecord(
    file: string,
    controller = process.platform === "linux" ? systemdContainment() : undefined,
): Promise<void> {
    const record = readContainmentRecord(file);
    if (record.released) return;
    const boot = currentBootId();
    const changedBoot = BOOT_ID_RE.test(boot) && boot !== record.containment.bootId;
    const neverLaunched = !record.launched && identity(record.ownerPid) !== record.ownerStartTime;
    if (!changedBoot && !neverLaunched) {
        if (!controller?.status) throw unknown("Terminal execution containment is unavailable for recovery");
        const status = await controller.status(record.containment);
        const launcherFinished = record.exited || record.observed
            || (record.pid !== undefined && record.startTime !== undefined && identity(record.pid) !== record.startTime);
        if (!(status === "active" || (status === "empty" && launcherFinished))
            || !await controller.release(record.containment)) {
            throw unknown("Terminal execution has no verified recovery release");
        }
    }
    record.released = true;
    persistContainmentRecord(file, record);
}

export function createProcessContainmentBoundary(
    controller = process.platform === "linux" ? systemdContainment() : undefined,
    options: { file?: string } = {},
): ProcessContainmentBoundary | undefined {
    if (!controller?.status) return undefined;
    if (options.file && existsSync(options.file)) throw Object.assign(new Error("Terminal containment record already exists"), { code: "conflict" });
    const proof = { authorityId: randomUUID(), generation: 1 };
    const containment = controller.create(proof);
    const record: TerminalContainmentRecord = { kind: "terminal-containment", ...proof, containment,
        ownerPid: process.pid, ownerStartTime: identity(process.pid) ?? "", launched: false, observed: false, exited: false, released: false };
    persistContainmentRecord(options.file, record);
    let closing: Promise<void> | undefined;
    return {
        launch(command, args) {
            if (record.launched) throw Object.assign(new Error("Containment already owns a launch"), { code: "conflict" });
            record.launched = true;
            persistContainmentRecord(options.file, record);
            return controller.launch(containment, command, args);
        },
        launcherStarted(pid) {
            record.pid = pid;
            record.startTime = identity(pid);
            persistContainmentRecord(options.file, record);
        },
        launcherExited() {
            record.exited = true;
            try { persistContainmentRecord(options.file, record); } catch { /* close must retry durable release */ }
        },
        close() {
            if (record.released) return Promise.resolve().then(() => { persistContainmentRecord(options.file, record); });
            if (!record.launched) {
                record.released = true;
                persistContainmentRecord(options.file, record);
                return Promise.resolve();
            }
            if (closing) return closing;
            closing = (async () => {
                const deadline = Date.now() + 5_000;
                do {
                    const state = await controller.status!(containment);
                    // An empty unit before launcher exit might simply mean that
                    // systemd-run has not submitted it yet. Never publish release
                    // while that launcher can still create the execution scope.
                    if (state === "active" || (state === "empty" && (record.exited || record.observed))) {
                        if (state === "active") { record.observed = true; persistContainmentRecord(options.file, record); }
                        if (!await controller.release(containment)) break;
                        record.released = true;
                        return;
                    }
                    await new Promise(resolveWait => setTimeout(resolveWait, 20));
                } while (Date.now() < deadline);
                throw unknown("Terminal execution containment has no verified release");
            })().then(() => { persistContainmentRecord(options.file, record); })
                .finally(() => { closing = undefined; });
            return closing;
        },
    };
}
const supervisorExecutable = () => {
    const target = `linux-${process.arch}`;
    const resources = process.env.POLYTH_RESOURCES_DIR;
    if (resources)
        return join(resources, "runtime-supervisor", target, "polyth-supervisor");
    const source = join(import.meta.dirname, "..", "native", "bin", target, "polyth-supervisor");
    return existsSync(source)
        ? source
        : join(import.meta.dirname, "..", "resources", "runtime-supervisor", target, "polyth-supervisor");
};
const validateLaunch = (binary: string, options: SpawnOptions) => {
    if (options.cwd !== undefined) {
        try {
            if (!statSync(options.cwd).isDirectory())
                throw workspaceUnavailableError("Runtime workspace/cwd is not a directory");
        }
        catch (error) {
            if ((error as { code?: string }).code === "unavailable") throw error;
            const code = (error as { code?: string }).code;
            if (code === "ENOENT" || code === "ENOTDIR")
                throw workspaceUnavailableError("Runtime workspace/cwd no longer exists");
            throw unavailable("Runtime workspace/cwd is unavailable");
        }
    }
    try {
        if (!statSync(binary).isFile())
            throw unavailable("Polyth runtime supervisor binary is unavailable");
        accessSync(binary, constants.X_OK);
    }
    catch (error) {
        if ((error as { code?: string }).code === "unavailable") throw error;
        const code = (error as { code?: string }).code;
        throw unavailable(code === "ENOENT"
            ? "Polyth runtime supervisor binary is missing"
            : "Polyth runtime supervisor binary is unavailable");
    }
};
const identity = (pid: number) => {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    }
    catch (error) {
        if ((error as {
            code?: string;
        }).code === "ENOENT")
            return undefined;
        throw error;
    }
};
const confirmed = (state: State) => {
    if (!state.receiptFile)
        return false;
    try {
        const proof = JSON.parse(readFileSync(state.receiptFile, "utf8")) as ProcessAuthorityProof;
        return proof.authorityId === state.authorityId && proof.generation === state.generation;
    }
    catch (error) {
        if ((error as {
            code?: string;
        }).code === "ENOENT")
            return false;
        throw error;
    }
};
const writeReleaseReceipt = (state: State, stateFile?: string) => {
    if (!state.receiptFile)
        throw unknown("Process containment released without a durable receipt path");
    if (
        stateFile
        && state.receiptFile !== `${stateFile}.${state.authorityId}.${state.generation}.released`
    ) {
        throw unknown("Process containment receipt path does not match its authority");
    }
    const temp = `${state.receiptFile}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({
        authorityId: state.authorityId,
        generation: state.generation,
    }), { mode: 0o600 });
    renameSync(temp, state.receiptFile);
};
const observeLegacyRecoveryBoot = (state: State, stateFile?: string) => {
    if (!stateFile || state.containment || state.legacyRecoveryBootId)
        return;
    const bootId = currentBootId();
    if (!BOOT_ID_RE.test(bootId))
        return;
    state.legacyRecoveryBootId = bootId;
    const temp = `${stateFile}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    renameSync(temp, stateFile);
};
const recoverContained = async (
    state: State,
    controller: ProcessContainmentController | undefined,
    stateFile?: string,
) => {
    const bootId = currentBootId();
    if (
        !state.containment
        && typeof state.legacyRecoveryBootId === "string"
        && BOOT_ID_RE.test(state.legacyRecoveryBootId)
        && BOOT_ID_RE.test(bootId)
        && bootId !== state.legacyRecoveryBootId
    ) {
        writeReleaseReceipt(state, stateFile);
        return true;
    }
    const containment = state.containment;
    const expectedUnit = systemdScopeUnit(state);
    if (!containment)
        return false;
    if (containment.kind !== "systemd-user-scope"
        || !SYSTEMD_SCOPE_RE.test(containment.unit)
        || containment.unit !== expectedUnit
        || typeof containment.bootId !== "string"
        || !BOOT_ID_RE.test(containment.bootId))
        return false;
    if (BOOT_ID_RE.test(bootId) && bootId !== containment.bootId) {
        writeReleaseReceipt(state, stateFile);
        return true;
    }
    if (!controller || !await controller.release(containment))
        return false;
    writeReleaseReceipt(state, stateFile);
    return true;
};
async function release(
    state: State,
    controller: ProcessContainmentController | undefined,
    stateFile?: string,
) {
    if (!state.pid || state.released || confirmed(state))
        return;
    if (!state.receiptFile || !state.startTime || identity(state.pid) !== state.startTime) {
        if (await recoverContained(state, controller, stateFile))
            return;
        throw unknown("Previous executor has no verified release receipt");
    }
    let signalled = false;
    for (let i = 0; i < 250; i++) {
        if (confirmed(state))
            return;
        const ready = confirmed({ ...state, receiptFile: state.receiptFile + ".ready" });
        if (identity(state.pid) !== state.startTime) {
            if (await recoverContained(state, controller, stateFile))
                return;
            throw unknown(ready
                ? "Executor exited without a release receipt"
                : "Polyth runtime supervisor exited before ready");
        }
        if (!signalled && ready) {
            try {
                process.kill(state.pid, "SIGTERM");
            }
            catch (error) {
                if ((error as {
                    code?: string;
                }).code !== "ESRCH")
                    throw error;
            }
            signalled = true;
        }
        await new Promise(r => setTimeout(r, 20));
    }
    if (await recoverContained(state, controller, stateFile))
        return;
    throw unknown("Executor descendants have not confirmed shutdown");
}

/** Fence an exact durable process authority without constructing a runtime or
 * spawning in its (possibly vanished) workspace. */
export async function releaseProcessExecution(
    file: string,
    binding: RuntimeSessionBinding,
    operationId: string,
): Promise<MutationOutcome<ExecutionReleaseProof>> {
    const backendSessionId = binding.backendSessionId;
    if (!backendSessionId) {
        return { kind: "rejected", code: "binding-mismatch", message: "backend execution identity is missing" };
    }
    let state: State;
    try {
        state = JSON.parse(readFileSync(file, "utf8")) as State;
    }
    catch (error) {
        return {
            kind: "rejected",
            code: (error as { code?: string }).code === "ENOENT" ? "not-found" : "invalid-state",
            message: "durable process authority is unavailable",
        };
    }
    if (!state || typeof state !== "object"
        || typeof state.authorityId !== "string"
        || !Number.isSafeInteger(state.generation)
        || !Array.isArray(state.releasedAuthorities)
        || !state.releasedAuthorities.every((proof) => proof
            && typeof proof.authorityId === "string" && Number.isSafeInteger(proof.generation))) {
        return { kind: "rejected", code: "invalid-state", message: "durable process authority is malformed" };
    }
    const exactCurrent = state.authorityId === binding.authorityId
        && state.generation === binding.generation;
    const alreadyReleased = state.releasedAuthorities.some((proof) =>
        proof.authorityId === binding.authorityId && proof.generation === binding.generation);
    if (!exactCurrent && !alreadyReleased) {
        return { kind: "rejected", code: "stale-evidence", message: "durable process authority does not match" };
    }
    try {
        // If a prior recovery already advanced this state file, fence that
        // successor too: it may be the facade that reattached the same native
        // session before crashing. Provider state keys are exact to the
        // canonical session/workspace, so no unrelated authority is touched.
        if (!state.released) {
            await release(state, systemdContainment(), file);
            state.released = true;
            const temp = `${file}.${randomUUID()}.tmp`;
            writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
            renameSync(temp, file);
        }
        return {
            kind: "confirmed",
            value: {
                authorityId: binding.authorityId,
                generation: binding.generation,
                backendSessionId,
            },
        };
    }
    catch (error) {
        if ((error as { code?: string }).code === "outcome-unknown")
            observeLegacyRecoveryBoot(state, file);
        return {
            kind: "unknown",
            operationId,
            message: error instanceof Error ? error.message : "process authority release was not confirmed",
        };
    }
}
const discardReceiptFiles = (receipt: string): void => {
    for (const path of [receipt, `${receipt}.ready`]) {
        // A receipt that is already gone or cannot be removed is harmless.
        try { unlinkSync(path); } catch { /* lingers */ }
    }
};
/** Receipts of generations released before the most recent one are dead
 * weight once the state file names a newer generation: `hasDurableProcessRelease`
 * consults a receipt only for the generation the state file currently names,
 * and `releaseProcessExecution` proves older generations through
 * `releasedAuthorities`. The immediately preceding generation keeps its receipt
 * pair as the visible release evidence of the last recovery; without pruning
 * every restart left two more files per runtime behind forever. */
const pruneSupersededReceipts = (file: string, state: State, keep: ProcessAuthorityProof | undefined): void => {
    for (const proof of state.releasedAuthorities) {
        if (proof.authorityId === state.authorityId && proof.generation === state.generation) continue;
        if (keep && proof.authorityId === keep.authorityId && proof.generation === keep.generation) continue;
        discardReceiptFiles(`${file}.${proof.authorityId}.${proof.generation}.released`);
    }
};
/** Shared lifecycle only, not another execution API. Both SDK custom spawns
 * and stdio transports use the same durable, Linux-owned process authority. */
export async function createProcessAuthority(
    file?: string,
    stable = false,
    proof?: ProcessAuthorityProof,
    options: ProcessAuthorityOptions = {},
) {
    if (process.platform !== "linux")
        throw Object.assign(new Error("Execution supervision currently requires Linux"), { code: "unsupported" });
    let prior: State | undefined;
    if (file)
        try {
            prior = JSON.parse(readFileSync(file, "utf8")) as State;
        }
        catch (error) {
            if ((error as {
                code?: string;
            }).code !== "ENOENT")
                throw error;
        }
    const controller = options.containment === false
        ? undefined
        : options.containment ?? systemdContainment();
    if (prior)
        try {
            await release(prior, controller, file);
        }
        catch (error) {
            if ((error as { code?: string }).code === "outcome-unknown")
                observeLegacyRecoveryBoot(prior, file);
            throw error;
        }
    const state: State = { authorityId: stable && prior ? prior.authorityId : randomUUID(), generation: (prior?.generation ?? 0) + 1, ...proof, receipts: prior?.receipts ?? {}, releasedAuthorities: [...(prior?.releasedAuthorities ?? []), ...(prior ? [{ authorityId: prior.authorityId, generation: prior.generation }] : [])] };
    if (controller)
        state.containment = controller.create(state);
    state.receiptFile = file ? `${file}.${state.authorityId}.${state.generation}.released` : join(tmpdir(), `polyth-authority-${state.authorityId}.released`);
    mkdirSync(dirname(state.receiptFile), { recursive: true });
    if (file) pruneSupersededReceipts(file, state, prior);
    let child: ChildProcess | undefined;
    const persist = () => { if (!file)
        return; mkdirSync(dirname(file), { recursive: true }); const temp = `${file}.${randomUUID()}.tmp`; writeFileSync(temp, JSON.stringify(state), { mode: 0o600 }); renameSync(temp, file); };
    return {
        authorityId: state.authorityId, generation: state.generation, receipts: state.receipts, releasedAuthorities: state.releasedAuthorities,
        spawn(command: string, args: string[], options: SpawnOptions = {}) {
            if (child)
                throw Object.assign(new Error("Authority already owns a process"), { code: "conflict" });
            const binary = supervisorExecutable();
            validateLaunch(binary, options);
            const proof = JSON.stringify({ authorityId: state.authorityId, generation: state.generation });
            // SDK cancellation may kill the native process, but must not SIGKILL the
            // supervisor before it has proved descendants stopped. close() owns it.
            const { signal: _signal, shell: _shell, ...spawnOptions } = options;
            const supervisorArgs = [state.receiptFile!, proof, command, ...args];
            const launch = state.containment && controller
                ? controller.launch(state.containment, binary, supervisorArgs)
                : { command: binary, args: supervisorArgs };
            child = spawn(launch.command, launch.args, { ...spawnOptions, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] });
            const gate = child.stdio[3] as Duplex;
            const failGate = (): void => {
                // The proof gate is part of ownership publication. If it
                // disappears, never leave the supervisor waiting indefinitely.
                if (child && child.exitCode === null && child.signalCode === null)
                    child.kill("SIGKILL");
            };
            gate.on("error", failGate);
            state.pid = child.pid;
            state.startTime = child.pid ? identity(child.pid) : undefined;
            try {
                persist();
                gate.write("G", (error) => { if (error)
                    failGate(); });
            }
            catch (error) {
                gate.destroy();
                throw error;
            }
            return child;
        },
        async receipt(operationId: string, nativeId: string) { state.receipts[operationId] = nativeId; persist(); },
        async close() {
            await release(state, controller, file);
            state.released = true;
            persist();
            // A transient authority has no state file, so nothing can ever read
            // its receipt again; do not leave it in the temp directory.
            if (!file && state.receiptFile) discardReceiptFiles(state.receiptFile);
        },
    };
}
