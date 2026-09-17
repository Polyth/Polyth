import { readFile, readdir } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const coreTokens = join(workspaceRoot, "apps/web/src/tokens.css");
const coreStyles = join(workspaceRoot, "apps/web/src/styles.css");
const composerAdaptive = join(workspaceRoot, "apps/web/src/composerAdaptive.css");
const packagesDir = join(workspaceRoot, "packages");

function packageStylePathsSync(): string[] {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name, "widgets/styles.css"))
    .filter((path) => {
      try {
        readFileSync(path);
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * Read the effective web stylesheet graph. Feature CSS is package-owned and
 * loaded through each webEntry, so whole-app source audits must include those
 * entries instead of treating the shell stylesheet as a monolith.
 */
export async function readWebStyles(): Promise<string> {
  const paths = (await readdir(packagesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name, "widgets/styles.css"))
    .sort();
  const packageStyles = await Promise.all(paths.map(async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch {
      return "";
    }
  }));
  return [
    await readFile(coreTokens, "utf8"),
    await readFile(coreStyles, "utf8"),
    // main.tsx loads this shell-owned layer after the core stylesheet; keep
    // source/style assertions on the same cascade as the running app.
    await readFile(composerAdaptive, "utf8"),
    ...packageStyles,
  ].join("\n");
}

export function readWebStylesSync(): string {
  return [
    readFileSync(coreTokens, "utf8"),
    readFileSync(coreStyles, "utf8"),
    readFileSync(composerAdaptive, "utf8"),
    ...packageStylePathsSync().map((path) => readFileSync(path, "utf8")),
  ].join("\n");
}
