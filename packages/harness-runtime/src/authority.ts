import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Duplex } from "node:stream";
import type { ExecutionReleaseProof, MutationOutcome, RuntimeSessionBinding } from "@polyth/contracts";
export type ProcessAuthorityProof = {
    authorityId: string;
    generation: number;
};
type State = ProcessAuthorityProof & {
    pid?: number;
    startTime?: string;
    receiptFile?: string;
    released?: boolean;
    releasedAuthorities: ProcessAuthorityProof[];
    receipts: Record<string, string>;
    containment?: ProcessContainment;
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
}

export interface ProcessAuthorityOptions {
    /** Test/embedding seam. `false` preserves the receipt-only legacy mode. */
    containment?: ProcessContainmentController | false;
}

const unknown = (message: string) => Object.assign(new Error(message), { code: "outcome-unknown" });
const unavailable = (message: string) => Object.assign(new Error(message), { code: "unavailable" });
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
                throw unavailable("Runtime workspace/cwd is not a directory");
        }
        catch (error) {
            if ((error as { code?: string }).code === "unavailable") throw error;
            const code = (error as { code?: string }).code;
            if (code === "ENOENT" || code === "ENOTDIR")
                throw unavailable("Runtime workspace/cwd no longer exists");
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
const recoverContained = async (
    state: State,
    controller: ProcessContainmentController | undefined,
    stateFile?: string,
) => {
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
    const bootId = currentBootId();
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
        return {
            kind: "unknown",
            operationId,
            message: error instanceof Error ? error.message : "process authority release was not confirmed",
        };
    }
}
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
        await release(prior, controller, file);
    const state: State = { authorityId: stable && prior ? prior.authorityId : randomUUID(), generation: (prior?.generation ?? 0) + 1, ...proof, receipts: prior?.receipts ?? {}, releasedAuthorities: [...(prior?.releasedAuthorities ?? []), ...(prior ? [{ authorityId: prior.authorityId, generation: prior.generation }] : [])] };
    if (controller)
        state.containment = controller.create(state);
    state.receiptFile = file ? `${file}.${state.authorityId}.${state.generation}.released` : join(tmpdir(), `polyth-authority-${state.authorityId}.released`);
    mkdirSync(dirname(state.receiptFile), { recursive: true });
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
        async close() { await release(state, controller, file); state.released = true; persist(); },
    };
}
