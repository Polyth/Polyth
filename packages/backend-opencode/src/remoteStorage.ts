// Remote owned-OpenCode storage identity. Mirrors local `prepareOpenCodeRuntime`
// invariants (runtime.json, storageId, engine digest, fail-closed isolation)
// without treating a remote path as a local filesystem.
import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { RemoteHost, RemoteProcessHandle } from "@polyth/contracts";
import type { OwnedRuntimeIncarnation } from "./ownedRuntimeState.ts";
import {
  OPENCODE_BINARY_DIGEST_RE,
  OPENCODE_PROTOCOL_GENERATION,
  formatEngineRolloverDiagnostic,
  openCodeEnginesMatch,
  parseOpenCodeRuntimeMetadata,
  type OpenCodeBinarySource,
  type OpenCodeEngineIdentity,
  type OpenCodeRuntimeMetadata,
} from "./runtimeStorage.ts";

export const REMOTE_STORAGE_MARKERS = {
  resolveDir: "POLYTH_REMOTE_RUNTIME_DIR_RESOLVE=1",
  inspect: "POLYTH_REMOTE_STORAGE_INSPECT=1",
  hashBinary: "POLYTH_REMOTE_HASH_BINARY=1",
  writeDigestCache: "POLYTH_REMOTE_WRITE_DIGEST_CACHE=1",
  quarantine: "POLYTH_REMOTE_STORAGE_QUARANTINE=1",
  writeMetadata: "POLYTH_REMOTE_STORAGE_WRITE_METADATA=1",
  acquireLock: "POLYTH_REMOTE_ACQUIRE_LOCK=1",
  lockGuardian: "POLYTH_REMOTE_LOCK_GUARDIAN=1",
  attach: "POLYTH_REMOTE_ATTACH=1",
  stopServe: "POLYTH_REMOTE_STOP_SERVE=1",
} as const;

const REMOTE_CONTROLLER_LOCK_FILE = ".polyth-controller.lock";
const REMOTE_DIGEST_CACHE_FILE = ".polyth-binary-digest";

/** Same key `startServe` uses for `${XDG_CACHE_HOME:-$HOME/.cache}/polyth/serve-<hash>.pid`. */
const remoteProcessKey = (runtimeDir: string, remotePath: string): string =>
  createHash("sha256")
    .update(runtimeDir)
    .update("\0")
    .update(remotePath)
    .digest("hex")
    .slice(0, 24);

export const remoteServePidFileExpr = (runtimeDir: string, remotePath: string): string =>
  `"\${XDG_CACHE_HOME:-$HOME/.cache}/polyth/serve-${remoteProcessKey(runtimeDir, remotePath)}.pid"`;

/** Linux /proc helpers shared by identity probe, lock stale-check, and serve. */
export const REMOTE_PROCESS_IDENTITY_FUNS = [
  'oc_start() { sed "s/.*) //" "/proc/$1/stat" 2>/dev/null | cut -d" " -f20; }',
  'oc_exe() { readlink "/proc/$1/exe" 2>/dev/null; }',
  'oc_cmd() { tr "\\000" " " < "/proc/$1/cmdline" 2>/dev/null | cksum | awk \'{print $1 ":" $2}\'; }',
].join("; ");
export const DEFAULT_REMOTE_RUNTIME_ROOT_EXPR =
  "${XDG_DATA_HOME:-$HOME/.local/share}/polyth/runtimes/opencode";

const REMOTE_STATE_KEY_RE = /^[A-Za-z0-9._-]+$/;

export const shq = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

const unavailable = (message: string, cause?: unknown): Error =>
  Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    code: "unavailable",
  });

const invalid = (message: string): Error =>
  Object.assign(new Error(message), { code: "invalid-input" });

const taggedLine = (stdout: string, name: string): string | undefined => {
  const match = stdout.match(new RegExp(`(?:^|\\n)${name}=(.*)$`, "m"));
  const value = match?.[1]?.replace(/\r$/, "");
  return value === undefined || value === "" ? undefined : value;
};

const metadataBlock = (stdout: string): string | undefined => {
  const begin = stdout.indexOf("POLYTH_METADATA_BEGIN\n");
  if (begin < 0) return undefined;
  const contentStart = begin + "POLYTH_METADATA_BEGIN\n".length;
  const end = stdout.indexOf("\nPOLYTH_METADATA_END", contentStart);
  if (end < 0) return undefined;
  return stdout.slice(contentStart, end);
};

const pathKind = (value: string | undefined): "missing" | "file" | "symlink" | "other" => {
  if (value === "file" || value === "symlink" || value === "other" || value === "missing") {
    return value;
  }
  return "missing";
};

export interface PreparedRemoteOpenCodeRuntime {
  runtimeDir: string;
  dbPath: string;
  storageId: string;
  engineIdentity: OpenCodeEngineIdentity;
  binaryPath: string;
  binarySource: OpenCodeBinarySource;
  diagnostic?: string;
  recordOpen(incarnation: OwnedRuntimeIncarnation): Promise<void>;
}

const REMOTE_PATH_PREFIX = 'PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"';

const kindOfFn = [
  'kind_of() {',
  '  if [ -L "$1" ]; then echo symlink;',
  '  elif [ -f "$1" ]; then echo file;',
  '  elif [ -e "$1" ]; then echo other;',
  '  else echo missing; fi;',
  "}",
].join(" ");

// Fragments forming compound statements (case/esac, if/fi) MUST be joined
// with newlines: a "; " join injects a stray `;` after `case ... in` (and
// before `esac`), which POSIX shells reject as a syntax error and echo the
// whole command line to stderr — surfacing as a bogus
// "POLYTH_PREPARE_ERROR" fragment instead of the real failure.
const refuseOpenCodeGlobalDir = [
  'OC_GLOBAL="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"',
  'case "$RUNTIME_DIR" in',
  '  "$OC_GLOBAL"|"$OC_GLOBAL"/*)',
  "    echo POLYTH_PREPARE_ERROR=refusing-opencode-global-dir",
  "    exit 78",
  "    ;;",
  "esac",
].join("\n");

export const resolveRemoteRuntimeDir = async (options: {
  host: RemoteHost;
  runtimeDir?: string;
  remoteStateKey: string;
}): Promise<string> => {
  if (options.runtimeDir) {
    const checked = options.runtimeDir.trim();
    if (!checked.startsWith("/")) throw invalid("remote runtimeDir must be an absolute path");
    return posix.normalize(checked);
  }
  if (!REMOTE_STATE_KEY_RE.test(options.remoteStateKey)) {
    throw invalid("remoteStateKey must be a safe path segment");
  }
  const result = await options.host.exec(
    [
      REMOTE_STORAGE_MARKERS.resolveDir,
      `RUNTIME_DIR="${DEFAULT_REMOTE_RUNTIME_ROOT_EXPR}/${options.remoteStateKey}"`,
      'case "$RUNTIME_DIR" in',
      '  /*) ;;',
      '  *) echo POLYTH_PREPARE_ERROR=runtime-dir-not-absolute; exit 78 ;;',
      "esac",
      refuseOpenCodeGlobalDir,
      'echo "POLYTH_RUNTIME_DIR=$RUNTIME_DIR"',
    ].join("\n"),
    { timeoutMs: 20_000 },
  );
  if (result.code !== 0) {
    const error = taggedLine(result.stdout, "POLYTH_PREPARE_ERROR")
      ?? result.stderr.trim().slice(-300)
      ?? `exit ${result.code}`;
    throw unavailable(
      `could not resolve the isolated remote OpenCode runtime directory: ${error}`,
    );
  }
  const resolved = taggedLine(result.stdout, "POLYTH_RUNTIME_DIR");
  if (!resolved?.startsWith("/")) {
    throw unavailable(
      "remote runtime directory expansion did not produce an absolute path; "
        + "refusing to fall back to the remote global OpenCode DB",
    );
  }
  return posix.normalize(resolved);
};

export interface RemoteRuntimeAdoption {
  pid: string;
  startIdentity: string;
  executable: string;
  command: string;
  /** Immutable identity of the adopted OpenCode serve process. */
  serveToken: string;
  port: number;
  /** The guardian atomically upgraded a verified legacy five-field record. */
  legacyMigrated?: boolean;
}

export interface RemoteRuntimeLockHandle {
  adoption?: RemoteRuntimeAdoption;
  /** True while this controller still holds the flock. */
  held(): boolean;
  lost: Promise<void>;
  /** Ask the flock-holding guardian to exit. Process exit releases the flock. */
  release(): Promise<void>;
}

const LOCK_ACQUIRED_RE = /(?:^|\n)POLYTH_LOCK_ACQUIRED=1\r?\n/;
const LOCK_ERROR_RE = /(?:^|\n)POLYTH_LOCK_ERROR=([A-Za-z0-9._-]+)\r?\n/;

const lockUnavailable = (runtimeDir: string, error: string | undefined, fallback: string): Error => {
  if (error === "already-owned") {
    return unavailable(`owned remote runtime directory ${runtimeDir} is already owned / locked`);
  }
  if (error === "unsupported") {
    return unavailable(
      "owned SSH runtime requires Linux-compatible process identity "
        + "(/proc/self/stat, /proc/self/exe, /proc/self/cmdline); "
        + "refusing to start OpenCode serve",
    );
  }
  if (error === "identity-mismatch") {
    return unavailable(
      "owned remote runtime process identity does not match its owner record; refusing to adopt or kill it",
    );
  }
  if (error === "verify-failed") {
    return unavailable("could not verify remote startup ownership");
  }
  if (error === "listen-unknown") {
    return unavailable(
      "owned remote runtime is live but its listen endpoint is unknown; refusing to adopt or kill it",
    );
  }
  return unavailable(
    `could not acquire the remote runtime lock in ${runtimeDir}: ${error ?? fallback}`,
  );
};

const remoteLockGuardianCommand = (
  runtimeDir: string,
  remotePath: string,
): string => {
  const pidFileExpr = remoteServePidFileExpr(runtimeDir, remotePath);
  return [
    REMOTE_STORAGE_MARKERS.lockGuardian,
    REMOTE_STORAGE_MARKERS.acquireLock,
    "umask 077",
    `RUNTIME_DIR=${shq(runtimeDir)}`,
    REMOTE_PROCESS_IDENTITY_FUNS,
    'if [ -z "$(oc_start $$)" ] || [ -z "$(oc_exe $$)" ] || [ -z "$(oc_cmd $$)" ]; then '
      + "echo POLYTH_LOCK_ERROR=unsupported; exit 78; fi",
    'if [ -L "$RUNTIME_DIR" ]; then echo POLYTH_LOCK_ERROR=runtime-dir-is-symlink; exit 78; fi',
    'if ! mkdir -p "$RUNTIME_DIR" || ! chmod 700 "$RUNTIME_DIR"; then '
      + "echo POLYTH_LOCK_ERROR=mkdir-failed; exit 78; fi",
    'command -v flock >/dev/null 2>&1 || { echo POLYTH_LOCK_ERROR=flock-unavailable; exit 78; }',
    `CONTROLLER="$RUNTIME_DIR/${REMOTE_CONTROLLER_LOCK_FILE}"`,
    `PF=${pidFileExpr}`,
    'read_pf() { TAB=$(printf "\\t"); IFS="$TAB" read -r PF_TOK PF_PID PF_START PF_EXE PF_CMD PF_PORT < "$PF" || true; }',
    'id_exact() { [ "$(oc_start "$PF_PID")" = "$PF_START" ] '
      + '&& [ "$(oc_exe "$PF_PID")" = "$PF_EXE" ] '
      + '&& [ "$(oc_cmd "$PF_PID")" = "$PF_CMD" ]; }',
    'id_state() {',
    '  if [ ! -e "$PF" ]; then echo missing; return; fi',
    '  if [ -L "$PF" ] || [ ! -f "$PF" ]; then echo incomplete; return; fi',
    "  read_pf",
    '  if [ -z "$PF_TOK" ] || [ -z "$PF_PID" ] || [ -z "$PF_START" ] || [ -z "$PF_EXE" ] || [ -z "$PF_CMD" ]; then '
      + "echo incomplete; return; fi",
    '  if ! kill -0 "$PF_PID" 2>/dev/null; then echo dead; return; fi',
    '  if [ "$(oc_start "$PF_PID")" = "$PF_START" ] '
      + '&& [ "$(oc_exe "$PF_PID")" = "$PF_EXE" ] '
      + '&& [ "$(oc_cmd "$PF_PID")" = "$PF_CMD" ]; then echo live; return; fi',
    "  echo mismatch",
    "}",
    "wait_release() {",
    "  echo POLYTH_LOCK_ACQUIRED=1",
    "  while IFS= read -r line; do",
    '    case "$line" in',
    "      POLYTH_RELEASE) exit 0 ;;",
    "    esac",
    "  done",
    "  exit 0",
    "}",
    // Pre-ownership-v2 Polyth published exactly five fields and omitted the
    // listen port. Migration is allowed only while holding the controller
    // flock, around repeated exact /proc identity checks, and from the argv of
    // that process. No port scan or process-name inference is permitted.
    "migrate_legacy_port() {",
    "  echo POLYTH_LEGACY_RECORD=1",
    '  OLD_TOK=$PF_TOK; OLD_PID=$PF_PID; OLD_START=$PF_START; OLD_EXE=$PF_EXE; OLD_CMD=$PF_CMD',
    '  id_exact || return 1',
    '  ARGS=$(mktemp "$RUNTIME_DIR/.polyth-cmdline.XXXXXX") || return 1; MIG=',
    '  tr "\\000" "\\n" < "/proc/$PF_PID/cmdline" > "$ARGS" 2>/dev/null || { rm -f "$ARGS"; return 1; }',
    '  chmod 600 "$ARGS" 2>/dev/null || { rm -f "$ARGS"; return 1; }',
    '  id_exact || { rm -f "$ARGS"; return 1; }',
    "  PORT_VALUE=; PORT_COUNT=0; EXPECT_PORT=0; SERVE_COUNT=0",
    "  while IFS= read -r ARG; do",
    '    if [ "$EXPECT_PORT" = 1 ]; then PORT_VALUE=$ARG; PORT_COUNT=$((PORT_COUNT + 1)); EXPECT_PORT=0; continue; fi',
    '    case "$ARG" in',
    '      serve) SERVE_COUNT=$((SERVE_COUNT + 1)) ;;',
    '      --port) EXPECT_PORT=1 ;;',
    '      --port=*) PORT_VALUE=${ARG#--port=}; PORT_COUNT=$((PORT_COUNT + 1)) ;;',
    "    esac",
    '  done < "$ARGS"',
    '  rm -f "$ARGS"',
    '  [ "$EXPECT_PORT" = 0 ] && [ "$PORT_COUNT" = 1 ] && [ "$SERVE_COUNT" = 1 ] || return 1',
    '  case "$PORT_VALUE" in ""|*[!0-9]*) return 1 ;; esac',
    '  [ "${#PORT_VALUE}" -le 5 ] || return 1',
    '  PORT_VALUE=$(expr "$PORT_VALUE" + 0 2>/dev/null) || return 1',
    '  [ "$PORT_VALUE" -ge 1 ] && [ "$PORT_VALUE" -le 65535 ] || return 1',
    '  read_pf',
    '  [ "$PF_TOK" = "$OLD_TOK" ] && [ "$PF_PID" = "$OLD_PID" ] '
      + '&& [ "$PF_START" = "$OLD_START" ] && [ "$PF_EXE" = "$OLD_EXE" ] '
      + '&& [ "$PF_CMD" = "$OLD_CMD" ] && [ -z "$PF_PORT" ] || return 1',
    '  id_exact || return 1',
    '  MIG=$(mktemp "$PF.migrate.XXXXXX") || return 1',
    '  printf "%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$PF_TOK" "$PF_PID" "$PF_START" "$PF_EXE" "$PF_CMD" "$PORT_VALUE" > "$MIG" '
      + '|| { rm -f "$MIG"; return 1; }',
    '  chmod 600 "$MIG" 2>/dev/null || { rm -f "$MIG"; return 1; }',
    '  id_exact || { rm -f "$MIG"; return 1; }',
    '  mv "$MIG" "$PF" || { rm -f "$MIG"; return 1; }',
    '  PF_PORT=$PORT_VALUE',
    "  echo POLYTH_LEGACY_MIGRATED=1",
    "}",
    "emit_adopt() {",
    "  read_pf",
    '  if [ -z "$PF_PORT" ] && ! migrate_legacy_port; then echo POLYTH_LOCK_ERROR=listen-unknown; exit 78; fi',
    "  echo POLYTH_LOCK_ADOPTABLE=1",
    '  echo "POLYTH_ADOPT_PID=$PF_PID"',
    '  echo "POLYTH_ADOPT_START=$PF_START"',
    '  echo "POLYTH_ADOPT_EXE=$PF_EXE"',
    '  echo "POLYTH_ADOPT_CMD=$PF_CMD"',
    '  echo "POLYTH_ADOPT_TOKEN=$PF_TOK"',
    '  echo "POLYTH_ADOPT_PORT=$PF_PORT"',
    "  wait_release",
    "}",
    'exec 9>"$CONTROLLER" || { echo POLYTH_LOCK_ERROR=lock-open-failed; exit 78; }',
    'if ! flock -n 9; then echo POLYTH_LOCK_ERROR=already-owned; exit 78; fi',
    'SERVE_STATE=$(id_state)',
    'if [ "$SERVE_STATE" = "incomplete" ]; then echo POLYTH_LOCK_ERROR=verify-failed; exit 78; fi',
    'if [ "$SERVE_STATE" = "mismatch" ]; then echo POLYTH_LOCK_ERROR=identity-mismatch; exit 78; fi',
    'if [ "$SERVE_STATE" = "live" ]; then emit_adopt; fi',
    "wait_release",
  ].join("\n");
};

export const withRemoteDeadline = <T>(
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

const waitForGuardianExit = async (
  lost: Promise<void>,
  stillAlive: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> => {
  if (!stillAlive()) return;
  await withRemoteDeadline(lost, timeoutMs, label);
  if (stillAlive()) throw unavailable(`${label} completed without process exit`);
};

const killGuardianAndConfirm = async (
  handle: RemoteProcessHandle,
  lost: Promise<void>,
  stillAlive: () => boolean,
  timeoutMs: number,
): Promise<void> => {
  if (!stillAlive()) return;
  await withRemoteDeadline(handle.kill(), timeoutMs, "remote controller termination request");
  await waitForGuardianExit(lost, stillAlive, timeoutMs, "remote controller termination");
};

const confirmGuardianExit = async (
  handle: RemoteProcessHandle,
  lost: Promise<void>,
  stillAlive: () => boolean,
  exitCode: () => number | null | undefined,
  timeoutMs: number,
): Promise<void> => {
  if (!stillAlive()) return;
  let deliveryError: unknown;
  try {
    if (handle.write) {
      await withRemoteDeadline(
        handle.write("POLYTH_RELEASE\n"),
        timeoutMs,
        "remote controller release delivery",
      );
    } else {
      deliveryError = unavailable("remote controller has no interactive input channel");
    }
  } catch (error) {
    deliveryError = error;
  }
  if (!stillAlive() && !deliveryError && exitCode() === 0) return;
  if (!stillAlive()) {
    throw unavailable(
      `remote controller release was not confirmed (exit ${exitCode() ?? "killed"})`,
      deliveryError,
    );
  }
  if (!deliveryError) {
    try {
      await waitForGuardianExit(lost, stillAlive, timeoutMs, "remote controller release");
      if (exitCode() === 0) return;
      deliveryError = unavailable(
        `remote controller release exited unsuccessfully (${exitCode() ?? "killed"})`,
      );
    } catch (error) {
      deliveryError = error;
    }
  }
  let killError: unknown;
  try {
    await killGuardianAndConfirm(handle, lost, stillAlive, timeoutMs);
  } catch (error) {
    killError = error;
  }
  // Killing the local SSH process fences this controller, but is not proof
  // that the remote shell exited and released its flock. Only a delivered
  // POLYTH_RELEASE followed by normal channel exit is release confirmation.
  throw Object.assign(
    new AggregateError(
      [deliveryError, killError].filter(Boolean),
      "remote runtime controller did not release the flock; termination could not be confirmed",
    ),
    { code: "unavailable" },
  );
};

/** A terminal guardian error normally precedes process exit. Wait for that
 * exit first; never send a release message into a guardian already tearing
 * down. Escalate to terminating the SSH child only if it remains alive. */
const confirmTerminalGuardianExit = async (
  handle: RemoteProcessHandle,
  lost: Promise<void>,
  stillAlive: () => boolean,
  timeoutMs: number,
): Promise<void> => {
  try {
    await waitForGuardianExit(lost, stillAlive, timeoutMs, "failed remote controller exit");
  } catch (exitError) {
    let killError: unknown;
    try {
      await killGuardianAndConfirm(handle, lost, stillAlive, timeoutMs);
    } catch (error) {
      killError = error;
    }
    throw Object.assign(
      new AggregateError(
        [exitError, killError].filter(Boolean),
        "failed remote controller could not be confirmed exited",
      ),
      { code: "unavailable" },
    );
  }
};

const stopLateGuardian = async (
  handle: RemoteProcessHandle,
  timeoutMs: number,
): Promise<void> => {
  let exited = false;
  let exitCode: number | null | undefined;
  const lost = new Promise<void>((resolveLost) => {
    handle.onExit((code) => {
      exited = true;
      exitCode = code;
      resolveLost();
    });
  });
  await confirmGuardianExit(handle, lost, () => !exited, () => exitCode, timeoutMs);
};

const acquisitionCleanupFailed = (error: Error, cleanupErr: unknown): Error => {
  const cleanup = cleanupErr instanceof Error ? cleanupErr : new Error(String(cleanupErr));
  return Object.assign(
    new AggregateError(
      [error, cleanup],
      "remote controller acquisition failed; guardian cleanup could not be confirmed: "
        + cleanup.message,
    ),
    { code: "unavailable" },
  );
};

export const acquireRemoteRuntimeLock = async (
  host: RemoteHost,
  runtimeDir: string,
  remotePath: string,
  options?: { timeoutMs?: number },
): Promise<RemoteRuntimeLockHandle> => {
  if (!runtimeDir.startsWith("/")) throw invalid("remote runtimeDir must be an absolute path");
  if (!remotePath.trim()) throw invalid("remote path is required");
  const timeoutMs = options?.timeoutMs ?? 20_000;
  const command = remoteLockGuardianCommand(runtimeDir, remotePath);
  const handle = await withRemoteDeadline(
    host.start(command, { interactive: true }),
    timeoutMs,
    "remote runtime lock guardian start",
    (lateHandle) => {
      void stopLateGuardian(lateHandle, timeoutMs).catch((error) => {
        console.error(
          `[polyth] remote controller late-start cleanup failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    },
  );
  return new Promise<RemoteRuntimeLockHandle>((resolve, reject) => {
    let buf = "";
    let settled = false;
    let state: "starting" | "acquired" | "terminal-acquisition-error" | "exited" = "starting";
    let controllerAlive = true;
    let guardianExitCode: number | null | undefined;
    let legacyLogged = false;
    let releaseFlight: Promise<void> | undefined;
    let lostResolve!: () => void;
    const lost = new Promise<void>((resolveLost) => { lostResolve = resolveLost; });
    const markLost = (): void => {
      if (!controllerAlive) return;
      controllerAlive = false;
      state = "exited";
      lostResolve();
    };
    const parseAdoption = (): RemoteRuntimeAdoption | undefined => {
      if (!/POLYTH_LOCK_ADOPTABLE=1/.test(buf) && !taggedLine(buf, "POLYTH_ADOPT_PID")) {
        return undefined;
      }
      const pid = taggedLine(buf, "POLYTH_ADOPT_PID");
      const startIdentity = taggedLine(buf, "POLYTH_ADOPT_START");
      const executable = taggedLine(buf, "POLYTH_ADOPT_EXE");
      const command = taggedLine(buf, "POLYTH_ADOPT_CMD");
      const serveToken = taggedLine(buf, "POLYTH_ADOPT_TOKEN");
      const port = Number(taggedLine(buf, "POLYTH_ADOPT_PORT"));
      if (
        !pid
        || !startIdentity
        || !executable
        || !command
        || !serveToken
        || !Number.isInteger(port)
        || port < 1
        || port > 65535
      ) {
        return undefined;
      }
      return {
        pid,
        startIdentity,
        executable,
        command,
        serveToken,
        port,
        ...(/POLYTH_LEGACY_MIGRATED=1/.test(buf) ? { legacyMigrated: true } : {}),
      };
    };
    const fail = (error: Error, terminalError = false) => {
      if (settled) return;
      settled = true;
      if (terminalError && state !== "exited") state = "terminal-acquisition-error";
      clearTimeout(timer);
      const cleanup = terminalError
        ? confirmTerminalGuardianExit(handle, lost, () => controllerAlive, timeoutMs)
        : confirmGuardianExit(
            handle,
            lost,
            () => controllerAlive,
            () => guardianExitCode,
            timeoutMs,
          );
      void cleanup.then(
        () => reject(error),
        (cleanupErr) => reject(acquisitionCleanupFailed(error, cleanupErr)),
      );
    };
    const succeed = () => {
      if (settled) return;
      const adoption = parseAdoption();
      if ((/POLYTH_LOCK_ADOPTABLE=1/.test(buf) || taggedLine(buf, "POLYTH_ADOPT_PID")) && !adoption) {
        fail(lockUnavailable(runtimeDir, "listen-unknown", "adopt"));
        return;
      }
      settled = true;
      state = "acquired";
      clearTimeout(timer);
      resolve({
        ...(adoption ? { adoption } : {}),
        held: () => controllerAlive,
        lost,
        release: () => {
          releaseFlight ??= confirmGuardianExit(
            handle,
            lost,
            () => controllerAlive,
            () => guardianExitCode,
            timeoutMs,
          );
          return releaseFlight;
        },
      });
    };
    const timer = setTimeout(
      () => fail(unavailable(
        `remote runtime lock guardian did not acquire within ${timeoutMs}ms`,
      )),
      timeoutMs,
    );
    let outputSub: { dispose(): void } | undefined;
    let disposeOutputWhenRegistered = false;
    outputSub = handle.onOutput((chunk) => {
      buf += chunk;
      if (!legacyLogged && /POLYTH_LEGACY_RECORD=1/.test(buf)) {
        legacyLogged = true;
        console.log(`[polyth] runtime.remote.legacy-record.detected runtimeDir=${runtimeDir}`);
      }
      const tagged = buf.match(LOCK_ERROR_RE)?.[1];
      if (tagged) {
        if (tagged === "verify-failed" || tagged === "identity-mismatch") {
          console.warn(
            `[polyth] runtime.remote.adoption.refused runtimeDir=${runtimeDir} `
              + `reason=${tagged === "verify-failed" ? "identity-incomplete" : "identity-mismatch"}`,
          );
        } else if (tagged === "listen-unknown") {
          console.warn(
            `[polyth] runtime.remote.adoption.refused runtimeDir=${runtimeDir} reason=listen-unknown`,
          );
        }
        fail(lockUnavailable(runtimeDir, tagged, tagged), true);
        return;
      }
      if (LOCK_ACQUIRED_RE.test(buf)) {
        if (outputSub) outputSub.dispose();
        else disposeOutputWhenRegistered = true;
        succeed();
      }
    });
    if (disposeOutputWhenRegistered) outputSub.dispose();
    handle.onExit((code) => {
      guardianExitCode = code;
      markLost();
      if (state === "acquired" || settled) return;
      const tagged = buf.match(LOCK_ERROR_RE)?.[1];
      fail(lockUnavailable(
        runtimeDir,
        tagged,
        buf.trim().slice(-300) || `exit ${code ?? "killed"}`,
      ));
    });
  });
};

const inspectRemoteStorage = async (
  host: RemoteHost,
  runtimeDir: string,
  bin: string,
): Promise<{
  metadataKind: "missing" | "file" | "symlink" | "other";
  metadataRaw?: string;
  dbKind: "missing" | "file" | "symlink" | "other";
  dbEntries: string[];
  binaryPath: string;
  binarySize: string;
  binaryMtime: string;
  digestCacheKind: "missing" | "file" | "symlink" | "other";
  digestCache?: { path: string; size: string; mtime: string; digest: string };
}> => {
  const result = await host.exec(
    [
      REMOTE_STORAGE_MARKERS.inspect,
      REMOTE_PATH_PREFIX,
      "umask 077",
      `RUNTIME_DIR=${shq(runtimeDir)}`,
      `BIN=${shq(bin)}`,
      refuseOpenCodeGlobalDir,
      'if [ -L "$RUNTIME_DIR" ]; then echo POLYTH_PREPARE_ERROR=runtime-dir-is-symlink; exit 78; fi',
      'if ! mkdir -p "$RUNTIME_DIR" || ! chmod 700 "$RUNTIME_DIR"; then '
        + "echo POLYTH_PREPARE_ERROR=mkdir-failed; exit 78; fi",
      'echo "POLYTH_RUNTIME_DIR=$RUNTIME_DIR"',
      kindOfFn,
      `META="$RUNTIME_DIR/runtime.json"`,
      `DB="$RUNTIME_DIR/opencode.db"`,
      `CACHE="$RUNTIME_DIR/${REMOTE_DIGEST_CACHE_FILE}"`,
      'echo "POLYTH_METADATA_KIND=$(kind_of "$META")"',
      'if [ -f "$META" ] && [ ! -L "$META" ]; then '
        + "echo POLYTH_METADATA_BEGIN; cat \"$META\"; echo; echo POLYTH_METADATA_END; fi",
      'echo "POLYTH_DB_KIND=$(kind_of "$DB")"',
      "ENTRIES=",
      "for name in opencode.db opencode.db-wal opencode.db-shm; do "
        + 'p="$RUNTIME_DIR/$name"; '
        + 'if [ -L "$p" ] || [ -e "$p" ]; then ENTRIES="$ENTRIES $name"; fi; '
        + "done",
      'echo "POLYTH_DB_ENTRIES=$ENTRIES"',
      'if expr "$BIN" : "/" >/dev/null; then BIN_PATH="$BIN"; '
        + 'else BIN_PATH=$(command -v "$BIN" 2>/dev/null) || true; fi',
      'if [ -z "$BIN_PATH" ] || [ ! -x "$BIN_PATH" ]; then '
        + "echo POLYTH_PREPARE_ERROR=binary-not-found; exit 78; fi",
      'if command -v realpath >/dev/null 2>&1; then '
        + 'BIN_PATH=$(realpath "$BIN_PATH" 2>/dev/null || printf "%s" "$BIN_PATH"); fi',
      'echo "POLYTH_BINARY_PATH=$BIN_PATH"',
      'if stat -c "%s %Y" "$BIN_PATH" >/dev/null 2>&1; then BIN_STAT=$(stat -c "%s %Y" "$BIN_PATH"); '
        + 'elif stat -f "%z %m" "$BIN_PATH" >/dev/null 2>&1; then BIN_STAT=$(stat -f "%z %m" "$BIN_PATH"); '
        + "else echo POLYTH_PREPARE_ERROR=binary-stat-failed; exit 78; fi",
      'echo "POLYTH_BINARY_SIZE=${BIN_STAT%% *}"',
      'echo "POLYTH_BINARY_MTIME=${BIN_STAT#* }"',
      'echo "POLYTH_DIGEST_CACHE_KIND=$(kind_of "$CACHE")"',
      'if [ -f "$CACHE" ] && [ ! -L "$CACHE" ]; then '
        + 'TAB=$(printf "\\t"); '
        + 'IFS="$TAB" read -r CACHE_PATH CACHE_SIZE CACHE_MTIME CACHE_DIGEST < "$CACHE" || true; '
        + 'echo "POLYTH_DIGEST_CACHE_PATH=$CACHE_PATH"; '
        + 'echo "POLYTH_DIGEST_CACHE_SIZE=$CACHE_SIZE"; '
        + 'echo "POLYTH_DIGEST_CACHE_MTIME=$CACHE_MTIME"; '
        + 'echo "POLYTH_DIGEST_CACHE_DIGEST=$CACHE_DIGEST"; fi',
    ].join("\n"),
    { timeoutMs: 20_000 },
  );
  const error = taggedLine(result.stdout, "POLYTH_PREPARE_ERROR");
  if (result.code !== 0 || error) {
    throw unavailable(
      `could not inspect isolated remote OpenCode runtime ${runtimeDir}: `
        + (error ?? result.stderr.trim().slice(-300) ?? `exit ${result.code}`),
    );
  }
  const binaryPath = taggedLine(result.stdout, "POLYTH_BINARY_PATH");
  const binarySize = taggedLine(result.stdout, "POLYTH_BINARY_SIZE");
  const binaryMtime = taggedLine(result.stdout, "POLYTH_BINARY_MTIME");
  if (!binaryPath?.startsWith("/") || !binarySize || !binaryMtime) {
    throw unavailable(`could not resolve the remote OpenCode binary for ${runtimeDir}`);
  }
  const cacheDigest = taggedLine(result.stdout, "POLYTH_DIGEST_CACHE_DIGEST");
  const cachePath = taggedLine(result.stdout, "POLYTH_DIGEST_CACHE_PATH");
  const cacheSize = taggedLine(result.stdout, "POLYTH_DIGEST_CACHE_SIZE");
  const cacheMtime = taggedLine(result.stdout, "POLYTH_DIGEST_CACHE_MTIME");
  return {
    metadataKind: pathKind(taggedLine(result.stdout, "POLYTH_METADATA_KIND")),
    metadataRaw: metadataBlock(result.stdout),
    dbKind: pathKind(taggedLine(result.stdout, "POLYTH_DB_KIND")),
    dbEntries: (taggedLine(result.stdout, "POLYTH_DB_ENTRIES") ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean),
    binaryPath,
    binarySize,
    binaryMtime,
    digestCacheKind: pathKind(taggedLine(result.stdout, "POLYTH_DIGEST_CACHE_KIND")),
    digestCache: cachePath && cacheSize && cacheMtime && cacheDigest
      ? { path: cachePath, size: cacheSize, mtime: cacheMtime, digest: cacheDigest }
      : undefined,
  };
};

const hashRemoteBinary = async (host: RemoteHost, binaryPath: string): Promise<string> => {
  const result = await host.exec(
    [
      REMOTE_STORAGE_MARKERS.hashBinary,
      REMOTE_PATH_PREFIX,
      `BIN_PATH=${shq(binaryPath)}`,
      'if command -v sha256sum >/dev/null 2>&1; then '
        + 'DIGEST=$(sha256sum "$BIN_PATH" | awk \'{print $1}\'); '
        + "elif command -v shasum >/dev/null 2>&1; then "
        + 'DIGEST=$(shasum -a 256 "$BIN_PATH" | awk \'{print $1}\'); '
        + "elif command -v openssl >/dev/null 2>&1; then "
        + 'DIGEST=$(openssl dgst -sha256 "$BIN_PATH" | awk \'{print $NF}\'); '
        + "else echo POLYTH_PREPARE_ERROR=no-digest-tool; exit 78; fi",
      'if [ -z "$DIGEST" ]; then echo POLYTH_PREPARE_ERROR=empty-digest; exit 78; fi',
      'echo "POLYTH_BINARY_DIGEST=$DIGEST"',
    ].join("; "),
    { timeoutMs: 60_000 },
  );
  const error = taggedLine(result.stdout, "POLYTH_PREPARE_ERROR");
  const digest = taggedLine(result.stdout, "POLYTH_BINARY_DIGEST");
  if (result.code !== 0 || error || !digest || !OPENCODE_BINARY_DIGEST_RE.test(digest)) {
    throw unavailable(
      `could not hash the remote OpenCode binary at ${binaryPath}: `
        + (error ?? result.stderr.trim().slice(-300) ?? `exit ${result.code}`),
    );
  }
  return digest;
};

const writeRemoteDigestCache = async (
  host: RemoteHost,
  runtimeDir: string,
  cache: { path: string; size: string; mtime: string; digest: string },
): Promise<void> => {
  const cacheFile = posix.join(runtimeDir, REMOTE_DIGEST_CACHE_FILE);
  const body = `${cache.path}\t${cache.size}\t${cache.mtime}\t${cache.digest}\n`;
  const result = await host.exec(
    [
      REMOTE_STORAGE_MARKERS.writeDigestCache,
      "umask 077",
      `CACHE=${shq(cacheFile)}`,
      `BODY=${shq(body)}`,
      'TMP="$CACHE.$$.$RANDOM.tmp"',
      'if [ -L "$CACHE" ]; then rm -f "$CACHE"; fi',
      'printf "%s" "$BODY" > "$TMP" || { rm -f "$TMP"; echo POLYTH_PREPARE_ERROR=digest-cache-write; exit 78; }',
      'mv "$TMP" "$CACHE" || { rm -f "$TMP"; echo POLYTH_PREPARE_ERROR=digest-cache-write; exit 78; }',
      'chmod 600 "$CACHE"',
    ].join("; "),
    { timeoutMs: 20_000 },
  );
  if (result.code !== 0) {
    throw unavailable(`could not persist the remote OpenCode binary digest cache in ${runtimeDir}`);
  }
};

const quarantineRemoteDatabase = async (
  host: RemoteHost,
  runtimeDir: string,
  reason: string,
  now: number,
): Promise<void> => {
  const result = await host.exec(
    [
      REMOTE_STORAGE_MARKERS.quarantine,
      "umask 077",
      `RUNTIME_DIR=${shq(runtimeDir)}`,
      `REASON=${shq(reason)}`,
      `NOW=${shq(String(now))}`,
      'QUARANTINE="$RUNTIME_DIR/quarantine"',
      'DEST="$QUARANTINE/$NOW-$REASON"',
      'mkdir -p "$QUARANTINE" "$DEST" || { echo POLYTH_PREPARE_ERROR=quarantine-mkdir; exit 78; }',
      'chmod 700 "$QUARANTINE" "$DEST"',
      "MOVED=0",
      "for name in opencode.db opencode.db-wal opencode.db-shm; do "
        + 'p="$RUNTIME_DIR/$name"; '
        + 'if [ -L "$p" ] || [ -e "$p" ]; then mv "$p" "$DEST/" || { echo POLYTH_PREPARE_ERROR=quarantine-move; exit 78; }; MOVED=1; fi; '
        + "done",
      'echo "POLYTH_QUARANTINE_MOVED=$MOVED"',
    ].join("; "),
    { timeoutMs: 20_000 },
  );
  if (result.code !== 0) {
    throw unavailable(`could not quarantine incompatible OpenCode DB in ${runtimeDir}`);
  }
};

const writeRemoteMetadata = async (
  host: RemoteHost,
  metadataFile: string,
  metadata: OpenCodeRuntimeMetadata,
): Promise<void> => {
  const json = `${JSON.stringify(metadata, null, 2)}\n`;
  const result = await host.exec(
    [
      REMOTE_STORAGE_MARKERS.writeMetadata,
      "umask 077",
      `FILE=${shq(metadataFile)}`,
      `METADATA_JSON=${shq(json)}`,
      'TMP="$FILE.$$.$RANDOM.tmp"',
      'if [ -L "$FILE" ]; then rm -f "$FILE"; fi',
      'printf "%s" "$METADATA_JSON" > "$TMP" || { rm -f "$TMP"; echo POLYTH_PREPARE_ERROR=metadata-write; exit 78; }',
      'mv "$TMP" "$FILE" || { rm -f "$TMP"; echo POLYTH_PREPARE_ERROR=metadata-write; exit 78; }',
      'chmod 600 "$FILE"',
    ].join("; "),
    { timeoutMs: 20_000 },
  );
  if (result.code !== 0) {
    throw unavailable(`could not persist OpenCode runtime metadata ${metadataFile}`);
  }
};

const cachedDigest = (
  inspect: Awaited<ReturnType<typeof inspectRemoteStorage>>,
): string | undefined => {
  const cache = inspect.digestCache;
  if (
    inspect.digestCacheKind !== "file"
    || !cache
    || cache.path !== inspect.binaryPath
    || cache.size !== inspect.binarySize
    || cache.mtime !== inspect.binaryMtime
    || !OPENCODE_BINARY_DIGEST_RE.test(cache.digest)
  ) {
    return undefined;
  }
  return cache.digest;
};

export const prepareRemoteOpenCodeRuntime = async (options: {
  host: RemoteHost;
  runtimeDir: string;
  projectId: string;
  cwd: string;
  bin: string;
  version: string;
  binarySource: OpenCodeBinarySource;
  now?: number;
  /** Exact serve already verified by the controller lock. Storage must not
   * quarantine a DB that process still has open. */
  adoption?: RemoteRuntimeAdoption;
}): Promise<PreparedRemoteOpenCodeRuntime> => {
  if (!options.runtimeDir.startsWith("/")) {
    throw invalid("remote runtimeDir must be an absolute path");
  }
  if (!options.projectId.trim()) throw unavailable("owned OpenCode projectId is required");
  if (!options.version.trim()) {
    throw unavailable("could not read the remote OpenCode version; refusing owned startup");
  }
  const runtimeDir = posix.normalize(options.runtimeDir);
  const cwd = posix.normalize(options.cwd);
  const now = options.now ?? Date.now();
  const inspect = await inspectRemoteStorage(options.host, runtimeDir, options.bin);

  let binaryDigest = cachedDigest(inspect);
  if (!binaryDigest) {
    binaryDigest = await hashRemoteBinary(options.host, inspect.binaryPath);
    await writeRemoteDigestCache(options.host, runtimeDir, {
      path: inspect.binaryPath,
      size: inspect.binarySize,
      mtime: inspect.binaryMtime,
      digest: binaryDigest,
    });
  }

  const engineIdentity: OpenCodeEngineIdentity = {
    engine: "opencode",
    version: options.version,
    binaryDigest,
    protocolGeneration: OPENCODE_PROTOCOL_GENERATION,
  };

  const metadataExists = inspect.metadataKind !== "missing";
  const previous = inspect.metadataKind === "file" && inspect.metadataRaw
    ? parseOpenCodeRuntimeMetadata(inspect.metadataRaw)
    : undefined;
  const sameLocation = previous
    && previous.runtimeLocation.projectId === options.projectId
    && posix.normalize(previous.runtimeLocation.cwd) === cwd;
  const databaseIsRegular = inspect.dbKind === "file";
  const engineCompatible = previous && sameLocation
    && openCodeEnginesMatch(previous, engineIdentity);
  const compatible = Boolean(engineCompatible && databaseIsRegular);
  if (options.adoption && previous && sameLocation && !engineCompatible) {
    throw Object.assign(
      new Error(
        `runtime.engine.rollover remote ${runtimeDir}: live process still owns the previous engine `
          + `digest ${previous.binaryDigest.slice(0, 12)}; refusing to attach or quarantine a live DB`,
      ),
      { code: "incompatible" },
    );
  }
  if (options.adoption && !compatible) {
    throw unavailable(
      `cannot adopt live remote runtime ${runtimeDir}: storage is missing or unsafe`,
    );
  }
  const diagnostic = previous && sameLocation
    ? !openCodeEnginesMatch(previous, engineIdentity)
      ? formatEngineRolloverDiagnostic(`remote ${runtimeDir}`, previous, engineIdentity)
      : !databaseIsRegular
        ? `OpenCode runtime storage was missing or unsafe for remote ${runtimeDir}; recognized DB paths were quarantined without being opened. `
          + "Existing sessions will require a new runtime epoch."
        : undefined
    : undefined;

  if (!compatible) {
    const reason = metadataExists
      ? previous
        ? engineCompatible
          ? "missing-or-unsafe-database"
          : "incompatible-engine"
        : "invalid-metadata"
      : "missing-metadata";
    if (inspect.dbEntries.length > 0 || inspect.dbKind !== "missing") {
      await quarantineRemoteDatabase(options.host, runtimeDir, reason, now);
    }
  }

  const createdAt = compatible && previous
    ? previous.createdAt
    : new Date(now).toISOString();
  const storageId = compatible && previous
    ? previous.storageId
    : randomUUID();
  const metadataFile = posix.join(runtimeDir, "runtime.json");

  return {
    runtimeDir,
    dbPath: posix.join(runtimeDir, "opencode.db"),
    storageId,
    engineIdentity,
    binaryPath: inspect.binaryPath,
    binarySource: options.binarySource,
    ...(diagnostic ? { diagnostic } : {}),
    async recordOpen(incarnation) {
      const openedAt = new Date().toISOString();
      const metadata: OpenCodeRuntimeMetadata = {
        ...engineIdentity,
        storageId,
        binarySource: options.binarySource,
        binaryPath: inspect.binaryPath,
        runtimeAuthority: incarnation.authorityId,
        runtimeLocation: { projectId: options.projectId, cwd },
        createdAt,
        lastOpenedAt: openedAt,
      };
      await writeRemoteMetadata(options.host, metadataFile, metadata);
    },
  };
};
