// Chromium for layout tests, found without naming a removable package:
// POLYTH_CHROMIUM_PATH, then well-known system paths, then a local Playwright
// installation. Never downloads a browser.
import { access, constants } from "node:fs/promises";
import { chromium } from "playwright-core";

const CANDIDATE_PATHS = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/local/bin/chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/local/bin/google-chrome",
  "/opt/google/chrome/google-chrome",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

const executable = (path: string) => access(path, constants.X_OK).then(() => path, () => null);

export async function findChromium(): Promise<string | null> {
  const configured = process.env.POLYTH_CHROMIUM_PATH?.trim();
  if (configured) return executable(configured);
  if (process.env.POLYTH_REQUIRE_BUNDLED_CHROMIUM === "1") return null;
  for (const path of CANDIDATE_PATHS) {
    const found = await executable(path);
    if (found) return found;
  }
  try {
    const bundled = chromium.executablePath();
    return bundled ? await executable(bundled) : null;
  } catch {
    return null;
  }
}
