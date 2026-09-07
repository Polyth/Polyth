import { existsSync } from "node:fs";
import { join } from "node:path";

export type HostBinarySource = "env" | "packaged" | "dev-release" | "dev-debug";
export type HostBinaryMissingReason = "unsupported-platform" | "missing";

export type HostBinaryResolution =
  | { ok: true; path: string; source: HostBinarySource }
  | { ok: false; reason: HostBinaryMissingReason };

export interface HostBinaryLookup {
  platform?: string;
  env?: Record<string, string | undefined>;
  resourcesDir?: string;
  repoRoot?: string;
  exists?: (path: string) => boolean;
}

const defaultRepoRoot = join(import.meta.dirname, "../../..");

export function hostExecutableName(platform: string): string {
  return platform === "win32" ? "polyth-link-host.exe" : "polyth-link-host";
}

function resourcesPathFromProcess(): string | undefined {
  const value = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return typeof value === "string" && value ? value : undefined;
}

/** Resolve the Polyth Link host executable. Windows is fail-closed even when
 *  `POLYTH_LINK_HOST` is set, until named-pipe IPC exists. Packaged desktop
 *  builds look under `<resources>/polyth-link/`. */
export function resolveHostBinary(opts: HostBinaryLookup = {}): HostBinaryResolution {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const name = hostExecutableName(platform);

  if (platform === "win32") {
    return { ok: false, reason: "unsupported-platform" };
  }

  const override = env.POLYTH_LINK_HOST?.trim();
  if (override && exists(override)) {
    return { ok: true, path: override, source: "env" };
  }

  const resourcesDir = opts.resourcesDir
    ?? env.POLYTH_RESOURCES_DIR
    ?? resourcesPathFromProcess();
  if (resourcesDir) {
    const packaged = join(resourcesDir, "polyth-link", name);
    if (exists(packaged)) return { ok: true, path: packaged, source: "packaged" };
  }

  const root = opts.repoRoot ?? defaultRepoRoot;
  const release = join(root, "target", "release", name);
  if (exists(release)) return { ok: true, path: release, source: "dev-release" };
  const debug = join(root, "target", "debug", name);
  if (exists(debug)) return { ok: true, path: debug, source: "dev-debug" };
  return { ok: false, reason: "missing" };
}
