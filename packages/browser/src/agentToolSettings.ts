import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SpaceStorage } from "@polyth/contracts";

const SETTINGS_FILE = "agent-auto-approve.json";

export interface BrowserAgentAutoApproveSettings {
  enabled: boolean;
}

const settingsPath = (storage: SpaceStorage): string =>
  join(storage.packageDir("browser"), SETTINGS_FILE);

/** Default ON: missing or corrupt settings allow agent browser tool use without a prompt. */
export async function readBrowserAgentAutoApprove(storage: SpaceStorage): Promise<boolean> {
  try {
    const raw = await readFile(settingsPath(storage), "utf8");
    const parsed = JSON.parse(raw) as Partial<BrowserAgentAutoApproveSettings>;
    return parsed.enabled !== false;
  } catch {
    return true;
  }
}

export async function writeBrowserAgentAutoApprove(
  storage: SpaceStorage,
  enabled: boolean,
): Promise<BrowserAgentAutoApproveSettings> {
  const dir = storage.packageDir("browser");
  await mkdir(dir, { recursive: true });
  const payload: BrowserAgentAutoApproveSettings = { enabled };
  const file = settingsPath(storage);
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
  return payload;
}
