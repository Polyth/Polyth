import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Duplex } from "node:stream";
import { supervisorSource } from "./supervisor.ts";
type Proof = {
    authorityId: string;
    generation: number;
};
type State = Proof & {
    pid?: number;
    startTime?: string;
    receiptFile?: string;
    released?: boolean;
    releasedAuthorities: Proof[];
    receipts: Record<string, string>;
};
const unknown = (message: string) => Object.assign(new Error(message), { code: "outcome-unknown" });
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
        const proof = JSON.parse(readFileSync(state.receiptFile, "utf8")) as Proof;
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
async function release(state: State) {
    if (!state.pid || state.released || confirmed(state))
        return;
    if (!state.receiptFile || identity(state.pid) !== state.startTime)
        throw unknown("Previous executor has no verified release receipt");
    let signalled = false;
    for (let i = 0; i < 250; i++) {
        if (confirmed(state))
            return;
        if (!signalled && confirmed({ ...state, receiptFile: state.receiptFile + ".ready" })) {
            if (identity(state.pid) !== state.startTime)
                throw unknown("Executor exited without a release receipt");
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
    throw unknown("Executor descendants have not confirmed shutdown");
}
/** Shared lifecycle only, not another execution API. Both SDK custom spawns
 * and stdio transports use the same durable, Linux-owned process authority. */
export async function createProcessAuthority(file?: string, stable = false, proof?: Proof) {
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
    if (prior)
        await release(prior);
    const state: State = { authorityId: stable && prior ? prior.authorityId : randomUUID(), generation: (prior?.generation ?? 0) + 1, ...proof, receipts: prior?.receipts ?? {}, releasedAuthorities: [...(prior?.releasedAuthorities ?? []), ...(prior ? [{ authorityId: prior.authorityId, generation: prior.generation }] : [])] };
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
            const config = JSON.stringify({ argv: [command, ...args], receipt: state.receiptFile, proof: { authorityId: state.authorityId, generation: state.generation } });
            // SDK cancellation may kill the native process, but must not SIGKILL the
            // supervisor before it has proved descendants stopped. close() owns it.
            const { signal: _signal, ...spawnOptions } = options;
            child = spawn(process.env.POLYTH_PYTHON_BIN ?? "python3", ["-c", supervisorSource, config], { ...spawnOptions, detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] });
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
        async close() { await release(state); state.released = true; persist(); },
    };
}
