// Automatic updates of this server.
//
// When the instance owner turns it on, the server looks for a newer release
// (or revision) from its install's source, waits until no chat is working,
// has its driver install it, and then exits through the normal graceful
// shutdown with EXIT_FOR_UPDATE. The service that runs it (systemd
// `Restart=on-failure`, launchd or `brew services` keep-alive on an
// unsuccessful exit) starts the new code in the same place.
//
// Drivers (`ServerSelfUpdater`, @polyth/plugins): the packaged server's host
// passes its npm or Homebrew one (apps/server/src/selfUpdate.ts); a package
// may contribute one for another kind of install through `SERVER_SELF_UPDATE`
// (a source checkout). A contributed driver is used only when a service
// restarts this process, since without one an exit would simply stop it.
//
// The attempt is written down before the exit (`pending`), so the next boot
// can tell whether it came back on the new code and report it in
// Settings → About.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { compareReleaseVersions, principalHasFullAccess, type ServerAutoUpdateDto } from "@polyth/contracts";
import { hasInstanceOwnerAuthority, requireInstanceOwnerAuthority } from "@polyth/contracts/instance-authority";
import type { Disposable } from "@polyth/contracts";
import type { SelfUpdateResult, ServerSelfUpdateDrivers, ServerSelfUpdater } from "@polyth/plugins";
import type { RouteHandler } from "./http.ts";

export type { SelfUpdateResult, ServerSelfUpdater } from "@polyth/plugins";

/** EX_TEMPFAIL: an unsuccessful exit, so a keep-alive service restarts it. */
export const EXIT_FOR_UPDATE = 75;

/** The service names `polyth service install` and `brew services` give it. */
const SYSTEMD_UNITS = new Set(["polyth.service", "homebrew.polyth.service"]);
const LAUNCHD_LABELS = new Set(["app.polyth.server", "homebrew.mxcl.polyth"]);

/**
 * The service that restarts this process when it exits unsuccessfully, or
 * null. `INVOCATION_ID` alone is not enough: a shell in a terminal that
 * systemd runs as a user service inherits it, so the process's own cgroup
 * must be one of Polyth's units. `POLYTH_SUPERVISED=1` vouches for any other
 * supervisor that restarts on a non-zero exit.
 */
export function restartingService(input: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** /proc/self/cgroup, on Linux. */
  cgroup?: string;
}): string | null {
  if (input.env.POLYTH_SUPERVISED?.trim() === "1") return "POLYTH_SUPERVISED";
  if (input.platform === "linux" && input.env.INVOCATION_ID && input.cgroup) {
    for (const line of input.cgroup.split("\n")) {
      const unit = line.trim().split("/").at(-1);
      if (unit && SYSTEMD_UNITS.has(unit)) return unit;
    }
  }
  if (input.platform === "darwin") {
    const label = input.env.XPC_SERVICE_NAME?.trim();
    if (label && LAUNCHD_LABELS.has(label)) return label;
  }
  return null;
}

/** Why a contributed driver cannot run: nothing would start the server again. */
export const NO_RESTARTING_SERVICE =
  "No service restarts this server when it exits: run it as the polyth.service systemd unit with Restart=on-failure, or set POLYTH_SUPERVISED=1 under a supervisor that restarts it.";

/** The `SERVER_SELF_UPDATE` service: one contributed driver at a time. */
export function createSelfUpdateDrivers(service: string | null): ServerSelfUpdateDrivers & { current(): ServerSelfUpdater | undefined } {
  let driver: ServerSelfUpdater | undefined;
  return {
    restartingService: service,
    contribute(next): Disposable {
      if (driver) throw Object.assign(new Error(`a ${driver.kind} self-update driver is already contributed`), { code: "conflict" });
      driver = next;
      return { dispose: () => { if (driver === next) driver = undefined; } };
    },
    current: () => driver,
  };
}

type LastRun = NonNullable<ServerAutoUpdateDto["last"]>;
interface Stored {
  enabled?: boolean;
  last?: LastRun;
  /** Written before the exit; the next boot settles it. `revision`: the
   *  driver names what it runs (`current()`), not the server's version. */
  pending?: { from: string; to: string; at: number; kind?: string; revision?: boolean };
  /** An update that failed is not tried again before `retryAt`. */
  tried?: { version: string; retryAt: number };
}

const FIRST_TICK_MS = 2 * 60_000;
export const SERVER_AUTO_UPDATE_TICK_MS = 60_000;
const CHECK_EVERY_MS = 6 * 60 * 60_000;
const CHECK_RETRY_MS = 60 * 60_000;
const RETRY_FAILED_MS = 24 * 60 * 60_000;
const MESSAGE_TAIL = 600;
const DEFAULT_UNAVAILABLE =
  "Automatic updates need a packaged server (npm or Homebrew) or a package that updates this kind of install, and a service that runs it.";

export interface ServerAutoUpdaterOptions {
  /** Machine-wide settings file in the data directory (not a Space). */
  file: string;
  version: string;
  /** The host's own driver (the packaged server's npm or Homebrew one). */
  updater?: ServerSelfUpdater;
  /** A driver a package contributed, read at every check. Used only when the
   *  host passed none. */
  contributed?: () => ServerSelfUpdater | undefined;
  /** The service that restarts this process; a contributed driver needs one. */
  restartingService?: string | null;
  /** Why there is no updater, shown when none is present. */
  unavailable?: string;
  /** Chats working now; an update waits for none. */
  busy(): Promise<number>;
  /** Graceful shutdown, then exit with EXIT_FOR_UPDATE. */
  restart(): void;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

export type ServerAutoUpdater = ReturnType<typeof createServerAutoUpdater>;

const tail = (text: string): string => text.length > MESSAGE_TAIL ? `…${text.slice(-MESSAGE_TAIL)}` : text;
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function createServerAutoUpdater(options: ServerAutoUpdaterOptions) {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string, error?: unknown) => console.warn(`[polyth] ${message}`, error ?? ""));
  let stored: Stored = {};
  let loaded: Promise<void> | undefined;
  let writes: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ticking: Promise<void> | undefined;
  let stopped = false;
  let phase: ServerAutoUpdateDto["phase"] = "idle";
  let available: string | null = null;
  let checkedAt: number | null = null;
  let nextCheckAt = 0;
  let busy = 0;
  /** Why the last check could not offer an update (local changes…). */
  let problem: string | null = null;
  /** Installed and waiting to restart into. */
  let installed: string | null = null;
  /** The driver the last check used; a different one starts over. */
  let checkedWith: ServerSelfUpdater | undefined;
  /** The attempt the previous boot left: the only one this process settles
   *  (one it writes itself is for the next boot, even while shutting down). */
  let bootPending: Stored["pending"];

  const driver = (): ServerSelfUpdater | undefined => options.updater ?? options.contributed?.();
  const unavailableOf = (updater: ServerSelfUpdater | undefined): string | null => {
    if (!updater) return options.unavailable ?? DEFAULT_UNAVAILABLE;
    if (updater.unavailable) return updater.unavailable;
    // The host's own driver checked its service itself.
    if (updater !== options.updater && !options.restartingService) return NO_RESTARTING_SERVICE;
    return null;
  };
  /** What runs now, as the driver names it. */
  const currentOf = async (updater: ServerSelfUpdater): Promise<string> =>
    updater.current ? await updater.current() : options.version;
  const newer = (updater: ServerSelfUpdater, candidate: string | null, current: string): candidate is string =>
    candidate !== null && (updater.isNewer
      ? updater.isNewer(candidate, current)
      : (compareReleaseVersions(candidate, current) ?? 0) > 0);

  const save = (): Promise<void> => {
    const snapshot = JSON.stringify(stored, null, 2);
    writes = writes.then(async () => {
      await mkdir(dirname(options.file), { recursive: true });
      const temp = `${options.file}.${process.pid}.tmp`;
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, options.file);
    }).catch((error) => log("server auto-update settings were not saved", error));
    return writes;
  };

  const load = (): Promise<void> => loaded ??= (async () => {
    try {
      const raw = JSON.parse(await readFile(options.file, "utf8")) as unknown;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) stored = raw as Stored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log("server auto-update settings are unreadable", error);
    }
    bootPending = stored.pending;
  })();

  /** Settles the update this boot may be the result of. A revision named by
   *  a contributed driver waits until that driver is here to read it. */
  const settle = async (updater: ServerSelfUpdater | undefined): Promise<void> => {
    const pending = stored.pending;
    if (!pending || pending !== bootPending) return;
    let running: string;
    if (pending.revision) {
      if (!updater?.current || updater.kind !== pending.kind) return;
      try {
        running = await updater.current();
      } catch (error) {
        log("server auto-update could not read what runs now", error);
        return;
      }
    } else {
      running = options.version;
    }
    const ok = pending.to === running;
    stored.last = {
      at: now(),
      from: pending.from,
      to: pending.to,
      ok,
      message: ok
        ? `Updated from ${pending.from} to ${pending.to}.`
        : `Installed ${pending.to}, but the server came back as ${running}.`,
    };
    if (!ok) stored.tried = { version: pending.to, retryAt: now() + RETRY_FAILED_MS };
    delete stored.pending;
    await save();
  };

  const ready = async (): Promise<ServerSelfUpdater | undefined> => {
    await load();
    const updater = driver();
    await settle(updater);
    return updater;
  };

  const enabled = (updater: ServerSelfUpdater | undefined): updater is ServerSelfUpdater =>
    stored.enabled === true && Boolean(updater) && !unavailableOf(updater);

  const record = async (from: string, to: string, result: { ok: boolean; message: string }, retryAt?: number): Promise<void> => {
    stored.last = { at: now(), from, to, ok: result.ok, message: tail(result.message) };
    if (retryAt !== undefined) stored.tried = { version: to, retryAt };
    await save();
  };

  const restartInto = async (updater: ServerSelfUpdater, from: string, target: string): Promise<void> => {
    phase = "restarting";
    stored.pending = {
      from,
      to: target,
      at: now(),
      kind: updater.kind,
      ...(updater.current ? { revision: true } : {}),
    };
    await save();
    log(`restarting into Polyth ${target} (automatic update from ${from})`);
    options.restart();
  };

  const tick = async (): Promise<void> => {
    const updater = await ready();
    if (!enabled(updater)) {
      phase = stored.enabled ? "idle" : "off";
      return;
    }
    if (checkedWith !== updater) {
      // Another driver (a package came or went) starts from a fresh check.
      checkedWith = updater;
      available = null;
      installed = null;
      problem = null;
      nextCheckAt = 0;
    }
    const current = await currentOf(updater);
    if (installed) {
      busy = await options.busy();
      if (busy > 0) {
        phase = "waiting";
        return;
      }
      await restartInto(updater, current, installed);
      return;
    }
    if (now() >= nextCheckAt) {
      phase = "checking";
      try {
        available = await updater.newest(current);
        problem = null;
        checkedAt = now();
        nextCheckAt = now() + CHECK_EVERY_MS;
      } catch (error) {
        log("server auto-update check failed", error);
        available = null;
        problem = tail(messageOf(error));
        checkedAt = now();
        nextCheckAt = now() + CHECK_RETRY_MS;
      }
    }
    phase = "idle";
    if (!newer(updater, available, current)) return;
    const target = available;
    if (stored.tried?.version === target && now() < stored.tried.retryAt) return;
    busy = await options.busy();
    if (busy > 0) {
      phase = "waiting";
      return;
    }
    phase = "installing";
    let result: SelfUpdateResult;
    try {
      result = await updater.apply(target, current);
    } catch (error) {
      result = { ok: false, installed: null, message: messageOf(error) };
    }
    if (!result.ok || result.installed !== target) {
      phase = "idle";
      // A tap that has not caught up is asked again at the next check.
      const retryAt = result.notYet ? now() + CHECK_EVERY_MS : now() + RETRY_FAILED_MS;
      await record(current, target, { ok: false, message: result.message || `${updater.kind} did not install ${target}` }, retryAt);
      return;
    }
    installed = target;
    // A chat may have started while the driver ran.
    busy = await options.busy();
    if (busy > 0) {
      phase = "waiting";
      return;
    }
    await restartInto(updater, current, target);
  };

  const runTick = (): Promise<void> => ticking ??= tick()
    .catch((error) => log("server auto-update failed", error))
    .finally(() => { ticking = undefined; });

  const schedule = (delay: number): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void runTick().finally(() => { if (phase !== "restarting") schedule(SERVER_AUTO_UPDATE_TICK_MS); });
    }, delay);
    timer.unref?.();
  };

  return {
    start(): void {
      stopped = false;
      void load().then(() => schedule(FIRST_TICK_MS));
    },
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    /** One pass, for tests and for turning it on. */
    tick: runTick,
    async setEnabled(value: boolean): Promise<void> {
      const updater = await ready();
      const unavailable = unavailableOf(updater);
      if (value && unavailable) throw Object.assign(new Error(unavailable), { code: "conflict" });
      stored.enabled = value;
      // Turning it on looks again soon and gives a failed update another try.
      if (value) {
        nextCheckAt = 0;
        delete stored.tried;
      } else {
        phase = "off";
        installed = null;
        problem = null;
      }
      await save();
    },
    /** `owner`: the instance owner, who may change it and read the details
     *  (install paths, driver output); others get plain outcomes. */
    async status(owner: boolean): Promise<ServerAutoUpdateDto> {
      const updater = await ready();
      const unavailable = unavailableOf(updater);
      const on = enabled(updater);
      const hidden = "The details are in the server log.";
      const last = stored.last && !owner
        ? { ...stored.last, message: stored.last.ok ? stored.last.message : hidden }
        : stored.last;
      let current = options.version;
      if (on && updater) {
        try {
          current = await currentOf(updater);
        } catch {
          // The last check's answer still stands.
        }
      }
      return {
        install: updater?.kind ?? null,
        unavailable: unavailable && !owner ? "This server cannot update itself." : unavailable,
        enabled: stored.enabled === true,
        canChange: owner && !unavailable,
        phase: on ? phase : "off",
        available: on && updater && newer(updater, available, current) ? available : null,
        busy: on && phase === "waiting" ? busy : 0,
        checkedAt: on ? checkedAt : null,
        last: last ?? null,
        source: owner ? updater?.source?.() ?? null : null,
        problem: on && problem ? (owner ? problem : hidden) : null,
      };
    },
  };
}

/** `GET`/`PUT /api/system/auto-update`. Everyone with full access reads it;
 *  only the instance owner changes it. */
export function serverAutoUpdateRoutes(autoUpdate: ServerAutoUpdater): RouteHandler {
  return async (rc) => {
    if (rc.path !== "/api/system/auto-update") return false;
    if (rc.method !== "GET" && rc.method !== "PUT") return false;
    if (rc.principal.kind === "anonymous") {
      throw Object.assign(new Error("authentication required"), { code: "unauthorized" });
    }
    if (rc.principal.kind === "paired-device" && !principalHasFullAccess(rc.principal)) {
      throw Object.assign(new Error("not allowed"), { code: "forbidden" });
    }
    const owner = hasInstanceOwnerAuthority(rc);
    if (rc.method === "PUT") {
      requireInstanceOwnerAuthority(rc, "automatic server updates require the instance owner");
      const body = await rc.body() as { enabled?: unknown } | null;
      if (typeof body?.enabled !== "boolean") throw Object.assign(new Error("enabled must be true or false"), { code: "invalid-input" });
      await autoUpdate.setEnabled(body.enabled);
    }
    rc.json(200, await autoUpdate.status(owner));
    return true;
  };
}
