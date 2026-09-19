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
  RemoteReverseForwardHandle,
  RuntimeAuthentication,
} from "@polyth/contracts";
import {
  acknowledgeCapabilityApplication,
  captureCapabilityLaunch,
  releaseCapabilityLaunch,
} from "@polyth/harness-runtime";
import {
  attachRuntimeLifecycle,
  createOpenCodeRuntimeLifecycle,
  createOpenCodeRuntimeFacade,
  type ManagedOpenCodeRuntime,
} from "./index.ts";
import {
  createOwnedSshEndpointLease,
  headersForAuthentication,
} from "./endpoint.ts";
import { verifyOpenCodeCapabilities } from "./capabilityDelivery.ts";
import type { OpenCodeLaunchOverlay } from "./provisioner.ts";
import type { PreparedRemoteOpenCodeRuntime } from "./remoteStorage.ts";
import {
  acquireRemoteRuntimeLock,
  prepareRemoteOpenCodeRuntime,
  remoteServePidFileExpr,
  REMOTE_PROCESS_IDENTITY_FUNS,
  REMOTE_STORAGE_MARKERS,
  resolveRemoteRuntimeDir,
  shq,
  withRemoteDeadline,
  type RemoteRuntimeAdoption,
} from "./remoteStorage.ts";
import { isOpenCodeV2, OPENCODE_UPDATE_DISABLE_ENV } from "./runtimeStorage.ts";

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
  /** Canonical Space identity for capability receipts. */
  spaceId?: string;
  /** Memory-only capability overlay captured before the remote process starts.
   * A resolver lets owned generation replacement read the newly reconciled
   * revision without persisting its scoped bearer. */
  capabilityOverlay?: OpenCodeLaunchOverlay | (() => OpenCodeLaunchOverlay | undefined);
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
  installable?: boolean;
}

const invalid = (message: string): Error =>
  Object.assign(new Error(message), { code: "invalid-input" });

const unavailable = (message: string): Error =>
  Object.assign(new Error(message), { code: "unavailable" });

const remoteBasicAuthentication = (password: string): RuntimeAuthentication => ({
  kind: "endpoint-headers",
  async resolve() {
    return {
      authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    };
  },
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

interface RemoteAgentToolsLaunch {
  localPort: number;
  path: string;
  name: string;
  headers: Record<string, string>;
}

const remoteAgentToolsLaunch = (
  overlay: OpenCodeLaunchOverlay | undefined,
): RemoteAgentToolsLaunch | undefined => {
  const servers = overlay?.remoteMcp ?? [];
  if (!servers.length) return undefined;
  if (servers.length !== 1 || servers[0]?.capabilityId !== "polyth.agent-tools") {
    throw invalid("remote OpenCode received an unsupported host-bridge capability set");
  }
  const server = servers[0];
  let target: URL;
  try { target = new URL(server.url); } catch { throw invalid("remote OpenCode received an invalid Polyth tool endpoint"); }
  const hostname = target.hostname.toLowerCase();
  const port = Number(target.port || (target.protocol === "http:" ? 80 : 443));
  if (target.protocol !== "http:"
    || hostname !== "127.0.0.1"
    || !target.port
    || target.username || target.password
    || target.pathname !== "/internal/agent-tools/mcp"
    || target.search || target.hash
    || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw invalid("remote OpenCode Polyth tools require the canonical local MCP endpoint");
  }
  const headers = Object.fromEntries(Object.entries(server.headers).map(([key, value]) => {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(key) || !value || /[\r\n]/.test(value)) {
      throw invalid("remote OpenCode received an invalid Polyth tool header");
    }
    return [key, value];
  }));
  const headerEntries = Object.entries(headers);
  if (headerEntries.length !== 1
    || headerEntries[0]![0].toLowerCase() !== "authorization"
    || !/^Bearer [a-f0-9]{64}$/.test(headerEntries[0]![1])) {
    throw invalid("remote OpenCode Polyth tools require scoped authorization");
  }
  if (server.name !== "polyth-agent-tools") {
    throw invalid("remote OpenCode received an invalid Polyth tool bridge name");
  }
  return { localPort: port, path: target.pathname, name: server.name, headers };
};

const remoteAgentToolsConfig = (
  launch: RemoteAgentToolsLaunch,
  remotePort: number,
): string => JSON.stringify({
  mcp: {
    [launch.name]: {
      type: "remote",
      url: `http://127.0.0.1:${remotePort}${launch.path}`,
      headers: launch.headers,
      enabled: true,
    },
  },
});

const capabilityOverlayOf = (
  options: Pick<RemoteOpenCodeOptions, "capabilityOverlay">,
): OpenCodeLaunchOverlay | undefined => typeof options.capabilityOverlay === "function"
  ? options.capabilityOverlay()
  : options.capabilityOverlay;

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
      installable: true,
      message: `opencode is not installed on ${host.label} — install it there first (curl -fsSL https://opencode.ai/v2/install | bash)`,
    };
  }
  const version = out.split("\n").pop()?.trim();
  if (expectedDb) {
    // V2 moved this to `debug paths db`; use the legacy command only when the
    // modern probe itself is unavailable. Both must report the exact isolated
    // path, otherwise no owned serve may touch the remote global DB.
    const dbResult = await host.exec(
      `${REMOTE_PATH}; export ${OPENCODE_UPDATE_DISABLE_ENV}=true; `
        + `mkdir -p ${shq(posix.dirname(expectedDb))} && `
        + `OPENCODE_DB=${shq(expectedDb)} ${safeBin} debug paths db 2>/dev/null; MODERN=$?; `
        + `if [ $MODERN -ne 0 ]; then OPENCODE_DB=${shq(expectedDb)} ${safeBin} db path 2>/dev/null; fi; `
        + `CODE=$?; rm -f ${shq(expectedDb)} ${shq(`${expectedDb}-wal`)} ${shq(`${expectedDb}-shm`)}; exit $CODE`,
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

/** Install OpenCode using the vendor-provided remote installer. The command is
 * intentionally fixed: no user input is interpolated into it. */
export const installRemoteOpenCode = async (host: RemoteHost): Promise<void> => {
  const result = await host.exec(
    `${REMOTE_PATH}; export PATH; curl -fsSL https://opencode.ai/v2/install | bash && command -v opencode >/dev/null 2>&1`,
    { timeoutMs: 120_000 },
  );
  if (result.code !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(-300);
    throw unavailable(
      `could not install opencode on ${host.label}: ${detail || `installer exited ${result.code}`}`,
    );
  }
};

interface ServeProcess {
  port: number;
  remotePid: number | null;
  pidFileExpr: string;
  serveToken: string;
}

interface StartedServe extends ServeProcess {
  cleanupOnFailedStart(): Promise<void>;
  disposeCommittedRuntime(): Promise<void>;
}

const TERMINATE_GRACE_CHECKS = 20;

const terminateServeScript = (serve: Pick<ServeProcess, "pidFileExpr" | "serveToken">): string => [
  REMOTE_STORAGE_MARKERS.stopServe,
  `PF=${serve.pidFileExpr}`,
  `EXPECT_TOKEN=${shq(serve.serveToken)}`,
  `GRACE_CHECKS=${TERMINATE_GRACE_CHECKS}`,
  REMOTE_PROCESS_IDENTITY_FUNS,
  'TAB=$(printf "\\t")',
  'read_pf() { IFS="$TAB" read -r TOKEN PID START EXE CMD PORT < "$PF" || true; }',
  'exact_live() {',
  '  [ -n "$PID" ] && [ "$(oc_start "$PID")" = "$START" ] '
    + '&& [ "$(oc_exe "$PID")" = "$EXE" ] && [ "$(oc_cmd "$PID")" = "$CMD" ]',
  "}",
  'remove_ours() { if [ -f "$PF" ]; then read_pf; if [ "$TOKEN" = "$EXPECT_TOKEN" ]; then rm -f "$PF"; fi; fi; }',
  "wait_gone() {",
  '  N=0; while [ "$N" -lt "$GRACE_CHECKS" ]; do',
  '    if [ ! -f "$PF" ]; then return 0; fi',
  "    read_pf",
  '    if [ "$TOKEN" != "$EXPECT_TOKEN" ]; then return 0; fi',
  "    if ! exact_live; then return 0; fi",
  '    sleep 0.05; N=$((N+1))',
  "  done; return 1",
  "}",
  'if [ ! -f "$PF" ]; then echo POLYTH_STOP_OK=1; exit 0; fi',
  "read_pf",
  'if [ "$TOKEN" != "$EXPECT_TOKEN" ]; then echo POLYTH_STOP_OK=1; exit 0; fi',
  "if ! exact_live; then remove_ours; echo POLYTH_STOP_OK=1; exit 0; fi",
  'kill -TERM "$PID" 2>/dev/null || true',
  "echo POLYTH_STOP_TERM=1",
  "if wait_gone; then remove_ours; echo POLYTH_STOP_OK=1; exit 0; fi",
  "read_pf",
  'if [ "$TOKEN" = "$EXPECT_TOKEN" ] && exact_live; then kill -KILL "$PID" 2>/dev/null || true; echo POLYTH_STOP_KILL=1; fi',
  "if wait_gone; then remove_ours; echo POLYTH_STOP_OK=1; exit 0; fi",
  "read_pf",
  'if [ "$TOKEN" = "$EXPECT_TOKEN" ] && exact_live; then echo POLYTH_STOP_ERROR=still-alive; exit 78; fi',
  "remove_ours",
  "echo POLYTH_STOP_OK=1",
].join("\n");

const terminateServeAndVerify = async (
  host: RemoteHost,
  serve: Pick<ServeProcess, "pidFileExpr" | "serveToken">,
  timeoutMs: number,
): Promise<void> => {
  const result = await host.exec(terminateServeScript(serve), { timeoutMs });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0 || /POLYTH_STOP_ERROR=/.test(output)) {
    throw unavailable(
      `could not prove remote OpenCode serve exited: ${
        output.match(/POLYTH_STOP_ERROR=([A-Za-z0-9._-]+)/)?.[1]
        ?? result.stderr.trim().slice(-300)
        ?? `exit ${result.code}`
      }`,
    );
  }
};

const spawnedServe = (
  serve: ServeProcess,
  host: RemoteHost,
  timeoutMs: number,
): StartedServe => ({
  ...serve,
  cleanupOnFailedStart: () => terminateServeAndVerify(host, serve, timeoutMs),
  disposeCommittedRuntime: () => terminateServeAndVerify(host, serve, timeoutMs),
});

const adoptedServe = (
  serve: ServeProcess,
  host: RemoteHost,
  timeoutMs: number,
): StartedServe => ({
  ...serve,
  cleanupOnFailedStart: async () => undefined,
  disposeCommittedRuntime: () => terminateServeAndVerify(host, serve, timeoutMs),
});

const startServe = async (
  opts: Required<Pick<RemoteOpenCodeOptions, "host" | "remotePath">> & {
    bin: string;
    listenTimeoutMs: number;
    lifecycleTimeoutMs: number;
    runtimeDir: string;
    port: number;
    serveToken: string;
    password?: string;
    configContent?: string;
  },
): Promise<StartedServe> => {
  // The PID record is a process-ownership boundary. Key it by the isolated
  // runtime directory as well as the worktree: two configured projects may
  // legitimately address the same remote path but must never reap each other.
  const dbPath = posix.join(opts.runtimeDir, "opencode.db");
  // The external PF is the serve-process record: immutable serveToken plus
  // start/exe/cmd identities. A stale/reused PID fails this complete match
  // and is never signalled. The start shell daemonizes and exits.
  const pidFileExpr = remoteServePidFileExpr(opts.runtimeDir, opts.remotePath);
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
    ...(opts.password ? [
      'IFS= read -r OPENCODE_PASSWORD || { echo "POLYTH_OPENCODE_PASSWORD_INPUT_FAILED=1" >&2; exit 78; }',
      "export OPENCODE_PASSWORD",
    ] : []),
    ...(opts.configContent ? [
      'IFS= read -r OPENCODE_CONFIG_CONTENT || { echo "POLYTH_OPENCODE_CONFIG_INPUT_FAILED=1" >&2; exit 78; }',
      "export OPENCODE_CONFIG_CONTENT",
    ] : []),
    `PF=${pidFileExpr}`,
    'mkdir -p "$(dirname "$PF")"',
    REMOTE_PROCESS_IDENTITY_FUNS,
    'TAB=$(printf "\\t")',
    'if [ -L "$PF" ]; then echo "POLYTH_RUNTIME_OWNED_SYMLINK=$PF" >&2; exit 78; fi',
    'if [ -f "$PF" ] && IFS="$TAB" read -r OLD_TOKEN OLD_PID OLD_START OLD_EXE OLD_CMD OLD_PORT < "$PF"; then '
      + 'if [ -n "$OLD_TOKEN" ] && [ -n "$OLD_PID" ] && [ "$(oc_start "$OLD_PID")" = "$OLD_START" ] '
      + '&& [ "$(oc_exe "$OLD_PID")" = "$OLD_EXE" ] && [ "$(oc_cmd "$OLD_PID")" = "$OLD_CMD" ]; '
      + 'then echo "POLYTH_RUNTIME_OWNED=$OLD_PID" >&2; exit 78; fi; fi',
    `SERVE_TOKEN=${shq(opts.serveToken)}`,
    'LOG="$RUNTIME_DIR/opencode.serve.log"',
    `cd ${shq(opts.remotePath)}`,
    'rm -f "$LOG"; : > "$LOG"',
    `setsid ${opts.bin} serve --hostname 127.0.0.1 --port ${opts.port} </dev/null >"$LOG" 2>&1 & OC_PID=$!`,
    'N=0; while [ "$N" -lt 100 ]; do OC_CMD=$(oc_cmd "$OC_PID"); '
      + 'case "$OC_CMD" in *" serve --hostname "*) break;; esac; '
      + 'N=$((N + 1)); sleep 0.02; done',
    'OC_START=$(oc_start "$OC_PID")',
    'OC_EXE=$(oc_exe "$OC_PID")',
    'write_pf() { tok=$1; pid=$2; st=$3; ex=$4; cm=$5; po=$6; '
      + 'if [ -z "$tok" ] || [ -z "$pid" ] || [ -z "$st" ] || [ -z "$ex" ] || [ -z "$cm" ] || [ -z "$po" ]; then return 1; fi; '
      + 'tmp=$(mktemp "$PF.tmp.XXXXXX") || return 1; '
      + 'printf "%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$tok" "$pid" "$st" "$ex" "$cm" "$po" > "$tmp" || { rm -f "$tmp"; return 1; }; '
      + 'chmod 600 "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }; '
      + 'mv "$tmp" "$PF" || { rm -f "$tmp"; return 1; }; }',
    `terminate_unpublished_child() { [ -z "$OC_PID" ] && return 0; `
      + 'kill -TERM "$OC_PID" 2>/dev/null || true; echo POLYTH_UNPUBLISHED_TERM=1; '
      + `N=0; while [ "$N" -lt ${TERMINATE_GRACE_CHECKS} ]; do `
      + 'if ! kill -0 "$OC_PID" 2>/dev/null; then return 0; fi; '
      + 'N=$((N+1)); sleep 0.05; done; '
      + 'if ! kill -0 "$OC_PID" 2>/dev/null; then return 0; fi; '
      + 'kill -KILL "$OC_PID" 2>/dev/null || true; echo POLYTH_UNPUBLISHED_KILL=1; '
      + `N=0; while [ "$N" -lt ${TERMINATE_GRACE_CHECKS} ]; do `
      + 'if ! kill -0 "$OC_PID" 2>/dev/null; then return 0; fi; '
      + 'N=$((N+1)); sleep 0.05; done; '
      + 'if kill -0 "$OC_PID" 2>/dev/null; then echo POLYTH_UNPUBLISHED_ERROR=still-alive; return 1; fi; '
      + "return 0; }",
    `write_pf "$SERVE_TOKEN" "$OC_PID" "$OC_START" "$OC_EXE" "$OC_CMD" ${shq(String(opts.port))} `
      + '|| { if terminate_unpublished_child; then echo POLYTH_SERVE_IDENTITY_INCOMPLETE=1; exit 1; fi; exit 78; }',
    'echo "POLYTH_REMOTE_PID=$OC_PID"',
    'N=0; while [ "$N" -lt 40 ]; do '
      + 'if ! kill -0 "$OC_PID" 2>/dev/null; then '
      + 'echo POLYTH_SERVE_EXITED=1; tail -c 4096 "$LOG" 2>/dev/null; exit 1; fi; '
      + 'N=$((N + 1)); sleep 0.05; done',
    "echo POLYTH_SERVE_SPAWNED=1",
    "exit 0",
  ].join("; ");

  const handle = await withRemoteDeadline(
    opts.host.start(command, opts.password || opts.configContent ? { stdin: "pipe" } : undefined),
    opts.lifecycleTimeoutMs,
    "remote OpenCode process start",
    async (lateHandle) => {
      await withRemoteDeadline(
        lateHandle.kill(),
        opts.lifecycleTimeoutMs,
        "late remote OpenCode process cleanup",
      ).catch(() => {});
    },
  );
  if (opts.password || opts.configContent) {
    if (!handle.write) {
      await withRemoteDeadline(handle.kill(), opts.lifecycleTimeoutMs, "remote OpenCode input cleanup").catch(() => {});
      throw unavailable("remote OpenCode start transport has no non-interactive input channel");
    }
    try {
      await handle.write(`${opts.password ? `${opts.password}\n` : ""}${opts.configContent ? `${opts.configContent}\n` : ""}`);
    } catch {
      await withRemoteDeadline(handle.kill(), opts.lifecycleTimeoutMs, "remote OpenCode input cleanup").catch(() => {});
      throw unavailable(opts.configContent
        ? "could not deliver private remote OpenCode startup configuration"
        : "could not deliver private remote OpenCode startup credential");
    }
  }
  return new Promise<StartedServe>((resolve, reject) => {
    let buf = "";
    let settled = false;
    let remotePid: number | null = null;
    const serveRecord = (): ServeProcess => ({
      port: opts.port,
      remotePid,
      pidFileExpr,
      serveToken: opts.serveToken,
    });
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outputSub.dispose();
      exitSub.dispose();
      if (err) {
        void withRemoteDeadline(
          Promise.all([
            handle.kill(),
            terminateServeAndVerify(opts.host, serveRecord(), opts.lifecycleTimeoutMs),
          ]).then(() => undefined),
          opts.lifecycleTimeoutMs,
          "failed remote OpenCode start-shell cleanup",
        ).then(
          () => reject(err),
          (stopErr) => reject(stopErr),
        );
      } else {
        resolve(spawnedServe(serveRecord(), opts.host, opts.lifecycleTimeoutMs));
      }
    };
    const spawnFailed = (code?: number | null) => {
      if (/POLYTH_UNPUBLISHED_ERROR=/.test(buf)) {
        finish(unavailable("could not prove unpublished remote OpenCode serve exited"));
        return;
      }
      const err = IN_USE_RE.test(buf)
        ? Object.assign(new Error(`remote port ${opts.port} is in use`), { code: "port-in-use" })
        : unavailable(
          `remote opencode serve exited${code === undefined ? "" : ` (${code ?? "killed"})`}: ${buf.trim().slice(-400)}`,
        );
      finish(err);
    };
    const timer = setTimeout(
      () => finish(unavailable(`remote opencode serve did not spawn within ${opts.listenTimeoutMs}ms`)),
      opts.listenTimeoutMs,
    );
    const outputSub = handle.onOutput((chunk) => {
      buf += chunk;
      const pid = buf.match(PID_LINE_RE);
      if (pid) remotePid = Number(pid[1]);
      if (/POLYTH_SERVE_EXITED=1/.test(buf)) {
        spawnFailed();
        return;
      }
      if (/POLYTH_SERVE_SPAWNED=1/.test(buf)) finish();
    });
    const exitSub = handle.onExit((code) => {
      if (settled) return;
      if (code === 0) {
        queueMicrotask(() => {
          if (settled) return;
          if (/POLYTH_SERVE_SPAWNED=1/.test(buf) || remotePid !== null) finish();
          else spawnFailed(code);
        });
        return;
      }
      spawnFailed(code);
    });
  });
};

type AttachResult =
  | { kind: "live"; serve: StartedServe }
  | { kind: "dead" };

const attachAdoptedServe = async (opts: {
  host: RemoteHost;
  runtimeDir: string;
  remotePath: string;
  adoption: RemoteRuntimeAdoption;
  lifecycleTimeoutMs: number;
}): Promise<AttachResult> => {
  const pidFileExpr = remoteServePidFileExpr(opts.runtimeDir, opts.remotePath);
  let result;
  try {
    result = await opts.host.exec(
      [
        REMOTE_STORAGE_MARKERS.attach,
        REMOTE_PROCESS_IDENTITY_FUNS,
        `RUNTIME_DIR=${shq(opts.runtimeDir)}`,
        `EXPECT_PID=${shq(opts.adoption.pid)}`,
        `EXPECT_START=${shq(opts.adoption.startIdentity)}`,
        `EXPECT_EXE=${shq(opts.adoption.executable)}`,
        `EXPECT_CMD=${shq(opts.adoption.command)}`,
        'if ! kill -0 "$EXPECT_PID" 2>/dev/null; then echo POLYTH_ATTACH_ERROR=dead; exit 78; fi',
        'if [ "$(oc_start "$EXPECT_PID")" != "$EXPECT_START" ] '
          + '|| [ "$(oc_exe "$EXPECT_PID")" != "$EXPECT_EXE" ] '
          + '|| [ "$(oc_cmd "$EXPECT_PID")" != "$EXPECT_CMD" ]; then '
          + "echo POLYTH_ATTACH_ERROR=dead; exit 78; fi",
        "echo POLYTH_ATTACH_OK=1",
      ].join("; "),
      { timeoutMs: opts.lifecycleTimeoutMs },
    );
  } catch (error) {
    throw unavailable(
      `could not attach to live remote OpenCode: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result.stdout.includes("POLYTH_ATTACH_OK=1")) {
    return {
      kind: "live",
      serve: adoptedServe({
        port: opts.adoption.port,
        remotePid: Number(opts.adoption.pid),
        pidFileExpr,
        serveToken: opts.adoption.serveToken,
      }, opts.host, opts.lifecycleTimeoutMs),
    };
  }
  const error = `${result.stdout}\n${result.stderr}`.match(/POLYTH_ATTACH_ERROR=([A-Za-z0-9._-]+)/)?.[1];
  if (error === "dead") return { kind: "dead" };
  throw unavailable(
    `could not attach to live remote OpenCode: ${
      error ?? result.stderr.trim().slice(-300) ?? `exit ${result.code}`
    }`,
  );
};

/** Spawn `opencode serve` on the remote host and return the standard adapter
 *  attached through a forwarded local port. Failure modes are explicit:
 *  missing binary and missing workspace path are reported before any process
 *  is started; port collisions retry with a fresh candidate. */
const createRemoteOpenCodeRuntimeInner = async (
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
  const initialAgentTools = remoteAgentToolsLaunch(capabilityOverlayOf(options));
  if (initialAgentTools && !host.reverseForward) {
    throw unavailable("remote host transport cannot expose the scoped Polyth tool bridge");
  }
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

  const modern = isOpenCodeV2(probe.version);
  const configuredModernPassword = process.env.OPENCODE_PASSWORD
    || process.env.OPENCODE_SERVER_PASSWORD;
  if (configuredModernPassword && /[\r\n]/.test(configuredModernPassword)) {
    throw invalid("remote OpenCode password cannot contain line breaks");
  }
  // An owned v2 serve must not leave the upstream-generated password unknown
  // to its controller. Keep a generated value only in this runtime closure and
  // pass it to the child environment, never the parent process environment.
  const modernPassword = modern ? configuredModernPassword || randomUUID() : undefined;
  const authentication: RuntimeAuthentication = modernPassword
    ? remoteBasicAuthentication(modernPassword)
    : {
      kind: "basic-env",
      usernameEnv: options.usernameEnv ?? "OPENCODE_SERVER_USERNAME",
      passwordEnv: options.passwordEnv ?? "OPENCODE_SERVER_PASSWORD",
    };
  const lock = await acquireRemoteRuntimeLock(host, runtimeDir, remotePath, {
    timeoutMs: lifecycleTimeoutMs,
  });
  console.log(`[polyth] runtime.controller.acquired runtimeDir=${runtimeDir}`);
  if (lock.adoption) {
    if (lock.adoption.legacyMigrated) {
      console.log(
        `[polyth] runtime.remote.legacy-record.migrated runtimeDir=${runtimeDir} `
          + `pid=${lock.adoption.pid} port=${lock.adoption.port}`,
      );
    }
    console.log(
      `[polyth] runtime.remote.adopt host=${host.label} runtimeDir=${runtimeDir} `
        + `pid=${lock.adoption.pid} port=${lock.adoption.port}`,
    );
  }
  let pendingAdoption = lock.adoption;
  if (modern && pendingAdoption && !configuredModernPassword && !initialAgentTools) {
    await lock.release();
    throw unavailable(
      "cannot attach to an existing owned OpenCode v2 serve without its explicit OPENCODE_PASSWORD; refusing to stop or replace it",
    );
  }
  let controllerState: "held" | "releasing" | "released" | "lost" = "held";
  let publishedPort: number | undefined;
  let publishedServeToken: string | undefined;
  let publishedCapabilityOverlay: OpenCodeLaunchOverlay | undefined;
  let publishedLaunchCapture: {
    target: { harnessId: "opencode"; spaceId: string; projectId: string; cwd: string };
    desiredRevision: string;
  } | undefined;
  let committed = false;
  let releaseLockFlight: Promise<void> | undefined;
  void lock.lost.then(() => {
    if (controllerState === "held") {
      controllerState = "lost";
      console.log(`[polyth] runtime.controller.lost runtimeDir=${runtimeDir}`);
    }
  });
  const releaseLock = (): Promise<void> => {
    if (controllerState === "released" || controllerState === "lost") return Promise.resolve();
    if (releaseLockFlight) return releaseLockFlight;
    controllerState = "releasing";
    releaseLockFlight = lock.release().then(
      () => {
        controllerState = "released";
        console.log(`[polyth] runtime.controller.released runtimeDir=${runtimeDir}`);
      },
      (error: unknown) => {
        if (lock.held()) {
          controllerState = "held";
          releaseLockFlight = undefined;
        } else {
          controllerState = "lost";
          console.log(`[polyth] runtime.controller.lost runtimeDir=${runtimeDir}`);
        }
        throw error;
      },
    );
    return releaseLockFlight;
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
        ...(pendingAdoption ? { adoption: pendingAdoption } : {}),
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
    async start(leaseToken, incarnation) {
      // leaseToken is the endpoint generation UUID. A newly spawned serve
      // uses it as serveToken. An adopted serve keeps its existing serveToken;
      // controller ownership is this guardian + flock, not a process rename.
      const runtime = prepared;
      if (!runtime) throw unavailable("isolated remote OpenCode runtime was not prepared");
      if (!lock.held()) {
        throw Object.assign(
          new Error("remote runtime controller lease was lost; refusing concurrent mutation"),
          { code: "conflict" },
        );
      }
      const launchOverlay = capabilityOverlayOf(options);
      const agentTools = remoteAgentToolsLaunch(launchOverlay);
      if (agentTools && !host.reverseForward) {
        throw unavailable("remote host transport cannot expose the scoped Polyth tool bridge");
      }
      const launchCapture = options.projectId && launchOverlay?.desiredRevision
        ? {
            target: {
              harnessId: "opencode" as const,
              spaceId: options.spaceId ?? "",
              projectId: options.projectId,
              cwd: remotePath,
            },
            desiredRevision: launchOverlay.desiredRevision,
          }
        : undefined;
      if (launchCapture) captureCapabilityLaunch(launchCapture);
      try {
        await runtime.recordOpen(incarnation);
      } catch (error) {
        if (launchCapture) releaseCapabilityLaunch(launchCapture);
        throw error;
      }
      const openReverse = async (
        localPort: number,
        remotePort?: number,
      ): Promise<RemoteReverseForwardHandle> => {
        const reverseForward = host.reverseForward;
        if (!reverseForward) {
          throw unavailable("remote host transport cannot expose the scoped Polyth tool bridge");
        }
        return withRemoteDeadline(
          reverseForward.call(host, localPort, remotePort),
          lifecycleTimeoutMs,
          "remote Polyth tool reverse forward",
          async (lateReverse) => {
            await withRemoteDeadline(
              Promise.resolve(lateReverse.dispose()),
              lifecycleTimeoutMs,
              "late remote Polyth tool reverse-forward cleanup",
            ).catch(() => {});
          },
        );
      };
      let reverse: RemoteReverseForwardHandle | undefined;
      try {
        reverse = agentTools ? await openReverse(agentTools.localPort) : undefined;
      } catch (error) {
        if (launchCapture) releaseCapabilityLaunch(launchCapture);
        throw error;
      }
      const configContent = agentTools && reverse
        ? remoteAgentToolsConfig(agentTools, reverse.remotePort)
        : undefined;
      let started: StartedServe | null = null;
      try {
        if (pendingAdoption) {
          const adoption = pendingAdoption;
          pendingAdoption = undefined;
          const attached = await attachAdoptedServe({
            host,
            runtimeDir: runtime.runtimeDir,
            remotePath,
            adoption,
            lifecycleTimeoutMs,
          });
          if (attached.kind === "live") {
            if (agentTools) {
              // Agent-tool grants are memory-only and minted for this launch.
              // An older serve cannot prove it holds the current scoped token.
              await attached.serve.disposeCommittedRuntime();
            } else {
              started = attached.serve;
            }
          }
        }
        if (!started) {
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
                serveToken: leaseToken,
                ...(modernPassword ? { password: modernPassword } : {}),
                ...(configContent ? { configContent } : {}),
              });
            } catch (error) {
              lastError = error;
              if ((error as { code?: string }).code !== "port-in-use") throw error;
            }
          }
          if (!started) {
            throw lastError ?? unavailable(`could not start opencode serve on ${host.label}`);
          }
        }
      } catch (error) {
        await Promise.resolve(reverse?.dispose()).catch(() => {});
        if (launchCapture) releaseCapabilityLaunch(launchCapture);
        throw error;
      }
      const serve = started;
      publishedPort = serve.port;
      publishedServeToken = serve.serveToken;

      const openForward = async (port: number) =>
        withRemoteDeadline(
          host.forward(port),
          lifecycleTimeoutMs,
          "remote OpenCode forward",
          async (lateForward) => {
            await withRemoteDeadline(
              Promise.resolve(lateForward.dispose()),
              lifecycleTimeoutMs,
              "late remote OpenCode forward cleanup",
            ).catch(() => {});
          },
        );

      let forward: Awaited<ReturnType<RemoteHost["forward"]>>;
      try {
        forward = await openForward(serve.port);
      } catch (error) {
        await serve.cleanupOnFailedStart();
        await Promise.resolve(reverse?.dispose()).catch(() => {});
        if (launchCapture) releaseCapabilityLaunch(launchCapture);
        throw error;
      }
      publishedCapabilityOverlay = launchOverlay;
      publishedLaunchCapture = launchCapture;

      let stopped = false;
      let reviving: Promise<string | undefined> | undefined;
      let recoveredTransport = false;
      let transportDead = false;
      const probeServe = async (): Promise<"live" | "dead" | "unreachable"> => {
        try {
          const result = await host.exec(
            [
              REMOTE_PROCESS_IDENTITY_FUNS,
              `PF=${serve.pidFileExpr}`,
              `TOKEN=${shq(serve.serveToken)}`,
              'TAB=$(printf "\\t")',
              'if [ -f "$PF" ] && IFS="$TAB" read -r PF_TOK PID START EXE CMD PORT < "$PF"; then '
                + 'if [ "$PF_TOK" = "$TOKEN" ] '
                + '&& [ "$(oc_start "$PID")" = "$START" ] '
                + '&& [ "$(oc_exe "$PID")" = "$EXE" ] '
                + '&& [ "$(oc_cmd "$PID")" = "$CMD" ]; then echo POLYTH_SERVE_LIVE=1; fi; fi',
            ].join("; "),
            { timeoutMs: lifecycleTimeoutMs },
          );
          if (result.stdout.includes("POLYTH_SERVE_LIVE=1")) return "live";
          if (result.code === 0) return "dead";
          return "unreachable";
        } catch {
          return "unreachable";
        }
      };
      const transportIsUp = (): boolean =>
        !stopped && (recoveredTransport || !transportDead);
      return {
        url: `http://127.0.0.1:${forward.localPort}`,
        instanceIdentity: `${serve.serveToken}:${serve.remotePid ?? "unknown"}:${serve.port}`,
        notStopped: () => !stopped,
        controllerAlive: () => lock.held() && !stopped,
        transportAlive: transportIsUp,
        markTransportDead: () => {
          recoveredTransport = false;
          transportDead = true;
        },
        async revive() {
          if (stopped) return undefined;
          if (reviving) return reviving;
          reviving = (async () => {
            if (!lock.held()) {
              throw Object.assign(
                new Error("remote runtime controller lease was lost; refusing concurrent mutation"),
                { code: "conflict" },
              );
            }
            const status = await probeServe();
            if (status === "unreachable") {
              throw unavailable(
                "remote runtime transport is down while the owned serve may still be alive",
              );
            }
            if (status === "dead") return undefined;
            if (transportIsUp()) return `http://127.0.0.1:${forward.localPort}`;
            const next = await openForward(serve.port);
            let nextReverse: RemoteReverseForwardHandle | undefined;
            if (agentTools && reverse) {
              const remotePort = reverse.remotePort;
              await Promise.resolve(reverse.dispose()).catch(() => {});
              reverse = undefined;
              try {
                nextReverse = await openReverse(agentTools.localPort, remotePort);
              } catch (error) {
                await Promise.resolve(next.dispose()).catch(() => {});
                throw error;
              }
            }
            await Promise.resolve(forward.dispose()).catch(() => {});
            forward = next;
            if (nextReverse) reverse = nextReverse;
            recoveredTransport = true;
            console.log(
              `[polyth] runtime.remote.reconnect runtimeDir=${runtime.runtimeDir} port=${serve.port}`,
            );
            return `http://127.0.0.1:${forward.localPort}`;
          })().finally(() => { reviving = undefined; });
          return reviving;
        },
        async stop() {
          if (stopped) return;
          stopped = true;
          try {
            if (committed) await serve.disposeCommittedRuntime();
            else await serve.cleanupOnFailedStart();
          } finally {
            await Promise.all([
              withRemoteDeadline(
                Promise.resolve(forward.dispose()),
                lifecycleTimeoutMs,
                "remote OpenCode forward disposal",
              ).catch(() => {}),
              withRemoteDeadline(
                Promise.resolve(reverse?.dispose()),
                lifecycleTimeoutMs,
                "remote Polyth tool reverse-forward disposal",
              ).catch(() => {}),
            ]);
          }
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
    if (publishedPort === undefined || !publishedServeToken) {
      throw unavailable("remote OpenCode listen identity was not captured");
    }
    if (!lock.held()) {
      throw Object.assign(
        new Error("remote runtime controller lease was lost; refusing concurrent mutation"),
        { code: "conflict" },
      );
    }
    committed = true;
  } catch (error) {
    if (publishedLaunchCapture) {
      releaseCapabilityLaunch(publishedLaunchCapture);
      publishedLaunchCapture = undefined;
    }
    await lease.dispose();
    if (error instanceof Error && /unpublished remote OpenCode serve/.test(error.message)) {
      throw error;
    }
    throw unavailable(
      `remote opencode serve on ${host.label} did not become ready: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const acknowledgePublishedCapabilities = async (endpoint: Awaited<ReturnType<typeof lifecycle.endpoint>>): Promise<void> => {
    if (!options.projectId) return;
    const overlay = publishedCapabilityOverlay;
    const target = {
      harnessId: "opencode" as const,
      spaceId: options.spaceId ?? "",
      projectId: options.projectId,
      cwd: remotePath,
      authorityId: endpoint.authorityId,
      generation: endpoint.generation,
    };
    acknowledgeCapabilityApplication({
      target,
      desiredRevision: overlay?.desiredRevision ?? "",
      capabilityIds: overlay?.capabilityIds ?? [],
      outcome: "unverifiable",
      evidence: { stage: "staged", source: "opencode:ssh-launch" },
      reason: overlay
        ? "Remote OpenCode started with the private SSH launch overlay"
        : "Remote OpenCode started",
    });
    publishedLaunchCapture = undefined;
    if (!overlay) return;
    const v2 = isOpenCodeV2(probe.version!);
    let activation: Promise<void> | undefined;
    const capabilityUrl = (path: string): URL => {
      const url = new URL(path, endpoint.url);
      url.searchParams.set(v2 ? "location[directory]" : "directory", remotePath);
      return url;
    };
    await verifyOpenCodeCapabilities(
      overlay,
      target,
      async (path) => {
        const headers = await headersForAuthentication(authentication);
        if (v2) {
          activation ??= (async () => {
            const response = await fetch(capabilityUrl("/api/plugin/await-activation"), {
              method: "POST",
              headers,
              signal: AbortSignal.timeout(listenTimeoutMs),
            });
            if (response.status !== 204) {
              throw new Error(`OpenCode V2 plugin activation wait failed (HTTP ${response.status})`);
            }
          })();
          await activation;
        }
        const response = await fetch(capabilityUrl(path), {
          headers,
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error("OpenCode capability readback unavailable");
        return response.json();
      },
      undefined,
      v2 ? "v2" : "legacy",
    );
  };
  const releaseFailedPublishedLaunch = (): void => {
    if (!publishedLaunchCapture) return;
    releaseCapabilityLaunch(publishedLaunchCapture);
    publishedLaunchCapture = undefined;
  };
  const refreshLifecycle = lifecycle.refresh.bind(lifecycle);
  lifecycle.refresh = async (reason) => {
    const previous = await lifecycle.endpoint().catch(() => undefined);
    try {
      const endpoint = await refreshLifecycle(reason);
      if (!previous
        || previous.authorityId !== endpoint.authorityId
        || previous.generation !== endpoint.generation) {
        await acknowledgePublishedCapabilities(endpoint);
      }
      return endpoint;
    } catch (error) {
      releaseFailedPublishedLaunch();
      throw error;
    }
  };
  if ("restart" in lifecycle) {
    const restartLifecycle = lifecycle.restart.bind(lifecycle);
    lifecycle.restart = async (reason) => {
      try {
        const endpoint = await restartLifecycle(reason);
        await acknowledgePublishedCapabilities(endpoint);
        return endpoint;
      } catch (error) {
        releaseFailedPublishedLaunch();
        throw error;
      }
    };
    const withConfigRestart = lifecycle.withConfigRestart.bind(lifecycle);
    lifecycle.withConfigRestart = (action) => withConfigRestart((restartGeneration) =>
      action(async () => {
        try {
          const endpoint = await restartGeneration();
          await acknowledgePublishedCapabilities(endpoint);
          return endpoint;
        } catch (error) {
          releaseFailedPublishedLaunch();
          throw error;
        }
      }));
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
  const managed = attachRuntimeLifecycle(runtime, lifecycle) as ManagedOpenCodeRuntime;
  try {
    await acknowledgePublishedCapabilities(await lifecycle.endpoint());
  } catch (error) {
    releaseFailedPublishedLaunch();
    await managed.dispose();
    throw error;
  }
  return managed;
  } catch (error) {
    if (!(error instanceof Error && /unpublished remote OpenCode serve/.test(error.message))) {
      await releaseLock();
    }
    throw error;
  }
};

export const createRemoteOpenCodeRuntime = createRemoteOpenCodeRuntimeInner;
