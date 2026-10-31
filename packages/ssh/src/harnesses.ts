// Harness CLIs on an SSH host: detect every enabled harness in one round trip
// and run a harness's own backend-declared installer on request.
//
// The harness list, binary names and installers come from the harness
// registry (`HarnessDescriptor.remoteHost`), so this package never names a
// vendor. Install commands are fixed strings owned by each backend; the only
// value interpolated into a remote command is a binary name that passed a
// strict allow-list check.
import type {
  HarnessContext,
  HarnessRegistry,
  RemoteHost,
  SshConnectionDto,
  SshRemoteHarnessDto,
  SshRemoteHarnessesDto,
} from "@polyth/contracts";
import { harnessConfigSource, REMOTE_HARNESS_PATH, shq } from "./index.ts";

export { REMOTE_HARNESS_PATH };

/** One enabled harness family, as the SSH host should offer it. */
export interface RemoteHarnessTarget {
  harnessId: string;
  name: string;
  binary?: string;
  installCommand?: string;
  sessions: boolean;
  localConfig: boolean;
  setupUrl?: string;
}


const BINARY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MARKER = "POLYTH_HARNESS";
const PROBE_TIMEOUT_MS = 45_000;
const INSTALL_TIMEOUT_MS = 300_000;

const unavailable = (message: string): Error =>
  Object.assign(new Error(message), { code: "unavailable" });

const tail = (text: string, max = 400): string => {
  const t = text.trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
};

/** Enabled harness families in roster order. Extra accounts of a
 * multi-account harness share one CLI, so only the family entry is listed. */
export async function remoteHarnessTargets(
  registry: HarnessRegistry,
  context: HarnessContext,
): Promise<RemoteHarnessTarget[]> {
  const roster = await registry.roster(context);
  return roster
    .filter((item) => item.policy.enabled)
    .sort((a, b) => a.policy.priority - b.policy.priority)
    .flatMap((item): RemoteHarnessTarget[] => {
      const descriptor = registry.get(item.identity.id)?.descriptor;
      if (!descriptor) return [];
      if (descriptor.accounts && descriptor.accounts.family !== descriptor.id) return [];
      const remote = descriptor.remoteHost;
      const binary = remote && BINARY_RE.test(remote.binary) ? remote.binary : undefined;
      return [{
        harnessId: descriptor.id,
        name: descriptor.name,
        ...(binary ? { binary } : {}),
        ...(binary && remote?.installCommand?.trim() ? { installCommand: remote.installCommand.trim() } : {}),
        sessions: remote?.sessions === true,
        localConfig: remote?.localConfig === true,
        ...(descriptor.setupUrl ? { setupUrl: descriptor.setupUrl } : {}),
      }];
    });
}

interface BinaryFact { installed: boolean; version?: string }

/** `opencode 1.2.3`, `2.1.0 (Claude Code)`, `v0.9.1` → the version token. */
export const versionFrom = (line: string): string | undefined => {
  const clean = line.replace(/\p{Cc}/gu, " ").trim();
  if (!clean) return undefined;
  const match = clean.match(/v?\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/);
  return (match ? match[0].replace(/^v/, "") : clean).slice(0, 64);
};

/** One shell script that reports every binary; `--version` is bounded by
 * `timeout` where the host has it so one hanging CLI cannot stall the rest. */
export const probeScript = (binaries: readonly string[]): string => [
  REMOTE_HARNESS_PATH,
  'T=""; if command -v timeout >/dev/null 2>&1; then T="timeout 10"; fi',
  `for B in ${binaries.map(shq).join(" ")}; do`,
  '  if command -v "$B" >/dev/null 2>&1; then',
  '    V=$($T "$B" --version </dev/null 2>/dev/null | head -n 1 | tr -d "\\t\\r")',
  `    printf '${MARKER}\\t%s\\t1\\t%s\\n' "$B" "$V"`,
  `  else printf '${MARKER}\\t%s\\t0\\t\\n' "$B"; fi`,
  "done",
].join("\n");

export const parseProbe = (stdout: string): Map<string, BinaryFact> => {
  const facts = new Map<string, BinaryFact>();
  for (const line of stdout.split("\n")) {
    const [marker, binary, installed, version] = line.split("\t");
    if (marker !== MARKER || !binary || !BINARY_RE.test(binary)) continue;
    const parsed = installed === "1" ? versionFrom(version ?? "") : undefined;
    facts.set(binary, { installed: installed === "1", ...(parsed ? { version: parsed } : {}) });
  }
  return facts;
};

const dtoFor = (
  target: RemoteHarnessTarget,
  connection: Pick<SshConnectionDto, "harnessConfig">,
  fact: BinaryFact | undefined,
  message?: string,
): SshRemoteHarnessDto => ({
  harnessId: target.harnessId,
  name: target.name,
  installed: fact ? fact.installed : "unknown",
  ...(fact?.version ? { version: fact.version } : {}),
  installable: Boolean(target.installCommand),
  ...(target.installCommand ? { installCommand: target.installCommand } : {}),
  sessions: target.sessions,
  configSource: harnessConfigSource(connection, target.harnessId),
  localConfig: target.localConfig,
  ...(target.setupUrl ? { setupUrl: target.setupUrl } : {}),
  ...(message ? { message } : {}),
});

/** Lists the targets for one connection. With `probe`, reaches the host once
 * and reports what is installed; without it, returns configuration only. */
export async function listRemoteHarnesses(input: {
  connection: SshConnectionDto;
  host: RemoteHost;
  targets: readonly RemoteHarnessTarget[];
  probe: boolean;
  now?: () => number;
}): Promise<SshRemoteHarnessesDto> {
  const { connection, targets } = input;
  const binaries = [...new Set(targets.flatMap((target) => target.binary ? [target.binary] : []))];
  if (!input.probe || binaries.length === 0) {
    return {
      connectionId: connection.id,
      items: targets.map((target) => dtoFor(target, connection, undefined)),
    };
  }
  const result = await input.host.exec(probeScript(binaries), { timeoutMs: PROBE_TIMEOUT_MS });
  const facts = parseProbe(result.stdout);
  if (facts.size === 0) {
    const message = tail(result.stderr) || `the host did not answer (exit ${result.code})`;
    return {
      connectionId: connection.id,
      message,
      items: targets.map((target) => dtoFor(target, connection, undefined)),
    };
  }
  return {
    connectionId: connection.id,
    checkedAt: (input.now ?? Date.now)(),
    items: targets.map((target) =>
      dtoFor(target, connection, target.binary ? facts.get(target.binary) : undefined)),
  };
}

/** Runs the harness's own installer as the SSH user, then proves the binary is
 * reachable on the probed PATH. Output is kept only for the failure message. */
export async function installRemoteHarness(input: {
  connection: SshConnectionDto;
  host: RemoteHost;
  target: RemoteHarnessTarget;
}): Promise<SshRemoteHarnessDto> {
  const { target, host, connection } = input;
  if (!target.binary || !target.installCommand) {
    throw Object.assign(
      new Error(`${target.name} has no unattended installer; set it up on ${host.label} by hand`),
      { code: "unsupported" },
    );
  }
  const script = [
    REMOTE_HARNESS_PATH,
    `( ${target.installCommand} ) </dev/null 2>&1`,
    'CODE=$?; if [ "$CODE" -ne 0 ]; then echo "POLYTH_INSTALL_EXIT=$CODE"; exit "$CODE"; fi',
    `command -v ${shq(target.binary)} >/dev/null 2>&1 || { echo POLYTH_INSTALL_NOT_ON_PATH; exit 79; }`,
  ].join("\n");
  const result = await host.exec(script, { timeoutMs: INSTALL_TIMEOUT_MS, maxOutputBytes: 4_000_000 });
  if (result.code !== 0) {
    const output = `${result.stdout}\n${result.stderr}`;
    const detail = /POLYTH_INSTALL_NOT_ON_PATH/.test(output)
      ? `the installer finished but "${target.binary}" is not on the PATH`
      : tail(output.replace(/POLYTH_INSTALL_EXIT=\d+/g, "")) || `installer exited ${result.code}`;
    throw unavailable(`could not install ${target.name} on ${host.label}: ${detail}`);
  }
  const probe = await host.exec(probeScript([target.binary]), { timeoutMs: PROBE_TIMEOUT_MS });
  const fact = parseProbe(probe.stdout).get(target.binary) ?? { installed: true };
  return dtoFor(target, connection, fact);
}
