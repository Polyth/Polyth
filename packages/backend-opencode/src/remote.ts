// Remote OpenCode runtime: run `opencode serve` ON the remote host over a
// generic RemoteHost transport (implemented by @polyth/ssh), then attach the
// normal adapter through ONE forwarded local port.
//
// Why serve-on-remote instead of a local agent over a remote filesystem: the
// agent's hot loop is file reads/edits/greps/shell — running it next to the
// working tree costs zero extra hops, while Polyth only pays one multiplexed
// control channel for the REST/SSE traffic it already speaks locally.
//
// This module owns everything OpenCode-specific about the remote leg (binary
// name, serve invocation, listen-line protocol, pidfile reaping); the
// transport knows nothing about OpenCode, keeping the adapter boundary intact.
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type {
  AgentRuntime,
  JsonObject,
  RemoteHost,
  RuntimeAuthentication,
} from "@polyth/contracts";
import {
  attachRuntimeLifecycle,
  createOpenCodeRuntimeLifecycle,
  createOpenCodeRuntimeFacade,
  type ManagedOpenCodeRuntime,
} from "./index.ts";
import {
  createOwnedSshEndpointLease,
  LISTEN_RE,
} from "./endpoint.ts";
import type { PreparedRemoteOpenCodeRuntime } from "./remoteStorage.ts";
import {
  acquireRemoteRuntimeLock,
  prepareRemoteOpenCodeRuntime,
  probeRemoteProcessIdentity,
  releaseRemoteRuntimeLock,
  remoteServePidFileExpr,
  REMOTE_LOCK_DIR,
  REMOTE_LOCK_HANDOFF,
  REMOTE_LOCK_STARTING,
  REMOTE_OWNER_FILE,
  REMOTE_PROCESS_IDENTITY_FUNS,
  resolveRemoteRuntimeDir,
  shq,
  stopRemoteLockGuardian,
} from "./remoteStorage.ts";
import { OPENCODE_UPDATE_DISABLE_ENV } from "./runtimeStorage.ts";

export interface RemoteOpenCodeOptions {
  host: RemoteHost;
  /** Stable SSH connection identity from project configuration. */
  connectionIdentity?: string;
  /** Workspace path on the remote machine (becomes the serve cwd). */
  remotePath: string;
  /** Absolute runtime directory on the remote host. When omitted, the remote
   * XDG data path `${XDG_DATA_HOME:-$HOME/.local/share}/polyth/runtimes/opencode/<remoteStateKey>`
   * is expanded on the remote host. Never the user's OpenCode global dir. */
  runtimeDir?: string;
  /** Path segment under the remote XDG polyth runtime root when runtimeDir is omitted. */
  remoteStateKey?: string;
  /** Project identity recorded in remote runtime.json (not folded into storageId). */
  projectId?: string;
  /** Remote opencode binary (default "opencode" on the remote PATH). */
  bin?: string;
  sessionIdMap?: Map<string, string>;
  log?: (level: "debug" | "info" | "warn" | "error", msg: string, data?: JsonObject) => void;
  onRuntimeDiagnostic?: (message: string) => void;
  listenTimeoutMs?: number;
  readyTimeoutMs?: number;
  lifecycleTimeoutMs?: number;
  usernameEnv?: string;
  passwordEnv?: string;
  /** Local durable authority/generation state for this owned remote runtime. */
  leaseStateFile?: string;
  /** Remote port candidate picker — injectable for tests. */
  pickPort?: () => number;
}

export interface RemoteOpenCodeProbe {
  ok: boolean;
  version?: string;
  message?: string;
}

const invalid = (message: string): Error =>
  Object.assign(new Error(message), { code: "invalid-input" });

const unavailable = (message: string): Error =>
  Object.assign(new Error(message), { code: "unavailable" });

const withDeadline = <T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
  onLateResult?: (value: T) => void | Promise<void>,
): Promise<T> =>
  new Promise<T>((resolveOperation, rejectOperation) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectOperation(unavailable(`${label} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    operation.then(
      (value) => {
        if (settled) {
          void onLateResult?.(value);
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolveOperation(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectOperation(error);
      },
    );
  });

const checkBin = (bin: string): string => {
  if (!/^[A-Za-z0-9_.~/-]+$/.test(bin)) throw invalid(`invalid remote binary name: ${bin}`);
  return bin;
};

const checkRemotePath = (path: string): string => {
  const p = path.trim();
  if (!p) throw invalid("remote path is required");
  if (/\p{Cc}/u.test(p)) throw invalid("remote path must not contain control characters");
  return p;
};

const checkRemoteRuntimeDir = (path: string): string => {
  const checked = checkRemotePath(path);
  if (!checked.startsWith("/")) throw invalid("remote runtimeDir must be an absolute path");
  return posix.normalize(checked);
};

const defaultRemoteStateKey = (
  connectionIdentity: string,
  remotePath: string,
): string =>
  createHash("sha256")
    .update(connectionIdentity)
    .update("\0")
    .update(remotePath)
    .digest("hex")
    .slice(0, 24);

const defaultLeaseStateFile = (hostLabel: string, remotePath: string): string => {
  const key = createHash("sha256")
    .update(hostLabel)
    .update("\0")
    .update(remotePath)
    .digest("hex")
    .slice(0, 24);
  return join(tmpdir(), "polyth-opencode", `ssh-${key}.lease.json`);
};

const PID_LINE_RE = /POLYTH_REMOTE_PID=(\d+)/;
const IN_USE_RE = /EADDRINUSE|address already in use/i;

/** Non-interactive SSH shells never source the rc files where the opencode
 *  installer appends its PATH entry, so a healthy install at ~/.opencode/bin
 *  (or ~/.local/bin) probes as "not installed" and every remote session start
 *  fails. Prefix each remote invocation with the standard install locations
 *  instead of trusting the login PATH. */
const REMOTE_PATH = 'PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"';

/** Probe the remote binary and, when a runtime directory is supplied, prove
 * that it honors the isolated OpenCode DB path before owned startup. */
export const probeRemoteOpenCode = async (
  host: RemoteHost,
  bin = "opencode",
  runtimeDir?: string,
): Promise<RemoteOpenCodeProbe> => {
  const safeBin = checkBin(bin);
  const expectedDb = runtimeDir ? posix.join(runtimeDir, "probe.db") : undefined;
  const result = await host.exec(
    `${REMOTE_PATH}; export ${OPENCODE_UPDATE_DISABLE_ENV}=true; `
      + `command -v ${safeBin} >/dev/null 2>&1 && `
      + `${expectedDb ? `OPENCODE_DB=${shq(expectedDb)} ` : ""}`
      + `${safeBin} --version 2>/dev/null || echo POLYTH_OC_MISSING`,
    { timeoutMs: 20_000 },
  );
  const out = result.stdout.trim();
  if (result.code !== 0) {
    return { ok: false, message: `probe failed on ${host.label}: ${result.stderr.trim().slice(-300) || `exit ${result.code}`}` };
  }
  if (out.includes("POLYTH_OC_MISSING")) {
    return {
      ok: false,
      message: `opencode is not installed on ${host.label} — install it there first (curl -fsSL https://opencode.ai/install | bash)`,
    };
  }
  const version = out.split("\n").pop()?.trim();
  if (expectedDb) {
    const dbResult = await host.exec(
      `${REMOTE_PATH}; export ${OPENCODE_UPDATE_DISABLE_ENV}=true; `
        + `OPENCODE_DB=${shq(expectedDb)} ${safeBin} db path 2>/dev/null`,
      { timeoutMs: 20_000 },
    );
    const actualDb = dbResult.stdout.trim().split(/\r?\n/).at(-1)?.trim();
    if (dbResult.code !== 0 || actualDb !== expectedDb) {
      return {
        ok: false,
        message: `OpenCode ${version || "unknown"} on ${host.label} does not honor OPENCODE_DB; `
          + `expected ${expectedDb}, got ${actualDb || `exit ${dbResult.code}`}. `
          + "Polyth refuses to start an owned remote runtime because its global OpenCode DB would not be isolated.",
      };
    }
  }
  return { ok: true, ...(version ? { version } : {}) };
};

interface StartedServe {
  handle: Awaited<ReturnType<RemoteHost["start"]>>;
  port: number;
  remotePid: number | null;
  pidFileExpr: string;
  instanceToken: string;
  alive(): boolean;
  disposeExit(): void;
}

const startServe = async (
  opts: Required<Pick<RemoteOpenCodeOptions, "host" | "remotePath">> & {
    bin: string;
    listenTimeoutMs: number;
    lifecycleTimeoutMs: number;
    runtimeDir: string;
    port: number;
    instanceToken: string;
    lockToken: string;
  },
): Promise<StartedServe> => {
  // The PID record is a process-ownership boundary. Key it by the isolated
  // runtime directory as well as the worktree: two configured projects may
  // legitimately address the same remote path but must never reap each other.
  const dbPath = posix.join(opts.runtimeDir, "opencode.db");
  // A private PID record carries the exact lease token plus process start,
  // executable, and command identities. A stale/reused PID fails this complete
  // match and is never signalled.
  const pidFileExpr = remoteServePidFileExpr(opts.runtimeDir, opts.remotePath);
  const ownerFileExpr = `"$RUNTIME_DIR/${REMOTE_OWNER_FILE}"`;
  const lockFileExpr = `"$RUNTIME_DIR/${REMOTE_LOCK_DIR}"`;
  const command = [
    REMOTE_PATH,
    "umask 077",
    `RUNTIME_DIR=${shq(opts.runtimeDir)}`,
    'if [ -L "$RUNTIME_DIR" ]; then '
      + 'echo "POLYTH_OPENCODE_RUNTIME_DIR_FAILED=$RUNTIME_DIR" >&2; exit 78; fi',
    'if ! mkdir -p "$RUNTIME_DIR" || ! chmod 700 "$RUNTIME_DIR"; then '
      + 'echo "POLYTH_OPENCODE_RUNTIME_DIR_FAILED=$RUNTIME_DIR" >&2; exit 78; fi',
    `export OPENCODE_DB=${shq(dbPath)}`,
    `export ${OPENCODE_UPDATE_DISABLE_ENV}=true`,
    `PF=${pidFileExpr}`,
    `OWNER=${ownerFileExpr}`,
    `LOCK=${lockFileExpr}`,
    'mkdir -p "$(dirname "$PF")"',
    REMOTE_PROCESS_IDENTITY_FUNS,
    'TAB=$(printf "\\t")',
    'if [ -L "$OWNER" ]; then echo "POLYTH_RUNTIME_OWNED_SYMLINK=$OWNER" >&2; exit 78; fi',
    'if [ -f "$OWNER" ] && IFS="$TAB" read -r OWN_TOKEN OWN_PID OWN_START OWN_EXE OWN_CMD < "$OWNER"; then '
      + 'if [ -n "$OWN_TOKEN" ] && [ "$(oc_start "$OWN_PID")" = "$OWN_START" ] '
      + '&& [ "$(oc_exe "$OWN_PID")" = "$OWN_EXE" ] && [ "$(oc_cmd "$OWN_PID")" = "$OWN_CMD" ]; '
      + 'then echo "POLYTH_RUNTIME_OWNED=$OWN_PID" >&2; exit 78; fi; fi',
    'if [ -f "$PF" ] && IFS="$TAB" read -r OLD_TOKEN OLD_PID OLD_START OLD_EXE OLD_CMD < "$PF"; then '
      + 'if [ -n "$OLD_TOKEN" ] && [ "$(oc_start "$OLD_PID")" = "$OLD_START" ] '
      + '&& [ "$(oc_exe "$OLD_PID")" = "$OLD_EXE" ] && [ "$(oc_cmd "$OLD_PID")" = "$OLD_CMD" ]; '
      + 'then echo "POLYTH_RUNTIME_OWNED=$OLD_PID" >&2; exit 78; fi; fi',
    `cd ${shq(opts.remotePath)}`,
    `${opts.bin} serve --hostname 127.0.0.1 --port ${opts.port} & OC_PID=$!`,
    'trap \'kill "$OC_PID" 2>/dev/null || true\' TERM INT HUP',
    'N=0; while [ "$N" -lt 100 ]; do OC_CMD=$(oc_cmd "$OC_PID"); '
      + 'case "$OC_CMD" in *" serve --hostname "*) break;; esac; '
      + 'N=$((N + 1)); sleep 0.02; done',
    'OC_START=$(oc_start "$OC_PID")',
    'OC_EXE=$(oc_exe "$OC_PID")',
    `printf '%s\\t%s\\t%s\\t%s\\t%s\\n' ${shq(opts.instanceToken)} "$OC_PID" "$OC_START" "$OC_EXE" "$OC_CMD" > "$PF"`,
    `printf '%s\\t%s\\t%s\\t%s\\t%s\\n' ${shq(opts.instanceToken)} "$OC_PID" "$OC_START" "$OC_EXE" "$OC_CMD" > "$OWNER"`,
    `if [ "$(cut -f1 "$LOCK/${REMOTE_LOCK_STARTING}" 2>/dev/null)" = ${shq(opts.lockToken)} ]; then `
      + `printf '%s\\n' ${shq(opts.lockToken)} > "$LOCK/${REMOTE_LOCK_HANDOFF}"; fi`,
    'echo "POLYTH_REMOTE_PID=$OC_PID"',
    'wait "$OC_PID"; CODE=$?',
    `if [ "$(cut -f1 "$PF" 2>/dev/null)" = ${shq(opts.instanceToken)} ]; then rm -f "$PF"; fi`,
    `if [ "$(cut -f1 "$OWNER" 2>/dev/null)" = ${shq(opts.instanceToken)} ]; then rm -f "$OWNER"; fi`,
    'exit "$CODE"',
  ].join("; ");

  const handle = await withDeadline(
    opts.host.start(command),
    opts.lifecycleTimeoutMs,
    "remote OpenCode process start",
    async (lateHandle) => {
      await withDeadline(
        lateHandle.kill(),
        opts.lifecycleTimeoutMs,
        "late remote OpenCode process cleanup",
      ).catch(() => {});
    },
  );
  return new Promise<StartedServe>((resolve, reject) => {
    let buf = "";
    let settled = false;
    let exited = false;
    let remotePid: number | null = null;
    const finish = (err?: Error, port?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outputSub.dispose();
      if (err) {
        exitSub.dispose();
        void withDeadline(
          handle.kill(),
          opts.lifecycleTimeoutMs,
          "failed remote OpenCode process cleanup",
        ).catch(() => {}).finally(() => reject(err));
      } else {
        resolve({
          handle,
          port: port!,
          remotePid,
          pidFileExpr,
          instanceToken: opts.instanceToken,
          alive: () => !exited,
          disposeExit: () => { exitSub.dispose(); },
        });
      }
    };
    const timer = setTimeout(
      () => finish(unavailable(`remote opencode serve did not report a listen address within ${opts.listenTimeoutMs}ms`)),
      opts.listenTimeoutMs,
    );
    const outputSub = handle.onOutput((chunk) => {
      buf += chunk;
      const pid = buf.match(PID_LINE_RE);
      if (pid) remotePid = Number(pid[1]);
      const listen = buf.match(LISTEN_RE);
      if (listen) finish(undefined, Number(listen[1]));
    });
    const exitSub = handle.onExit((code) => {
      exited = true;
      const err = IN_USE_RE.test(buf)
        ? Object.assign(new Error(`remote port ${opts.port} is in use`), { code: "port-in-use" })
        : unavailable(`remote opencode serve exited (${code ?? "killed"}): ${buf.trim().slice(-400)}`);
      finish(err);
    });
  });
};

/** Spawn `opencode serve` on the remote host and return the standard adapter
 *  attached through a forwarded local port. Failure modes are explicit:
 *  missing binary and missing workspace path are reported before any process
 *  is started; port collisions retry with a fresh candidate. */
export const createRemoteOpenCodeRuntime = async (
  options: RemoteOpenCodeOptions,
): Promise<AgentRuntime> => {
  const { host } = options;
  const remotePath = checkRemotePath(options.remotePath);
  const bin = checkBin(options.bin ?? "opencode");
  const listenTimeoutMs = options.listenTimeoutMs ?? 30_000;
  const readyTimeoutMs = options.readyTimeoutMs ?? 20_000;
  const lifecycleTimeoutMs = options.lifecycleTimeoutMs ?? 10_000;
  const pickPort = options.pickPort ?? (() => 20_000 + Math.floor(Math.random() * 45_000));
  const connection = options.connectionIdentity ?? host.label;
  const remoteStateKey = options.remoteStateKey ?? defaultRemoteStateKey(connection, remotePath);
  const projectId = options.projectId?.trim() || connection;
  const runtimeDir = options.runtimeDir
    ? checkRemoteRuntimeDir(options.runtimeDir)
    : await resolveRemoteRuntimeDir({ host, remoteStateKey });

  const probe = await probeRemoteOpenCode(host, bin, runtimeDir);
  if (!probe.ok) throw unavailable(probe.message ?? `opencode is unavailable on ${host.label}`);
  if (!probe.version) {
    throw unavailable(`could not read the OpenCode version on ${host.label}`);
  }

  const dirCheck = await host.exec(`test -d ${shq(remotePath)}`, { timeoutMs: 20_000 });
  if (dirCheck.code !== 0) {
    throw Object.assign(
      new Error(`remote path does not exist on ${host.label}: ${remotePath}`),
      { code: "not-found" },
    );
  }

  const authentication: RuntimeAuthentication = {
    kind: "basic-env",
    usernameEnv: options.usernameEnv ?? "OPENCODE_SERVER_USERNAME",
    passwordEnv: options.passwordEnv ?? "OPENCODE_SERVER_PASSWORD",
  };
  await probeRemoteProcessIdentity(host);
  const lockToken = randomUUID();
  const lock = await acquireRemoteRuntimeLock(host, runtimeDir, lockToken, remotePath, {
    timeoutMs: lifecycleTimeoutMs,
  });
  let lockHeld = true;
  const releaseLock = async (): Promise<void> => {
    if (!lockHeld) return;
    lockHeld = false;
    await stopRemoteLockGuardian(host, lock);
    await releaseRemoteRuntimeLock(host, runtimeDir, lockToken);
  };
  let prepared: PreparedRemoteOpenCodeRuntime | undefined;
  try {
  const lease = await createOwnedSshEndpointLease({
    location: { directory: remotePath },
    authentication,
    stateFile: options.leaseStateFile
      ?? defaultLeaseStateFile(connection, remotePath),
    async prepareStart() {
      prepared = await prepareRemoteOpenCodeRuntime({
        host,
        runtimeDir,
        projectId,
        cwd: remotePath,
        bin,
        version: probe.version!,
        binarySource: options.bin ? "configured" : "path",
      });
      if (prepared.diagnostic) {
        const emit = options.onRuntimeDiagnostic
          ?? (options.log
            ? (message: string) => { options.log!("warn", message); }
            : (message: string) => { console.warn(`[polyth] ${message}`); });
        emit(prepared.diagnostic);
      }
    },
    runtimeIdentity: () => {
      const runtime = prepared;
      if (!runtime) throw unavailable("isolated remote OpenCode runtime was not prepared");
      return {
        connection,
        host: host.label,
        remotePath,
        runtimeDir: runtime.runtimeDir,
        engine: runtime.engineIdentity.engine,
        version: runtime.engineIdentity.version,
        binaryDigest: runtime.engineIdentity.binaryDigest,
        protocolGeneration: runtime.engineIdentity.protocolGeneration,
        storageId: runtime.storageId,
      };
    },
    async start(instanceToken, incarnation) {
      const runtime = prepared;
      if (!runtime) throw unavailable("isolated remote OpenCode runtime was not prepared");
      await runtime.recordOpen(incarnation);
      let started: StartedServe | null = null;
      let lastError: unknown;
      // Three collisions still get three fresh retries and a fourth candidate.
      for (let attempt = 0; attempt < 4 && !started; attempt++) {
        const port = pickPort();
        try {
          started = await startServe({
            host,
            remotePath,
            runtimeDir: runtime.runtimeDir,
            bin,
            listenTimeoutMs,
            lifecycleTimeoutMs,
            port,
            instanceToken,
            lockToken,
          });
        } catch (error) {
          lastError = error;
          if ((error as { code?: string }).code !== "port-in-use") throw error;
        }
      }
      if (!started) {
        throw lastError ?? unavailable(`could not start opencode serve on ${host.label}`);
      }
      const serve = started;
      const ownerPath = posix.join(runtime.runtimeDir, REMOTE_OWNER_FILE);

      const cleanupRemote = async (): Promise<void> => {
        const command = [
          `PF=${serve.pidFileExpr}`,
          `OWNER=${shq(ownerPath)}`,
          REMOTE_PROCESS_IDENTITY_FUNS,
          'TAB=$(printf "\\t")',
          'if [ -f "$PF" ] && IFS="$TAB" read -r TOKEN PID START EXE CMD < "$PF"; then '
            + `if [ "$TOKEN" = ${shq(serve.instanceToken)} ] `
            + '&& [ "$(oc_start "$PID")" = "$START" ] '
            + '&& [ "$(oc_exe "$PID")" = "$EXE" ] '
            + '&& [ "$(oc_cmd "$PID")" = "$CMD" ]; '
            + 'then kill "$PID" 2>/dev/null || true; fi; '
            + `if [ "$TOKEN" = ${shq(serve.instanceToken)} ]; then rm -f "$PF"; fi; fi`,
          `if [ "$(cut -f1 "$OWNER" 2>/dev/null)" = ${shq(serve.instanceToken)} ]; then rm -f "$OWNER"; fi`,
        ].join("; ");
        await host.exec(command, { timeoutMs: lifecycleTimeoutMs }).catch(() => {});
        await withDeadline(
          serve.handle.kill(),
          lifecycleTimeoutMs,
          "remote OpenCode handle cleanup",
        ).catch(() => {});
      };

      let forward: Awaited<ReturnType<RemoteHost["forward"]>>;
      try {
        forward = await withDeadline(
          host.forward(serve.port),
          lifecycleTimeoutMs,
          "remote OpenCode forward",
          async (lateForward) => {
            await withDeadline(
              Promise.resolve(lateForward.dispose()),
              lifecycleTimeoutMs,
              "late remote OpenCode forward cleanup",
            ).catch(() => {});
          },
        );
      } catch (error) {
        await cleanupRemote();
        throw error;
      }

      let stopped = false;
      return {
        url: `http://127.0.0.1:${forward.localPort}`,
        instanceIdentity: `${instanceToken}:${serve.remotePid ?? "unknown"}:${serve.port}`,
        alive: () => serve.alive() && !stopped,
        async stop() {
          if (stopped) return;
          stopped = true;
          serve.disposeExit();
          await cleanupRemote();
          await withDeadline(
            Promise.resolve(forward.dispose()),
            lifecycleTimeoutMs,
            "remote OpenCode forward disposal",
          ).catch(() => {});
        },
      };
    },
  });

  let lifecycle;
  try {
    lifecycle = await createOpenCodeRuntimeLifecycle({
      lease,
      startupDeadlineMs: readyTimeoutMs,
    });
  } catch (error) {
    await lease.dispose();
    throw unavailable(
      `remote opencode serve on ${host.label} did not become ready: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const runtime = createOpenCodeRuntimeFacade({
    cwd: remotePath,
    ...(options.sessionIdMap ? { sessionIdMap: options.sessionIdMap } : {}),
    ...(options.log ? { log: options.log } : {}),
    lifecycle,
  });
  const innerDispose = runtime.dispose.bind(runtime);
  let disposed = false;
  runtime.dispose = async () => {
    if (disposed) return;
    disposed = true;
    await innerDispose();
    await lifecycle.dispose();
    await releaseLock();
  };
  return attachRuntimeLifecycle(runtime, lifecycle) as ManagedOpenCodeRuntime;
  } catch (error) {
    await releaseLock();
    throw error;
  }
};
