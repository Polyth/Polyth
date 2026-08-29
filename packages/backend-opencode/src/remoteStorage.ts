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
  processIdentity: "POLYTH_REMOTE_PROCESS_IDENTITY=1",
  acquireLock: "POLYTH_REMOTE_ACQUIRE_LOCK=1",
  lockGuardian: "POLYTH_REMOTE_LOCK_GUARDIAN=1",
  releaseLock: "POLYTH_REMOTE_RELEASE_LOCK=1",
} as const;

export const REMOTE_OWNER_FILE = ".polyth-runtime-owner";
export const REMOTE_LOCK_DIR = ".polyth-runtime-lock";
export const REMOTE_LOCK_STARTING = "starting";
export const REMOTE_LOCK_HANDOFF = "handoff";
export const REMOTE_DIGEST_CACHE_FILE = ".polyth-binary-digest";

/** Same key `startServe` uses for `${XDG_CACHE_HOME:-$HOME/.cache}/polyth/serve-<hash>.pid`. */
export const remoteProcessKey = (runtimeDir: string, remotePath: string): string =>
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

const refuseOpenCodeGlobalDir = [
  'OC_GLOBAL="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"',
  'case "$RUNTIME_DIR" in',
  '  "$OC_GLOBAL"|"$OC_GLOBAL"/*)',
  "    echo POLYTH_PREPARE_ERROR=refusing-opencode-global-dir",
  "    exit 78",
  "    ;;",
  "esac",
].join("; ");

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
    ].join("; "),
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

export const probeRemoteProcessIdentity = async (host: RemoteHost): Promise<void> => {
  const result = await host.exec(
    [
      REMOTE_STORAGE_MARKERS.processIdentity,
      REMOTE_PROCESS_IDENTITY_FUNS,
      "START=$(oc_start self)",
      "EXE=$(oc_exe self)",
      "CMD=$(oc_cmd self)",
      'if [ -z "$START" ] || [ -z "$EXE" ] || [ -z "$CMD" ]; then '
        + "echo POLYTH_PROCESS_IDENTITY_ERROR=unsupported; exit 78; fi",
      "echo POLYTH_PROCESS_IDENTITY_OK=1",
      'echo "POLYTH_PROCESS_START=$START"',
      'echo "POLYTH_PROCESS_EXE=$EXE"',
      'echo "POLYTH_PROCESS_CMD=$CMD"',
    ].join("; "),
    { timeoutMs: 20_000 },
  );
  const error = taggedLine(result.stdout, "POLYTH_PROCESS_IDENTITY_ERROR");
  const start = taggedLine(result.stdout, "POLYTH_PROCESS_START");
  const exe = taggedLine(result.stdout, "POLYTH_PROCESS_EXE");
  const cmd = taggedLine(result.stdout, "POLYTH_PROCESS_CMD");
  if (
    result.code !== 0
    || error
    || taggedLine(result.stdout, "POLYTH_PROCESS_IDENTITY_OK") !== "1"
    || !start
    || !exe
    || !cmd
  ) {
    throw unavailable(
      "owned SSH runtime requires Linux-compatible process identity "
        + "(/proc/self/stat, /proc/self/exe, /proc/self/cmdline); "
        + "refusing to start OpenCode serve",
    );
  }
};

export interface RemoteRuntimeLockHandle {
  lockToken: string;
  runtimeDir: string;
  guardian: RemoteProcessHandle;
}

const LOCK_ACQUIRED_RE = /POLYTH_LOCK_ACQUIRED=1/;
const LOCK_ERROR_RE = /POLYTH_LOCK_ERROR=([A-Za-z0-9._-]+)/;

const lockUnavailable = (runtimeDir: string, error: string | undefined, fallback: string): Error => {
  if (error === "already-owned") {
    return unavailable(`owned remote runtime directory ${runtimeDir} is already owned / locked`);
  }
  if (error === "starting-alive") {
    return unavailable("owned remote runtime startup owner is still alive");
  }
  if (error === "verify-failed") {
    return unavailable("could not verify remote startup ownership");
  }
  if (error === "reclaim-failed") {
    return unavailable("could not reclaim stale remote runtime lock");
  }
  return unavailable(
    `could not acquire the remote runtime lock in ${runtimeDir}: ${error ?? fallback}`,
  );
};

const remoteLockGuardianCommand = (
  runtimeDir: string,
  lockToken: string,
  remotePath: string,
): string => {
  const pidFileExpr = remoteServePidFileExpr(runtimeDir, remotePath);
  return [
    REMOTE_STORAGE_MARKERS.lockGuardian,
    REMOTE_STORAGE_MARKERS.acquireLock,
    "umask 077",
    `RUNTIME_DIR=${shq(runtimeDir)}`,
    `LOCK_TOKEN=${shq(lockToken)}`,
    REMOTE_PROCESS_IDENTITY_FUNS,
    'if [ -z "$(oc_start $$)" ] || [ -z "$(oc_exe $$)" ] || [ -z "$(oc_cmd $$)" ]; then '
      + "echo POLYTH_LOCK_ERROR=unsupported; exit 78; fi",
    'if [ -L "$RUNTIME_DIR" ]; then echo POLYTH_LOCK_ERROR=runtime-dir-is-symlink; exit 78; fi',
    'if ! mkdir -p "$RUNTIME_DIR" || ! chmod 700 "$RUNTIME_DIR"; then '
      + "echo POLYTH_LOCK_ERROR=mkdir-failed; exit 78; fi",
    `LOCK="$RUNTIME_DIR/${REMOTE_LOCK_DIR}"`,
    `OWNER="$RUNTIME_DIR/${REMOTE_OWNER_FILE}"`,
    `PF=${pidFileExpr}`,
    'id_state() {',
    '  _f="$1"',
    '  if [ ! -e "$_f" ]; then echo missing; return; fi',
    '  if [ -L "$_f" ] || [ ! -f "$_f" ]; then echo incomplete; return; fi',
    '  TAB=$(printf "\\t")',
    '  IFS="$TAB" read -r _tok _pid _st _ex _cm < "$_f" || true',
    '  if [ -z "$_tok" ] || [ -z "$_pid" ] || [ -z "$_st" ] || [ -z "$_ex" ] || [ -z "$_cm" ]; then '
      + "echo incomplete; return; fi",
    '  if [ "$(oc_start "$_pid")" = "$_st" ] '
      + '&& [ "$(oc_exe "$_pid")" = "$_ex" ] '
      + '&& [ "$(oc_cmd "$_pid")" = "$_cm" ]; then echo live; return; fi',
    "  echo dead",
    "}",
    "write_starting() {",
    `  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$LOCK_TOKEN" "$$" "$(oc_start $$)" "$(oc_exe $$)" "$(oc_cmd $$)" > "$LOCK/${REMOTE_LOCK_STARTING}" || return 1`,
    "}",
    "wait_handoff() {",
    "  echo POLYTH_LOCK_ACQUIRED=1",
    `  while [ ! -f "$LOCK/${REMOTE_LOCK_HANDOFF}" ]; do sleep 0.1; done`,
    "  exit 0",
    "}",
    'if mkdir "$LOCK"; then',
    "  if ! write_starting; then",
    '    rm -rf "$LOCK"',
    "    echo POLYTH_LOCK_ERROR=starting-write",
    "    exit 78",
    "  fi",
    "  wait_handoff",
    "fi",
    `STARTING_STATE=$(id_state "$LOCK/${REMOTE_LOCK_STARTING}")`,
    'if [ "$STARTING_STATE" = "live" ]; then echo POLYTH_LOCK_ERROR=starting-alive; exit 78; fi',
    'if [ "$STARTING_STATE" = "incomplete" ]; then echo POLYTH_LOCK_ERROR=verify-failed; exit 78; fi',
    'OWNER_STATE=$(id_state "$OWNER")',
    'if [ "$OWNER_STATE" = "live" ]; then echo POLYTH_LOCK_ERROR=already-owned; exit 78; fi',
    'if [ "$OWNER_STATE" = "incomplete" ]; then echo POLYTH_LOCK_ERROR=verify-failed; exit 78; fi',
    'SERVE_STATE=$(id_state "$PF")',
    'if [ "$SERVE_STATE" = "live" ]; then echo POLYTH_LOCK_ERROR=already-owned; exit 78; fi',
    'if [ "$SERVE_STATE" = "incomplete" ]; then echo POLYTH_LOCK_ERROR=verify-failed; exit 78; fi',
    // Exclusive reclaim: only the mkdir winner may rm -rf $LOCK. Do not rm
    // just because owner is missing. Incomplete identities never reclaim.
    'if ! mkdir "$LOCK.reclaim"; then echo POLYTH_LOCK_ERROR=already-owned; exit 78; fi',
    'rm -rf "$LOCK"',
    'if ! mv "$LOCK.reclaim" "$LOCK"; then '
      + 'rm -rf "$LOCK.reclaim"; echo POLYTH_LOCK_ERROR=reclaim-failed; exit 78; fi',
    "if ! write_starting; then echo POLYTH_LOCK_ERROR=starting-write; exit 78; fi",
    "echo POLYTH_LOCK_RECOVERED=1",
    "wait_handoff",
  ].join("\n");
};

const withStartDeadline = <T>(
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

export const acquireRemoteRuntimeLock = async (
  host: RemoteHost,
  runtimeDir: string,
  lockToken: string,
  remotePath: string,
  options?: { timeoutMs?: number },
): Promise<RemoteRuntimeLockHandle> => {
  if (!runtimeDir.startsWith("/")) throw invalid("remote runtimeDir must be an absolute path");
  if (!lockToken.trim()) throw unavailable("remote runtime lock token is required");
  if (!remotePath.trim()) throw invalid("remote path is required");
  const timeoutMs = options?.timeoutMs ?? 20_000;
  const command = remoteLockGuardianCommand(runtimeDir, lockToken, remotePath);
  const handle = await withStartDeadline(
    host.start(command),
    timeoutMs,
    "remote runtime lock guardian start",
    async (lateHandle) => {
      await withStartDeadline(
        lateHandle.kill(),
        timeoutMs,
        "late remote runtime lock guardian cleanup",
      ).catch(() => {});
    },
  );
  return new Promise<RemoteRuntimeLockHandle>((resolve, reject) => {
    let buf = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outputSub.dispose();
      if (error) {
        exitSub.dispose();
        void withStartDeadline(
          handle.kill(),
          timeoutMs,
          "failed remote runtime lock guardian cleanup",
        ).catch(() => {}).finally(() => reject(error));
        return;
      }
      resolve({ lockToken, runtimeDir, guardian: handle });
    };
    const timer = setTimeout(
      () => finish(unavailable(
        `remote runtime lock guardian did not acquire within ${timeoutMs}ms`,
      )),
      timeoutMs,
    );
    const outputSub = handle.onOutput((chunk) => {
      buf += chunk;
      const tagged = buf.match(LOCK_ERROR_RE)?.[1];
      if (tagged) {
        finish(lockUnavailable(runtimeDir, tagged, tagged));
        return;
      }
      if (LOCK_ACQUIRED_RE.test(buf)) finish();
    });
    const exitSub = handle.onExit((code) => {
      const tagged = buf.match(LOCK_ERROR_RE)?.[1];
      finish(lockUnavailable(
        runtimeDir,
        tagged,
        buf.trim().slice(-300) || `exit ${code ?? "killed"}`,
      ));
    });
  });
};

export const stopRemoteLockGuardian = async (
  host: RemoteHost,
  handle: RemoteRuntimeLockHandle,
): Promise<void> => {
  const { runtimeDir, lockToken, guardian } = handle;
  if (!runtimeDir.startsWith("/") || !lockToken.trim()) {
    await guardian.kill().catch(() => {});
    return;
  }
  await host.exec(
    [
      REMOTE_PROCESS_IDENTITY_FUNS,
      `LOCK=${shq(`${runtimeDir}/${REMOTE_LOCK_DIR}`)}`,
      `LOCK_TOKEN=${shq(lockToken)}`,
      `STARTING="$LOCK/${REMOTE_LOCK_STARTING}"`,
      'TAB=$(printf "\\t")',
      'if [ -f "$STARTING" ] && [ ! -L "$STARTING" ] '
        + '&& IFS="$TAB" read -r TOK PID START EXE CMD < "$STARTING"; then '
        + 'if [ "$TOK" = "$LOCK_TOKEN" ] '
        + '&& [ "$(oc_start "$PID")" = "$START" ] '
        + '&& [ "$(oc_exe "$PID")" = "$EXE" ] '
        + '&& [ "$(oc_cmd "$PID")" = "$CMD" ]; then '
        + 'kill "$PID" 2>/dev/null || true; fi; fi',
    ].join("; "),
    { timeoutMs: 20_000 },
  ).catch(() => {});
  await guardian.kill().catch(() => {});
};

export const releaseRemoteRuntimeLock = async (
  host: RemoteHost,
  runtimeDir: string,
  lockToken: string,
): Promise<void> => {
  if (!runtimeDir.startsWith("/") || !lockToken.trim()) return;
  await host.exec(
    [
      REMOTE_STORAGE_MARKERS.releaseLock,
      `RUNTIME_DIR=${shq(runtimeDir)}`,
      `LOCK_TOKEN=${shq(lockToken)}`,
      `LOCK="$RUNTIME_DIR/${REMOTE_LOCK_DIR}"`,
      'if [ -d "$LOCK" ] && [ ! -L "$LOCK" ] '
        + `&& [ "$(cut -f1 "$LOCK/${REMOTE_LOCK_STARTING}" 2>/dev/null)" = "$LOCK_TOKEN" ]; then `
        + 'rm -rf "$LOCK"; echo POLYTH_LOCK_RELEASED=1; fi',
    ].join("; "),
    { timeoutMs: 20_000 },
  ).catch(() => {});
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
  ownerKind: "missing" | "file" | "symlink" | "other";
  ownerLive: boolean;
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
      `OWNER="$RUNTIME_DIR/${REMOTE_OWNER_FILE}"`,
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
      'echo "POLYTH_OWNER_KIND=$(kind_of "$OWNER")"',
      "POLYTH_OWNER_LIVE=0",
      'if [ -f "$OWNER" ] && [ ! -L "$OWNER" ]; then '
        + 'TAB=$(printf "\\t"); '
        + 'IFS="$TAB" read -r OLD_TOKEN OLD_PID OLD_START OLD_EXE OLD_CMD < "$OWNER" || true; '
        + 'oc_start() { sed "s/.*) //" "/proc/$1/stat" 2>/dev/null | cut -d" " -f20; }; '
        + 'oc_exe() { readlink "/proc/$1/exe" 2>/dev/null; }; '
        + 'oc_cmd() { tr "\\000" " " < "/proc/$1/cmdline" 2>/dev/null | cksum | awk \'{print $1 ":" $2}\'; }; '
        + 'if [ -n "$OLD_TOKEN" ] && [ -n "$OLD_PID" ] '
        + '&& [ "$(oc_start "$OLD_PID")" = "$OLD_START" ] '
        + '&& [ "$(oc_exe "$OLD_PID")" = "$OLD_EXE" ] '
        + '&& [ "$(oc_cmd "$OLD_PID")" = "$OLD_CMD" ]; then POLYTH_OWNER_LIVE=1; fi; fi',
      'echo "POLYTH_OWNER_LIVE=$POLYTH_OWNER_LIVE"',
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
    ].join("; "),
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
    ownerKind: pathKind(taggedLine(result.stdout, "POLYTH_OWNER_KIND")),
    ownerLive: taggedLine(result.stdout, "POLYTH_OWNER_LIVE") === "1",
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
  if (inspect.ownerKind === "symlink") {
    throw unavailable(
      `owned remote runtime owner record is a symlink in ${runtimeDir}; refusing to open writable storage`,
    );
  }
  if (inspect.ownerLive) {
    throw unavailable(
      `owned remote runtime directory ${runtimeDir} is held by a live serve; refusing to take over`,
    );
  }

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
  const diagnostic = previous && sameLocation
    ? !openCodeEnginesMatch(previous, engineIdentity)
      ? `OpenCode engine identity changed for remote ${runtimeDir}; the previous writable runtime DB was quarantined without being opened. `
        + `Previous engine: version ${previous.version}, digest ${previous.binaryDigest}. `
        + `Selected engine: version ${engineIdentity.version}, digest ${engineIdentity.binaryDigest}. `
        + "Existing sessions will require a new runtime epoch."
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
