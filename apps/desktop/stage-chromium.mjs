import { createRequire } from "node:module";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const targetPlatform = process.env.POLYTH_TARGET_PLATFORM ?? process.platform;
const targetArch = process.env.POLYTH_TARGET_ARCH ?? process.arch;

const packageJsonPath = require.resolve("playwright-core/package.json");
const playwrightCore = JSON.parse(await readFile(packageJsonPath, "utf8"));
const { chromium } = await import("playwright-core");

const executablePath = resolve(chromium.executablePath());
let browserRoot = dirname(executablePath);
while (browserRoot !== dirname(browserRoot) && !basename(browserRoot).startsWith("chrome-")) {
  browserRoot = dirname(browserRoot);
}
if (!basename(browserRoot).startsWith("chrome-")) {
  throw new Error(`Could not identify the Playwright Chromium tree for ${executablePath}`);
}
const executableRelative = relative(browserRoot, executablePath);
if (!executableRelative || executableRelative.startsWith("..") || executableRelative.includes(`..${sep}`)) {
  throw new Error(`Playwright Chromium executable escaped its browser root: ${executablePath}`);
}
if (!existsSync(executablePath)) {
  throw new Error(
    `[desktop] Playwright Chromium is not installed at ${executablePath}; `
      + "run `npx playwright-core install chromium` before staging",
  );
}

const target = join(here, "resources", "chromium", `${targetPlatform}-${targetArch}`);
const stagedExecutable = join(target, executableRelative);
const metadataPath = join(target, "polyth-chromium.json");

await rm(target, { recursive: true, force: true });
await mkdir(dirname(target), { recursive: true });
await cp(browserRoot, target, { recursive: true, dereference: false, errorOnExist: false, force: true });
await writeFile(metadataPath, `${JSON.stringify({
  schemaVersion: 1,
  platform: targetPlatform,
  arch: targetArch,
  playwrightCoreVersion: playwrightCore.version,
  executable: executableRelative.split(sep).join("/"),
}, null, 2)}\n`, { mode: 0o600 });

console.log(`[desktop] staged Playwright Chromium ${playwrightCore.version} for ${targetPlatform}-${targetArch}: ${stagedExecutable}`);
