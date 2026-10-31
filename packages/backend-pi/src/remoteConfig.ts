// Pi configuration for SSH projects. Pi runs on the host; the host's own Pi
// configuration wins whenever it offers models. When it offers none, this
// machine's Pi configuration is projected into a private Polyth-owned agent
// directory on the host, so a project on a fresh host works with the models
// already configured here instead of failing readiness.
//
// What crosses the boundary is bounded: API-key credentials (never OAuth
// tokens, whose refresh rotation on the host would invalidate this machine's
// login), `models.json`, the offline model catalog and portable settings
// defaults. Sessions stay in the host's default Pi session directory, so a
// conversation keeps its history whichever configuration launches it.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import {
  execRemoteHarness,
  readRemoteFile,
  remoteHome,
  writeRemoteFile,
  type RemoteProcessHost,
} from "@polyth/harness-runtime/remote-host";

const PROJECTED_FILES = ["auth.json", "models.json", "models-store.json", "settings.json"] as const;
type ProjectedFile = typeof PROJECTED_FILES[number];
const MARKER = ".polyth-config";
const HOST_MODELS_TTL_MS = 60_000;
/** Settings that mean the same thing on any machine. Resource paths, session
 * locations and local package paths do not. */
const PORTABLE_SETTINGS = ["defaultProvider", "defaultModel", "defaultThinkingLevel", "enabledModels", "packages"] as const;
const PORTABLE_PACKAGE = /^(?:npm|git):|^https:\/\//;

export interface LocalPiConfig {
  files: Record<ProjectedFile, string | undefined>;
  /** Whether the configuration can offer any model at all. */
  usable: boolean;
}

/** This machine's Pi agent directory, as Pi itself resolves it. */
export function localPiAgentDir(agentDir?: string): string {
  if (agentDir) return agentDir;
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (configured) return configured === "~" ? homedir() : configured.replace(/^~(?=\/)/, homedir());
  return join(homedir(), ".pi", "agent");
}

const readText = (file: string) => readFile(file, "utf8").catch(() => undefined);
const parseObject = (text: string | undefined): Record<string, unknown> | undefined => {
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
};
const portablePackage = (entry: unknown) => {
  const source = typeof entry === "string" ? entry : (entry as { source?: unknown } | null)?.source;
  return typeof source === "string" && PORTABLE_PACKAGE.test(source);
};

/** The projectable part of a local Pi agent directory. */
export async function readLocalPiConfig(dir: string): Promise<LocalPiConfig> {
  const [auth, models, store, settings] = await Promise.all(
    PROJECTED_FILES.map((name) => readText(join(dir, name))),
  );
  const keys = Object.fromEntries(Object.entries(parseObject(auth) ?? {})
    .filter(([, entry]) => (entry as { type?: unknown } | null)?.type === "api_key"));
  const localSettings = parseObject(settings) ?? {};
  const portable: Record<string, unknown> = {};
  for (const key of PORTABLE_SETTINGS) {
    if (localSettings[key] === undefined) continue;
    portable[key] = key === "packages" && Array.isArray(localSettings[key])
      ? (localSettings[key] as unknown[]).filter(portablePackage)
      : localSettings[key];
  }
  const modelsFile = parseObject(models) ? models : undefined;
  return {
    files: {
      "auth.json": Object.keys(keys).length ? `${JSON.stringify(keys, null, 2)}\n` : undefined,
      "models.json": modelsFile,
      "models-store.json": parseObject(store) ? store : undefined,
      "settings.json": Object.keys(portable).length ? `${JSON.stringify(portable, null, 2)}\n` : undefined,
    },
    usable: Object.keys(keys).length > 0 || modelsFile !== undefined,
  };
}

const hostModels = new Map<string, { at: number; promise: Promise<boolean> }>();

/** Whether the host's own Pi configuration offers a model. Offline catalog
 * report only; no turn. An unclear answer keeps the host's configuration. */
function hostHasOwnModels(remote: RemoteProcessHost, binary: string): Promise<boolean> {
  const key = JSON.stringify([remote.label, binary]);
  const cached = hostModels.get(key);
  if (cached && Date.now() - cached.at < HOST_MODELS_TTL_MS) return cached.promise;
  const promise = execRemoteHarness(remote, [
    "sh", "-c",
    'command -v "$1" >/dev/null 2>&1 || exit 127; PI_OFFLINE=1 "$1" --list-models </dev/null 2>&1',
    "sh", binary,
  ], 30_000, { maxOutputBytes: 1024 * 1024 }).then(({ code, stdout, stderr }) =>
    !(code === 0 && /no models available/i.test(`${stdout}\n${stderr}`)));
  hostModels.set(key, { at: Date.now(), promise });
  while (hostModels.size > 128) {
    const oldest = hostModels.keys().next().value as string | undefined;
    if (!oldest) break;
    hostModels.delete(oldest);
  }
  return promise;
}

const synced = new Map<string, Promise<void>>();

/** Make the host's projected agent directory match `files`. A digest marker,
 * written last, skips unchanged projections across server restarts. */
function syncProjection(remote: RemoteProcessHost, target: string, files: LocalPiConfig["files"]): Promise<void> {
  const digest = createHash("sha256").update(JSON.stringify(PROJECTED_FILES.map((name) => files[name] ?? null))).digest("hex");
  const key = JSON.stringify([remote.label, target, digest]);
  const pending = synced.get(key);
  if (pending) return pending;
  const marker = posix.join(target, MARKER);
  const promise = (async () => {
    if ((await readRemoteFile(remote, marker))?.trim() === digest) return;
    for (const name of PROJECTED_FILES) {
      const path = posix.join(target, name);
      const content = files[name];
      if (content !== undefined) {
        await writeRemoteFile(remote, path, content);
        continue;
      }
      const removed = await execRemoteHarness(remote, ["rm", "-f", "--", path], 20_000);
      if (removed.code !== 0) throw Object.assign(new Error(`Could not update Pi configuration on ${remote.label}`), { code: "runtime-unavailable" });
    }
    await writeRemoteFile(remote, marker, `${digest}\n`);
  })();
  synced.set(key, promise);
  promise.catch(() => { if (synced.get(key) === promise) synced.delete(key); });
  while (synced.size > 128) {
    const oldest = synced.keys().next().value as string | undefined;
    if (!oldest) break;
    synced.delete(oldest);
  }
  return promise;
}

/** Remote environment for Pi on `remote`: empty when the host's own
 * configuration is used, else the projected agent directory. */
export async function remotePiEnv(
  remote: RemoteProcessHost,
  options: { binary: string; localAgentDir?: string },
): Promise<Record<string, string>> {
  if (await hostHasOwnModels(remote, options.binary)) return {};
  const local = await readLocalPiConfig(localPiAgentDir(options.localAgentDir));
  if (!local.usable) return {};
  const home = await remoteHome(remote);
  const target = posix.join(home, ".local", "share", "polyth", "runtimes", "pi", "agent");
  await syncProjection(remote, target, local.files);
  return {
    PI_CODING_AGENT_DIR: target,
    PI_CODING_AGENT_SESSION_DIR: posix.join(home, ".pi", "agent", "sessions"),
  };
}
