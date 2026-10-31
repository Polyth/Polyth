import { readFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const coreTokens = join(workspaceRoot, "apps/web/src/tokens.css");
const coreStyles = join(workspaceRoot, "apps/web/src/styles.css");
const composerAdaptive = join(workspaceRoot, "apps/web/src/composerAdaptive.css");
const stackNavigation = join(workspaceRoot, "apps/web/src/stackNavigation.css");
const surfaceMotion = join(workspaceRoot, "apps/web/src/surfaceMotion.css");
const shellLooks = join(workspaceRoot, "apps/web/src/shellLooks.css");
const packagesDir = join(workspaceRoot, "packages");

/** Sheets imported directly by a package's widget components, besides index.tsx. */
function componentStylePathsSync(widgets: string): string[] {
  let files: string[] = [];
  try {
    files = readdirSync(widgets).filter((name) => name.endsWith(".tsx") && name !== "index.tsx").sort();
  } catch {
    return [];
  }
  return files.flatMap((name) => {
    const source = readFileSync(join(widgets, name), "utf8");
    return [...source.matchAll(/^import "\.\/([^"]+\.css)";/gm)].map((match) => join(widgets, match[1]!));
  });
}

/**
 * Stylesheets a package's web entry loads, in import order. Packages that
 * split their CSS (e.g. a page sheet beside `styles.css`) are read whole;
 * an entry without explicit CSS imports falls back to `widgets/styles.css`.
 */
function packageStylePathsSync(): string[] {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .flatMap((name) => {
      const widgets = join(packagesDir, name, "widgets");
      let entry = "";
      try {
        entry = readFileSync(join(widgets, "index.tsx"), "utf8");
      } catch {
        // No web entry: only a conventional sheet can apply.
      }
      const imported = [...entry.matchAll(/^import "\.\/([^"]+\.css)";/gm)].map((match) => join(widgets, match[1]!));
      const paths = imported.length ? imported : [join(widgets, "styles.css")];
      // A component can ship its own sheet (ProviderLogo, ModelPicker): it
      // reaches every bundle that renders the component, entry or not.
      paths.push(...componentStylePathsSync(widgets));
      return [...new Set(paths)].filter((path) => {
        try {
          readFileSync(path);
          return true;
        } catch {
          return false;
        }
      });
    });
}

/**
 * Read the effective web stylesheet graph. Feature CSS is package-owned and
 * loaded through each webEntry, so whole-app source audits must include those
 * entries instead of treating the shell stylesheet as a monolith.
 */
export async function readWebStyles(): Promise<string> {
  const packageStyles = await Promise.all(packageStylePathsSync().map((path) => readFile(path, "utf8")));
  return [
    await readFile(coreTokens, "utf8"),
    await readFile(coreStyles, "utf8"),
    // main.tsx loads this shell-owned layer after the core stylesheet; keep
    // source/style assertions on the same cascade as the running app.
    await readFile(composerAdaptive, "utf8"),
    await readFile(stackNavigation, "utf8"),
    await readFile(surfaceMotion, "utf8"),
    // Interface styles (Settings > Appearance) restyle every surface above.
    await readFile(shellLooks, "utf8"),
    ...packageStyles,
  ].join("\n");
}

export function readWebStylesSync(): string {
  return [
    readFileSync(coreTokens, "utf8"),
    readFileSync(coreStyles, "utf8"),
    readFileSync(composerAdaptive, "utf8"),
    readFileSync(stackNavigation, "utf8"),
    readFileSync(surfaceMotion, "utf8"),
    readFileSync(shellLooks, "utf8"),
    ...packageStylePathsSync().map((path) => readFileSync(path, "utf8")),
  ].join("\n");
}
