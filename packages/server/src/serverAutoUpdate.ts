// Automatic updates of a packaged server (npm package or Homebrew formula).
//
// When the instance owner turns it on, the server looks for a newer release of
// its own channel, waits until no chat is working, has its package manager
// install it (the host's `ServerSelfUpdater`, apps/server/src/selfUpdate.ts),
// and then exits through the normal graceful shutdown with EXIT_FOR_UPDATE.
// The service that runs it (systemd `Restart=on-failure`, launchd or `brew
// services` keep-alive on an unsuccessful exit) starts the new release in the
// same place. A host offers a driver only when such a service runs it; without
// one an exit would simply stop the server.
//
// The attempt is written down before the exit (`pending`), so the next boot
// can tell whether it came back on the new version and report it in
// Settings → About.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { compareReleaseVersions, principalHasFullAccess, type ServerAutoUpdateDto } from "@polyth/contracts";
import { hasInstanceOwnerAuthority, requireInstanceOwnerAuthority } from "@polyth/contracts/instance-authority";
import type { RouteHandler } from "./http.ts";

/** EX_TEMPFAIL: an unsuccessful exit, so a keep-alive service restarts it. */
export const EXIT_FOR_UPDATE = 75;

export interface SelfUpdateResult {
  ok: boolean;
  /** The version the install holds now, when it could be read. */
  installed: string | null;
  message: string;
  /** The manager does not offer that release yet (a tap behind GitHub). */
  notYet?: boolean;
}

/** How a packaged install updates itself. Provided by the host. */
export interface ServerSelfUpdater {
  kind: "npm" | "homebrew";
  /** Why this install cannot update itself (no service restarts it, the
   *  install is not writable…), or null. */
  unavailable: string | null;
  /** The newest release this install's channel offers. */
  newest(current: string): Promise<string | null>;
  /** Installs `version` and checks the result. Never restarts anything. */
  apply(version: string, current: string): Promise<SelfUpdateResult>;
}

type LastRun = NonNullable<ServerAutoUpdateDto["last"]>;
interface Stored {
  enabled?: boolean;
  last?: LastRun;
  /** Written before the exit; the next boot settles it. */
  pending?: { from: string; to: string; at: number };
  /** A release that failed is not tried again before `retryAt`. */
  tried?: { version: string; retryAt: number };
}

const FIRST_TICK_MS = 2 * 60_000;
export const SERVER_AUTO_UPDATE_TICK_MS = 60_000;
const CHECK_EVERY_MS = 6 * 60 * 60_000;
const CHECK_RETRY_MS = 60 * 60_000;
const RETRY_FAILED_MS = 24 * 60 * 60_000;
const MESSAGE_TAIL = 600;

export interface ServerAutoUpdaterOptions {
  /** Machine-wide settings file in the data directory (not a Space). */
  file: string;
  version: string;
  updater?: ServerSelfUpdater;
  /** Why there is no updater, shown when `updater` is absent. */
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
const newer = (candidate: string | null, current: string): candidate is string =>
  candidate !== null && (compareReleaseVersions(candidate, current) ?? 0) > 0;

export function createServerAutoUpdater(options: ServerAutoUpdaterOptions) {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string, error?: unknown) => console.warn(`[polyth] ${message}`, error ?? ""));
  const updater = options.updater;
  const unavailable = updater ? updater.unavailable : (options.unavailable ?? "This server cannot update itself.");
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
  /** Installed and waiting to restart into. */
  let installed: string | null = null;

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
    // The update this boot may be the result of.
    const pending = stored.pending;
    if (pending) {
      const ok = pending.to === options.version;
      stored.last = {
        at: now(),
        from: pending.from,
        to: pending.to,
        ok,
        message: ok
          ? `Updated from ${pending.from} to ${pending.to}.`
          : `Installed ${pending.to}, but the server came back as ${options.version}.`,
      };
      if (!ok) stored.tried = { version: pending.to, retryAt: now() + RETRY_FAILED_MS };
      delete stored.pending;
      await save();
    }
  })();

  const enabled = (): boolean => stored.enabled === true && !unavailable && Boolean(updater);

  const record = async (to: string, result: { ok: boolean; message: string }, retryAt?: number): Promise<void> => {
    stored.last = { at: now(), from: options.version, to, ok: result.ok, message: tail(result.message) };
    if (retryAt !== undefined) stored.tried = { version: to, retryAt };
    await save();
  };

  const restartInto = async (version: string): Promise<void> => {
    phase = "restarting";
    stored.pending = { from: options.version, to: version, at: now() };
    await save();
    log(`restarting into Polyth ${version} (automatic update from ${options.version})`);
    options.restart();
  };

  const tick = async (): Promise<void> => {
    await load();
    if (!enabled() || !updater) {
      phase = stored.enabled ? "idle" : "off";
      return;
    }
    if (installed) {
      busy = await options.busy();
      if (busy > 0) {
        phase = "waiting";
        return;
      }
      await restartInto(installed);
      return;
    }
    if (now() >= nextCheckAt) {
      phase = "checking";
      try {
        available = await updater.newest(options.version);
        checkedAt = now();
        nextCheckAt = now() + CHECK_EVERY_MS;
      } catch (error) {
        log("server auto-update check failed", error);
        nextCheckAt = now() + CHECK_RETRY_MS;
      }
    }
    phase = "idle";
    if (!newer(available, options.version)) return;
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
      result = await updater.apply(target, options.version);
    } catch (error) {
      result = { ok: false, installed: null, message: error instanceof Error ? error.message : String(error) };
    }
    if (!result.ok || result.installed !== target) {
      phase = "idle";
      // A tap that has not caught up is asked again at the next check.
      const retryAt = result.notYet ? now() + CHECK_EVERY_MS : now() + RETRY_FAILED_MS;
      await record(target, { ok: false, message: result.message || `${updater.kind} did not install ${target}` }, retryAt);
      return;
    }
    installed = target;
    // A chat may have started while the package manager ran.
    busy = await options.busy();
    if (busy > 0) {
      phase = "waiting";
      return;
    }
    await restartInto(target);
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
      await load();
      if (value && unavailable) throw Object.assign(new Error(unavailable), { code: "conflict" });
      stored.enabled = value;
      // Turning it on looks again soon and gives a failed release another try.
      if (value) {
        nextCheckAt = 0;
        delete stored.tried;
      } else {
        phase = "off";
        installed = null;
      }
      await save();
    },
    /** `owner`: the instance owner, who may change it and read the details
     *  (install paths, package-manager output); others get plain outcomes. */
    async status(owner: boolean): Promise<ServerAutoUpdateDto> {
      await load();
      const on = enabled();
      const last = stored.last && !owner
        ? { ...stored.last, message: stored.last.ok ? stored.last.message : "The details are in the server log." }
        : stored.last;
      return {
        install: updater?.kind ?? null,
        unavailable: unavailable && !owner ? "This server cannot update itself." : unavailable,
        enabled: stored.enabled === true,
        canChange: owner && !unavailable,
        phase: on ? phase : "off",
        available: on && newer(available, options.version) ? available : null,
        busy: on && phase === "waiting" ? busy : 0,
        checkedAt: on ? checkedAt : null,
        last: last ?? null,
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
