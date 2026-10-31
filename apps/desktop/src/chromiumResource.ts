import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";

export interface StagedChromiumMetadata {
  schemaVersion: 1;
  platform: string;
  arch: string;
  playwrightCoreVersion: string;
  executable: string;
}

const safeMetadata = (value: unknown): value is StagedChromiumMetadata => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const metadata = value as Partial<StagedChromiumMetadata>;
  return metadata.schemaVersion === 1
    && typeof metadata.platform === "string"
    && typeof metadata.arch === "string"
    && typeof metadata.playwrightCoreVersion === "string"
    && typeof metadata.executable === "string"
    && metadata.executable.length > 0;
};

/** Resolve only the build-time staged browser. The packaged app never invokes
 * Playwright's installer or falls back to a browser owned by another app. */
export function stagedChromiumExecutable(resourcesDir: string, platform: string, arch: string): string | null {
  const root = resolve(resourcesDir, "chromium", `${platform}-${arch}`);
  const metadataPath = join(root, "polyth-chromium.json");
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as unknown;
    if (!safeMetadata(metadata) || metadata.platform !== platform || metadata.arch !== arch) return null;
    const candidate = resolve(root, normalize(metadata.executable));
    const bounded = relative(root, candidate);
    if (isAbsolute(bounded) || bounded.startsWith("..")) return null;
    if (!existsSync(candidate)) return null;
    let cursor = root;
    for (const component of bounded.split(/[\\/]+/).filter(Boolean)) {
      cursor = join(cursor, component);
      if (lstatSync(cursor).isSymbolicLink()) return null;
    }
    return candidate;
  } catch {
    return null;
  }
}
