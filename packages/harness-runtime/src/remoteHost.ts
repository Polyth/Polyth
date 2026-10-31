// Remote execution for stdio harnesses: a project bound to an SSH host runs
// the harness CLI ON that host, with Polyth speaking the same stdio protocol
// through one multiplexed SSH channel. The transport (the SSH package) knows
// nothing about harnesses; backends supply only their argv and remote binary.
//
// The local `ssh` client is the process Polyth launches and owns. Closing it
// closes the remote program's stdin, which ends every stdio harness. The
// remote program runs on the host's own sign-in and native configuration:
// local account directories and env never cross the boundary. The one
// explicit exception is a backend's bounded configuration projection for a
// host with none of its own (Pi: backend-pi/src/remoteConfig.ts).
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import type { HarnessContext, HarnessProbe, RemoteHost, SshHarnessConfigSource } from "@polyth/contracts";
import { serverServiceKey, type ServerPackageHost } from "@polyth/plugins";

/** A remote host that can launch raw-stdio processes. */
export type RemoteProcessHost = RemoteHost & Required<Pick<RemoteHost, "processCommand">>;

type SshPrincipal =
  | { kind: "person"; userId: string; spaceId: string; instanceOwner: boolean }
  | { kind: "binding"; spaceId: string };

interface SshTransportService {
  host(connectionId: string): RemoteHost;
  /** The stored connection; carries per-harness configuration exceptions. */
  get?(connectionId: string): { harnessConfig?: Record<string, string> } | undefined;
  /** Connection ownership (Spaces §14.6); absent on older transports. */
  usable?(connectionId: string, principal: SshPrincipal): boolean;
}

const BINARY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROBE_TIMEOUT_MS = 20_000;
const PROBE_TTL_MS = 30_000;

const failure = (code: string, message: string): Error => Object.assign(new Error(message), { code });

/** Whose use of the connection this is: the session's acting person when a
 * turn has one (§14.2), else work on the project's existing binding. */
async function sshPrincipal(
  host: Partial<Pick<ServerPackageHost, "store" | "personSpaceContext">>,
  context: Pick<HarnessContext, "spaceId" | "sessionId">,
): Promise<SshPrincipal> {
  const actor = context.sessionId
    ? (await host.store?.projection(context.sessionId).catch(() => undefined))?.actor?.userId
    : undefined;
  const person = actor ? host.personSpaceContext?.(actor, context.spaceId) : undefined;
  return person && actor
    ? { kind: "person", userId: actor, spaceId: context.spaceId, instanceOwner: (person as { instanceOwner?: boolean }).instanceOwner === true }
    : { kind: "binding", spaceId: context.spaceId };
}

/** The SSH host a remote project's harness runs on, or undefined for a local
 * project. Resolved lazily per call from the tenant-scoped project service.
 * A connection the acting person may not use is `not-found`. */
export async function resolveRemoteHarnessHost(
  host: Pick<ServerPackageHost, "projects" | "services" | "forSpace"> & Partial<Pick<ServerPackageHost, "store" | "personSpaceContext">>,
  context: Pick<HarnessContext, "remote" | "projectId" | "spaceId" | "space" | "sessionId">,
): Promise<RemoteProcessHost | undefined> {
  if (!context.remote) return undefined;
  const projects = context.space ? host.forSpace(context.space).projects : host.projects;
  const project = await projects.get(context.projectId);
  if (!project || (project.spaceId !== undefined && project.spaceId !== context.spaceId)) {
    throw failure("not-found", "unknown project");
  }
  if (project.remote?.kind !== "ssh") {
    throw failure("unsupported", "This remote project kind cannot run conversations");
  }
  const ssh = host.services.get(serverServiceKey<SshTransportService>("ssh"));
  if (!ssh) throw failure("unavailable", "SSH support unavailable: the ssh package did not load");
  if (ssh.usable && !ssh.usable(project.remote.connectionId, await sshPrincipal(host, context))) {
    throw failure("not-found", "unknown SSH connection");
  }
  const remote = ssh.host(project.remote.connectionId);
  if (typeof remote.processCommand !== "function") {
    throw failure("unsupported", `${remote.label} cannot launch remote processes`);
  }
  return remote as RemoteProcessHost;
}

/** Where `harnessId` on a remote project's SSH host takes its configuration
 * from (`SshConnectionDto.harnessConfig`); unlisted harnesses use `local`.
 * Call after `resolveRemoteHarnessHost` has authorized the connection. */
export async function remoteHarnessConfigSource(
  host: Pick<ServerPackageHost, "projects" | "services" | "forSpace">,
  context: Pick<HarnessContext, "projectId" | "space">,
  harnessId: string,
): Promise<SshHarnessConfigSource> {
  const projects = context.space ? host.forSpace(context.space).projects : host.projects;
  const project = await projects.get(context.projectId);
  if (project?.remote?.kind !== "ssh") return "remote";
  const ssh = host.services.get(serverServiceKey<SshTransportService>("ssh"));
  return ssh?.get?.(project.remote.connectionId)?.harnessConfig?.[harnessId] === "remote" ? "remote" : "local";
}

/** Local spawn arguments for `argv` running in `cwd` on the host. The local
 * ssh client keeps this machine's environment (agent socket, ssh config) and
 * a local working directory; `env` is the explicit non-secret remote set. */
export function remoteHarnessLaunch(
  remote: RemoteProcessHost,
  argv: readonly string[],
  opts: { cwd: string; env?: Readonly<Record<string, string>> },
): { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  const { command, args } = remote.processCommand(argv, {
    cwd: opts.cwd,
    ...(opts.env && Object.keys(opts.env).length ? { env: opts.env } : {}),
  });
  return { command, args, cwd: homedir(), env: process.env };
}

/** Run one bounded command on the host and collect its output. `code` is the
 * remote exit status, or a non-zero local failure (ssh 255, timeout, spawn).
 * `input` is written to the remote program's stdin, then closed. */
export function execRemoteHarness(
  remote: RemoteProcessHost,
  argv: readonly string[],
  timeoutMs: number,
  opts: { cwd?: string; input?: string; maxOutputBytes?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { command, args } = remote.processCommand(argv, opts.cwd ? { cwd: opts.cwd } : undefined);
  return new Promise((resolve) => {
    const child = execFile(command, args, {
      timeout: timeoutMs,
      maxBuffer: opts.maxOutputBytes ?? 4 * 1024 * 1024,
      cwd: homedir(),
    }, (error, stdout, stderr) => {
      const code = !error ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.input ?? "");
  });
}

const unreachable = (remote: RemoteProcessHost, detail: string): Error =>
  failure("runtime-unavailable", `Could not reach ${remote.label}: ${detail.trim().slice(0, 200) || "no answer"}`);

// Keyed by label: a transport hands out a fresh facade object per call.
const homes = new Map<string, Promise<string>>();

/** The SSH user's absolute home directory on the host. */
export function remoteHome(remote: RemoteProcessHost): Promise<string> {
  const cached = homes.get(remote.label);
  if (cached) return cached;
  const promise = execRemoteHarness(remote, ["sh", "-c", 'printf %s "$HOME"'], 15_000).then(({ code, stdout, stderr }) => {
    const home = stdout.trim();
    if (code !== 0 || !home.startsWith("/")) throw unreachable(remote, stderr);
    return home;
  });
  homes.set(remote.label, promise);
  promise.catch(() => { if (homes.get(remote.label) === promise) homes.delete(remote.label); });
  return promise;
}

/** A file's text on the host, or undefined when it does not exist. */
export async function readRemoteFile(remote: RemoteProcessHost, path: string): Promise<string | undefined> {
  const { code, stdout, stderr } = await execRemoteHarness(remote, [
    "sh", "-c", '[ -e "$1" ] || exit 3; cat -- "$1"', "sh", path,
  ], 20_000);
  if (code === 3) return undefined;
  if (code !== 0) throw unreachable(remote, stderr);
  return stdout;
}

/** Atomically replace a private (0600) file on the host. With `ifAbsent`, an
 * existing file is kept (content-addressed sources). */
export async function writeRemoteFile(
  remote: RemoteProcessHost,
  path: string,
  content: string,
  opts: { ifAbsent?: boolean } = {},
): Promise<void> {
  const { code, stderr } = await execRemoteHarness(remote, [
    "sh", "-c",
    'umask 077; [ "$2" = keep ] && [ -e "$1" ] && exit 0; mkdir -p -- "$(dirname -- "$1")" || exit 1; t="$1.$$.tmp"; cat > "$t" && mv -f -- "$t" "$1"',
    "sh", path, opts.ifAbsent ? "keep" : "replace",
  ], 30_000, { input: content });
  if (code !== 0) throw unreachable(remote, stderr);
}

const probes = new Map<string, { at: number; promise: Promise<HarnessProbe> }>();

/** Forget the cached probes of one host (an install just changed it), so the
 *  next probe asks the host again. */
export function forgetRemoteHarnessProbes(label: string): void {
  for (const key of [...probes.keys()]) {
    if ((JSON.parse(key) as unknown[])[0] === label) probes.delete(key);
  }
}

/** Whether `binary` is on the host's harness PATH, and its version. Bounded,
 * process-free on the far side (`--version` only), cached briefly per host. */
export function probeRemoteHarness(
  remote: RemoteProcessHost,
  harnessId: string,
  binary: string | undefined,
): Promise<HarnessProbe> {
  if (!binary || !BINARY_RE.test(binary)) {
    return Promise.resolve({ harnessId, installed: false, authenticated: "unknown", healthy: false, message: `This harness cannot run on ${remote.label}` });
  }
  const key = JSON.stringify([remote.label, harnessId, binary]);
  const cached = probes.get(key);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.promise;
  const promise = execRemoteHarness(remote, [
    "sh", "-c",
    'command -v "$1" >/dev/null 2>&1 || exit 127; "$1" --version </dev/null 2>/dev/null | head -n 1',
    "sh", binary,
  ], PROBE_TIMEOUT_MS, { maxOutputBytes: 16_384 }).then(({ code, stdout }): HarnessProbe => {
    if (code === 127) {
      return { harnessId, installed: false, authenticated: "unknown", healthy: false, message: `Install ${binary} on ${remote.label} to run conversations there` };
    }
    if (code !== 0) {
      return { harnessId, installed: false, authenticated: "unknown", healthy: false, state: "offline", message: `Could not reach ${remote.label}` };
    }
    const line = stdout.replace(/\p{Cc}/gu, " ").trim();
    const version = line.match(/v?\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/)?.[0]?.replace(/^v/, "");
    return {
      harnessId,
      installed: true,
      authenticated: "unknown",
      healthy: true,
      state: "unknown",
      ...(version ? { version } : {}),
      message: `Runs on ${remote.label} with its own sign-in`,
    };
  });
  probes.set(key, { at: Date.now(), promise });
  while (probes.size > 128) {
    const oldest = probes.keys().next().value as string | undefined;
    if (!oldest) break;
    probes.delete(oldest);
  }
  // A failed reach must not stick for the whole TTL: drop it once settled.
  void promise.then((probe) => {
    if (probe.state === "offline" && probes.get(key)?.promise === promise) probes.delete(key);
  });
  return promise;
}
