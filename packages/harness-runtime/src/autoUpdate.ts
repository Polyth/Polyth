import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HarnessAutoUpdateState, HarnessDescriptor, HarnessUpdateStatus } from "@polyth/contracts";
import { harnessError } from "./index.ts";

/** One harness the updater may look after (a registry provider). */
export type AutoUpdateHarness = { descriptor: HarnessDescriptor; runtimeLifetime?: "session" | "workspace" };
export type AutoUpdateRun = { ok: boolean; exitCode: number | null; output: string };
/** The host's `harness.runtime.releaseIdle` service. `checkOnly` counts the
 *  chats that are working and releases nothing; `createdBefore` releases only
 *  idle runtimes created before that time. */
export type AutoUpdateRelease = (harnessId: string, options?: { checkOnly?: boolean; createdBefore?: number }) => Promise<{ released: number; busy: number }>;

type StoredRun = NonNullable<HarnessAutoUpdateState["last"]>;
type StoredHarness = { enabled?: boolean; last?: StoredRun };
type Stored = { harnesses?: Record<string, StoredHarness> };
type Memory = {
    /** When to ask for the newest release again. */
    nextCheckAt?: number;
    /** A newer release that waits for the chats to go idle. */
    waiting?: string;
    /** The update finished then: runtimes created before still run the old build. */
    restartBefore?: number;
    nextRestartAt?: number;
};

const FIRST_TICK_MS = 2 * 60_000;
export const AUTO_UPDATE_TICK_MS = 60_000;
/** Release lookups are cached for hours; this only bounds the snapshot probe. */
const CHECK_EVERY_MS = 30 * 60_000;
/** A shared runtime's restart assesses every session on it: not every minute. */
const SHARED_RESTART_EVERY_MS = 5 * 60_000;
/** One release is tried once a day: a failing updater, or one whose channel
 *  lags the registry (Claude's stable channel), is not rerun every check. */
const RETRY_SAME_RELEASE_MS = 24 * 60 * 60_000;
const MESSAGE_TAIL = 600;

/** The program an update replaces: harnesses that run the same CLI (one per
 *  account) are one update and are restarted together. */
const cliKey = (descriptor: HarnessDescriptor): string => descriptor.updateCommand?.[0] ?? descriptor.id;
const eligible = (harness: AutoUpdateHarness): boolean =>
    Boolean(harness.descriptor.updateCommand?.length) && !harness.descriptor.bundled;

export type HarnessAutoUpdaterOptions = {
    /** Machine-wide settings file (the package data directory, not a Space);
     *  a function is resolved on first use, not at registration. */
    file: string | (() => string);
    harnesses(): readonly AutoUpdateHarness[];
    /** This machine's update status for one harness, as the instance owner sees it. */
    status(harness: AutoUpdateHarness): Promise<HarnessUpdateStatus>;
    /** Run the updater of `harness`; `group` is every harness on the same CLI.
     *  Throws a `conflict` when a chat started working in the meantime. */
    update(harness: AutoUpdateHarness, group: readonly AutoUpdateHarness[]): Promise<AutoUpdateRun>;
    /** Resolved per call: the host provides it after this package registers. */
    release(): AutoUpdateRelease | undefined;
    now?: () => number;
    log?: (message: string, error?: unknown) => void;
};

export type HarnessAutoUpdater = ReturnType<typeof createHarnessAutoUpdater>;

/**
 * Installs a harness CLI's new releases by itself when the instance owner
 * turned that on, and only while none of the harness's chats is working:
 * a chat mid-turn keeps its CLI. After an update, every runtime still on the
 * previous build is restarted once its chat is idle (released through the
 * idle-release gate; its next turn launches the new version). Nothing here
 * runs a turn, wakes a dormant chat or interrupts a working one.
 */
export function createHarnessAutoUpdater(options: HarnessAutoUpdaterOptions) {
    const now = options.now ?? Date.now;
    const settingsFile = (): string => typeof options.file === "function" ? options.file() : options.file;
    const log = options.log ?? ((message: string, error?: unknown) => console.warn(`[polyth] ${message}`, error ?? ""));
    const memory = new Map<string, Memory>();
    const updating = new Set<string>();
    let stored: Stored | undefined;
    let writes: Promise<void> = Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ticking: Promise<void> | undefined;
    let running = false;
    let stopped = false;

    const load = async (): Promise<Stored> => {
        if (stored) return stored;
        let data: unknown;
        try {
            data = JSON.parse(await readFile(settingsFile(), "utf8"));
        } catch (error) {
            if ((error as { code?: string }).code !== "ENOENT") log("harness auto-update settings unreadable; starting empty", error);
        }
        stored = data && typeof data === "object" && !Array.isArray(data) ? data as Stored : {};
        return stored;
    };
    const saved = (data: Stored, harnessId: string): StoredHarness => {
        const value = data.harnesses?.[harnessId];
        return value && typeof value === "object" ? value : {};
    };
    const patch = async (harnessId: string, change: StoredHarness): Promise<void> => {
        const data = await load();
        const harnesses = { ...data.harnesses, [harnessId]: { ...saved(data, harnessId), ...change } };
        const next: Stored = { ...data, harnesses };
        stored = next;
        const write = writes.then(async () => {
            const file = settingsFile();
            await mkdir(dirname(file), { recursive: true });
            const temporary = `${file}.${randomUUID()}.tmp`;
            await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
            await rename(temporary, file);
        });
        writes = write.catch(() => undefined);
        try {
            await write;
        } catch (error) {
            // Not saved: do not act on a setting the next start would not have.
            if (stored === next) stored = data;
            throw error;
        }
    };
    const state = (harnessId: string): Memory => {
        let value = memory.get(harnessId);
        if (!value) memory.set(harnessId, value = {});
        return value;
    };
    const groupOf = (harness: AutoUpdateHarness): AutoUpdateHarness[] => {
        const key = cliKey(harness.descriptor);
        const group = options.harnesses().filter((other) => eligible(other) && cliKey(other.descriptor) === key);
        return group.some((other) => other.descriptor.id === harness.descriptor.id) ? group : [harness, ...group];
    };
    /** Chats of the group that are working. Without the host's gate nothing
     *  proves the CLI idle, so nothing is updated. */
    const busyIn = async (group: readonly AutoUpdateHarness[]): Promise<number> => {
        const release = options.release();
        if (!release) return Number.POSITIVE_INFINITY;
        let busy = 0;
        for (const harness of group) busy += (await release(harness.descriptor.id, { checkOnly: true })).busy;
        return busy;
    };
    /** Restart the idle runtimes the update left on the old build; the number
     *  still working, to try again later. */
    const restartOld = async (group: readonly AutoUpdateHarness[], before: number): Promise<number> => {
        const release = options.release();
        if (!release) return 0;
        let busy = 0;
        for (const harness of group) busy += (await release(harness.descriptor.id, { createdBefore: before })).busy;
        return busy;
    };
    const restartStep = async (group: readonly AutoUpdateHarness[], memo: Memory): Promise<void> => {
        if (memo.restartBefore === undefined || now() < (memo.nextRestartAt ?? 0)) return;
        const busy = await restartOld(group, memo.restartBefore);
        if (busy === 0) {
            memo.restartBefore = undefined;
            memo.nextRestartAt = undefined;
            return;
        }
        memo.nextRestartAt = group.some((member) => member.runtimeLifetime === "workspace")
            ? now() + SHARED_RESTART_EVERY_MS
            : undefined;
    };

    const step = async (harness: AutoUpdateHarness): Promise<void> => {
        const id = harness.descriptor.id;
        const memo = state(id);
        const group = groupOf(harness);
        if (memo.restartBefore !== undefined) {
            await restartStep(group, memo);
            return;
        }
        if (now() < (memo.nextCheckAt ?? 0)) return;
        const status = await options.status(harness);
        memo.nextCheckAt = now() + CHECK_EVERY_MS;
        if (!status.available || !status.latest || !status.canUpdate || status.external) {
            memo.waiting = undefined;
            return;
        }
        const last = saved(await load(), id).last;
        if (last?.latest === status.latest && now() - last.at < RETRY_SAME_RELEASE_MS) {
            memo.waiting = undefined;
            return;
        }
        const key = cliKey(harness.descriptor);
        if (updating.has(key) || stopped) return;
        if (await busyIn(group) > 0) {
            memo.waiting = status.latest;
            memo.nextCheckAt = now() + AUTO_UPDATE_TICK_MS;
            return;
        }
        if (stopped || updating.has(key)) return;
        updating.add(key);
        let result: AutoUpdateRun;
        try {
            result = await options.update(harness, group);
        } catch (error) {
            // A chat started between the check and the file swap: not a failed
            // update, the next tick waits for it again.
            if ((error as { code?: unknown } | null)?.code === "conflict") {
                memo.waiting = status.latest;
                memo.nextCheckAt = now() + AUTO_UPDATE_TICK_MS;
                return;
            }
            result = { ok: false, exitCode: null, output: error instanceof Error ? error.message : String(error) };
        } finally {
            updating.delete(key);
        }
        memo.waiting = undefined;
        const finishedAt = now();
        let after: HarnessUpdateStatus | undefined;
        try {
            after = await options.status(harness);
        } catch (error) {
            log(`could not re-read ${harness.descriptor.name} after its automatic update`, error);
        }
        const output = result.output.trim();
        await patch(id, {
            last: {
                at: finishedAt,
                ok: result.ok,
                latest: status.latest,
                ...(status.current ? { from: status.current } : {}),
                ...(after?.current ? { to: after.current } : {}),
                ...(!result.ok && output ? { message: output.slice(-MESSAGE_TAIL) } : {}),
            },
        });
        if (!result.ok) {
            log(`automatic update of ${harness.descriptor.name} failed`, output.slice(-MESSAGE_TAIL));
            return;
        }
        // An updater that left the same version (its channel lags the
        // registry) changed nothing a restart would pick up.
        if (!after?.current || after.current === status.current) return;
        memo.restartBefore = finishedAt;
        memo.nextRestartAt = undefined;
        await restartStep(group, memo);
    };

    const tick = (): Promise<void> => {
        if (ticking) return ticking;
        ticking = (async () => {
            const data = await load();
            for (const harness of options.harnesses()) {
                if (!eligible(harness) || saved(data, harness.descriptor.id).enabled !== true) continue;
                try {
                    await step(harness);
                } catch (error) {
                    log(`automatic update check of ${harness.descriptor.name} failed`, error);
                }
            }
        })().finally(() => {
            ticking = undefined;
        });
        return ticking;
    };
    const schedule = (delay: number) => {
        if (!running) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = undefined;
            void tick().catch((error: unknown) => log("harness auto-update pass failed", error)).finally(() => schedule(AUTO_UPDATE_TICK_MS));
        }, delay);
        timer.unref?.();
    };

    return {
        /** Start checking (first pass shortly after the server starts). */
        start(): void {
            if (running) return;
            running = true;
            stopped = false;
            schedule(FIRST_TICK_MS);
        },
        /** Stop the timer; a pass in progress starts no further update. An
         *  updater already running is not waited for (it is bounded by its
         *  own timeout), so a shutdown is never held for minutes. */
        stop(): void {
            running = false;
            stopped = true;
            if (timer) clearTimeout(timer);
            timer = undefined;
        },
        /** One pass now; tests and the first check after switching it on. */
        tick,
        async enabled(harnessId: string): Promise<boolean> {
            return saved(await load(), harnessId).enabled === true;
        },
        async set(harness: AutoUpdateHarness, enabled: boolean): Promise<void> {
            if (enabled && !eligible(harness))
                throw harnessError("unsupported", `${harness.descriptor.name} has no updater Polyth can run`);
            await patch(harness.descriptor.id, { enabled });
            const memo = state(harness.descriptor.id);
            memo.waiting = undefined;
            memo.nextCheckAt = undefined;
            // Switched on: look soon, not at the next half-hour check.
            if (enabled) schedule(5_000);
        },
        /** What one caller sees. `owner`: the instance owner, who alone may
         *  switch it and sees what it is waiting for and what it last did. */
        async state(harness: AutoUpdateHarness, owner: boolean): Promise<HarnessAutoUpdateState> {
            const entry = saved(await load(), harness.descriptor.id);
            const enabled = entry.enabled === true;
            const memo = memory.get(harness.descriptor.id);
            const pending: HarnessAutoUpdateState["pending"] = !owner || !enabled ? undefined
                : memo?.restartBefore !== undefined ? { kind: "restart" }
                : memo?.waiting ? { kind: "update", version: memo.waiting }
                : undefined;
            return {
                enabled,
                canChange: owner && eligible(harness),
                ...(pending ? { pending } : {}),
                ...(owner && entry.last ? { last: entry.last } : {}),
            };
        },
        /** Run one update of a CLI at a time, whoever asks (Settings or this
         *  updater); a second request while one runs is a `conflict`. */
        async exclusive<T>(descriptor: HarnessDescriptor, run: () => Promise<T>): Promise<T> {
            const key = cliKey(descriptor);
            if (updating.has(key)) throw harnessError("conflict", `${descriptor.name} is already being updated`);
            updating.add(key);
            try {
                return await run();
            } finally {
                updating.delete(key);
            }
        },
    };
}
